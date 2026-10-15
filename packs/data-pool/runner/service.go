package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
)

type poolsInput struct {
	Pool   string  `json:"pool,omitempty"`
	After  string  `json:"after,omitempty"`
	Limit  int     `json:"limit,omitempty"`
	Parent *string `json:"parent,omitempty"`
}
type queryInput struct {
	Action       string `json:"action"`
	Pool         string `json:"pool"`
	ID           string `json:"id,omitempty"`
	Query        string `json:"query,omitempty"`
	After        string `json:"after,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Offset       int    `json:"offset,omitempty"`
	Conversation string `json:"conversation_id,omitempty"`
	Run          string `json:"run_id,omitempty"`
}
type manageInput struct {
	Action                 string  `json:"action"`
	Pool                   string  `json:"pool"`
	RequestID              string  `json:"request_id"`
	Name                   string  `json:"name,omitempty"`
	Soot                   string  `json:"soot,omitempty"`
	Level                  string  `json:"level,omitempty"`
	Generation             string  `json:"generation,omitempty"`
	ExpectedPolicyRevision *uint64 `json:"expected_policy_revision,omitempty"`
	Parent                 *string `json:"parent,omitempty"`
	Inherit                *bool   `json:"inherit,omitempty"`
	Group                  string  `json:"group,omitempty"`
	// Scope/Subject are pool_create shortcuts for the matching grant: workspace
	// writes @workspace=level, group writes @group/<subject>=level (level read
	// by default, at most write), own writes the creator =manage (the default).
	Scope   string `json:"scope,omitempty"`
	Subject string `json:"subject,omitempty"`
}
type writeInput struct {
	Action           string   `json:"action"`
	Pool             string   `json:"pool"`
	ID               string   `json:"id"`
	RequestID        string   `json:"request_id"`
	Title            string   `json:"title,omitempty"`
	Content          string   `json:"content,omitempty"`
	Source           string   `json:"source,omitempty"`
	URL              string   `json:"url,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	Generation       string   `json:"generation,omitempty"`
	ExpectedRevision *int     `json:"expected_revision,omitempty"`
}
type statusInput struct {
	RequestID string `json:"request_id"`
	Owner     string `json:"owner,omitempty"`
}

func fingerprint(v any) string { data, _ := json.Marshal(v); return hash(string(data)) }
func pageSize(n int) (int, error) {
	if n == 0 {
		return 10, nil
	}
	if n < 1 || n > 20 {
		return 0, errors.New("limit must be between 1 and 20")
	}
	return n, nil
}
func cursorValid(s string) bool { return s == "" || identifier.MatchString(s) }

// generationShape is what rand.Text gives a collection when it is created.
var generationShape = regexp.MustCompile(`^[A-Z2-7]{26}$`)

// queryShape names the one field a list, read or search got wrong. A refusal
// that lists every rule at once gets repeated back by the model as the cause,
// whichever rule actually failed, and the Soot retries the same input.
// Fields an action has no use for are ignored, not refused: models of every
// tier fill each optional field with a placeholder ("after":"0" on a read,
// "id":"0" on a list), and refusing that only teaches them to loop.
func queryShape(in queryInput) error {
	bad := func(format string, args ...any) error {
		return inputError{in.Action + ": " + fmt.Sprintf(format, args...)}
	}
	switch in.Action {
	case "list", "search":
		if in.Limit < 0 || in.Limit > 20 {
			return bad("limit is %d; use 1 to 20, or omit it for 10", in.Limit)
		}
	case "read":
		if in.ID == "" {
			return bad("id is required; list the collection to find it")
		}
		if !identifier.MatchString(in.ID) {
			return bad("id %q is not a document ID (letters, digits, - and _, up to 64)", in.ID)
		}
		if in.Limit < 0 || in.Limit > 8192 {
			return bad("limit is %d bytes; use 4 to 8192, or omit it for 4096", in.Limit)
		}
		if in.Offset < 0 || in.Offset > maxContent {
			return bad("offset is %d; start at 0 and pass next_offset from the previous read", in.Offset)
		}
	}
	switch in.Action {
	case "list":
		if in.Query != "" {
			return bad("query belongs to action search")
		}
		if in.Offset != 0 {
			return bad("offset is not used; page with after set to the previous next")
		}
		if !cursorValid(in.After) {
			return bad("after %q is not a document ID; pass next from the previous page", in.After)
		}
	case "search":
		if strings.TrimSpace(in.Query) == "" || !validText(in.Query, 512) {
			return bad("query is required, up to 512 characters")
		}
		if in.Offset < 0 || in.Offset > 980 {
			return bad("offset is %d; use 0 to 980", in.Offset)
		}
	}
	return nil
}

