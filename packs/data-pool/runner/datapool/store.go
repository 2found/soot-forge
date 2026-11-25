package datapool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// One fixed schema inside the operator's database. The service creates and
// migrates it on start, so a new deployment needs only a reachable database.
const databaseSchema = "data_pool"

type pool struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CreatedAt      string `json:"created_at"`
	Generation     string `json:"generation"`
	PolicyRevision uint64 `json:"policy_revision"`
	Parent         string `json:"parent,omitempty"`
	Inherit        bool   `json:"inherit"`
	// Scope declares the intended audience at creation: workspace (every bound
	// Soot), group (members of Subject), or own (the creating Soot). Realized
	// through grants, so later grant/revoke adjusts it like any other pool.
	Scope   string `json:"scope,omitempty"`
	Subject string `json:"subject,omitempty"`
	// Public marks the pool readable by the reserved knowledge reader (public.go).
	// Only a host manager sets it; it is never inherited by sub-collections.
	Public bool `json:"public"`
}

type document struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Source    string     `json:"source"`
	Tags      []string   `json:"tags"`
	SHA256    string     `json:"sha256"`
	Revision  int        `json:"revision"`
	UpdatedAt string     `json:"updated_at"`
	Writer    *actorRef  `json:"writer,omitempty"`
	Origin    *originRef `json:"origin,omitempty"`
}

type storedDocument struct {
	document
	Content     string `json:"content"`
	TitleNorm   string `json:"title_norm"`
	ContentNorm string `json:"content_norm"`
	Receipt     string `json:"receipt"`
}

type receipt struct {
	ID             string     `json:"request_id"`
	Owner          string     `json:"owner"`
	Pool           string     `json:"pool"`
	PoolGeneration string     `json:"pool_generation"`
	Action         string     `json:"action"`
	Fingerprint    string     `json:"fingerprint"`
	Status         string     `json:"status"`
	Document       *document  `json:"document,omitempty"`
	Reason         string     `json:"reason,omitempty"`
	Actor          *actorRef  `json:"actor,omitempty"`
	Replay         bool       `json:"replay,omitempty"`
	Origin         *originRef `json:"origin,omitempty"`
}

type service struct {
	b          binding
	actor      string
	db         *store
	fetch      func(string) (string, error)
	human      bool
	origin     *originRef
	membership []string
	groupsFor  string
	perms      map[string]string
	// static is the operator's binding before admissions widen b (admission.go);
	// hosts names the gateway's @host clients, empty in local executable mode.
	static binding
	hosts  []string
}

func hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

