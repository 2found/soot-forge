package main

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Correlation fields originate in the host envelope, never model input. They
// do not confer authority: workspace/Soot and group membership remain bound by
// the service credential/config. No chat text is forwarded or stored.
type callEvent struct {
	ID      string `json:"id,omitempty"`
	Source  string `json:"source,omitempty"`
	Subject string `json:"subject,omitempty"`
}
type originRef struct {
	Workspace    string `json:"workspace"`
	Soot         string `json:"soot"`
	Group        string `json:"group_id,omitempty"`
	Conversation string `json:"conversation_id,omitempty"`
	Run          string `json:"run_id,omitempty"`
}

func (s *service) callOrigin(call toolCall) *originRef {
	o := &originRef{Workspace: s.b.Namespace, Soot: s.actor}
	for _, g := range s.groups() {
		if g == call.GroupID {
			o.Group = g
			break
		}
	}
	if call.Event != nil && call.Event.Source == "conversation" && validContextID(call.Event.Subject) {
		o.Conversation = call.Event.Subject
		if !s.human && validContextID(call.Event.ID) {
			o.Run = call.Event.ID
		}
	}
	return o
}
func validContextID(id string) bool {
	return id != "" && len(id) <= 256 && validText(id, 256) && strings.TrimSpace(id) == id
}

const referenceRetention = 1000

type dataReference struct {
	Sequence   uint64    `json:"sequence"`
	At         string    `json:"at"`
	Pool       string    `json:"pool"`
	Generation string    `json:"generation"`
	ID         string    `json:"id"`
	Revision   int       `json:"revision"`
	SHA256     string    `json:"sha256"`
	Action     string    `json:"action"`
	Origin     originRef `json:"origin"`
}

func appendReference(ctx context.Context, tx pgx.Tx, origin *originRef, pool, generation, action string, d *document) error {
	if origin == nil || origin.Conversation == "" || d == nil {
		return nil
	}
	var seq uint64
	if err := tx.QueryRow(ctx, `INSERT INTO `+databaseSchema+`.references_log
		(conversation, at, pool, generation, id, revision, sha256, action, origin)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING seq`,
		origin.Conversation, time.Now().UTC(), pool, generation, d.ID, d.Revision, d.SHA256, action, jsonBytes(*origin)).Scan(&seq); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.references_log
		WHERE conversation = $1 AND seq <= (SELECT max(seq) - $2 FROM `+databaseSchema+`.references_log WHERE conversation = $1)`, origin.Conversation, referenceRetention)
	return err
}

func (s *service) references(ctx context.Context, in queryInput) (any, error) {
	limit, err := pageSize(in.Limit)
	if err != nil || !validContextID(in.Conversation) || in.Run != "" && !validContextID(in.Run) || in.ID != "" || in.Query != "" || in.Offset != 0 {
		return nil, errors.New("invalid reference query")
	}
	after := uint64(0)
	if in.After != "" {
		after, err = strconv.ParseUint(in.After, 10, 64)
		if err != nil || after == ^uint64(0) {
			return nil, errors.New("invalid reference cursor")
		}
	}
	rowsOut := []dataReference{}
	var oldest uint64
	err = s.db.view(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT COALESCE(min(seq), 0) FROM `+databaseSchema+`.references_log WHERE conversation = $1`, in.Conversation).Scan(&oldest); err != nil {
			return err
		}
		cursor, more := after, true
		for more && len(rowsOut) <= limit {
			rows, err := tx.Query(ctx, `SELECT r.seq, r.at, r.pool, p.generation, r.id, r.revision, r.sha256, r.action, r.origin
				FROM `+databaseSchema+`.references_log r JOIN `+databaseSchema+`.pools p ON p.id = r.pool
				WHERE r.conversation = $1 AND r.seq > $2 AND p.generation = r.generation
				ORDER BY r.seq LIMIT 100`, in.Conversation, cursor)
			if err != nil {
				return err
			}
			candidates := []dataReference{}
			rawCount := 0
			for rows.Next() {
				rawCount++
				var r dataReference
				var at time.Time
				var origin []byte
				if err := rows.Scan(&r.Sequence, &at, &r.Pool, &r.Generation, &r.ID, &r.Revision, &r.SHA256, &r.Action, &origin); err != nil {
					rows.Close()
					return err
				}
				cursor = r.Sequence
				r.At = at.UTC().Format(time.RFC3339Nano)
				_ = jsonUnmarshal(origin, &r.Origin)
				if in.Pool != "" && r.Pool != in.Pool || in.Run != "" && r.Origin.Run != in.Run || r.Origin.Soot != s.actor && !s.manager() {
					continue
				}
				candidates = append(candidates, r)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()
			for _, r := range candidates {
				allowed, err := s.allowed(ctx, tx, r.Pool, "read")
				if err != nil {
					return err
				}
				if allowed {
					rowsOut = append(rowsOut, r)
				}
			}
			more = rawCount == 100
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	next := ""
	if len(rowsOut) > limit {
		rowsOut = rowsOut[:limit]
		next = strconv.FormatUint(rowsOut[len(rowsOut)-1].Sequence, 10)
	}
	return map[string]any{"references": rowsOut, "next": next, "oldest_sequence": oldest}, nil
}
