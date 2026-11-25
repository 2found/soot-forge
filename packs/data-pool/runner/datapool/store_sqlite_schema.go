package datapool

// sqliteSchema is the data_pool schema for the embedded backend. Tables and
// columns match the PostgreSQL ones (store_pg.go); the differences are the
// engine's: integer rowids for identity columns, 0/1 booleans, text timestamps
// in the driver's format, and the FTS5 trigram index that stands in for the
// pg_trgm GIN indexes.
//
// documents has its own integer key (seq) because FTS5 rows are addressed by
// rowid, and a table keyed by (pool_id, id) may renumber its implicit rowids on
// VACUUM. The index is contentless: it holds trigrams, not a second copy of
// the text, and is padded with a space on each side so word boundaries are
// indexed. Triggers keep it and the per-document trigram counts (used to skip
// the content similarity of documents too long to reach the threshold) in step,
// including for rows a pool removal cascades away. They call trgm_count, which
// is registered by this package, so only the service may write the file.
var sqliteSchema = []string{
	`CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS pools (
		id text PRIMARY KEY,
		name text NOT NULL,
		created_at timestamp NOT NULL,
		generation text NOT NULL,
		policy_revision integer NOT NULL DEFAULT 0,
		parent text NOT NULL DEFAULT '',
		inherit boolean NOT NULL DEFAULT 1,
		scope text NOT NULL DEFAULT '',
		subject text NOT NULL DEFAULT '',
		public boolean NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS pools_parent ON pools (parent)`,
	`CREATE TABLE IF NOT EXISTS grants (
		pool_id text NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
		subject text NOT NULL,
		level text NOT NULL,
		PRIMARY KEY (pool_id, subject)
	)`,
	`CREATE INDEX IF NOT EXISTS grants_subject ON grants (subject, pool_id)`,
	`CREATE TABLE IF NOT EXISTS documents (
		seq integer PRIMARY KEY AUTOINCREMENT,
		pool_id text NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
		id text NOT NULL,
		title text NOT NULL,
		source text NOT NULL,
		tags blob NOT NULL DEFAULT '[]',
		sha256 text NOT NULL,
		revision integer NOT NULL,
		updated_at timestamp NOT NULL,
		writer blob,
		origin blob,
		content text NOT NULL,
		title_norm text NOT NULL,
		content_norm text NOT NULL,
		receipt text NOT NULL,
		UNIQUE (pool_id, id)
	)`,
	`CREATE TABLE IF NOT EXISTS document_trgm (seq integer PRIMARY KEY, title_n integer NOT NULL, content_n integer NOT NULL)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title_norm, content_norm, content = '', contentless_delete = 1, tokenize = 'trigram')`,
	`CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
		INSERT INTO documents_fts (rowid, title_norm, content_norm) VALUES (new.seq, ' ' || new.title_norm || ' ', ' ' || new.content_norm || ' ');
		INSERT INTO document_trgm (seq, title_n, content_n) VALUES (new.seq, trgm_count(new.title_norm), trgm_count(new.content_norm));
	END`,
	`CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE OF title_norm, content_norm ON documents BEGIN
		DELETE FROM documents_fts WHERE rowid = old.seq;
		INSERT INTO documents_fts (rowid, title_norm, content_norm) VALUES (new.seq, ' ' || new.title_norm || ' ', ' ' || new.content_norm || ' ');
		UPDATE document_trgm SET title_n = trgm_count(new.title_norm), content_n = trgm_count(new.content_norm) WHERE seq = new.seq;
	END`,
	`CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
		DELETE FROM documents_fts WHERE rowid = old.seq;
		DELETE FROM document_trgm WHERE seq = old.seq;
	END`,
	`CREATE TABLE IF NOT EXISTS receipts (
		owner text NOT NULL,
		id text NOT NULL,
		pool text NOT NULL DEFAULT '',
		pool_generation text NOT NULL DEFAULT '',
		action text NOT NULL,
		fingerprint text NOT NULL,
		status text NOT NULL,
		document blob,
		reason text NOT NULL DEFAULT '',
		actor blob,
		origin blob,
		at timestamp NOT NULL,
		PRIMARY KEY (owner, id)
	)`,
	`CREATE TABLE IF NOT EXISTS admissions (
		soot text PRIMARY KEY,
		host text NOT NULL DEFAULT '',
		level text NOT NULL,
		by text NOT NULL,
		at timestamp NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS activity (
		seq integer PRIMARY KEY AUTOINCREMENT,
		pool_id text NOT NULL,
		at timestamp NOT NULL,
		generation text NOT NULL,
		actor blob NOT NULL,
		action text NOT NULL,
		status text NOT NULL,
		request_id text NOT NULL DEFAULT '',
		documents blob,
		target_soot text NOT NULL DEFAULT '',
		target_group text NOT NULL DEFAULT '',
		level text NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS activity_pool_seq ON activity (pool_id, seq DESC)`,
	`CREATE TABLE IF NOT EXISTS references_log (
		seq integer PRIMARY KEY AUTOINCREMENT,
		conversation text NOT NULL,
		at timestamp NOT NULL,
		pool text NOT NULL,
		generation text NOT NULL,
		id text NOT NULL,
		revision integer NOT NULL,
		sha256 text NOT NULL,
		action text NOT NULL,
		origin blob NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS references_conversation_seq ON references_log (conversation, seq)`,
}