// bind pins the database to one namespace, exactly as the old state directory
// refused to open for another one.
func (st *store) bind(ctx context.Context, namespace string) error {
	return st.update(ctx, func(tx dbTx) error {
		var existing string
		err := tx.QueryRow(ctx, `SELECT value FROM `+databaseSchema+`.meta WHERE key = 'namespace'`).Scan(&existing)
		if errors.Is(err, errNoRows) {
			_, err = tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.meta (key, value) VALUES ('namespace', $1)`, namespace)
			return err
		}
		if err != nil {
			return errors.New("data-pool database unavailable")
		}
		if existing != namespace {
			return errors.New("database is already bound to another namespace")
		}
		return nil
	})
}

func openService(ctx context.Context, b binding, actor string) (*service, error) {
	db, err := openStore(ctx, b.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.bind(ctx, b.Namespace); err != nil {
		db.close()
		return nil, err
	}
	s := &service{b: b, static: b, actor: actor, db: db, membership: actorGroups(b, actor), groupsFor: actor, perms: map[string]string{}}
	s.withAdmitted(ctx)
	if ctx.Err() != nil {
		db.close()
		return nil, errors.New("data-pool database unavailable")
	}
	return s, nil
}

func (s *service) close()                      { s.db.close() }
func (s *service) manager() bool               { return !s.reader() && contains(s.b.Managers, s.actor) }
func (s *service) requestKey(id string) string { return s.actor + "/" + id }
func rank(level string) int {
	switch level {
	case "read":
		return 1
	case "write":
		return 2
	case "manage":
		return 3
	}
	return 0
}

// permission resolves the actor's strongest access to one collection, through
// its own grants, the workspace subject, its bound groups and inheriting
// ancestors. One recursive query per collection per invocation.
func (s *service) permission(ctx context.Context, tx dbTx, id string) (string, error) {
	key := s.actor + "\x00" + id
	if level, ok := s.perms[key]; ok {
		return level, nil
	}
	if s.reader() {
		level, err := s.publicLevel(ctx, tx, id)
		if err == nil {
			s.perms[key] = level
		}
		return level, err
	}
	level := ""
	if s.manager() {
		level = "manage"
	}
	subjects := []string{s.actor, workspaceSubject}
	for _, group := range s.groups() {
		subjects = append(subjects, "@group/"+group)
	}
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, parent, inherit FROM `+databaseSchema+`.pools WHERE id = $2
			UNION ALL
			SELECT p.id, p.parent, p.inherit FROM `+databaseSchema+`.pools p
			JOIN chain c ON p.id = c.parent
			WHERE c.inherit AND c.parent <> ''
		)
		SELECT g.level FROM `+databaseSchema+`.grants g JOIN chain c ON c.id = g.pool_id
		WHERE g.subject = ANY($1)`, subjects, id)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var other string
		if err := rows.Scan(&other); err != nil {
			return "", err
		}
		if rank(other) > rank(level) {
			level = other
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	s.perms[key] = level
	return level, nil
}

func (s *service) allowed(ctx context.Context, tx dbTx, id, level string) (bool, error) {
	current, err := s.permission(ctx, tx, id)
	if err != nil {
		return false, err
	}
	return rank(current) >= rank(level) && rank(level) > 0, nil
}

func (s *service) authorize(ctx context.Context, id, level string) error {
	return s.db.view(ctx, func(tx dbTx) error {
		ok, err := s.allowed(ctx, tx, id, level)
		if err != nil {
			return err
		}
		if !ok && s.reader() {
			return inputError{readerPoolUnavailable}
		}
		if !ok {
			// One answer for missing and forbidden, so it is no existence oracle,
			// but actionable: a model that guessed an ID must list or create one.
			return inputError{"collection " + safeID(id) + " is not available to this Soot at " + level + " level (missing or not granted); list accessible collections with data-pool_pools without a pool argument, or create one with data-pool_manage pool_create if you manage pools"}
		}
		return nil
	})
}

func (s *service) poolGeneration(ctx context.Context, id string) (string, error) {
	generation := ""
	err := s.db.view(ctx, func(tx dbTx) error {
		return tx.QueryRow(ctx, `SELECT generation FROM `+databaseSchema+`.pools WHERE id = $1`, id).Scan(&generation)
	})
	if errors.Is(err, errNoRows) || generation == "" {
		return "", errors.New("pool identity unavailable")
	}
	return generation, err
}

// Host managers own the namespace's retained history. Delegated permissions
// apply only to the specific pool generation they currently manage/read.
func (s *service) authorizeReceipt(ctx context.Context, r receipt, level string) error {
	if s.manager() {
		return nil
	}
	return s.db.view(ctx, func(tx dbTx) error {
		var generation string
		if err := tx.QueryRow(ctx, `SELECT generation FROM `+databaseSchema+`.pools WHERE id = $1`, r.Pool).Scan(&generation); err != nil || r.PoolGeneration == "" || generation != r.PoolGeneration {
			return errors.New("request unavailable")
		}
		ok, err := s.allowed(ctx, tx, r.Pool, level)
		if err != nil || !ok {
			return errors.New("request unavailable")
		}
		return nil
	})
}

func scanDocument(row dbRow) (storedDocument, error) {
	var d storedDocument
	var tags, writer, origin []byte
	var updated time.Time
	if err := row.Scan(&d.ID, &d.Title, &d.Source, &tags, &d.SHA256, &d.Revision, &updated, &writer, &origin, &d.Content, &d.TitleNorm, &d.ContentNorm, &d.Receipt); err != nil {
		return d, err
	}
	d.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if len(tags) > 0 {
		_ = json.Unmarshal(tags, &d.Tags)
	}
	if d.Tags == nil {
		d.Tags = []string{}
	}
	if len(writer) > 0 {
		_ = json.Unmarshal(writer, &d.Writer)
	}
	if len(origin) > 0 {
		_ = json.Unmarshal(origin, &d.Origin)
	}
	return d, nil
}

const documentColumns = `id, title, source, tags, sha256, revision, updated_at, writer, origin, content, title_norm, content_norm, receipt`
const documentMetaColumns = `id, title, source, tags, sha256, revision, updated_at, writer, origin`

func scanMeta(row dbRow) (document, error) {
	var d document
	var tags, writer, origin []byte
	var updated time.Time
	if err := row.Scan(&d.ID, &d.Title, &d.Source, &tags, &d.SHA256, &d.Revision, &updated, &writer, &origin); err != nil {
		return d, err
	}
	d.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
	if len(tags) > 0 {
		_ = json.Unmarshal(tags, &d.Tags)
	}
	if d.Tags == nil {
		d.Tags = []string{}
	}
	_ = jsonUnmarshal(writer, &d.Writer)
	_ = jsonUnmarshal(origin, &d.Origin)
	return d, nil
}

func (s *service) doc(ctx context.Context, poolID, docID string) (document, error) {
	var d document
	err := s.db.view(ctx, func(tx dbTx) error {
		stored, err := scanDocument(tx.QueryRow(ctx, `SELECT `+documentColumns+` FROM `+databaseSchema+`.documents WHERE pool_id = $1 AND id = $2`, poolID, docID))
		d = stored.document
		return err
	})
	if errors.Is(err, errNoRows) {
		err = errors.New("document unavailable")
	}
	return d, err
}

func (s *service) loadReceipt(ctx context.Context, owner, id string) (receipt, error) {
	var r receipt
	var document, actor, origin []byte
	var at time.Time
	err := s.db.view(ctx, func(tx dbTx) error {
		return tx.QueryRow(ctx, `SELECT id, owner, pool, pool_generation, action, fingerprint, status, document, reason, actor, origin, at
			FROM `+databaseSchema+`.receipts WHERE owner = $1 AND id = $2`, owner, id).
			Scan(&r.ID, &r.Owner, &r.Pool, &r.PoolGeneration, &r.Action, &r.Fingerprint, &r.Status, &document, &r.Reason, &actor, &origin, &at)
	})
	if errors.Is(err, errNoRows) {
		return r, errors.New("not found")
	}
	if err != nil {
		return r, errors.New("request state unavailable")
	}
	if len(document) > 0 {
		_ = json.Unmarshal(document, &r.Document)
	}
	if len(actor) > 0 {
		_ = json.Unmarshal(actor, &r.Actor)
	}
	if len(origin) > 0 {
		_ = json.Unmarshal(origin, &r.Origin)
	}
	return r, nil
}

func (s *service) saveReceipt(ctx context.Context, tx dbTx, r receipt) error {
	document, actor, origin := jsonBytes(r.Document), jsonBytes(r.Actor), jsonBytes(r.Origin)
	_, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.receipts
		(owner, id, pool, pool_generation, action, fingerprint, status, document, reason, actor, origin, at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (owner, id) DO UPDATE SET pool = EXCLUDED.pool, pool_generation = EXCLUDED.pool_generation,
			action = EXCLUDED.action, fingerprint = EXCLUDED.fingerprint, status = EXCLUDED.status,
			document = EXCLUDED.document, reason = EXCLUDED.reason, actor = EXCLUDED.actor,
			origin = EXCLUDED.origin, at = EXCLUDED.at`,
		r.Owner, r.ID, r.Pool, r.PoolGeneration, r.Action, r.Fingerprint, r.Status, document, r.Reason, actor, origin, time.Now().UTC())
	return err
}

func jsonUnmarshal(data []byte, into any) error {
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, into)
}

func jsonBytes(v any) []byte {
	if v == nil {
		return nil
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return data
}

func (s *service) replay(ctx context.Context, id, fp string) (receipt, bool, error) {
	r, err := s.loadReceipt(ctx, s.actor, id)
	if err != nil && err.Error() == "not found" {
		return r, false, nil
	}
	if err != nil {
		return r, true, errors.New("request state unavailable")
	}
	if r.Fingerprint != fp {
		return r, true, inputError{"request_id already used with different input; a new intent needs a new request_id"}
	}
	if r.Action == "pool_create" || r.Action == "pool_remove" {
		if s.authorizeReceipt(ctx, r, "manage") != nil {
			return r, true, errors.New("access denied")
		}
	} else if err := s.authorizeReceipt(ctx, r, map[string]string{"upsert": "write", "append": "write", "remove": "write", "grant": "manage", "revoke": "manage", "pool_update": "manage"}[r.Action]); err != nil {
		return r, true, err
	}
	r.Replay = true
	return r, true, nil
}

func receiptToken(s *service, r receipt) string {
	return hash(fmt.Sprintf("%s/%s/%s/%s/%s", s.b.Namespace, r.PoolGeneration, r.Owner, r.ID, r.Fingerprint))
}

func safeID(id string) string {
	if identifier.MatchString(id) {
		return id
	}
	return "(invalid ID)"
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