func (s *service) dispatch(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	switch op {
	case "pools":
		var in poolsInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		return s.pools(in)
	case "query":
		var in queryInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		result, err := s.query(ctx, in)
		if err == nil && in.Action != "references" {
			err = s.recordQuery(in, result)
		}
		return result, err
	case "write":
		var in writeInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		if in.Pool == "" {
			in.Pool = s.b.Defaults[s.actor]
		}
		return s.write(ctx, in)
	case "manage":
		var in manageInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		return s.manage(ctx, in)
	case "status":
		var in statusInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		return s.status(ctx, in)
	case "view", "action":
		if !s.human || !s.manager() {
			return nil, errors.New("human configuration access required")
		}
		if op == "view" {
			return s.view(ctx, raw)
		}
		return s.action(ctx, raw)
	}
	return nil, errors.New("unsupported operation")
}

func (s *service) pools(in poolsInput) (any, error) {
	limit, err := pageSize(in.Limit)
	if err != nil || !cursorValid(in.After) {
		return nil, inputError{"invalid pool page: limit is 1..20 and after must be a returned cursor"}
	}
	if in.Pool != "" {
		// after and limit page the collection list; a detail has no pages, so
		// placeholders a model filled in ("after":"0","limit":20) are ignored.
		if err = s.authorize(in.Pool, "read"); err != nil {
			return nil, err
		}
		var p pool
		var count uint64
		var level string
		grants := map[string]string{}
		effective := map[string]string{}
		effectiveGroups := map[string]string{}
		var path []collectionCrumb
		err = s.db.View(func(tx *bolt.Tx) error {
			if err := getJSON(tx.Bucket([]byte("pools")), in.Pool, &p); err != nil {
				return err
			}
			count = docsBucket(tx, in.Pool).Sequence()
			path = s.collectionPath(tx, in.Pool)
			level = s.permission(tx, in.Pool)
			if s.manager() {
				level = "manage"
			}
			if level == "manage" {
				for group := range s.b.Groups {
					effectiveGroups[group] = string(tx.Bucket([]byte("by-group")).Get([]byte(group + "/" + in.Pool)))
				}
				// The 'effective' bucket already stores this collection's
				// resolved subject→level map (inheritance included); expand it
				// instead of re-running permission() per bound Soot.
				resolved := map[string]string{}
				if err := getJSON(tx.Bucket([]byte("effective")), in.Pool, &resolved); err != nil {
					return err
				}
				all := groupMembership(s.b)
				for _, actor := range s.b.Soots {
					level := resolved[actor]
					if other := resolved[workspaceSubject]; rank(other) > rank(level) {
						level = other
					}
					for _, g := range all[actor] {
						if other := resolved["@group/"+g]; rank(other) > rank(level) {
							level = other
						}
					}
					if slices.Contains(s.b.Managers, actor) {
						level = "manage"
					}
					effective[actor] = level
					permission := string(tx.Bucket([]byte("grants")).Get([]byte(in.Pool + "/" + actor)))
					if slices.Contains(s.b.Managers, actor) {
						permission = "manage"
					}
					if permission != "" {
						grants[actor] = permission
					}
				}
				// The workspace subject is a grant like any Soot's: visible here,
				// revocable with group "@workspace".
				if level := string(tx.Bucket([]byte("grants")).Get([]byte(in.Pool + "/" + workspaceSubject))); level != "" {
					grants[workspaceSubject] = level
				}
			}
			return nil
		})
		result := map[string]any{"pool": p, "documents": count, "permission": level, "path": path}
		if level == "manage" {
			result["grants"] = grants
			result["effective_permissions"] = effective
			result["effective_group_grants"] = effectiveGroups
			result["host_managers"] = s.b.Managers
			result["bound_soots"] = s.b.Soots
			result["groups"] = s.b.Groups
			result["group_grants"], result["inherited_grants"] = s.collectionGrantDetails(in.Pool)
		}
		return result, err
	}
	return s.collectionPage(in, limit)

}

