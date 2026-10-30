package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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
			if !contains(b.Soots, actor) || seen[actor] {
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
		if !contains(b.Soots, actor) || !identifier.MatchString(id) {
			return errors.New("invalid default collection binding")
		}
	}
	return nil
}

// actorGroups lists the bound groups containing actor. Only the calling
// actor's list is ever consulted, so build just that one.
func actorGroups(b binding, actor string) []string {
	out := []string{}
	for group, members := range b.Groups {
		if contains(members, actor) {
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

const poolColumns = `id, name, created_at, generation, policy_revision, parent, inherit, scope, subject`

func scanPool(row pgx.Row) (pool, error) {
	var p pool
	var created time.Time
	err := row.Scan(&p.ID, &p.Name, &created, &p.Generation, &p.PolicyRevision, &p.Parent, &p.Inherit, &p.Scope, &p.Subject)
	p.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return p, err
}

func (s *service) poolByID(ctx context.Context, tx pgx.Tx, id string) (pool, error) {
	return scanPool(tx.QueryRow(ctx, `SELECT `+poolColumns+` FROM `+databaseSchema+`.pools WHERE id = $1`, id))
}

// bumpDescendants invalidates the policy revision of every nested collection,
// so a concurrent editor holding the old revision gets a conflict.
func bumpDescendants(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `
		WITH RECURSIVE kids AS (
			SELECT id FROM `+databaseSchema+`.pools WHERE parent = $1
			UNION ALL
			SELECT p.id FROM `+databaseSchema+`.pools p JOIN kids k ON p.parent = k.id
		)
		UPDATE `+databaseSchema+`.pools SET policy_revision = policy_revision + 1 WHERE id IN (SELECT id FROM kids)`, id)
	return err
}

func (s *service) requireLeaf(ctx context.Context, id string) error {
	return s.db.view(ctx, func(tx pgx.Tx) error {
		var nested bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+databaseSchema+`.pools WHERE parent = $1)`, id).Scan(&nested); err != nil {
			return err
		}
		if nested {
			return errors.New("collection contains subcollections; move or remove them explicitly first")
		}
		return nil
	})
}

// grantMap reads the collection's own grants.
func grantMap(ctx context.Context, tx pgx.Tx, id string) (map[string]string, error) {
	rows, err := tx.Query(ctx, `SELECT subject, level FROM `+databaseSchema+`.grants WHERE pool_id = $1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var subject, level string
		if err := rows.Scan(&subject, &level); err != nil {
			return nil, err
		}
		out[subject] = level
	}
	return out, rows.Err()
}

func (s *service) collectionGrantDetails(ctx context.Context, id string) (map[string]string, map[string]string) {
	groups, inherited := map[string]string{}, map[string]string{}
	_ = s.db.view(ctx, func(tx pgx.Tx) error {
		own, err := grantMap(ctx, tx, id)
		if err != nil {
			return err
		}
		for group := range s.b.Groups {
			if level := own["@group/"+group]; level != "" {
				groups[group] = level
			}
		}
		rows, err := tx.Query(ctx, `
			WITH RECURSIVE chain AS (
				SELECT id, parent, inherit FROM `+databaseSchema+`.pools WHERE id = $1
				UNION ALL
				SELECT p.id, p.parent, p.inherit FROM `+databaseSchema+`.pools p
				JOIN chain c ON p.id = c.parent
				WHERE c.inherit AND c.parent <> ''
			)
			SELECT g.subject, g.level FROM `+databaseSchema+`.grants g JOIN chain c ON c.id = g.pool_id`, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		resolved := map[string]string{}
		for rows.Next() {
			var subject, level string
			if err := rows.Scan(&subject, &level); err != nil {
				return err
			}
			if rank(level) > rank(resolved[subject]) {
				resolved[subject] = level
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for subject, level := range resolved {
			if rank(own[subject]) < rank(level) {
				inherited[subject] = level
			}
		}
		return nil
	})
	return groups, inherited
}

// collectionPage lists collections by ID cursor. Managers see every
// collection; other Soots see the ones granted to them, their groups or the
// workspace, including through inheriting ancestors.
func (s *service) collectionPage(ctx context.Context, in poolsInput, limit int) (any, error) {
	if in.Parent != nil && *in.Parent != "" && !identifier.MatchString(*in.Parent) {
		return nil, errors.New("invalid parent collection")
	}
	var parent *string
	if in.Parent != nil {
		parent = in.Parent
	}
	ids := []string{}
	err := s.db.view(ctx, func(tx pgx.Tx) error {
		var rows pgx.Rows
		var err error
		if s.manager() {
			rows, err = tx.Query(ctx, `SELECT id FROM `+databaseSchema+`.pools
				WHERE ($1::text IS NULL OR parent = $1) AND id > $2 ORDER BY id LIMIT $3`, parent, in.After, limit+1)
		} else {
			// The chain resolves every inheriting ancestor once; the grants join
			// keeps only collections this Soot, its groups or the workspace can
			// read, so the page never needs a second pass.
			rows, err = tx.Query(ctx, `
				WITH RECURSIVE chain AS (
					SELECT id AS pool_id, id, parent, inherit FROM `+databaseSchema+`.pools
					UNION ALL
					SELECT c.pool_id, p.id, p.parent, p.inherit FROM `+databaseSchema+`.pools p
					JOIN chain c ON c.parent = p.id
					WHERE c.inherit AND c.parent <> ''
				)
				SELECT DISTINCT c.pool_id FROM chain c
				JOIN `+databaseSchema+`.grants g ON g.pool_id = c.id
				WHERE g.subject = ANY($1) AND c.pool_id > $2
					AND ($3::text IS NULL OR c.pool_id IN (SELECT id FROM `+databaseSchema+`.pools WHERE parent = $3))
				ORDER BY c.pool_id LIMIT $4`, s.subjectList(), in.After, parent, limit+1)
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	next := ""
	if len(ids) > limit {
		ids = ids[:limit]
		next = ids[len(ids)-1]
	}
	items := []collectionSummary{}
	for _, id := range ids {
		p, path, err := s.collectionSummary(ctx, id)
		if err != nil {
			return nil, err
		}
		items = append(items, collectionSummary{p, path})
	}
	return map[string]any{"pools": items, "next": next}, nil
}

// subjectList is the caller plus the pseudo-subjects its membership grants.
func (s *service) subjectList() []string {
	out := []string{s.actor, workspaceSubject}
	for _, group := range s.groups() {
		out = append(out, "@group/"+group)
	}
	return out
}

func (s *service) collectionSummary(ctx context.Context, id string) (pool, []collectionCrumb, error) {
	var p pool
	var path []collectionCrumb
	err := s.db.view(ctx, func(tx pgx.Tx) error {
		var err error
		if p, err = s.poolByID(ctx, tx, id); err != nil {
			return err
		}
		path, err = s.collectionPath(ctx, tx, id)
		return err
	})
	return p, path, err
}

type collectionCrumb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *service) collectionPath(ctx context.Context, tx pgx.Tx, id string) ([]collectionCrumb, error) {
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, name, parent, 0 AS depth FROM `+databaseSchema+`.pools WHERE id = $1
			UNION ALL
			SELECT p.id, p.name, p.parent, c.depth + 1 FROM `+databaseSchema+`.pools p
			JOIN chain c ON p.id = c.parent
			WHERE c.depth < $2
		)
		SELECT id, name, parent FROM chain`, id, maxCollectionDepth)
	if err != nil {
		return nil, err
	}
	nodes := map[string]collectionCrumb{}
	parents := map[string]string{}
	for rows.Next() {
		var crumb collectionCrumb
		var parent string
		if err := rows.Scan(&crumb.ID, &crumb.Name, &parent); err != nil {
			rows.Close()
			return nil, err
		}
		nodes[crumb.ID], parents[crumb.ID] = crumb, parent
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	path := []collectionCrumb{}
	for at, depth := id, 0; at != "" && depth < maxCollectionDepth; depth++ {
		crumb, ok := nodes[at]
		if !ok {
			break
		}
		visible, err := s.allowed(ctx, tx, crumb.ID, "read")
		if err != nil {
			return nil, err
		}
		if visible {
			path = append(path, crumb)
		}
		at = parents[crumb.ID]
	}
	slices.Reverse(path)
	return path, nil
}

type collectionSummary struct {
	pool
	Path []collectionCrumb `json:"path"`
}

func (s *service) manageCollection(ctx context.Context, in manageInput) (any, error) {
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
		if in.Soot != "" && !identifier.MatchString(in.Soot) || in.Group != "" && in.Group != workspaceSubject && !identifier.MatchString(in.Group) {
			return nil, inputError{"grant target must be a bound Soot or group ID"}
		}
		if in.Group != "" && in.Group != workspaceSubject && len(s.b.Groups[in.Group]) == 0 {
			return nil, inputError{fmt.Sprintf("group %s has no members bound to this data service; list it under groups in the service storage config", in.Group)}
		}
		if in.Soot != "" && contains(s.b.Managers, in.Soot) {
			return nil, inputError{fmt.Sprintf("%s manages this namespace already; a pool grant cannot change that", in.Soot)}
		}
		// Turning the pool on for a Soot in Nest is the host half; the
		// service must also accept that identity (config or admission).
		if in.Soot != "" && !contains(s.b.Soots, in.Soot) {
			return nil, inputError{fmt.Sprintf("%s is not admitted to this data service; a pool manager admits it first by turning Kho dữ liệu on for it in Nest, then grant again", in.Soot)}
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
	if r, exists, err := s.replay(ctx, in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if in.Action != "pool_create" {
		if err := s.authorize(ctx, in.Pool, "manage"); err != nil {
			return nil, err
		}
		if err := s.checkPolicyRevision(ctx, in); err != nil {
			return nil, err
		}
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, Action: in.Action, Fingerprint: fp, Status: "succeeded"}
	err := s.db.update(ctx, func(tx pgx.Tx) error {
		var p pool
		if in.Action == "pool_create" {
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+databaseSchema+`.pools`).Scan(&count); err != nil {
				return err
			}
			if count >= maxPools {
				return errors.New("collection limit reached")
			}
			p = pool{ID: in.Pool, Name: in.Name, Generation: rand.Text(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Inherit: true, Scope: in.Scope, Subject: in.Subject}
			if in.Parent != nil {
				p.Parent = *in.Parent
			}
			if in.Inherit != nil {
				p.Inherit = *in.Inherit
			}
			if p.Parent == "" && !s.manager() {
				return errors.New("workspace manager required for root collections")
			}
			if p.Parent != "" {
				ok, err := s.allowed(ctx, tx, p.Parent, "manage")
				if err != nil {
					return err
				}
				if !ok {
					return errors.New("parent collection management required")
				}
			}
			_, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.pools (id, name, created_at, generation, parent, inherit, scope, subject)
				VALUES ($1,$2,now(),$3,$4,$5,$6,$7)`, p.ID, p.Name, p.Generation, p.Parent, p.Inherit, p.Scope, p.Subject)
			if err != nil {
				return err
			}
			if err := validateTree(ctx, tx); err != nil {
				return err
			}
			if !s.manager() {
				if _, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.grants (pool_id, subject, level) VALUES ($1,$2,'manage')
					ON CONFLICT (pool_id, subject) DO UPDATE SET level = EXCLUDED.level`, p.ID, s.actor); err != nil {
					return err
				}
			}
			// The declared scope is written as ordinary grants so grant/revoke
			// later adjusts the audience without special cases.
			switch in.Scope {
			case "workspace":
				if _, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.grants (pool_id, subject, level) VALUES ($1,$2,$3)`, p.ID, workspaceSubject, in.Level); err != nil {
					return err
				}
			case "group":
				if _, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.grants (pool_id, subject, level) VALUES ($1,$2,$3)`, p.ID, "@group/"+in.Subject, in.Level); err != nil {
					return err
				}
			}
		} else {
			var err error
			if p, err = scanPool(tx.QueryRow(ctx, `SELECT `+poolColumns+` FROM `+databaseSchema+`.pools WHERE id = $1 FOR UPDATE`, in.Pool)); err != nil {
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
			if p.Parent == "" {
				if !s.manager() && (in.Action == "pool_create" || oldParent != "") {
					return errors.New("workspace manager required for root collections")
				}
			} else if in.Action == "pool_create" || oldParent != p.Parent {
				ok, err := s.allowed(ctx, tx, p.Parent, "manage")
				if err != nil {
					return err
				}
				if !ok {
					return errors.New("parent collection management required")
				}
			}
			if in.Action == "pool_update" {
				p.PolicyRevision++
			}
			if _, err := tx.Exec(ctx, `UPDATE `+databaseSchema+`.pools SET name = $2, parent = $3, inherit = $4, policy_revision = $5, scope = $6, subject = $7 WHERE id = $1`,
				p.ID, p.Name, p.Parent, p.Inherit, p.PolicyRevision, p.Scope, p.Subject); err != nil {
				return err
			}
			if err := validateTree(ctx, tx); err != nil {
				return err
			}
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
			if in.Action == "grant" {
				if _, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.grants (pool_id, subject, level) VALUES ($1,$2,$3)
					ON CONFLICT (pool_id, subject) DO UPDATE SET level = EXCLUDED.level`, p.ID, subject, in.Level); err != nil {
					return err
				}
			} else if _, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.grants WHERE pool_id = $1 AND subject = $2`, p.ID, subject); err != nil {
				return err
			}
			p.PolicyRevision++
			if _, err := tx.Exec(ctx, `UPDATE `+databaseSchema+`.pools SET policy_revision = $2, scope = $3, subject = $4 WHERE id = $1`, p.ID, p.PolicyRevision, p.Scope, p.Subject); err != nil {
				return err
			}
		}
		if in.Action != "pool_create" {
			if err := bumpDescendants(ctx, tx, p.ID); err != nil {
				return err
			}
		}
		r.PoolGeneration = p.Generation
		a := activityForReceipt(r)
		a.TargetGroup = in.Group
		a.TargetSoot = in.Soot
		a.Level = in.Level
		if err := appendActivity(ctx, tx, a); err != nil {
			return err
		}
		return s.saveReceipt(ctx, tx, r)
	})
	if err == nil {
		clear(s.perms)
	}
	return r, err
}

// validateTree rejects a cycle or a path deeper than maxCollectionDepth after
// a move; at most maxPools metadata rows, never document content.
func validateTree(ctx context.Context, tx pgx.Tx) error {
	rows, err := tx.Query(ctx, `SELECT id, parent FROM `+databaseSchema+`.pools`)
	if err != nil {
		return err
	}
	defer rows.Close()
	parent := map[string]string{}
	for rows.Next() {
		var id, above string
		if err := rows.Scan(&id, &above); err != nil {
			return err
		}
		parent[id] = above
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id := range parent {
		seen := map[string]bool{}
		for at, depth := id, 0; at != ""; depth++ {
			if depth >= maxCollectionDepth || seen[at] {
				return errors.New("collection cycle or maximum depth exceeded")
			}
			seen[at] = true
			at = parent[at]
		}
	}
	return nil
}
