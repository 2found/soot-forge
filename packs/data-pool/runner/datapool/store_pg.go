package datapool

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// schemaVersion is the data_pool.meta schema_version this build writes. 1 was
// the first shared-service schema; 2 adds pools.public.
const schemaVersion = "2"

type pgBackend struct{ pool *pgxpool.Pool }

func openPostgres(ctx context.Context, dsn string) (backend, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid data-pool database URL")
	}
	cfg.MaxConns, cfg.MaxConnIdleTime = 8, 5*time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("data-pool database unavailable")
	}
	check, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(check); err != nil {
		pool.Close()
		return nil, errors.New("data-pool database unavailable")
	}
	return &pgBackend{pool}, nil
}

func (b *pgBackend) close()                         { b.pool.Close() }
func (b *pgBackend) ping(ctx context.Context) error { return b.pool.Ping(ctx) }

type pgTx struct{ tx pgx.Tx }

func (t pgTx) Exec(ctx context.Context, sql string, args ...any) (int64, error) {
	tag, err := t.tx.Exec(ctx, sql, args...)
	return tag.RowsAffected(), err
}
func (t pgTx) Query(ctx context.Context, sql string, args ...any) (dbRows, error) {
	rows, err := t.tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return rows, nil
}
func (t pgTx) QueryRow(ctx context.Context, sql string, args ...any) dbRow {
	return pgRow{t.tx.QueryRow(ctx, sql, args...)}
}

type pgRow struct{ row pgx.Row }

func (r pgRow) Scan(dest ...any) error {
	err := r.row.Scan(dest...)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNoRows
	}
	return err
}

func (b *pgBackend) begin(ctx context.Context, readOnly bool) (dbTx, func(context.Context) error, func(context.Context), error) {
	opts := pgx.TxOptions{}
	if readOnly {
		opts.AccessMode = pgx.ReadOnly
	}
	tx, err := b.pool.BeginTx(ctx, opts)
	if err != nil {
		return nil, nil, nil, err
	}
	return pgTx{tx}, tx.Commit, func(ctx context.Context) { _ = tx.Rollback(ctx) }, nil
}

func pgUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// likeEscaped makes model text a literal LIKE pattern: "%" and "_" lose their
// wildcard meaning, so a query cannot turn into an accidental match-all.
func likeEscaped(text string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text)
}

// searchDocuments: trigram indexes serve both the LIKE substring and the fuzzy
// `%` match; ranking uses the short title field so the sort does not re-read
// every matched document body.
func (b *pgBackend) searchDocuments(ctx context.Context, tx dbTx, pool, terms string, limit, offset int) (dbRows, error) {
	pattern := "%" + likeEscaped(terms) + "%"
	return tx.Query(ctx, `SELECT `+documentColumns+` FROM `+databaseSchema+`.documents
		WHERE pool_id = $1 AND (title_norm LIKE $2 ESCAPE '\' OR content_norm LIKE $2 ESCAPE '\' OR title_norm % $3 OR content_norm % $3)
		ORDER BY title_norm = $3 DESC, similarity(title_norm, $3) DESC, id
		LIMIT $4 OFFSET $5`, pool, pattern, terms, limit, offset)
}

// migrate creates the schema once. The advisory lock keeps two replicas from
// racing the DDL; runtime policy already assumes one service per namespace.
func (b *pgBackend) migrate(ctx context.Context) error {
	tx, commit, rollback, err := b.begin(ctx, false)
	if err != nil {
		return err
	}
	if err := b.migrateTx(ctx, tx); err != nil {
		rollback(ctx)
		return err
	}
	return commit(ctx)
}

