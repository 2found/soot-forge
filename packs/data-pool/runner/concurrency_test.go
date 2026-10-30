package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayParallelAppendAndSameIntentReplay(t *testing.T) {
	// One principal may hold perPrincipal requests at once; fill exactly that.
	const n = perPrincipal
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"})
	results := make(chan receipt, n)
	failures := make(chan error, n)
	for i := range n {
		go func() {
			raw, err := remoteCall(t, server.URL, managerToken, "manager", "write", writeInput{Action: "append", Pool: "company", RequestID: fmt.Sprintf("append-%d", i), Title: "Duplicate is okay", Content: "Same content from independent collectors"})
			if err != nil {
				failures <- err
				return
			}
			var r receipt
			if err = json.Unmarshal(raw, &r); err != nil {
				failures <- err
				return
			}
			results <- r
		}()
	}
	docs := map[string]bool{}
	for range n {
		select {
		case err := <-failures:
			t.Fatal(err)
		case r := <-results:
			if r.Status != "succeeded" || r.Document.Revision != 1 || docs[r.Document.ID] {
				t.Fatal(r)
			}
			docs[r.Document.ID] = true
		}
	}
	if len(docs) != n {
		t.Fatal("independent writes did not all land")
	}
	for i := range n {
		var r receipt
		raw := mustRemote(t, server.URL, managerToken, "manager", "write", writeInput{Action: "append", Pool: "company", RequestID: fmt.Sprintf("append-%d", i), Title: "Duplicate is okay", Content: "Same content from independent collectors"})
		if json.Unmarshal(raw, &r) != nil || !r.Replay || !docs[r.Document.ID] {
			t.Fatal(string(raw))
		}
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "write", writeInput{Action: "append", Pool: "company", RequestID: "append-0", Title: "Changed", Content: "different"}); err == nil {
		t.Fatal("request ID conflict accepted")
	}
}

func TestGatewayConcurrentRevisionGuard(t *testing.T) {
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"})
	zero := 0
	const n = 12
	results := make(chan error, n)
	for i := range n {
		go func() {
			_, e := remoteCall(t, server.URL, managerToken, "manager", "write", writeInput{Action: "upsert", Pool: "company", ID: "one", RequestID: fmt.Sprintf("guard-%d", i), Title: "One", Content: fmt.Sprint(i), ExpectedRevision: &zero})
			results <- e
		}()
	}
	success := 0
	for range n {
		if <-results == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("revision guard lost", success)
	}
	var page struct{ Documents []document }
	json.Unmarshal(mustRemote(t, server.URL, managerToken, "manager", "query", queryInput{Action: "list", Pool: "company"}), &page)
	if len(page.Documents) != 1 || page.Documents[0].Revision != 1 {
		t.Fatal("stale writes reached storage", page)
	}
}

func TestPolicyRevokeDoesNotStarveOrLeakCancelledAdmission(t *testing.T) {
	var gate policyGate
	read, err := gate.acquire(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		release, err := gate.acquire(ctx, true)
		if release != nil {
			release()
		}
		done <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		gate.mu.Lock()
		waiting := gate.waiting
		gate.mu.Unlock()
		if waiting == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("writer not queued")
		}
		time.Sleep(time.Millisecond)
	}
	short, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if release, err := gate.acquire(short, false); err == nil {
		release()
		t.Fatal("new reader starved revoke")
	}
	cancel()
	if <-done != context.Canceled {
		t.Fatal("cancel ignored")
	}
	read()
	release, err := gate.acquire(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestPoolLooseMetadataAndPublicValidation(t *testing.T) {
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"})
	// Missing display metadata must not trigger another paid model turn. Inline
	// content plus a provenance URL must not unexpectedly fetch that URL.
	g.base.fetch = func(string) (string, error) { t.Error("inline data unexpectedly fetched URL"); return "", nil }
	for _, in := range []writeInput{
		{Action: "upsert", Pool: "company", ID: "one", RequestID: "one", Content: "inline without title"},
		{Action: "append", Pool: "company", RequestID: "two", Content: "inline with redundant URL", URL: "https://example.com/article", Source: "https://example.com/article"},
	} {
		var r receipt
		raw := mustRemote(t, server.URL, managerToken, "manager", "write", in)
		if json.Unmarshal(raw, &r) != nil || r.Status != "succeeded" || r.Document.Title == "" {
			t.Fatal(string(raw))
		}
	}
	_, err := remoteCall(t, server.URL, managerToken, "manager", "write", writeInput{Action: "append", Pool: "company", ID: "chosen", RequestID: "bad", Content: "bad"})
	if err == nil || !strings.Contains(err.Error(), "invalid input; no mutation submitted") {
		t.Fatal("lost actionable validation", err)
	}
	var page struct{ Documents []document }
	json.Unmarshal(mustRemote(t, server.URL, managerToken, "manager", "query", queryInput{Action: "list", Pool: "company"}), &page)
	if len(page.Documents) != 2 {
		t.Fatal("invalid input changed storage", page)
	}
	_, err = remoteCall(t, server.URL, managerToken, "manager", "write", writeInput{Action: "append", Pool: "company", RequestID: "ambiguous", Content: "inline", Source: "https://example.com/one", URL: "https://example.com/two"})
	if err == nil {
		t.Fatal("ambiguous provenance accepted")
	}
}
