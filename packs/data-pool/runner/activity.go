package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const activityRetention = 1000

type actorRef struct {
	Kind string `json:"kind"`
	Soot string `json:"soot"`
}
type revisionRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
}
type activity struct {
	Sequence    uint64        `json:"sequence"`
	At          string        `json:"at"`
	Pool        string        `json:"pool"`
	Generation  string        `json:"generation"`
	Actor       actorRef      `json:"actor"`
	Action      string        `json:"action"`
	Status      string        `json:"status"`
	RequestID   string        `json:"request_id,omitempty"`
	Documents   []revisionRef `json:"documents,omitempty"`
	TargetSoot  string        `json:"target_soot,omitempty"`
	TargetGroup string        `json:"target_group,omitempty"`
	Level       string        `json:"level,omitempty"`
}

func (s *service) actorReference() *actorRef {
	kind := "soot"
	if s.human {
		kind = "human"
	}
	return &actorRef{Kind: kind, Soot: s.actor}
}
func activityForReceipt(r receipt) activity {
	actor := actorRef{Kind: "soot", Soot: r.Owner}
	if r.Actor != nil {
		actor = *r.Actor
	}
	a := activity{Pool: r.Pool, Generation: r.PoolGeneration, Actor: actor, Action: r.Action, Status: r.Status, RequestID: r.ID}
	if r.Document != nil {
		a.Documents = []revisionRef{{ID: r.Document.ID, Revision: r.Document.Revision}}
	}
	return a
}

// appendActivity writes one audit row and drops everything older than the
// pool's retained window, so the table stays bounded without a janitor.
func appendActivity(ctx context.Context, tx pgx.Tx, a activity) error {
	a.At = time.Now().UTC().Format(time.RFC3339Nano)
	if err := tx.QueryRow(ctx, `INSERT INTO `+databaseSchema+`.activity
		(pool_id, at, generation, actor, action, status, request_id, documents, target_soot, target_group, level)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING seq`,
		a.Pool, time.Now().UTC(), a.Generation, jsonBytes(a.Actor), a.Action, a.Status, a.RequestID, jsonBytes(a.Documents), a.TargetSoot, a.TargetGroup, a.Level).Scan(&a.Sequence); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.activity
		WHERE pool_id = $1 AND seq <= (SELECT max(seq) - $2 FROM `+databaseSchema+`.activity WHERE pool_id = $1)`, a.Pool, activityRetention)
	return err
}

// Query results are already bounded and integrity-checked. Never store query
// text, snippets, document content or credentials in the activity index.
func (s *service) recordQuery(ctx context.Context, in queryInput, result any) error {
	generation, err := s.poolGeneration(ctx, in.Pool)
	if err != nil {
		return err
	}
	a := activity{Pool: in.Pool, Generation: generation, Actor: *s.actorReference(), Action: in.Action, Status: "succeeded"}
	v := result.(map[string]any)
	if d, ok := v["document"].(document); ok {
		a.Documents = append(a.Documents, revisionRef{ID: d.ID, Revision: d.Revision})
	}
	if docs, ok := v["documents"].([]document); ok {
		for _, d := range docs {
			a.Documents = append(a.Documents, revisionRef{ID: d.ID, Revision: d.Revision})
		}
	}
	read := []document{}
	if d, ok := v["document"].(document); ok {
		read = append(read, d)
	}
	if pages, ok := v["documents"].([]readPage); ok {
		for _, p := range pages {
			a.Documents = append(a.Documents, revisionRef{ID: p.Document.ID, Revision: p.Document.Revision})
			read = append(read, p.Document)
		}
	}
	if hits, ok := v["hits"].([]any); ok {
		for _, hit := range hits {
			d := hit.(map[string]any)["document"].(document)
			a.Documents = append(a.Documents, revisionRef{ID: d.ID, Revision: d.Revision})
		}
	}
	return s.db.update(ctx, func(tx pgx.Tx) error {
		if err := appendActivity(ctx, tx, a); err != nil {
			return err
		}
		if in.Action == "read" {
			for _, d := range read {
				if err := appendReference(ctx, tx, s.origin, in.Pool, generation, "read", &d); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

type activityInput struct {
	Pool  string `json:"pool"`
	After string `json:"after,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

func (s *service) activities(ctx context.Context, in activityInput) (any, error) {
	if err := s.authorize(ctx, in.Pool, "manage"); err != nil {
		return nil, err
	}
	limit, err := pageSize(in.Limit)
	if err != nil {
		return nil, err
	}
	before := uint64(0)
	if in.After != "" {
		before, err = strconv.ParseUint(in.After, 10, 64)
		if err != nil || before == 0 {
			return nil, errors.New("invalid activity cursor")
		}
	}
	items := []activity{}
	var oldest uint64
	if err := s.db.view(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(min(seq), 0) FROM `+databaseSchema+`.activity WHERE pool_id = $1`, in.Pool).Scan(&oldest); err != nil {
			return err
		}
		query := `SELECT seq, pool_id, at, generation, actor, action, status, request_id, documents, target_soot, target_group, level
			FROM ` + databaseSchema + `.activity WHERE pool_id = $1`
		args := []any{in.Pool}
		if before > 0 {
			query += ` AND seq < $2`
			args = append(args, before)
		}
		query += ` ORDER BY seq DESC LIMIT $` + strconv.Itoa(len(args)+1)
		args = append(args, limit+1)
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a activity
			var at time.Time
			var actor, documents []byte
			if err := rows.Scan(&a.Sequence, &a.Pool, &at, &a.Generation, &actor, &a.Action, &a.Status, &a.RequestID, &documents, &a.TargetSoot, &a.TargetGroup, &a.Level); err != nil {
				return err
			}
			a.At = at.UTC().Format(time.RFC3339Nano)
			_ = jsonUnmarshal(actor, &a.Actor)
			_ = jsonUnmarshal(documents, &a.Documents)
			items = append(items, a)
		}
		return rows.Err()
	}); err != nil {
		return nil, err
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = strconv.FormatUint(items[len(items)-1].Sequence, 10)
	}
	return map[string]any{"activity": items, "next": next, "retention": activityRetention, "oldest_sequence": oldest}, nil
}
