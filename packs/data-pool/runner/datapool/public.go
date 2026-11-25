package datapool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// knowledgeIdentity is the reserved reader a host runs its public-knowledge
// tools as (2agent config.KnowledgeIdentity). It needs no allowlist entry in a
// binding: every host binding may claim it. Its authority is fixed here and
// never read from grants, manager lists, writer lists or admissions, so a
// binding that happens to list a Soot of that name gains nothing:
//
//   - pools, listing only public pools, and query list/read/search on public
//     pools; nothing else (no write, manage, status, references, view, action);
//   - a pool that is not public answers exactly as a missing pool does;
//   - its reads are not recorded in the pool's activity log, so a public
//     reader never writes to the database.
const knowledgeIdentity = "knowledge"

// errAccessDenied is the service's stable refusal for an operation an identity
// may never call. It matches the executable's and the gateway's 403 text.
var errAccessDenied = errors.New("access denied")

func (s *service) reader() bool { return s.actor == knowledgeIdentity }

// The reader's two refusals start with a stable code the host matches on
// (2agent compose/app/knowledge.go): a pool that is private or missing, and a
// document a public pool does not hold. Neither names the pool, so the reader
// learns nothing about pools it may not see.
const (
	readerPoolUnavailable = "pool_unavailable: this collection is not available to the knowledge reader"
	readerDocumentMissing = "document_not_found: the collection holds no such document"
)

// missingDocument is the answer for a document the collection does not hold:
// the reader gets the stable code, everyone else the actionable hint.
func (s *service) missingDocument(id, pool string) error {
	if s.reader() {
		return inputError{readerDocumentMissing}
	}
	return inputError{fmt.Sprintf("document %s is not in collection %s; list the collection to find it, or create it with an upsert that omits expected_revision", id, pool)}
}

// readerGate refuses everything the reserved reader may not call, before any
// state is touched.
func (s *service) readerGate(op string, raw json.RawMessage) error {
	if !s.reader() {
		return nil
	}
	switch op {
	case "pools":
		return nil
	case "query":
		var peek struct {
			Action string `json:"action"`
		}
		if json.Unmarshal(raw, &peek) == nil {
			switch peek.Action {
			case "list", "read", "search":
				return nil
			}
		}
	}
	return errAccessDenied
}

// publicLevel is the reader's access to one pool: read when the pool is public,
// nothing otherwise (a pool that does not exist reads as not public).
func (s *service) publicLevel(ctx context.Context, tx dbTx, id string) (string, error) {
	var public bool
	err := tx.QueryRow(ctx, `SELECT public FROM `+databaseSchema+`.pools WHERE id = $1`, id).Scan(&public)
	if errors.Is(err, errNoRows) || err == nil && !public {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return "read", nil
}

// publicPoolIDs pages the public pools by ID cursor, as the manager listing
// does for every pool.
func publicPoolIDs(ctx context.Context, tx dbTx, parent *string, after string, limit int) (dbRows, error) {
	return tx.Query(ctx, `SELECT id FROM `+databaseSchema+`.pools
		WHERE public = true AND ($1::text IS NULL OR parent = $1) AND id > $2 ORDER BY id LIMIT $3`, parent, after, limit)
}

// reservedIdentity names the identities no grant or admission may target.
func reservedIdentity(id string) bool { return id == knowledgeIdentity }

// restatesVisibility reports a pool_update that asks only for the visibility
// the pool already has, so repeating it with a new request_id is a no-op.
func restatesVisibility(in manageInput, p pool) bool {
	return in.Public != nil && *in.Public == p.Public && in.Name == "" && in.Parent == nil && in.Inherit == nil
}
