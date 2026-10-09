package main

import (
	"context"
	"encoding/json"
	"sync"
)

// Policy changes take exclusive admission; document operations share it.
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
func (g *gateway) admit(ctx context.Context, op string, call toolCall) (func(), error) {
	// Reconciliation/UI retain exclusive admission. Ingestion/read hot paths no
	// longer hold a namespace mutex across backend network calls.
	if op != "write" && op != "query" && op != "pools" {
		return g.policy.acquire(ctx, true)
	}
	var input struct {
		Action, Pool, ID string
		RequestID        string `json:"request_id"`
	}
	if err := json.Unmarshal(call.Input, &input); err != nil {
		return nil, err
	}
	var releaseRequest, releaseDocument func()
	if op == "write" {
		var err error
		releaseRequest, err = g.keys.acquire(ctx, "request/"+call.Soot+"/"+input.RequestID)
		if err != nil {
			return nil, err
		}
		if input.Action == "append" {
			input.ID = appendID(call.Soot, input.RequestID)
		}
		releaseDocument, err = g.keys.acquire(ctx, "document/"+input.Pool+"/"+input.ID)
		if err != nil {
			releaseRequest()
			return nil, err
		}
	}
	releasePolicy, err := g.policy.acquire(ctx, false)
	if err != nil {
		if releaseDocument != nil {
			releaseDocument()
			releaseRequest()
		}
		return nil, err
	}
	return func() {
		releasePolicy()
		if releaseDocument != nil {
			releaseDocument()
			releaseRequest()
		}
	}, nil
}

// Only static pre-submission validation messages use this public error type.
type inputError struct{ message string }

func (e inputError) Error() string { return e.message }
