package datapool

import (
	"context"
	"errors"
	"net/url"
	"strings"
)

// The service speaks to its database through three small interfaces, so the
// same service code runs over PostgreSQL (shared service, many hosts) and over
// an embedded SQLite file (one host, no database server). Statements are
// written once in PostgreSQL syntax; the SQLite backend translates the few
// constructs that differ (dialect.go).

// errNoRows is what QueryRow(...).Scan returns when nothing matched, on either
// backend.
var errNoRows = errors.New("no rows in result set")

type dbRow interface{ Scan(dest ...any) error }

type dbRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

type dbTx interface {
	Exec(ctx context.Context, sql string, args ...any) (int64, error)
	Query(ctx context.Context, sql string, args ...any) (dbRows, error)
	QueryRow(ctx context.Context, sql string, args ...any) dbRow
}

// backend is one database engine behind the store.
type backend interface {
	// begin opens a transaction; update transactions serialize writers.
	begin(ctx context.Context, readOnly bool) (dbTx, func(context.Context) error, func(context.Context), error)
	// migrate creates or upgrades the schema.
	migrate(ctx context.Context) error
	ping(ctx context.Context) error
	close()
	// searchDocuments returns the documents of one pool whose normalized title
	// or content contains terms or is trigram-similar to it, best title first.
	// The rows carry documentColumns.
	searchDocuments(ctx context.Context, tx dbTx, pool, terms string, limit, offset int) (dbRows, error)
}

type store struct{ backend }

// isSQLiteURL reports whether a database_url names the embedded SQLite file.
func isSQLiteURL(raw string) bool { return strings.HasPrefix(raw, "sqlite:") }

// sqlitePath returns the absolute file path of sqlite:///abs/path. Only an
// absolute path is accepted: the host decides where state lives.
func sqlitePath(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "sqlite" || u.Host != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(raw) > 4096 {
		return "", errors.New("invalid database_url; use sqlite:///absolute/path/to/file")
	}
	if !strings.HasPrefix(u.Path, "/") || strings.ContainsRune(u.Path, 0) || strings.HasSuffix(u.Path, "/") {
		return "", errors.New("invalid database_url; use sqlite:///absolute/path/to/file")
	}
	return u.Path, nil
}

func openStore(ctx context.Context, dsn string) (*store, error) {
	var be backend
	var err error
	if isSQLiteURL(dsn) {
		be, err = openSQLite(ctx, dsn)
	} else {
		be, err = openPostgres(ctx, dsn)
	}
	if err != nil {
		return nil, err
	}
	st := &store{be}
	if err := st.migrate(ctx); err != nil {
		be.close()
		return nil, err
	}
	return st, nil
}

func (st *store) close() { st.backend.close() }

func (st *store) view(ctx context.Context, fn func(dbTx) error) error { return st.run(ctx, true, fn) }
func (st *store) update(ctx context.Context, fn func(dbTx) error) error {
	return st.run(ctx, false, fn)
}

func (st *store) run(ctx context.Context, readOnly bool, fn func(dbTx) error) error {
	tx, commit, rollback, err := st.begin(ctx, readOnly)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		rollback(ctx)
		return err
	}
	return commit(ctx)
}

// isUniqueViolation reports a duplicate primary key on either backend.
func isUniqueViolation(err error) bool {
	return pgUniqueViolation(err) || sqliteUniqueViolation(err)
}
