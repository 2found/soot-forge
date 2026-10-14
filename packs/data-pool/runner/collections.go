package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const maxCollectionDepth = 8

// workspaceSubject is the grant subject covering every bound Soot. Managers
// grant and revoke it as group "@workspace"; group IDs never contain '@'.
const workspaceSubject = "@workspace"

// Membership is operator configuration, not an assertion in model input or a
// tool envelope. Group grants never let a caller add itself to a group.
func validateOrganization(b binding) error {
	if len(b.Groups) > 256 || len(b.Defaults) > 4096 {
		return errors.New("organization binding exceeds limits")
	}
	counts := map[string]int{}
	for group, members := range b.Groups {
		if !identifier.MatchString(group) || len(members) == 0 || len(members) > 4096 {
			return errors.New("invalid bound group")
		}
		seen := map[string]bool{}
		for _, actor := range members {
			if !slices.Contains(b.Soots, actor) || seen[actor] {
				return errors.New("group members must be distinct bound Soots")
			}
			seen[actor] = true
			counts[actor]++
			if counts[actor] > 64 {
				return errors.New("a Soot can belong to at most 64 bound groups")
			}
		}
	}
	for actor, id := range b.Defaults {
		if !slices.Contains(b.Soots, actor) || !identifier.MatchString(id) {
			return errors.New("invalid default collection binding")
		}
	}
	return nil
}

// actorGroups lists the bound groups containing actor. Only the calling
// actor's list is ever consulted, so build just that one: a full
// actor→groups map costs O(groups × members) per short-lived invocation.
func actorGroups(b binding, actor string) []string {
	out := []string{}
	for group, members := range b.Groups {
		if slices.Contains(members, actor) {
			out = append(out, group)
		}
	}
	slices.Sort(out)
	return out
}

// groupMembership maps every bound actor to its groups; needed only on the
// manager-facing detail path that reports effective permissions per Soot.
func groupMembership(b binding) map[string][]string {
	out := map[string][]string{}
	for group, members := range b.Groups {
		for _, actor := range members {
			out[actor] = append(out[actor], group)
		}
	}
	for actor := range out {
		slices.Sort(out[actor])
	}
	return out
}