func (s *service) query(ctx context.Context, in queryInput) (any, error) {
	if in.Action == "references" {
		return s.references(in)
	}
	if in.Conversation != "" || in.Run != "" {
		return nil, errors.New("correlation filters require references action")
	}
	if err := s.authorize(in.Pool, "read"); err != nil {
		return nil, err
	}
	switch in.Action {
	case "list":
		if err := queryShape(in); err != nil {
			return nil, err
		}
		limit, _ := pageSize(in.Limit)
		items := []document{}
		next := ""
		err := s.db.View(func(tx *bolt.Tx) error {
			c := docsBucket(tx, in.Pool).Cursor()
			for k, v := c.Seek([]byte(in.After)); k != nil; k, v = c.Next() {
				if string(k) <= in.After {
					continue
				}
				if len(items) == limit {
					next = items[len(items)-1].ID
					break
				}
				var d document
				if err := json.Unmarshal(v, &d); err != nil {
					return err
				}
				items = append(items, d)
			}
			return nil
		})
		return map[string]any{"documents": items, "next": next}, err
	case "read":
		if err := queryShape(in); err != nil {
			return nil, err
		}
		if in.Limit == 0 {
			in.Limit = 4096
		}
		meta, err := s.doc(in.Pool, in.ID)
		if err != nil {
			// Read access is already checked, so absence is not a leak.
			return nil, inputError{fmt.Sprintf("document %s is not in collection %s; list the collection to find it, or create it with an upsert that omits expected_revision", in.ID, in.Pool)}
		}
		var d storedDocument
		if err = s.backend.call(ctx, "GET", "/indexes/"+s.index(in.Pool)+"/documents/"+in.ID, nil, &d); err != nil {
			return nil, err
		}
		if !sameDocument(meta, d.document) || hash(d.Content) != meta.SHA256 || !validText(d.Content, maxContent) {
			return nil, errors.New("document is changing or backend integrity check failed; inspect its request status")
		}
		if in.Offset > len(d.Content) || in.Offset < len(d.Content) && !utf8.RuneStart(d.Content[in.Offset]) {
			return nil, errors.New("offset must be a valid UTF-8 content boundary")
		}
		end := min(len(d.Content), in.Offset+in.Limit)
		for end < len(d.Content) && end > in.Offset && !utf8.RuneStart(d.Content[end]) {
			end--
		}
		if end == in.Offset && end < len(d.Content) {
			return nil, errors.New("read limit must fit the next UTF-8 character; use at least 4 bytes")
		}
		return map[string]any{"document": meta, "content": d.Content[in.Offset:end], "next_offset": end, "complete": end == len(d.Content)}, nil
	case "search":
		if err := queryShape(in); err != nil {
			return nil, err
		}
		limit, _ := pageSize(in.Limit)
		var result struct {
			Hits []storedDocument `json:"hits"`
		}
		body := map[string]any{"q": normalize(in.Query), "limit": limit, "offset": in.Offset, "attributesToRetrieve": []string{"id", "title", "source", "tags", "sha256", "revision", "updated_at", "content", "writer"}}
		err := s.backend.call(ctx, "POST", "/indexes/"+s.index(in.Pool)+"/search", body, &result)
		var be backendError
		if errors.As(err, &be) && be.status == 404 {
			var count uint64
			s.db.View(func(tx *bolt.Tx) error { count = docsBucket(tx, in.Pool).Sequence(); return nil })
			if count == 0 {
				return map[string]any{"hits": []any{}, "next_offset": 0}, nil
			}
		}
		if err != nil {
			return nil, err
		}
		hits := []any{}
		for _, d := range result.Hits[:min(limit, len(result.Hits))] {
			meta, err := s.doc(in.Pool, d.ID)
			if err != nil || !sameDocument(meta, d.document) || !validText(d.Content, maxContent) || hash(d.Content) != meta.SHA256 {
				continue
			}
			end := min(len(d.Content), 768)
			for end < len(d.Content) && end > 0 && !utf8.RuneStart(d.Content[end]) {
				end--
			}
			hits = append(hits, map[string]any{"document": meta, "snippet": d.Content[:end]})
		}
		next := 0
		if len(result.Hits) >= limit && in.Offset+limit <= 980 {
			next = in.Offset + limit
		}
		return map[string]any{"hits": hits, "next_offset": next}, nil
	}
	return nil, errors.New("query action must be list, read or search")
}

