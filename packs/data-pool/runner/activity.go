package main

import (
	"encoding/binary"
	"errors"
	"strconv"
	"time"

	bolt "go.etcd.io/bbolt"
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
func sequenceKey(seq uint64) []byte {
	key := make([]byte, 8)
	binary.BigEndian.PutUint64(key, seq)
	return key
}
func appendActivity(tx *bolt.Tx, a activity) error {
	b, err := tx.Bucket([]byte("activity")).CreateBucketIfNotExists([]byte(a.Pool))
	if err != nil {
		return err
	}
	a.Sequence, err = b.NextSequence()
	if err != nil {
		return err
	}
	a.At = time.Now().UTC().Format(time.RFC3339Nano)
	if err := putJSON(b, string(sequenceKey(a.Sequence)), a); err != nil {
		return err
	}
	if a.Sequence > activityRetention {
		return b.Delete(sequenceKey(a.Sequence - activityRetention))
	}
	return nil
}

// Query results are already bounded and integrity-checked. Never store query
// text, snippets, document content or credentials in the activity index.
func (s *service) recordQuery(in queryInput, result any) error {
	generation, err := s.poolGeneration(in.Pool)
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
	if hits, ok := v["hits"].([]any); ok {
		for _, hit := range hits {
			d := hit.(map[string]any)["document"].(document)
			a.Documents = append(a.Documents, revisionRef{ID: d.ID, Revision: d.Revision})
		}
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		if err := appendActivity(tx, a); err != nil {
			return err
		}
		if in.Action == "read" {
			if d, ok := v["document"].(document); ok {
				return appendReference(tx, s.origin, in.Pool, generation, "read", &d)
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

func (s *service) activities(in activityInput) (any, error) {
	if err := s.authorize(in.Pool, "manage"); err != nil {
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
	next := ""
	oldest := uint64(0)
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("activity")).Bucket([]byte(in.Pool))
		if b == nil {
			return nil
		}
		c := b.Cursor()
		k, _ := c.First()
		if k != nil {
			oldest = binary.BigEndian.Uint64(k)
		}
		k, _ = c.Last()
		if before > 0 {
			k, _ = c.Seek(sequenceKey(before))
			if k == nil {
				k, _ = c.Last()
			} else {
				k, _ = c.Prev()
			}
		}
		for ; k != nil; k, _ = c.Prev() {
			if len(items) == limit {
				next = strconv.FormatUint(items[len(items)-1].Sequence, 10)
				break
			}
			var a activity
			if err := getJSON(b, string(k), &a); err != nil {
				return err
			}
			items = append(items, a)
		}
		return nil
	})
	return map[string]any{"activity": items, "next": next, "retention": activityRetention, "oldest_sequence": oldest}, err
}
