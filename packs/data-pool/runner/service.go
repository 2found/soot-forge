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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type poolsInput struct {
	Pool   string  `json:"pool,omitempty"`
	After  string  `json:"after,omitempty"`
	Limit  int     `json:"limit,omitempty"`
	Parent *string `json:"parent,omitempty"`
}
type queryInput struct {
	Action       string   `json:"action"`
	Pool         string   `json:"pool"`
	ID           string   `json:"id,omitempty"`
	IDs          []string `json:"ids,omitempty"`
	Query        string   `json:"query,omitempty"`
	After        string   `json:"after,omitempty"`
	Limit        int      `json:"limit,omitempty"`
	Offset       int      `json:"offset,omitempty"`
	Conversation string   `json:"conversation_id,omitempty"`
	Run          string   `json:"run_id,omitempty"`
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
	// Host is the admit target's machine credential name (admission.go).
	Host string `json:"host,omitempty"`
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

// likeEscaped makes model text a literal LIKE pattern: "%" and "_" lose their
// wildcard meaning, so a query cannot turn into an accidental match-all.
func likeEscaped(text string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text)
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

// A batch read returns several documents in one call, so a digest of a day's
// documents is one list and one read instead of a call per document. Its
// content shares one byte budget so the page fits the tool's output bound.
const (
	maxBatchRead      = 8
	batchContentBytes = 48 << 10
)

// readTargets is id followed by ids, without blanks or repeats. A model may put
// the first document in id and the rest in ids, or fill ids with a placeholder.
func readTargets(in queryInput) []string {
	targets := []string{}
	for _, id := range append([]string{in.ID}, in.IDs...) {
		if id != "" && !slices.Contains(targets, id) {
			targets = append(targets, id)
		}
	}
	return targets
}

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
		targets := readTargets(in)
		if len(targets) == 0 {
			return bad("id is required; list the collection to find it")
		}
		if len(targets) > maxBatchRead {
			return bad("ids names %d documents; read at most %d per call", len(targets), maxBatchRead)
		}
		for _, id := range targets {
			if !identifier.MatchString(id) {
				return bad("id %q is not a document ID (letters, digits, - and _, up to 64)", id)
			}
		}
		if len(targets) > 1 && in.Offset != 0 {
			return bad("offset continues one document; read it alone with id and that offset")
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
		return s.pools(ctx, in)
	case "query":
		var in queryInput
		if err := decodeInput(raw, &in); err != nil {
			return nil, err
		}
		result, err := s.query(ctx, in)
		if err == nil && in.Action != "references" {
			err = s.recordQuery(ctx, in, result)
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

func (s *service) pools(ctx context.Context, in poolsInput) (any, error) {
	limit, err := pageSize(in.Limit)
	if err != nil || !cursorValid(in.After) {
		return nil, inputError{"invalid pool page: limit is 1..20 and after must be a returned cursor"}
	}
	if in.Pool != "" {
		// after and limit page the collection list; a detail has no pages, so
		// placeholders a model filled in ("after":"0","limit":20) are ignored.
		if err = s.authorize(ctx, in.Pool, "read"); err != nil {
			return nil, err
		}
		var p pool
		var count int
		var level string
		grants := map[string]string{}
		effective := map[string]string{}
		effectiveGroups := map[string]string{}
		var path []collectionCrumb
		err = s.db.view(ctx, func(tx pgx.Tx) error {
			var e error
			if p, e = s.poolByID(ctx, tx, in.Pool); e != nil {
				return e
			}
			if e = tx.QueryRow(ctx, `SELECT count(*) FROM `+databaseSchema+`.documents WHERE pool_id = $1`, in.Pool).Scan(&count); e != nil {
				return e
			}
			if path, e = s.collectionPath(ctx, tx, in.Pool); e != nil {
				return e
			}
			if level, e = s.permission(ctx, tx, in.Pool); e != nil {
				return e
			}
			if s.manager() {
				level = "manage"
			}
			if level != "manage" {
				return nil
			}
			own, e := grantMap(ctx, tx, in.Pool)
			if e != nil {
				return e
			}
			resolved, e := resolvedGrants(ctx, tx, in.Pool)
			if e != nil {
				return e
			}
			for group := range s.b.Groups {
				effectiveGroups[group] = forSubject(resolved, "@group/"+group)
			}
			all := groupMembership(s.b)
			for _, actor := range s.b.Soots {
				level := forSubject(resolved, actor)
				if other := forSubject(resolved, workspaceSubject); rank(other) > rank(level) {
					level = other
				}
				for _, g := range all[actor] {
					if other := forSubject(resolved, "@group/"+g); rank(other) > rank(level) {
						level = other
					}
				}
				if contains(s.b.Managers, actor) {
					level = "manage"
				}
				effective[actor] = level
				permission := own[actor]
				if contains(s.b.Managers, actor) {
					permission = "manage"
				}
				if permission != "" {
					grants[actor] = permission
				}
			}
			// The workspace subject is a grant like any Soot's: visible here,
			// revocable with group "@workspace".
			if level := own[workspaceSubject]; level != "" {
				grants[workspaceSubject] = level
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
			result["group_grants"], result["inherited_grants"] = s.collectionGrantDetails(ctx, in.Pool)
		}
		return result, err
	}
	return s.collectionPage(ctx, in, limit)
}

// resolvedGrants maps every subject with access through the collection's
// inheriting ancestors to its strongest level.
func resolvedGrants(ctx context.Context, tx pgx.Tx, id string) (map[string]string, error) {
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
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var subject, level string
		if err := rows.Scan(&subject, &level); err != nil {
			return nil, err
		}
		if rank(level) > rank(out[subject]) {
			out[subject] = level
		}
	}
	return out, rows.Err()
}

func forSubject(resolved map[string]string, subject string) string { return resolved[subject] }

func (s *service) query(ctx context.Context, in queryInput) (any, error) {
	if in.Action == "references" {
		return s.references(ctx, in)
	}
	if in.Conversation != "" || in.Run != "" {
		return nil, errors.New("correlation filters require references action")
	}
	if err := s.authorize(ctx, in.Pool, "read"); err != nil {
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
		err := s.db.view(ctx, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `SELECT `+documentMetaColumns+` FROM `+databaseSchema+`.documents
				WHERE pool_id = $1 AND id > $2 ORDER BY id LIMIT $3`, in.Pool, in.After, limit+1)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				d, err := scanMeta(rows)
				if err != nil {
					return err
				}
				items = append(items, d)
			}
			return rows.Err()
		})
		if len(items) > limit {
			items = items[:limit]
			next = items[len(items)-1].ID
		}
		return map[string]any{"documents": items, "next": next}, err
	case "read":
		if err := queryShape(in); err != nil {
			return nil, err
		}
		if in.Limit == 0 {
			in.Limit = 4096
		}
		targets := readTargets(in)
		if len(targets) == 1 {
			page, err := s.readPage(ctx, in.Pool, targets[0], in.Offset, in.Limit)
			if errors.Is(err, errNotInPool) {
				// Read access is already checked, so absence is not a leak.
				return nil, inputError{fmt.Sprintf("document %s is not in collection %s; list the collection to find it, or create it with an upsert that omits expected_revision", targets[0], in.Pool)}
			}
			if errors.Is(err, errChanging) {
				return nil, errors.New("document content failed its integrity check; inspect its request status")
			}
			if err != nil {
				return nil, err
			}
			return map[string]any{"document": page.Document, "content": page.Content, "next_offset": page.NextOffset, "complete": page.Complete}, nil
		}
		limit := min(in.Limit, batchContentBytes/len(targets))
		pages, missing, changing := []readPage{}, []string{}, []string{}
		for _, id := range targets {
			page, err := s.readPage(ctx, in.Pool, id, 0, limit)
			switch {
			case errors.Is(err, errNotInPool):
				missing = append(missing, id)
			case errors.Is(err, errChanging):
				changing = append(changing, id)
			case err != nil:
				return nil, err
			default:
				pages = append(pages, page)
			}
		}
		out := map[string]any{"documents": pages}
		if len(missing) > 0 {
			out["missing"] = missing
		}
		if len(changing) > 0 {
			out["changing"] = changing
		}
		return out, nil
	case "search":
		if err := queryShape(in); err != nil {
			return nil, err
		}
		limit, _ := pageSize(in.Limit)
		terms := strings.TrimSpace(normalize(in.Query))
		pattern := "%" + likeEscaped(terms) + "%"
		hits := []any{}
		err := s.db.view(ctx, func(tx pgx.Tx) error {
			// Trigram indexes serve both the ILIKE substring and the fuzzy
			// `%` match; ranking uses the short title field so the sort does
			// not re-read every matched document body.
			rows, err := tx.Query(ctx, `SELECT `+documentColumns+` FROM `+databaseSchema+`.documents
				WHERE pool_id = $1 AND (title_norm LIKE $2 ESCAPE '\' OR content_norm LIKE $2 ESCAPE '\' OR title_norm % $3 OR content_norm % $3)
				ORDER BY title_norm = $3 DESC, similarity(title_norm, $3) DESC, id
				LIMIT $4 OFFSET $5`, in.Pool, pattern, terms, limit, in.Offset)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				d, err := scanDocument(rows)
				if err != nil {
					return err
				}
				if !validText(d.Content, maxContent) || hash(d.Content) != d.SHA256 {
					continue
				}
				hits = append(hits, map[string]any{"document": d.document, "snippet": snippet(d.Content, in.Query)})
			}
			return rows.Err()
		})
		if err != nil {
			return nil, err
		}
		next := 0
		if len(hits) == limit && in.Offset+limit <= 980 {
			next = in.Offset + limit
		}
		return map[string]any{"hits": hits, "next_offset": next}, nil
	}
	return nil, errors.New("query action must be list, read or search")
}

