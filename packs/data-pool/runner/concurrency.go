package main

import (
	"context"
	"encoding/json"
	"sync"
)

// Policy changes take exclusive admission; document operations and status share it.
// A queued revoke blocks new readers, and leases extend through response Flush.
type policyGate struct {
	mu               sync.Mutex
	readers, waiting int
	writer           bool
	changed          chan struct{}
}

func (g *policyGate) signal() {
	if g.changed != nil {
		close(g.changed)
	}
	g.changed = make(chan struct{})
}
func (g *policyGate) acquire(ctx context.Context, exclusive bool) (func(), error) {
	g.mu.Lock()
	if exclusive {
		g.waiting++
	}
	for {
		if err := ctx.Err(); err != nil {
			if exclusive {
				g.waiting--
				g.signal()
			}
			g.mu.Unlock()
			return nil, err
		}
		if !g.writer && ((exclusive && g.readers == 0) || (!exclusive && g.waiting == 0)) {
			if exclusive {
				g.waiting--
				g.writer = true
			} else {
				g.readers++
			}
			g.mu.Unlock()
			return func() {
				g.mu.Lock()
				if exclusive {
					g.writer = false
				} else {
					g.readers--
				}
				g.signal()
				g.mu.Unlock()
			}, nil
		}
		if g.changed == nil {
			g.changed = make(chan struct{})
		}
		change := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-change:
		}
		g.mu.Lock()
	}
}

type keyedGate struct {
	mu      sync.Mutex
	entries map[string]*keyGate
}
type keyGate struct {
	token chan struct{}
	refs  int
}

func (g *keyedGate) acquire(ctx context.Context, key string) (func(), error) {
	g.mu.Lock()
	if g.entries == nil {
		g.entries = map[string]*keyGate{}
	}
	entry := g.entries[key]
	if entry == nil {
		entry = &keyGate{token: make(chan struct{}, 1)}
		g.entries[key] = entry
	}
	entry.refs++
	g.mu.Unlock()
	drop := func() {
		g.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(g.entries, key)
		}
		g.mu.Unlock()
	}
	select {
	case entry.token <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-entry.token
			drop()
			return nil, err
		}
		return func() { <-entry.token; drop() }, nil
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	}
}
func appendID(actor, request string) string { return "entry_" + hash(actor + "/" + request)[:40] }
func (g *gateway) admit(ctx context.Context, op, actor string, call toolCall) (func(), error) {
	// UI and management retain exclusive admission. Ingestion, reads and status
	// share it; per-key locks order work on one request or document.
	exclusive := op != "write" && op != "query" && op != "pools" && op != "status"
	var input struct {
		Action, Pool, ID, Owner string
		RequestID               string `json:"request_id"`
	}
	keys := []string{}
	// Malformed input admits with no keys; dispatch's strict decode rejects it
	// before any mutation, so it never needs ordering.
	if !exclusive && json.Unmarshal(call.Input, &input) == nil {
		switch op {
		case "write":
			if input.Action == "append" {
				input.ID = appendID(actor, input.RequestID)
			}
			keys = append(keys, "request/"+actor+"/"+input.RequestID, "document/"+input.Pool+"/"+input.ID)
		case "status":
			// A receipt is written by the same transaction as its effect, so
			// status only needs to ride along with the original request key.
			keys = append(keys, "request/"+ownerOr(input.Owner, actor)+"/"+input.RequestID)
		}
	}
	held := []func(){}
	release := func() {
		for i := len(held) - 1; i >= 0; i-- {
			held[i]()
		}
	}
	for _, key := range keys {
		r, err := g.keys.acquire(ctx, key)
		if err != nil {
			release()
			return nil, err
		}
		held = append(held, r)
	}
	r, err := g.policy.acquire(ctx, exclusive)
	if err != nil {
		release()
		return nil, err
	}
	held = append(held, r)
	return release, nil
}

func ownerOr(owner, actor string) string {
	if owner != "" {
		return owner
	}
	return actor
}

// Only static pre-submission validation messages use this public error type.
type inputError struct{ message string }

func (e inputError) Error() string { return e.message }

// fieldError is an inputError that names the field it refuses, so the access
// log records which rule failed without the caller's values.
type fieldError struct {
	field string
	inputError
}

func (e fieldError) As(target any) bool {
	if p, ok := target.(*inputError); ok {
		*p = e.inputError
		return true
	}
	return false
}

// decodeInput reports a malformed tool input as an inputError, so a remote
// caller learns what to fix exactly as a local one does from stderr.
func decodeInput(raw json.RawMessage, into any) error {
	if err := decodeStrict(raw, into); err != nil {
		return inputError{err.Error() + "; check the tool's parameters"}
	}
	return nil
}