// groups returns the calling actor's bound groups, computed lazily because
// the gateway and status() reassign s.actor after openService ran.
func (s *service) groups() []string {
	if s.groupsFor != s.actor {
		s.membership = actorGroups(s.b, s.actor)
		s.groupsFor = s.actor
	}
	return s.membership
}
func (s *service) permission(tx *bolt.Tx, id string) string {
	if !identifier.MatchString(id) || tx.Bucket([]byte("pools")).Get([]byte(id)) == nil {
		return ""
	}
	// Listing paths resolve the same pool for every ancestor and every
	// candidate row; the grants index is stable within one invocation, so
	// memoize. reindexCollection clears the cache after a grant change.
	if level, ok := s.perms[s.actor+"\x00"+id]; ok {
		return level
	}
	level := ""
	if s.manager() {
		level = "manage"
	}
	if other := string(tx.Bucket([]byte("by-soot")).Get([]byte(s.actor + "/" + id))); rank(other) > rank(level) {
		level = other
	}
	if other := string(tx.Bucket([]byte("by-group")).Get([]byte("@workspace/" + id))); rank(other) > rank(level) {
		level = other
	}
	for _, group := range s.groups() {
		if other := string(tx.Bucket([]byte("by-group")).Get([]byte(group + "/" + id))); rank(other) > rank(level) {
			level = other
		}
	}
	s.perms[s.actor+"\x00"+id] = level
	return level
}
func principalIndex(tx *bolt.Tx, subject, id string) (*bolt.Bucket, []byte) {
	if strings.HasPrefix(subject, "@group/") {
		return tx.Bucket([]byte("by-group")), []byte(strings.TrimPrefix(subject, "@group/") + "/" + id)
	}
	if subject == workspaceSubject {
		// Pseudo-group covering every bound Soot; its key cannot collide with a
		// real group entry because group IDs never contain '@'.
		return tx.Bucket([]byte("by-group")), []byte("@workspace/" + id)
	}
	return tx.Bucket([]byte("by-soot")), []byte(subject + "/" + id)
}
func (s *service) initializeCollections(tx *bolt.Tx) error {
	c := tx.Bucket([]byte("config"))
	if c.Get([]byte("collections-v1")) != nil {
		return nil
	}
	// One-time, bounded metadata upgrade (maxPools), never a document rewrite.
	if err := tx.Bucket([]byte("pools")).ForEach(func(k, v []byte) error {
		var p pool
		if err := getJSON(tx.Bucket([]byte("pools")), string(k), &p); err != nil {
			return err
		}
		return tx.Bucket([]byte("children")).Put([]byte(p.Parent+"/"+p.ID), nil)
	}); err != nil {
		return err
	}
	cursor := tx.Bucket([]byte("children")).Cursor()
	roots := []string{}
	for k, _ := cursor.Seek([]byte("/")); k != nil && strings.HasPrefix(string(k), "/"); k, _ = cursor.Next() {
		roots = append(roots, strings.TrimPrefix(string(k), "/"))
	}
	for _, id := range roots {
		if err := s.reindexCollection(tx, id, false); err != nil {
			return err
		}
	}
	return c.Put([]byte("collections-v1"), []byte("1"))
}
func (s *service) reindexCollection(tx *bolt.Tx, id string, changed bool) error {
	// Grant changes invalidate what this invocation cached; delete in place so
	// the map identity survives (status() swaps s.actor, never the service).
	for key := range s.perms {
		delete(s.perms, key)
	}
	var p pool
	if err := getJSON(tx.Bucket([]byte("pools")), id, &p); err != nil {
		return err
	}
	old := map[string]string{}
	_ = getJSON(tx.Bucket([]byte("effective")), id, &old)
	for subject := range old {
		b, key := principalIndex(tx, subject, id)
		if err := b.Delete(key); err != nil {
			return err
		}
	}
	effective := map[string]string{}
	if p.Inherit && p.Parent != "" {
		if err := getJSON(tx.Bucket([]byte("effective")), p.Parent, &effective); err != nil {
			return err
		}
	}
	prefix := id + "/"
	cursor := tx.Bucket([]byte("grants")).Cursor()
	for k, v := cursor.Seek([]byte(prefix)); k != nil && strings.HasPrefix(string(k), prefix); k, v = cursor.Next() {
		subject := strings.TrimPrefix(string(k), prefix)
		if rank(string(v)) > rank(effective[subject]) {
			effective[subject] = string(v)
		}
	}
	for subject, level := range effective {
		b, key := principalIndex(tx, subject, id)
		if err := b.Put(key, []byte(level)); err != nil {
			return err
		}
	}
	if err := putJSON(tx.Bucket([]byte("effective")), id, effective); err != nil {
		return err
	}
	children := []string{}
	cursor = tx.Bucket([]byte("children")).Cursor()
	for k, _ := cursor.Seek([]byte(prefix)); k != nil && strings.HasPrefix(string(k), prefix); k, _ = cursor.Next() {
		children = append(children, strings.TrimPrefix(string(k), prefix))
	}
	for _, child := range children {
		if changed {
			var c pool
			if err := getJSON(tx.Bucket([]byte("pools")), child, &c); err != nil {
				return err
			}
			c.PolicyRevision++
			if err := putJSON(tx.Bucket([]byte("pools")), child, c); err != nil {
				return err
			}
		}
		if err := s.reindexCollection(tx, child, changed); err != nil {
			return err
		}
	}
	return nil
}
func (s *service) removeCollectionIndexes(tx *bolt.Tx, id string) error {
	var p pool
	if err := getJSON(tx.Bucket([]byte("pools")), id, &p); err != nil {
		return err
	}
	effective := map[string]string{}
	if err := getJSON(tx.Bucket([]byte("effective")), id, &effective); err != nil {
		return err
	}
	for subject := range effective {
		b, key := principalIndex(tx, subject, id)
		if err := b.Delete(key); err != nil {
			return err
		}
	}
	if err := tx.Bucket([]byte("effective")).Delete([]byte(id)); err != nil {
		return err
	}
	return tx.Bucket([]byte("children")).Delete([]byte(p.Parent + "/" + id))
}
func (s *service) requireLeaf(id string) error {
	return s.db.View(func(tx *bolt.Tx) error {
		k, _ := tx.Bucket([]byte("children")).Cursor().Seek([]byte(id + "/"))
		if k != nil && strings.HasPrefix(string(k), id+"/") {
			return errors.New("collection contains subcollections; move or remove them explicitly first")
		}
		return nil
	})
}
func (s *service) collectionGrantDetails(id string) (map[string]string, map[string]string) {
	groups, inherited := map[string]string{}, map[string]string{}
	_ = s.db.View(func(tx *bolt.Tx) error {
		for group := range s.b.Groups {
			if level := tx.Bucket([]byte("grants")).Get([]byte(id + "/@group/" + group)); len(level) > 0 {
				groups[group] = string(level)
			}
		}
		_ = getJSON(tx.Bucket([]byte("effective")), id, &inherited)
		for subject := range inherited {
			if rank(string(tx.Bucket([]byte("grants")).Get([]byte(id+"/"+subject)))) >= rank(inherited[subject]) {
				delete(inherited, subject)
			}
		}
		return nil
	})
	return groups, inherited
}

