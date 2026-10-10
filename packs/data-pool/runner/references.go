package main

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
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

func appendReference(tx *bolt.Tx, origin *originRef, pool, generation, action string, d *document) error {
	if origin == nil || origin.Conversation == "" || d == nil {
		return nil
	}
	b, err := tx.Bucket([]byte("references")).CreateBucketIfNotExists([]byte(origin.Conversation))
	if err != nil {
		return err
	}
	seq, err := b.NextSequence()
	if err != nil {
		return err
	}
	r := dataReference{Sequence: seq, At: time.Now().UTC().Format(time.RFC3339Nano), Pool: pool, Generation: generation, ID: d.ID, Revision: d.Revision, SHA256: d.SHA256, Action: action, Origin: *origin}
	if err := putJSON(b, string(sequenceKey(seq)), r); err != nil {
		return err
	}
	if seq > referenceRetention {
		return b.Delete(sequenceKey(seq - referenceRetention))
	}
	return nil
}
func (s *service) references(in queryInput) (any, error) {
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
	rows := []dataReference{}
	next := ""
	oldest := uint64(0)
	err = s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("references")).Bucket([]byte(in.Conversation))
		if b == nil {
			return nil
		}
		if b.Sequence() > referenceRetention {
			oldest = b.Sequence() - referenceRetention + 1
		} else if b.Sequence() > 0 {
			oldest = 1
		}
		c := b.Cursor()
		for k, v := c.Seek(sequenceKey(after + 1)); k != nil; k, v = c.Next() {
			var r dataReference
			if err := json.Unmarshal(v, &r); err != nil {
				return err
			}
			if in.Pool != "" && r.Pool != in.Pool || in.Run != "" && r.Origin.Run != in.Run || r.Origin.Soot != s.actor && !s.manager() || !s.allowed(tx, r.Pool, "read") {
				continue
			}
			var p pool
			if getJSON(tx.Bucket([]byte("pools")), r.Pool, &p) != nil || p.Generation != r.Generation {
				continue
			}
			if len(rows) == limit {
				next = strconv.FormatUint(rows[len(rows)-1].Sequence, 10)
				break
			}
			rows = append(rows, r)
		}
		return nil
	})
	return map[string]any{"references": rows, "next": next, "oldest_sequence": oldest}, err
}