type readPage struct {
	Document   document `json:"document"`
	Content    string   `json:"content"`
	NextOffset int      `json:"next_offset"`
	Complete   bool     `json:"complete"`
}

var (
	errNotInPool = errors.New("document is not in the collection")
	errChanging  = errors.New("document is changing")
)

// readPage reads limit bytes of a document's verified text from offset.
func (s *service) readPage(ctx context.Context, pool, id string, offset, limit int) (readPage, error) {
	var d storedDocument
	err := s.db.view(ctx, func(tx pgx.Tx) error {
		var err error
		d, err = scanDocument(tx.QueryRow(ctx, `SELECT `+documentColumns+` FROM `+databaseSchema+`.documents WHERE pool_id = $1 AND id = $2`, pool, id))
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return readPage{}, errNotInPool
	}
	if err != nil {
		return readPage{}, err
	}
	if hash(d.Content) != d.SHA256 || !validText(d.Content, maxContent) {
		return readPage{}, errChanging
	}
	if offset > len(d.Content) || offset < len(d.Content) && !utf8.RuneStart(d.Content[offset]) {
		return readPage{}, errors.New("offset must be a valid UTF-8 content boundary")
	}
	end := min(len(d.Content), offset+limit)
	for end < len(d.Content) && end > offset && !utf8.RuneStart(d.Content[end]) {
		end--
	}
	if end == offset && end < len(d.Content) {
		return readPage{}, errors.New("read limit must fit the next UTF-8 character; use at least 4 bytes")
	}
	return readPage{d.document, d.Content[offset:end], end, end == len(d.Content)}, nil
}

func (s *service) manage(ctx context.Context, in manageInput) (any, error) {
	if in.Action == "admit" || in.Action == "dismiss" {
		return s.manageAdmission(ctx, in)
	}
	if in.Action != "pool_remove" {
		return s.manageCollection(ctx, in)
	}
	if !identifier.MatchString(in.Pool) || !identifier.MatchString(in.RequestID) || in.Parent != nil || in.Inherit != nil || in.Name != "" || in.Soot != "" || in.Group != "" || in.Level != "" {
		return nil, errors.New("invalid collection removal")
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(ctx, in.RequestID, fp); exists || err != nil {
		return r, err
	}
	if err := s.authorize(ctx, in.Pool, "manage"); err != nil {
		return nil, err
	}
	if err := s.checkPolicyRevision(ctx, in); err != nil {
		return nil, err
	}
	if err := s.requireLeaf(ctx, in.Pool); err != nil {
		return nil, err
	}
	generation, err := s.poolGeneration(ctx, in.Pool)
	if err != nil {
		return nil, err
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, PoolGeneration: generation, Action: in.Action, Fingerprint: fp, Status: "succeeded"}
	err = s.db.update(ctx, func(tx pgx.Tx) error {
		// Receipts and retained history outlive the pool; documents and grants
		// cascade with the row. A reused pool ID starts private and empty.
		if _, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.activity WHERE pool_id = $1`, in.Pool); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.pools WHERE id = $1`, in.Pool); err != nil {
			return err
		}
		if err := appendActivity(ctx, tx, activityForReceipt(r)); err != nil {
			return err
		}
		return s.saveReceipt(ctx, tx, r)
	})
	if err == nil {
		clear(s.perms)
	}
	return r, err
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
		_ = s.db.view(ctx, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `SELECT id FROM `+databaseSchema+`.pools ORDER BY id`)
			if err != nil {
				return err
			}
			candidates := []string{}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				candidates = append(candidates, id)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()
			for _, id := range candidates {
				if len(writable) == 8 {
					break
				}
				ok, err := s.allowed(ctx, tx, id, "write")
				if err != nil {
					return err
				}
				if ok {
					writable = append(writable, id)
				}
			}
			return nil
		})
		if len(writable) == 0 {
			return nil, fieldError{"pool", inputError{in.Action + ": pool is required, and this Soot may write to no collection; ask the operator to grant one"}}
		}
		return nil, fieldError{"pool", inputError{in.Action + ": pool is required (this Soot has no default); it may write to: " + strings.Join(writable, ", ")}}
	}
	if err := writeShape(in); err != nil {
		return nil, err
	}
	if err := s.authorize(ctx, in.Pool, "write"); err != nil {
		return nil, err
	}
	fp := fingerprint(in)
	if r, exists, err := s.replay(ctx, in.RequestID, fp); exists || err != nil {
		return r, err
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
	if in.Action != "remove" && (!validText(content, maxContent) || strings.TrimSpace(content) == "") {
		return nil, inputError{"document content is empty, not UTF-8 text, or over 128 KiB; shorten or split it"}
	}
	r := receipt{ID: in.RequestID, Owner: s.actor, Actor: s.actorReference(), Pool: in.Pool, Action: in.Action, Fingerprint: fp, Status: "succeeded", Origin: s.origin}
	err := s.db.update(ctx, func(tx pgx.Tx) error {
		var generation string
		if err := tx.QueryRow(ctx, `SELECT generation FROM `+databaseSchema+`.pools WHERE id = $1 FOR SHARE`, in.Pool).Scan(&generation); err != nil {
			return errors.New("collection no longer exists")
		}
		r.PoolGeneration = generation
		if in.Generation != "" && in.Generation != generation {
			return conflictError{fmt.Sprintf("collection %s is not at generation %s; omit generation, or copy it from data-pool_pools", in.Pool, in.Generation)}
		}
		var old document
		var oldStored storedDocument
		oldErr := error(nil)
		stored, err := scanDocument(tx.QueryRow(ctx, `SELECT `+documentColumns+` FROM `+databaseSchema+`.documents WHERE pool_id = $1 AND id = $2 FOR UPDATE`, in.Pool, in.ID))
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			oldErr = errNotInPool
		case err != nil:
			return err
		default:
			old, oldStored = stored.document, stored
		}
		if in.Action == "remove" {
			if oldErr != nil {
				return oldErr
			}
			if in.ExpectedRevision != nil && (*in.ExpectedRevision < 0 || *in.ExpectedRevision != old.Revision) {
				return conflictError{fmt.Sprintf("document %s is at revision %d, not %d; read it again, merge, and retry with a new request_id", in.ID, old.Revision, *in.ExpectedRevision)}
			}
			if _, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.documents WHERE pool_id = $1 AND id = $2`, in.Pool, in.ID); err != nil {
				return err
			}
			r.Document = &old
			if err := appendReference(ctx, tx, r.Origin, r.Pool, r.PoolGeneration, r.Action, r.Document); err != nil {
				return err
			}
			if err := appendActivity(ctx, tx, activityForReceipt(r)); err != nil {
				return err
			}
			return s.saveReceipt(ctx, tx, r)
		}
		if oldErr != nil {
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+databaseSchema+`.documents WHERE pool_id = $1`, in.Pool).Scan(&count); err != nil {
				return err
			}
			if count >= maxDocuments {
				return errors.New("document limit reached")
			}
		}
		if oldErr != nil && in.Action == "upsert" && in.ExpectedRevision != nil && *in.ExpectedRevision != 0 {
			return inputError{fmt.Sprintf("document %s does not exist yet; omit expected_revision to create it", in.ID)}
		}
		if oldErr == nil && in.ExpectedRevision != nil && (*in.ExpectedRevision < 0 || *in.ExpectedRevision != old.Revision) {
			return conflictError{fmt.Sprintf("document %s is at revision %d, not %d; read it again, merge, and retry with a new request_id", in.ID, old.Revision, *in.ExpectedRevision)}
		}
		if source == "" {
			source = "soot://" + s.b.Namespace + "/" + in.Pool + "/" + in.ID
		}
		meta := document{ID: in.ID, Title: in.Title, Source: source, Tags: in.Tags, SHA256: hash(content), Revision: old.Revision + 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), Writer: s.actorReference(), Origin: s.origin}
		r.Document = &meta
		if oldErr == nil && oldStored.SHA256 == meta.SHA256 && oldStored.Title == meta.Title && oldStored.Source == meta.Source && slices.Equal(oldStored.Tags, meta.Tags) {
			// Identical content and metadata keeps the stored revision.
			r.Document = &old
			if err := appendReference(ctx, tx, r.Origin, r.Pool, r.PoolGeneration, r.Action, r.Document); err != nil {
				return err
			}
			if err := appendActivity(ctx, tx, activityForReceipt(r)); err != nil {
				return err
			}
			return s.saveReceipt(ctx, tx, r)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.documents
			(pool_id, id, title, source, tags, sha256, revision, updated_at, writer, origin, content, title_norm, content_norm, receipt)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			ON CONFLICT (pool_id, id) DO UPDATE SET title = EXCLUDED.title, source = EXCLUDED.source, tags = EXCLUDED.tags,
				sha256 = EXCLUDED.sha256, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at,
				writer = EXCLUDED.writer, origin = EXCLUDED.origin, content = EXCLUDED.content,
				title_norm = EXCLUDED.title_norm, content_norm = EXCLUDED.content_norm, receipt = EXCLUDED.receipt`,
			in.Pool, meta.ID, meta.Title, meta.Source, jsonBytes(meta.Tags), meta.SHA256, meta.Revision, time.Now().UTC(),
			jsonBytes(meta.Writer), jsonBytes(meta.Origin), content, normalize(meta.Title), normalize(content), receiptToken(s, r)); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return conflictError{fmt.Sprintf("document %s was created concurrently; read it again and retry with a new request_id", in.ID)}
			}
			return err
		}
		if err := appendReference(ctx, tx, r.Origin, r.Pool, r.PoolGeneration, r.Action, r.Document); err != nil {
			return err
		}
		if err := appendActivity(ctx, tx, activityForReceipt(r)); err != nil {
			return err
		}
		return s.saveReceipt(ctx, tx, r)
	})
	if err != nil {
		return nil, err
	}
	return r, nil
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
	r, err := s.loadReceipt(ctx, owner, in.RequestID)
	if err != nil || r.Owner != owner {
		return nil, unavailable
	}
	level := "read"
	if owner != s.actor {
		level = "manage"
	}
	if err := s.authorizeReceipt(ctx, r, level); err != nil {
		return nil, unavailable
	}
	return r, nil
}