// Merge index cursors rather than scanning all collections for each Soot.
func (s *service) collectionPage(in poolsInput, limit int) (any, error) {
	if in.Parent != nil && *in.Parent != "" && !identifier.MatchString(*in.Parent) {
		return nil, errors.New("invalid parent collection")
	}
	items := []collectionSummary{}
	next := ""
	err := s.db.View(func(tx *bolt.Tx) error {
		type stream struct {
			c      *bolt.Cursor
			prefix string
			key    []byte
		}
		streams := []stream{}
		add := func(bucket, prefix string) {
			c := tx.Bucket([]byte(bucket)).Cursor()
			k, _ := c.Seek([]byte(prefix + in.After))
			if k != nil && string(k) == prefix+in.After {
				k, _ = c.Next()
			}
			streams = append(streams, stream{c, prefix, k})
		}
		if in.Parent != nil {
			add("children", *in.Parent+"/")
		} else if s.manager() {
			add("pools", "")
		} else {
			add("by-soot", s.actor+"/")
			// Workspace-scoped collections index under the synthetic
			// "@workspace" group; it is never a named membership.
			add("by-group", "@workspace/")
			for _, g := range s.groups() {
				add("by-group", g+"/")
			}
		}
		for {
			id := ""
			for _, st := range streams {
				if st.key != nil && strings.HasPrefix(string(st.key), st.prefix) {
					candidate := strings.TrimPrefix(string(st.key), st.prefix)
					if id == "" || candidate < id {
						id = candidate
					}
				}
			}
			if id == "" {
				break
			}
			for i := range streams {
				st := &streams[i]
				if st.key != nil && string(st.key) == st.prefix+id {
					st.key, _ = st.c.Next()
				}
			}
			if !s.allowed(tx, id, "read") {
				continue
			}
			if len(items) == limit {
				next = items[len(items)-1].ID
				break
			}
			var p pool
			if err := getJSON(tx.Bucket([]byte("pools")), id, &p); err != nil {
				return err
			}
			items = append(items, collectionSummary{p, s.collectionPath(tx, p.ID)})
		}
		return nil
	})
	return map[string]any{"pools": items, "next": next}, err
}