func (s *service) manage(ctx context.Context, in manageInput) (any, error) {
	if in.Action != "pool_remove" {
		return s.manageCollection(in)
	}
	if !identifier.MatchString(in.Pool) || !identifier.MatchString(in.RequestID) || in.Parent != nil || in.Inherit != nil || in.Name != "" || in.Soot != "" || in.Group != "" || in.Level != "" {
		return nil, errors.New("invalid collection removal")
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if err := s.authorize(in.Pool, "manage"); err != nil {
		return nil, err
	}
	if err := s.checkPolicyRevision(in); err != nil {
		return nil, err
	}
	if err := s.requireLeaf(in.Pool); err != nil {
		return nil, err
	}
	generation, err := s.poolGeneration(in.Pool)
	if err != nil {
		return nil, err
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, PoolGeneration: generation, Action: in.Action, Fingerprint: fp, Status: "uncertain"}
	var probe any
	err = s.backend.call(ctx, "GET", "/indexes/"+s.index(in.Pool), nil, &probe)
	var be backendError
	if errors.As(err, &be) && be.status == 404 {
		if err := s.begin(r); err != nil {
			return nil, err
		}
		return s.finish(r, "succeeded")
	}
	if err != nil {
		return nil, err
	}
	return s.submit(ctx, r, "DELETE", "/indexes/"+s.index(in.Pool), nil)
}

// writeShape names the one field a write got wrong, as queryShape does for
// reads: "invalid action, pool, document or request_id" sent a Soot to list
// pools when its document ID was the problem.
func writeShape(in writeInput) error {
	bad := func(field, format string, args ...any) error {
		return fieldError{field, inputError{in.Action + ": " + fmt.Sprintf(format, args...)}}
	}
	switch {
	case !slices.Contains([]string{"upsert", "append", "remove"}, in.Action):
		return fieldError{"action", inputError{fmt.Sprintf("action %q is not upsert, append or remove", in.Action)}}
	case in.Pool == "":
		return bad("pool", "pool is required; list collections with data-pool_pools")
	case !identifier.MatchString(in.Pool):
		return bad("pool", "pool %q is not a collection ID; copy one from data-pool_pools", in.Pool)
	case in.ID == "":
		return bad("id", "id is required; choose a stable document ID such as note-2026-10-15")
	case !identifier.MatchString(in.ID):
		return bad("id", "id %q is not a document ID (letters, digits, - and _, up to 64)", in.ID)
	case in.RequestID == "":
		return bad("request_id", "request_id is required; one per intent, e.g. the id plus -1")
	case !identifier.MatchString(in.RequestID):
		return bad("request_id", "request_id %q is not an ID (letters, digits, - and _, up to 64)", in.RequestID)
	}
	if in.Action == "remove" {
		if in.Title != "" || in.Content != "" || in.Source != "" || in.URL != "" || len(in.Tags) > 0 {
			return bad("content", "remove accepts only document identity")
		}
		return nil
	}
	switch {
	case (in.Content == "") == (in.URL == ""):
		return bad("content", "content is required, or an import url instead")
	case !validText(in.Content, 12<<10):
		return bad("content", "content must be UTF-8 text under 12 KiB (this is %d bytes); split it into several documents", len(in.Content))
	case strings.TrimSpace(in.Title) == "" || !validText(in.Title, 256):
		return bad("title", "title must be text")
	case len(in.Tags) > 16:
		return bad("tags", "%d tags; use at most 16", len(in.Tags))
	case !validText(in.Source, 2048):
		return bad("source", "source is over 2048 bytes")
	case in.URL != "" && in.Source != "":
		return bad("source", "URL imports use the fetched URL as source; omit source")
	}
	for _, tag := range in.Tags {
		if strings.TrimSpace(tag) == "" || !validText(tag, 64) {
			return bad("tags", "tag %q is empty or over 64 bytes", tag)
		}
	}
	if in.Source != "" {
		if u, err := url.Parse(in.Source); err != nil || u.Scheme == "" || u.User != nil {
			return bad("source", "source must be a URI without credentials")
		}
	}
	return nil
}

func (s *service) write(ctx context.Context, in writeInput) (any, error) {
	// Duplicate content is allowed across append intents; retrying one intent
	// preserves its generated ID and cannot overwrite another document.
	// Smaller models fill every optional field. Values that cannot be what the
	// field means are placeholders, dropped before the fingerprint so a retry
	// replays: a generation is only ever copied from data-pool_pools, and a
	// source is provenance only as a URI ("operator probe" is neither). A
	// well-formed stale generation, or a URI carrying credentials, still refuses.
	if in.Generation != "" && !generationShape.MatchString(in.Generation) {
		in.Generation = ""
	}
	if in.Source != "" {
		if u, err := url.Parse(in.Source); err != nil || u.Scheme == "" {
			in.Source = ""
		}
	}
	if in.Action == "append" {
		if in.ExpectedRevision != nil && *in.ExpectedRevision == 0 {
			in.ExpectedRevision = nil // a filled-in placeholder, not a precondition
		}
		if in.ID != "" || in.ExpectedRevision != nil {
			return nil, inputError{"append chooses its own document ID and does not accept expected_revision"}
		}
		in.ID = appendID(s.actor, in.RequestID)
	}

	// Inline text wins over an accidentally repeated import URL. Treat the URL
	// as provenance, without fetching; contradictory provenance is still refused.
	if in.Content != "" && in.URL != "" {
		if in.Source != "" && in.Source != in.URL {
			return nil, inputError{"content source and url disagree; supply one provenance URL"}
		}
		in.Source, in.URL = in.URL, ""
	}
	if in.Action != "remove" && strings.TrimSpace(in.Title) == "" {
		in.Title = in.Source
		if in.Title == "" {
			in.Title = in.URL
		}
		if in.Title == "" {
			in.Title = in.ID
		}
		for len(in.Title) > 256 {
			_, size := utf8.DecodeLastRuneInString(in.Title)
			in.Title = in.Title[:len(in.Title)-size]
		}
	}
	if in.Pool == "" {
		// No default for this Soot: name the collections it may write, so the
		// next call can succeed without a detour through data-pool_pools.
		var writable []string
		s.db.View(func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("pools")).ForEach(func(k, _ []byte) error {
				if len(writable) < 8 && s.allowed(tx, string(k), "write") {
					writable = append(writable, string(k))
				}
				return nil
			})
		})
		if len(writable) == 0 {
			return nil, fieldError{"pool", inputError{in.Action + ": pool is required, and this Soot may write to no collection; ask the operator to grant one"}}
		}
		return nil, fieldError{"pool", inputError{in.Action + ": pool is required (this Soot has no default); it may write to: " + strings.Join(writable, ", ")}}
	}
	if err := writeShape(in); err != nil {
		return nil, err
	}
	if err := s.authorize(in.Pool, "write"); err != nil {
		return nil, err
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if err := s.db.View(func(tx *bolt.Tx) error { return ensureUnfenced(tx, in.Pool, in.ID) }); err != nil {
		return nil, err
	}
	old, oldErr := s.doc(in.Pool, in.ID)
	if oldErr != nil && in.Action == "upsert" && in.ExpectedRevision != nil && *in.ExpectedRevision != 0 {
		return nil, inputError{fmt.Sprintf("document %s does not exist yet; omit expected_revision to create it", in.ID)}
	}
	if err := s.checkDocumentRevision(in, old); err != nil {
		return nil, err
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, Action: in.Action, Fingerprint: fp, Status: "uncertain", Origin: s.origin}
	var err error
	r.PoolGeneration, err = s.poolGeneration(in.Pool)
	if err != nil {
		return nil, err
	}
	if in.Action == "remove" {
		if oldErr != nil {
			return nil, oldErr
		}
		r.Document = &old
		return s.submit(ctx, r, "DELETE", "/indexes/"+s.index(in.Pool)+"/documents/"+in.ID, nil)
	}
	content := in.Content
	source := in.Source
	if in.URL != "" {
		if _, err := publicURL(in.URL); err != nil {
			return nil, err
		}
		var err error
		if s.fetch != nil {
			content, err = s.fetch(in.URL)
		} else {
			content, err = fetchPage(ctx, in.URL)
		}
		if err != nil {
			return nil, err
		}
		source = in.URL
	}
	if !validText(content, maxContent) || strings.TrimSpace(content) == "" {
		return nil, inputError{"document content is empty, not UTF-8 text, or over 128 KiB; shorten or split it"}
	}
	if source == "" {
		source = "soot://" + s.b.Namespace + "/" + in.Pool + "/" + in.ID
	}
	meta := document{ID: in.ID, Title: in.Title, Source: source, Tags: in.Tags, SHA256: hash(content), Revision: old.Revision + 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), Writer: s.actorReference(), Origin: s.origin}
	if oldErr == nil && old.SHA256 == meta.SHA256 && old.Title == meta.Title && old.Source == meta.Source && slices.Equal(old.Tags, meta.Tags) {
		r.Document = &old
		r.Status = "succeeded"
		return r, s.db.Update(func(tx *bolt.Tx) error {
			if err := putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r); err != nil {
				return err
			}
			if err := appendActivity(tx, activityForReceipt(r)); err != nil {
				return err
			}
			return appendReference(tx, r.Origin, r.Pool, r.PoolGeneration, r.Action, r.Document)
		})
	}
	r.Document = &meta
	r.NewDocument = oldErr != nil
	d := storedDocument{document: meta, Content: content, TitleNorm: normalize(in.Title), ContentNorm: normalize(content), Receipt: receiptToken(s, r)}
	return s.submit(ctx, r, "POST", "/indexes/"+s.index(in.Pool)+"/documents?primaryKey=id", []storedDocument{d})
}

