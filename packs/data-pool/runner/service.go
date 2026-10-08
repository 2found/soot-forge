package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
)

type poolsInput struct {
	Pool  string `json:"pool,omitempty"`
	After string `json:"after,omitempty"`
	Limit int    `json:"limit,omitempty"`
}
type queryInput struct {
	Action string `json:"action"`
	Pool   string `json:"pool"`
	ID     string `json:"id,omitempty"`
	Query  string `json:"query,omitempty"`
	After  string `json:"after,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Offset int    `json:"offset,omitempty"`
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

func (s *service) dispatch(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	switch op {
	case "pools":
		var in poolsInput
		if err := decodeStrict(raw, &in); err != nil {
			return nil, err
		}
		return s.pools(in)
	case "query":
		var in queryInput
		if err := decodeStrict(raw, &in); err != nil {
			return nil, err
		}
		result, err := s.query(ctx, in)
		if err == nil {
			err = s.recordQuery(in, result)
		}
		return result, err
	case "write":
		var in writeInput
		if err := decodeStrict(raw, &in); err != nil {
			return nil, err
		}
		return s.write(ctx, in)
	case "manage":
		var in manageInput
		if err := decodeStrict(raw, &in); err != nil {
			return nil, err
		}
		return s.manage(ctx, in)
	case "status":
		var in statusInput
		if err := decodeStrict(raw, &in); err != nil {
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
		return nil, errors.New("invalid pool page")
	}
	if in.Pool != "" {
		if in.After != "" || in.Limit != 0 {
			return nil, errors.New("pool detail does not accept pagination")
		}
		if err = s.authorize(in.Pool, "read"); err != nil {
			return nil, err
		}
		var p pool
		var count uint64
		var level string
		grants := map[string]string{}
		err = s.db.View(func(tx *bolt.Tx) error {
			if err := getJSON(tx.Bucket([]byte("pools")), in.Pool, &p); err != nil {
				return err
			}
			count = docsBucket(tx, in.Pool).Sequence()
			level = string(tx.Bucket([]byte("grants")).Get([]byte(in.Pool + "/" + s.actor)))
			if s.manager() {
				level = "manage"
			}
			if level == "manage" {
				for _, actor := range s.b.Soots {
					permission := string(tx.Bucket([]byte("grants")).Get([]byte(in.Pool + "/" + actor)))
					if slices.Contains(s.b.Managers, actor) {
						permission = "manage"
					}
					if permission != "" {
						grants[actor] = permission
					}
				}
			}
			return nil
		})
		result := map[string]any{"pool": p, "documents": count, "permission": level}
		if level == "manage" {
			result["grants"] = grants
			result["host_managers"] = s.b.Managers
			result["bound_soots"] = s.b.Soots
		}
		return result, err
	}
	items := []pool{}
	next := ""
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("pools"))
		prefix := ""
		if !s.manager() {
			b = tx.Bucket([]byte("by-soot"))
			prefix = s.actor + "/"
		}
		c := b.Cursor()
		start := prefix + in.After
		for k, _ := c.Seek([]byte(start)); k != nil && strings.HasPrefix(string(k), prefix); k, _ = c.Next() {
			id := strings.TrimPrefix(string(k), prefix)
			if id <= in.After {
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
			items = append(items, p)
		}
		return nil
	})
	return map[string]any{"pools": items, "next": next}, err
}

func (s *service) query(ctx context.Context, in queryInput) (any, error) {
	if err := s.authorize(in.Pool, "read"); err != nil {
		return nil, err
	}
	switch in.Action {
	case "list":
		limit, err := pageSize(in.Limit)
		if err != nil || !cursorValid(in.After) || in.ID != "" || in.Query != "" || in.Offset != 0 {
			return nil, errors.New("invalid document page")
		}
		items := []document{}
		next := ""
		err = s.db.View(func(tx *bolt.Tx) error {
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
		if !identifier.MatchString(in.ID) || in.After != "" || in.Query != "" || in.Offset < 0 || in.Offset > maxContent || in.Limit < 0 || in.Limit > 8192 {
			return nil, errors.New("invalid document read")
		}
		if in.Limit == 0 {
			in.Limit = 4096
		}
		meta, err := s.doc(in.Pool, in.ID)
		if err != nil {
			return nil, err
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
		limit, err := pageSize(in.Limit)
		if err != nil || !validText(in.Query, 512) || strings.TrimSpace(in.Query) == "" || in.After != "" || in.ID != "" || in.Offset < 0 || in.Offset > 980 {
			return nil, errors.New("invalid search query or page")
		}
		var result struct {
			Hits []storedDocument `json:"hits"`
		}
		body := map[string]any{"q": normalize(in.Query), "limit": limit, "offset": in.Offset, "attributesToRetrieve": []string{"id", "title", "source", "tags", "sha256", "revision", "updated_at", "content", "writer"}}
		err = s.backend.call(ctx, "POST", "/indexes/"+s.index(in.Pool)+"/search", body, &result)
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
	if !identifier.MatchString(in.Pool) || !identifier.MatchString(in.RequestID) {
		return nil, errors.New("invalid pool or request_id")
	}
	if !slices.Contains([]string{"pool_create", "pool_remove", "grant", "revoke"}, in.Action) {
		return nil, errors.New("invalid management action")
	}
	if in.Action == "pool_create" {
		if !s.manager() {
			return nil, errors.New("access denied")
		}
		if strings.TrimSpace(in.Name) == "" || !validText(in.Name, 128) || in.Soot != "" || in.Level != "" {
			return nil, errors.New("pool_create requires only a name")
		}
	} else {
		if in.Name != "" {
			return nil, errors.New("name is only used when creating a pool")
		}
		if in.Action == "pool_remove" && (in.Soot != "" || in.Level != "") {
			return nil, errors.New("invalid pool_remove fields")
		}
		if in.Action == "grant" || in.Action == "revoke" {
			if slices.Contains(s.b.Managers, in.Soot) {
				return nil, errors.New("host administrator access is configured by the host")
			}
			if !slices.Contains(s.b.Soots, in.Soot) || (in.Action == "grant" && rank(in.Level) == 0) || (in.Action == "revoke" && in.Level != "") {
				return nil, errors.New("target Soot/permission is not allowed by host binding")
			}
		}
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
	if in.Action == "pool_create" {
		r.PoolGeneration = rand.Text()
	} else {
		var err error
		r.PoolGeneration, err = s.poolGeneration(in.Pool)
		if err != nil {
			return nil, err
		}
	}
	if in.Action == "pool_remove" {
		r.Status = "uncertain"
		// A never-populated pool has no index. Its local removal is provable.
		var probe any
		err := s.backend.call(ctx, "GET", "/indexes/"+s.index(in.Pool), nil, &probe)
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
	err := s.db.Update(func(tx *bolt.Tx) error {
		switch in.Action {
		case "pool_create":
			b := tx.Bucket([]byte("pools"))
			if b.Get([]byte(in.Pool)) != nil {
				return errors.New("pool already exists; use its existing ID")
			}
			if b.Sequence() >= maxPools {
				return errors.New("pool limit reached")
			}
			if err := putJSON(b, in.Pool, pool{ID: in.Pool, Name: in.Name, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Generation: r.PoolGeneration}); err != nil {
				return err
			}
			if err := b.SetSequence(b.Sequence() + 1); err != nil {
				return err
			}
			if _, err := tx.Bucket([]byte("documents")).CreateBucket([]byte(in.Pool)); err != nil {
				return err
			}
		case "grant":
			if err := tx.Bucket([]byte("grants")).Put([]byte(in.Pool+"/"+in.Soot), []byte(in.Level)); err != nil {
				return err
			}
			if err := tx.Bucket([]byte("by-soot")).Put([]byte(in.Soot+"/"+in.Pool), []byte(in.Level)); err != nil {
				return err
			}
		case "revoke":
			if err := tx.Bucket([]byte("grants")).Delete([]byte(in.Pool + "/" + in.Soot)); err != nil {
				return err
			}
			if err := tx.Bucket([]byte("by-soot")).Delete([]byte(in.Soot + "/" + in.Pool)); err != nil {
				return err
			}
		}
		if in.Action == "grant" || in.Action == "revoke" {
			var p pool
			if err := getJSON(tx.Bucket([]byte("pools")), in.Pool, &p); err != nil {
				return err
			}
			p.PolicyRevision++
			if err := putJSON(tx.Bucket([]byte("pools")), in.Pool, p); err != nil {
				return err
			}
		}
		event := activityForReceipt(r)
		event.TargetSoot = in.Soot
		event.Level = in.Level
		if err := appendActivity(tx, event); err != nil {
			return err
		}
		return putJSON(tx.Bucket([]byte("receipts")), s.requestKey(in.RequestID), r)
	})
	return r, err
}

func (s *service) write(ctx context.Context, in writeInput) (any, error) {
	if !identifier.MatchString(in.Pool) || !identifier.MatchString(in.ID) || !identifier.MatchString(in.RequestID) || !slices.Contains([]string{"upsert", "remove"}, in.Action) {
		return nil, errors.New("invalid write action, pool, document or request_id")
	}
	if err := s.authorize(in.Pool, "write"); err != nil {
		return nil, err
	}
	if in.Action == "remove" && (in.Title != "" || in.Content != "" || in.Source != "" || in.URL != "" || len(in.Tags) > 0) {
		return nil, errors.New("remove accepts only document identity")
	}
	if in.Action == "upsert" {
		if strings.TrimSpace(in.Title) == "" || !validText(in.Title, 256) || len(in.Tags) > 16 || !validText(in.Content, 12<<10) || (in.Content == "") == (in.URL == "") || !validText(in.Source, 2048) {
			return nil, errors.New("upsert needs a title and exactly one of content or url")
		}
		for _, tag := range in.Tags {
			if strings.TrimSpace(tag) == "" || !validText(tag, 64) {
				return nil, errors.New("invalid document tag")
			}
		}
		if in.URL != "" && in.Source != "" {
			return nil, errors.New("URL imports use the fetched URL as source")
		}
		if in.Source != "" {
			u, err := url.Parse(in.Source)
			if err != nil || u.Scheme == "" || u.User != nil {
				return nil, errors.New("source must be a URI without credentials")
			}
		}
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if err := s.db.View(func(tx *bolt.Tx) error { return ensureUnfenced(tx, in.Pool, in.ID) }); err != nil {
		return nil, err
	}
	old, oldErr := s.doc(in.Pool, in.ID)
	if err := s.checkDocumentRevision(in, old); err != nil {
		return nil, err
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, Action: in.Action, Fingerprint: fp, Status: "uncertain"}
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
		return nil, errors.New("document content is empty, malformed or too large")
	}
	if source == "" {
		source = "soot://" + s.b.Namespace + "/" + in.Pool + "/" + in.ID
	}
	meta := document{ID: in.ID, Title: in.Title, Source: source, Tags: in.Tags, SHA256: hash(content), Revision: old.Revision + 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), Writer: s.actorReference()}
	if oldErr == nil && old.SHA256 == meta.SHA256 && old.Title == meta.Title && old.Source == meta.Source && slices.Equal(old.Tags, meta.Tags) {
		r.Document = &old
		r.Status = "succeeded"
		return r, s.db.Update(func(tx *bolt.Tx) error {
			if err := putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r); err != nil {
				return err
			}
			return appendActivity(tx, activityForReceipt(r))
		})
	}
	r.Document = &meta
	r.NewDocument = oldErr != nil
	d := storedDocument{document: meta, Content: content, TitleNorm: normalize(in.Title), ContentNorm: normalize(content), Receipt: receiptToken(s, r)}
	return s.submit(ctx, r, "POST", "/indexes/"+s.index(in.Pool)+"/documents?primaryKey=id", []storedDocument{d})
}

func (s *service) status(ctx context.Context, in statusInput) (any, error) {
	if !identifier.MatchString(in.RequestID) || in.Owner != "" && !identifier.MatchString(in.Owner) {
		return nil, errors.New("invalid request status identity")
	}
	owner := in.Owner
	if owner == "" {
		owner = s.actor
	}
	var r receipt
	if err := s.db.View(func(tx *bolt.Tx) error { return getJSON(tx.Bucket([]byte("receipts")), owner+"/"+in.RequestID, &r) }); err != nil {
		return nil, errors.New("request unavailable")
	}
	if r.Owner != owner {
		return nil, errors.New("request identity mismatch")
	}
	level := "read"
	if owner != s.actor {
		level = "manage"
	}
	if err := s.authorizeReceipt(r, level); err != nil {
		return nil, errors.New("request unavailable")
	}
	// Reconciliation keeps the original owner's receipt key, even when an
	// explicitly authorized pool manager checks a revoked writer's request.
	actor := s.actor
	s.actor = owner
	defer func() { s.actor = actor }()
	return s.reconcile(ctx, r)
}