func (s *service) manageCollection(in manageInput) (any, error) {
	if !identifier.MatchString(in.Pool) || !identifier.MatchString(in.RequestID) {
		return nil, errors.New("invalid collection or request_id")
	}
	if in.Parent != nil && *in.Parent != "" && !identifier.MatchString(*in.Parent) {
		return nil, errors.New("invalid parent collection")
	}
	if !slices.Contains([]string{"pool_create", "pool_update", "grant", "revoke"}, in.Action) {
		return nil, errors.New("invalid collection management action")
	}
	if in.Action == "grant" || in.Action == "revoke" {
		if (in.Soot == "") == (in.Group == "") || in.Parent != nil || in.Inherit != nil || in.Name != "" {
			return nil, errors.New("grant requires one Soot or group")
		}
		// Refused before any mutation, so the reason reaches the caller (a
		// model or Nest) as invalid input; IDs are echoed only when well formed.
		if in.Soot != "" && !identifier.MatchString(in.Soot) || in.Group != "" && in.Group != workspaceSubject && !identifier.MatchString(in.Group) {
			return nil, inputError{"grant target must be a bound Soot or group ID"}
		}
		if in.Group != "" && in.Group != workspaceSubject && len(s.b.Groups[in.Group]) == 0 {
			return nil, inputError{fmt.Sprintf("group %s has no members bound to this data service; list it under groups in the service storage config", in.Group)}
		}
		if in.Soot != "" && slices.Contains(s.b.Managers, in.Soot) {
			return nil, inputError{fmt.Sprintf("%s manages this namespace already; a pool grant cannot change that", in.Soot)}
		}
		// Turning the pool on for a Soot in Nest is the host half; the
		// service must also accept that identity, or every grant fails here.
		if in.Soot != "" && !slices.Contains(s.b.Soots, in.Soot) {
			return nil, inputError{fmt.Sprintf("%s is not bound to this data service; add it to storage.soots (and to the host client's soots) in the service config, restart the service, then grant again", in.Soot)}
		}
		if in.Action == "grant" && rank(in.Level) == 0 || in.Action == "revoke" && in.Level != "" {
			return nil, errors.New("invalid permission")
		}
		// Everyone-may-administer is never one call away: managing stays with
		// named Soots and groups.
		if in.Group == workspaceSubject && in.Level == "manage" {
			return nil, errors.New("workspace grants are limited to read or write")
		}
	}
	if in.Action == "pool_create" || in.Action == "pool_update" {
		if in.Soot != "" || in.Group != "" || in.Action == "pool_create" && strings.TrimSpace(in.Name) == "" || in.Name != "" && (!validText(in.Name, 128) || strings.TrimSpace(in.Name) == "") {
			return nil, errors.New("invalid collection name or fields")
		}
	}
	if in.Action == "pool_create" {
		if in.Scope == "" {
			in.Scope = "own"
		}
		if !slices.Contains([]string{"own", "group", "workspace"}, in.Scope) {
			return nil, errors.New("invalid collection scope")
		}
		if in.Scope == "own" {
			if in.Level != "" || in.Subject != "" {
				return nil, errors.New("own collections carry no level or subject")
			}
		} else {
			// A shared audience starts read-only unless write is asked for;
			// manage is never seeded to a whole group or the workspace.
			if in.Level == "" {
				in.Level = "read"
			}
			if in.Level != "read" && in.Level != "write" {
				return nil, errors.New("collection scope level must be read or write")
			}
		}
		if in.Scope == "group" {
			if len(s.b.Groups[in.Subject]) == 0 {
				return nil, errors.New("collection scope needs a bound group")
			}
		} else if in.Subject != "" {
			return nil, errors.New("scope subject is only valid for group collections")
		}
	} else if in.Action == "pool_update" && (in.Level != "" || in.Scope != "" || in.Subject != "") {
		return nil, errors.New("scope is set at collection creation; use grant or revoke to adjust access")
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if in.Action != "pool_create" {
		if err := s.authorize(in.Pool, "manage"); err != nil {
			return nil, err
		}
		if err := s.checkPolicyRevision(in); err != nil {
			return nil, err
		}
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, Action: in.Action, Fingerprint: fp, Status: "succeeded"}
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("pools"))
		var p pool
		if in.Action == "pool_create" {
			if b.Get([]byte(in.Pool)) != nil {
				return errors.New("collection already exists")
			}
			if b.Sequence() >= maxPools {
				return errors.New("collection limit reached")
			}
			p = pool{ID: in.Pool, Name: in.Name, Generation: rand.Text(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Inherit: true, Scope: in.Scope, Subject: in.Subject}
		} else if err := getJSON(b, in.Pool, &p); err != nil {
			return err
		}
		oldParent := p.Parent
		if in.Name != "" {
			p.Name = in.Name
		}
		if in.Parent != nil {
			p.Parent = *in.Parent
		}
		if in.Inherit != nil {
			p.Inherit = *in.Inherit
		}
		if in.Action == "pool_create" || in.Action == "pool_update" {
			if p.Parent == "" {
				if !s.manager() && (in.Action == "pool_create" || oldParent != "") {
					return errors.New("workspace manager required for root collections")
				}
			} else if (in.Action == "pool_create" || oldParent != p.Parent) && !s.allowed(tx, p.Parent, "manage") {
				return errors.New("parent collection management required")
			}
			for at, depth := p.ID, 0; at != ""; depth++ {
				if depth >= maxCollectionDepth {
					return errors.New("collection cycle or maximum depth exceeded")
				}
				if tx.Bucket([]byte("fences")).Get([]byte(at+"/*")) != nil {
					return errors.New("collection removal is unresolved; inspect its receipt")
				}
				if at == p.ID {
					at = p.Parent
				} else {
					var ancestor pool
					if err := getJSON(b, at, &ancestor); err != nil {
						return err
					}
					at = ancestor.Parent
				}
				if at == p.ID {
					return errors.New("collection cycle")
				}
			}
			// Validate every affected path; at most maxPools metadata records, no content.
			if err := putJSON(b, p.ID, p); err != nil {
				return err
			}
			if err := b.ForEach(func(k, v []byte) error {
				at := string(k)
				seen := map[string]bool{}
				for depth := 0; at != ""; depth++ {
					if depth >= maxCollectionDepth || seen[at] {
						return errors.New("collection cycle or maximum depth exceeded")
					}
					seen[at] = true
					var node pool
					if err := getJSON(b, at, &node); err != nil {
						return errors.New("parent collection unavailable")
					}
					at = node.Parent
				}
				return nil
			}); err != nil {
				return err
			}
			if err := tx.Bucket([]byte("children")).Delete([]byte(oldParent + "/" + p.ID)); err != nil {
				return err
			}
			if err := tx.Bucket([]byte("children")).Put([]byte(p.Parent+"/"+p.ID), nil); err != nil {
				return err
			}
		}
		if in.Action == "pool_create" {
			if err := b.SetSequence(b.Sequence() + 1); err != nil {
				return err
			}
			if _, err := tx.Bucket([]byte("documents")).CreateBucket([]byte(p.ID)); err != nil {
				return err
			}
			if !s.manager() {
				if err := tx.Bucket([]byte("grants")).Put([]byte(p.ID+"/"+s.actor), []byte("manage")); err != nil {
					return err
				}
			}
			// The declared scope is written as ordinary grants so grant/revoke
			// later adjusts the audience without special cases.
			switch in.Scope {
			case "workspace":
				if err := tx.Bucket([]byte("grants")).Put([]byte(p.ID+"/"+workspaceSubject), []byte(in.Level)); err != nil {
					return err
				}
			case "group":
				if err := tx.Bucket([]byte("grants")).Put([]byte(p.ID+"/@group/"+in.Subject), []byte(in.Level)); err != nil {
					return err
				}
			}
		} else {
			p.PolicyRevision++
		}
		if in.Action == "grant" || in.Action == "revoke" {
			subject := in.Soot
			if in.Group == workspaceSubject {
				subject = workspaceSubject
			} else if in.Group != "" {
				subject = "@group/" + in.Group
			}
			// Scope describes how the collection was created; once a manager
			// edits the grant the scope materialized, the stored marker would
			// lie about the current audience, so it is cleared.
			scopeSubject := ""
			switch p.Scope {
			case "workspace":
				scopeSubject = workspaceSubject
			case "group":
				scopeSubject = "@group/" + p.Subject
			}
			if scopeSubject != "" && subject == scopeSubject {
				p.Scope, p.Subject = "own", ""
			}
			key := []byte(p.ID + "/" + subject)
			var err error
			if in.Action == "grant" {
				err = tx.Bucket([]byte("grants")).Put(key, []byte(in.Level))
			} else {
				err = tx.Bucket([]byte("grants")).Delete(key)
			}
			if err != nil {
				return err
			}
		}
		if err := putJSON(b, p.ID, p); err != nil {
			return err
		}
		if err := s.reindexCollection(tx, p.ID, true); err != nil {
			return err
		}
		r.PoolGeneration = p.Generation
		a := activityForReceipt(r)
		a.TargetGroup = in.Group
		a.TargetSoot = in.Soot
		a.Level = in.Level
		if err := appendActivity(tx, a); err != nil {
			return err
		}
		return putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r)
	})
	return r, err
}

type collectionCrumb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *service) collectionPath(tx *bolt.Tx, id string) []collectionCrumb {
	path := []collectionCrumb{}
	for depth := 0; id != "" && depth < maxCollectionDepth; depth++ {
		var p pool
		if getJSON(tx.Bucket([]byte("pools")), id, &p) != nil {
			break
		}
		if s.allowed(tx, id, "read") {
			path = append(path, collectionCrumb{p.ID, p.Name})
		}
		id = p.Parent
	}
	slices.Reverse(path)
	return path
}

type collectionSummary struct {
	pool
	Path []collectionCrumb `json:"path"`
}