func (s *service) status(ctx context.Context, in statusInput) (any, error) {
	if !identifier.MatchString(in.RequestID) || in.Owner != "" && !identifier.MatchString(in.Owner) {
		return nil, inputError{"status needs the request_id the write or manage call returned"}
	}
	owner := in.Owner
	if owner == "" {
		owner = s.actor
	}
	// One answer for missing, someone else's and no-longer-granted, so it is no
	// existence oracle, but actionable: status is a read and changed nothing.
	unavailable := inputError{"request " + safeID(in.RequestID) + " is not visible to this Soot (never submitted by it, submitted by another Soot, or its collection is no longer granted); status only checks a request_id that your own data-pool_write or data-pool_manage call returned. Nothing was changed; to inspect data, read or list the collection instead"}
	var r receipt
	if err := s.db.View(func(tx *bolt.Tx) error { return getJSON(tx.Bucket([]byte("receipts")), owner+"/"+in.RequestID, &r) }); err != nil {
		return nil, unavailable
	}
	if r.Owner != owner {
		return nil, unavailable
	}
	level := "read"
	if owner != s.actor {
		level = "manage"
	}
	if err := s.authorizeReceipt(r, level); err != nil {
		return nil, unavailable
	}
	// Reconciliation keeps the original owner's receipt key, even when an
	// explicitly authorized pool manager checks a revoked writer's request.
	actor := s.actor
	s.actor = owner
	defer func() { s.actor = actor }()
	return s.reconcile(ctx, r)
}
