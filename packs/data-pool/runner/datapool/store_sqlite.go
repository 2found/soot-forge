package datapool

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"modernc.org/sqlite"
)

// The embedded backend: one SQLite file is one namespace. It needs no server,
// no CGO and no network, so a single host (a laptop, a small VM) gets a working
// data pool by default. The service logic, grants, revisions, receipts and
// activity are the PostgreSQL ones; only the engine differs (dialect.go), and
// search is the FTS5 trigram index plus pg_trgm's similarity (trigram.go).

func init() {
	sqlite.MustRegisterDeterministicScalarFunction("trgm_sim", 2, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		a, aok := args[0].(string)
		b, bok := args[1].(string)
		if !aok || !bok {
			return float64(0), nil
		}
		return float64(trigramsOf(a).similarity(querySet(b))), nil
	})
	sqlite.MustRegisterDeterministicScalarFunction("trgm_count", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		text, _ := args[0].(string)
		return int64(len(trigramsOf(text))), nil
	})
}

type sqliteBackend struct{ db *sql.DB }

func openSQLite(ctx context.Context, raw string) (backend, error) {
	path, err := sqlitePath(raw)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, errors.New("data-pool database unavailable")
	}
	// Create the file private; SQLite gives its -wal and -shm files the same mode.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, errors.New("data-pool database unavailable")
	}
	f.Close()
	query := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(NORMAL)", "foreign_keys(1)"} {
		query.Add("_pragma", p)
	}
	query.Set("_time_format", "sqlite")
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, errors.New("data-pool database unavailable")
	}
	db.SetMaxOpenConns(8)
	check, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(check); err != nil {
		db.Close()
		return nil, errors.New("data-pool database unavailable")
	}
	return &sqliteBackend{db}, nil
}

func (b *sqliteBackend) close()                         { b.db.Close() }
func (b *sqliteBackend) ping(ctx context.Context) error { return b.db.PingContext(ctx) }

type sqlTx struct{ conn *sql.Conn }

func (t sqlTx) Exec(ctx context.Context, query string, args ...any) (int64, error) {
	q, a := sqliteSQL(query, args)
	res, err := t.conn.ExecContext(ctx, q, a...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (t sqlTx) Query(ctx context.Context, query string, args ...any) (dbRows, error) {
	q, a := sqliteSQL(query, args)
	rows, err := t.conn.QueryContext(ctx, q, a...)
	if err != nil {
		return nil, err
	}
	return sqlRows{rows}, nil
}

func (t sqlTx) QueryRow(ctx context.Context, query string, args ...any) dbRow {
	q, a := sqliteSQL(query, args)
	return sqlRow{t.conn.QueryRowContext(ctx, q, a...)}
}

type sqlRows struct{ *sql.Rows }

func (r sqlRows) Close() { _ = r.Rows.Close() }

type sqlRow struct{ row *sql.Row }

func (r sqlRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	if errors.Is(err, sql.ErrNoRows) {
		return errNoRows
	}
	return err
}

// begin takes the write lock up front for an update (BEGIN IMMEDIATE), so a
// read-modify-write is serialized exactly as the PostgreSQL FOR UPDATE and
// FOR SHARE locks serialize it; WAL lets views read concurrently meanwhile.
func (b *sqliteBackend) begin(ctx context.Context, readOnly bool) (dbTx, func(context.Context) error, func(context.Context), error) {
	conn, err := b.db.Conn(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	start, finish := "BEGIN IMMEDIATE", ""
	if readOnly {
		start, finish = "BEGIN", "PRAGMA query_only = 0"
		if _, err := conn.ExecContext(ctx, "PRAGMA query_only = 1"); err != nil {
			conn.Close()
			return nil, nil, nil, err
		}
	}
	if _, err := conn.ExecContext(ctx, start); err != nil {
		if finish != "" {
			_, _ = conn.ExecContext(context.WithoutCancel(ctx), finish)
		}
		conn.Close()
		return nil, nil, nil, err
	}
	release := func(ctx context.Context) {
		if finish != "" {
			_, _ = conn.ExecContext(context.WithoutCancel(ctx), finish)
		}
		conn.Close()
	}
	commit := func(ctx context.Context) error {
		_, err := conn.ExecContext(ctx, "COMMIT")
		if err != nil {
			_, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
		release(ctx)
		return err
	}
	rollback := func(ctx context.Context) {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		release(ctx)
	}
	return sqlTx{conn}, commit, rollback, nil
}

func sqliteUniqueViolation(err error) bool {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return false
	}
	code := se.Code()
	return code&0xff == 19 && (code == 19 || code == 1555 || code == 2067) // SQLITE_CONSTRAINT, _PRIMARYKEY, _UNIQUE
}

// searchDocuments narrows by the FTS5 trigram index (any trigram of the query,
// word boundaries included), then applies pg_trgm's exact predicate to those
// rows: the text contains the query, or the title or content is >= 0.3 similar.
// A document with more distinct trigrams than |query|/0.3 cannot reach 0.3, so
// the stored count skips the content scan for long documents.
func (b *sqliteBackend) searchDocuments(ctx context.Context, tx dbTx, pool, terms string, limit, offset int) (dbRows, error) {
	maxTrigrams := int(float64(len(trigramsOf(terms)))/float64(trigramThreshold)) + 1
	candidates, args := "", []any{pool, terms, float64(trigramThreshold), maxTrigrams, limit, offset}
	// A substring of fewer than three characters has no trigram to look up (the
	// same is true of PostgreSQL's LIKE): those queries scan the pool, which
	// the per-pool document cap bounds.
	// The query itself is also a term: the trigram tokenizer matches a quoted
	// string anywhere in the text, so a document the instr predicate accepts
	// ("q&a" inside "official q&a page") is always a candidate, even when the
	// query's words are too short to share a word trigram with it.
	if utf8.RuneCountInString(terms) >= 3 {
		match := `"` + strings.ReplaceAll(terms, `"`, `""`) + `"`
		if words := matchQuery(terms); words != "" {
			match += " OR " + words
		}
		candidates = ` AND d.seq IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH $7)`
		args = append(args, match)
	}
	return tx.Query(ctx, `SELECT `+qualified(documentColumns, "d")+` FROM documents d JOIN document_trgm t ON t.seq = d.seq
		WHERE d.pool_id = $1`+candidates+` AND (instr(d.title_norm, $2) > 0 OR instr(d.content_norm, $2) > 0
			OR t.title_n <= $4 AND trgm_sim(d.title_norm, $2) >= $3
			OR t.content_n <= $4 AND trgm_sim(d.content_norm, $2) >= $3)
		ORDER BY d.title_norm = $2 DESC, trgm_sim(d.title_norm, $2) DESC, d.id
		LIMIT $5 OFFSET $6`, args...)
}

func qualified(columns, alias string) string {
	parts := strings.Split(columns, ",")
	for i, c := range parts {
		parts[i] = alias + "." + strings.TrimSpace(c)
	}
	return strings.Join(parts, ", ")
}

func (b *sqliteBackend) migrate(ctx context.Context) error {
	tx, commit, rollback, err := b.begin(ctx, false)
	if err != nil {
		return errors.New("data-pool database unavailable")
	}
	for _, statement := range sqliteSchema {
		if _, err := tx.Exec(ctx, statement); err != nil {
			rollback(ctx)
			return errors.New("cannot prepare the data-pool schema")
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO meta (key, value) VALUES ('schema_version', $1)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE meta.value < excluded.value`, schemaVersion); err != nil {
		rollback(ctx)
		return errors.New("cannot prepare the data-pool schema")
	}
	return commit(ctx)
}