func (b *pgBackend) migrateTx(ctx context.Context, tx dbTx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('soot-data-pool'))`); err != nil {
		return errors.New("data-pool database unavailable")
	}
	for _, statement := range []string{
		`CREATE EXTENSION IF NOT EXISTS pg_trgm`,
		`CREATE SCHEMA IF NOT EXISTS ` + databaseSchema,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.meta (key text PRIMARY KEY, value text NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.pools (
				id text PRIMARY KEY,
				name text NOT NULL,
				created_at timestamptz NOT NULL,
				generation text NOT NULL,
				policy_revision bigint NOT NULL DEFAULT 0,
				parent text NOT NULL DEFAULT '',
				inherit boolean NOT NULL DEFAULT true,
				scope text NOT NULL DEFAULT '',
				subject text NOT NULL DEFAULT '',
				public boolean NOT NULL DEFAULT false
			)`,
		// Schema 2: a constant default is a metadata-only change, so an
		// existing pool table is upgraded in place without a rewrite. Every
		// open runs this list, and ALTER TABLE takes ACCESS EXCLUSIVE even
		// when the column exists, so it runs only when the column is missing.
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns
				WHERE table_schema = '` + databaseSchema + `' AND table_name = 'pools' AND column_name = 'public') THEN
				SET LOCAL lock_timeout = '5s';
				ALTER TABLE ` + databaseSchema + `.pools ADD COLUMN public boolean NOT NULL DEFAULT false;
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS pools_parent ON ` + databaseSchema + `.pools (parent)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.grants (
				pool_id text NOT NULL REFERENCES ` + databaseSchema + `.pools (id) ON DELETE CASCADE,
				subject text NOT NULL,
				level text NOT NULL,
				PRIMARY KEY (pool_id, subject)
			)`,
		`CREATE INDEX IF NOT EXISTS grants_subject ON ` + databaseSchema + `.grants (subject, pool_id)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.documents (
				pool_id text NOT NULL REFERENCES ` + databaseSchema + `.pools (id) ON DELETE CASCADE,
				id text NOT NULL,
				title text NOT NULL,
				source text NOT NULL,
				tags jsonb NOT NULL DEFAULT '[]',
				sha256 text NOT NULL,
				revision integer NOT NULL,
				updated_at timestamptz NOT NULL,
				writer jsonb,
				origin jsonb,
				content text NOT NULL,
				title_norm text NOT NULL,
				content_norm text NOT NULL,
				receipt text NOT NULL,
				PRIMARY KEY (pool_id, id)
			)`,
		`CREATE INDEX IF NOT EXISTS documents_pool ON ` + databaseSchema + `.documents (pool_id)`,
		`CREATE INDEX IF NOT EXISTS documents_title_trgm ON ` + databaseSchema + `.documents USING gin (title_norm gin_trgm_ops)`,
		`CREATE INDEX IF NOT EXISTS documents_content_trgm ON ` + databaseSchema + `.documents USING gin (content_norm gin_trgm_ops)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.receipts (
				owner text NOT NULL,
				id text NOT NULL,
				pool text NOT NULL DEFAULT '',
				pool_generation text NOT NULL DEFAULT '',
				action text NOT NULL,
				fingerprint text NOT NULL,
				status text NOT NULL,
				document jsonb,
				reason text NOT NULL DEFAULT '',
				actor jsonb,
				origin jsonb,
				at timestamptz NOT NULL,
				PRIMARY KEY (owner, id)
			)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.admissions (
				soot text PRIMARY KEY,
				host text NOT NULL DEFAULT '',
				level text NOT NULL,
				by text NOT NULL,
				at timestamptz NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.activity (
				seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				pool_id text NOT NULL,
				at timestamptz NOT NULL,
				generation text NOT NULL,
				actor jsonb NOT NULL,
				action text NOT NULL,
				status text NOT NULL,
				request_id text NOT NULL DEFAULT '',
				documents jsonb,
				target_soot text NOT NULL DEFAULT '',
				target_group text NOT NULL DEFAULT '',
				level text NOT NULL DEFAULT ''
			)`,
		`CREATE INDEX IF NOT EXISTS activity_pool_seq ON ` + databaseSchema + `.activity (pool_id, seq DESC)`,
		`CREATE TABLE IF NOT EXISTS ` + databaseSchema + `.references_log (
				seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				conversation text NOT NULL,
				at timestamptz NOT NULL,
				pool text NOT NULL,
				generation text NOT NULL,
				id text NOT NULL,
				revision integer NOT NULL,
				sha256 text NOT NULL,
				action text NOT NULL,
				origin jsonb NOT NULL
			)`,
		`CREATE INDEX IF NOT EXISTS references_conversation_seq ON ` + databaseSchema + `.references_log (conversation, seq)`,
	} {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return errors.New("cannot prepare the data-pool schema")
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.meta (key, value) VALUES ('schema_version', $1)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE `+databaseSchema+`.meta.value < EXCLUDED.value`, schemaVersion)
	return err
}
