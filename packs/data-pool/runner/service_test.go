package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

type fakeBackend struct {
	mu                                  sync.Mutex
	docs                                map[string]map[string]storedDocument
	tasks                               map[int64]map[string]any
	next                                int64
	posts                               int
	pending, loseResponse, reject, fail bool
}

func TestPendingDocumentsReserveCapacityAndLocksSerialize(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	if err := s.db.Update(func(tx *bolt.Tx) error { return docsBucket(tx, "company").SetSequence(maxDocuments - 1) }); err != nil {
		t.Fatal(err)
	}
	f.pending = true
	r := writeDoc(t, s, "company", "last-slot", "pending-last", "Pending doc")
	if r.Status != "pending" {
		t.Fatal(r)
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "overflow", RequestID: "overflow", Title: "Overflow", Content: "Another doc"})
	if f.posts != 1 {
		t.Fatal("pending capacity was bypassed")
	}
	other := make(chan *service, 1)
	errs := make(chan error, 1)
	go func() {
		opened, err := openService(s.b, "manager")
		if err != nil {
			errs <- err
		} else {
			other <- opened
		}
	}()
	select {
	case opened := <-other:
		opened.close()
		t.Fatal("state lock did not serialize readers and revocation")
	case err := <-errs:
		t.Fatal(err)
	case <-time.After(50 * time.Millisecond):
	}
	s.db.Close()
	select {
	case opened := <-other:
		opened.close()
	case err := <-errs:
		t.Fatal(err)
	case <-time.After(4 * time.Second):
		t.Fatal("process lock not released")
	}
}

func newFake(t *testing.T) (*fakeBackend, *httptest.Server) {
	f := &fakeBackend{docs: map[string]map[string]storedDocument{}, tasks: map[int64]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}
func (f *fakeBackend) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 2 && parts[0] == "tasks" {
		id, _ := strconv.ParseInt(parts[1], 10, 64)
		if task := f.tasks[id]; task != nil {
			json.NewEncoder(w).Encode(task)
		} else {
			w.WriteHeader(404)
		}
		return
	}
	if len(parts) < 2 || parts[0] != "indexes" {
		w.WriteHeader(404)
		return
	}
	index := parts[1]
	if r.Method == "GET" {
		docs, exists := f.docs[index]
		if !exists {
			w.WriteHeader(404)
			return
		}
		if len(parts) == 2 {
			fmt.Fprint(w, `{"uid":"`+index+`"}`)
			return
		}
		if len(parts) == 4 {
			if d, ok := docs[parts[3]]; ok {
				json.NewEncoder(w).Encode(d)
			} else {
				w.WriteHeader(404)
			}
			return
		}
	}
	if len(parts) == 3 && parts[2] == "search" {
		var in struct {
			Query string `json:"q"`
			Limit int    `json:"limit"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if f.docs[index] == nil {
			w.WriteHeader(404)
			return
		}
		hits := []storedDocument{}
		for _, d := range f.docs[index] {
			if strings.Contains(d.ContentNorm, in.Query) {
				hits = append(hits, d)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"hits": hits})
		return
	}
	f.posts++
	if f.reject {
		w.WriteHeader(403)
		fmt.Fprint(w, "do not expose backend secrets")
		return
	}
	f.next++
	id := f.next
	status := "succeeded"
	if f.pending {
		status = "processing"
	}
	if f.fail {
		status = "failed"
	}
	f.tasks[id] = map[string]any{"uid": id, "indexUid": index, "status": status}
	if !f.fail {
		if r.Method == "POST" {
			var docs []storedDocument
			json.NewDecoder(r.Body).Decode(&docs)
			if f.docs[index] == nil {
				f.docs[index] = map[string]storedDocument{}
			}
			for _, d := range docs {
				f.docs[index][d.ID] = d
			}
		} else if r.Method == "DELETE" {
			if len(parts) == 2 {
				delete(f.docs, index)
			} else {
				delete(f.docs[index], parts[3])
			}
		}
	}
	if f.loseResponse {
		fmt.Fprint(w, `{"invalid":true}`)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"taskUid": id})
}

func testService(t *testing.T, endpoint string) *service {
	b := binding{Endpoint: endpoint, APIKey: "synthetic-test-backend-key", Namespace: "company", StateDir: t.TempDir(), Soots: []string{"manager", "marketing", "support", "writer", "outsider"}, Managers: []string{"manager"}}
	s, err := openService(b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	return s
}
func invoke(t *testing.T, s *service, op string, in any) any {
	t.Helper()
	raw, _ := json.Marshal(in)
	result, err := s.dispatch(context.Background(), op, raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func denied(t *testing.T, s *service, op string, in any) {
	t.Helper()
	raw, _ := json.Marshal(in)
	if _, err := s.dispatch(context.Background(), op, raw); err == nil {
		t.Fatalf("expected denial: %s %+v", op, in)
	}
}
func create(t *testing.T, s *service, id string) {
	invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: id, Name: "Company knowledge", RequestID: "create-" + id})
}
func grant(t *testing.T, s *service, pool, soot, level string) {
	invoke(t, s, "manage", manageInput{Action: "grant", Pool: pool, Soot: soot, Level: level, RequestID: "grant-" + pool + "-" + soot + "-" + level})
}
func writeDoc(t *testing.T, s *service, pool, id, req, text string) receipt {
	return invoke(t, s, "write", writeInput{Action: "upsert", Pool: pool, ID: id, RequestID: req, Title: "Company handbook", Content: text, Source: "urn:company:handbook", Tags: []string{"brand"}}).(receipt)
}

func TestSharedDataPermissionsRevocationAndRestart(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	create(t, s, "private")
	grant(t, s, "company", "marketing", "read")
	grant(t, s, "company", "support", "read")
	grant(t, s, "company", "writer", "write")
	r := writeDoc(t, s, "company", "handbook", "import-1", "Doanh nghiệp Việt Nam — sản phẩm hữu ích.")
	if r.Status != "succeeded" || r.Document.Revision != 1 {
		t.Fatalf("bad receipt %+v", r)
	}
	for _, actor := range []string{"marketing", "support"} {
		s.actor = actor
		read := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"}).(map[string]any)
		if !strings.Contains(read["content"].(string), "Việt Nam") {
			t.Fatal(read)
		}
		denied(t, s, "query", queryInput{Action: "read", Pool: "private", ID: "handbook"})
		denied(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "bad-remove"})
		denied(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "outsider", Level: "read", RequestID: "bad-grant"})
		denied(t, s, "status", statusInput{RequestID: "import-1", Owner: "manager"})
	}
	s.actor = "writer"
	denied(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "outsider", Level: "manage", RequestID: "writer-grant"})
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "revoke", Pool: "company", Soot: "marketing", RequestID: "revoke"})
	s.actor = "marketing"
	denied(t, s, "query", queryInput{Action: "search", Pool: "company", Query: "doanh"})
	pools := invoke(t, s, "pools", poolsInput{}).(map[string]any)["pools"].([]pool)
	if len(pools) != 0 {
		t.Fatal("revoked pool leaked", pools)
	}
	b := s.b
	s.close()
	reopened, err := openService(b, "support")
	if err != nil {
		t.Fatal(err)
	}
	s.db = reopened.db
	s.backend = reopened.backend
	s.actor = "support"
	invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
	if f.posts != 1 {
		t.Fatalf("unexpected backend mutations: %d", f.posts)
	}
}

func TestDuplicateUpdatesAndDeletion(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	r := writeDoc(t, s, "company", "handbook", "import-1", "First document")
	r2 := writeDoc(t, s, "company", "handbook", "import-1", "First document")
	if r2.Document.Revision != r.Document.Revision || f.posts != 1 {
		t.Fatal("duplicate was resent")
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "import-1", Title: "Different", Content: "Second"})
	r2 = writeDoc(t, s, "company", "handbook", "unchanged", "First document")
	if r2.Document.Revision != 1 || f.posts != 1 {
		t.Fatal("unchanged import was rewritten")
	}
	r2 = writeDoc(t, s, "company", "handbook", "import-2", "Second document")
	if r2.Document.Revision != 2 || f.posts != 2 {
		t.Fatal(r2)
	}
	r2 = invoke(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "remove"}).(receipt)
	if r2.Status != "succeeded" {
		t.Fatal(r2)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
	list := invoke(t, s, "query", queryInput{Action: "list", Pool: "company"}).(map[string]any)
	if len(list["documents"].([]document)) != 0 {
		t.Fatal(list)
	}
	create(t, s, "other")
	grant(t, s, "other", "support", "read")
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "drop"})
	if _, err := s.doc("company", "handbook"); err == nil {
		t.Fatal("removed pool survived")
	}
}

func TestUncertainPendingAndFailedEffects(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	grant(t, s, "company", "writer", "write")
	f.loseResponse = true
	s.actor = "writer"
	r := writeDoc(t, s, "company", "handbook", "lost-response", "Durable data")
	if r.Status != "uncertain" || r.Task != nil {
		t.Fatal(r)
	}
	denied(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "new-id"})
	if writeDoc(t, s, "company", "handbook", "lost-response", "Durable data").Status != "uncertain" || f.posts != 1 {
		t.Fatal("uncertain write resent")
	}
	f.loseResponse = false
	r = invoke(t, s, "status", statusInput{RequestID: "lost-response"}).(receipt)
	if r.Status != "succeeded" {
		t.Fatal(r)
	}
	f.pending = true
	r = writeDoc(t, s, "company", "handbook", "pending", "Updated data")
	if r.Status != "pending" {
		t.Fatal(r)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "revoke", Pool: "company", Soot: "writer", RequestID: "revoke-writer"})
	s.actor = "writer"
	denied(t, s, "status", statusInput{RequestID: "pending"})
	s.actor = "manager"
	f.mu.Lock()
	f.tasks[*r.Task]["status"] = "succeeded"
	f.mu.Unlock()
	r = invoke(t, s, "status", statusInput{RequestID: "pending", Owner: "writer"}).(receipt)
	if r.Status != "succeeded" {
		t.Fatal(r)
	}
	if _, err := s.loadReceipt("pending"); err == nil {
		t.Fatal("manager acquired writer's receipt identity")
	}
	f.pending = false
	f.fail = true
	r = writeDoc(t, s, "company", "handbook", "failed", "Will fail")
	if r.Status != "failed" {
		t.Fatal(r)
	}
	f.fail = false
	f.reject = true
	r = writeDoc(t, s, "company", "handbook", "rejected", "Denied by backend")
	if r.Status != "failed" || r.Reason != "backend_rejected" {
		t.Fatal(r)
	}
	f.reject = false
	r = writeDoc(t, s, "company", "handbook", "fixed", "After failure")
	if r.Status != "succeeded" {
		t.Fatal(r)
	}
}

func TestEnvelopeBindingValidationAndNoBackendLeak(t *testing.T) {
	_, srv := newFake(t)
	s := testService(t, srv.URL)
	b := s.b
	s.close()
	rawBinding, _ := json.Marshal(b)
	call := map[string]any{"api_version": "soot/v1", "hook": "tool.call", "soot": "outsider", "operation": "data-pool_pools", "future_field": true, "input": map[string]any{}}
	data, _ := json.Marshal(call)
	var out bytes.Buffer
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "key") || strings.Contains(out.String(), "policy.db") {
		t.Fatal(out.String())
	}
	for _, change := range []map[string]any{{"soot": "intruder"}, {"operation": "data-pool_manage"}, {"input": map[string]any{"soot": "manager"}}, {"input": map[string]any{"root": "/etc"}}, {"api_version": "soot/v2"}} {
		for k, v := range change {
			call[k] = v
		}
		data, _ = json.Marshal(call)
		if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err == nil {
			t.Fatal("accepted forged input", call)
		}
		call["soot"] = "outsider"
		call["operation"] = "data-pool_pools"
		call["input"] = map[string]any{}
		call["api_version"] = "soot/v1"
	}
	for _, endpoint := range []string{"http://remote.example", "https://user:secret@remote.example", "https://remote.example?token=secret", "https://remote.example/path"} {
		b.Endpoint = endpoint
		v, _ := json.Marshal(b)
		if _, err := loadBinding(string(v)); err == nil {
			t.Fatal(endpoint)
		}
	}
}

func TestPaginationIntegrityAndInputBoundaries(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	for _, id := range []string{"a", "b", "c"} {
		writeDoc(t, s, "company", id, "import-"+id, "Công ty đàng hoàng")
	}
	first := invoke(t, s, "query", queryInput{Action: "list", Pool: "company", Limit: 2}).(map[string]any)
	if first["next"] != "b" || len(first["documents"].([]document)) != 2 {
		t.Fatal(first)
	}
	last := invoke(t, s, "query", queryInput{Action: "list", Pool: "company", Limit: 2, After: "b"}).(map[string]any)
	if last["next"] != "" || len(last["documents"].([]document)) != 1 {
		t.Fatal(last)
	}
	for _, in := range []queryInput{{Action: "search", Pool: "company", Query: ""}, {Action: "search", Pool: "company", Query: "company", Limit: 21}, {Action: "list", Pool: "company", After: "../x"}, {Action: "read", Pool: "company", ID: "a", Offset: 2}, {Action: "read", Pool: "company", ID: "../a"}} {
		denied(t, s, "query", in)
	}
	f.mu.Lock()
	d := f.docs[s.index("company")]["a"]
	d.Content = "tampered"
	f.docs[s.index("company")]["a"] = d
	f.mu.Unlock()
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "a"})
	if normalize("ĐÀNG Hoàng Việt Nam") != "dang hoang viet nam" {
		t.Fatal("Vietnamese normalization drift")
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "big", RequestID: "big", Title: "Big", Content: strings.Repeat("x", 13<<10)})
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "nul", RequestID: "nul", Title: "Nul", Content: "bad\x00text"})
}

func TestPoolRemovalClearsHistoricalGrants(t *testing.T) {
	_, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	grant(t, s, "company", "marketing", "read")
	grant(t, s, "company", "support", "write")
	writeDoc(t, s, "company", "old", "old-import", "Old company")
	s.b.Soots = []string{"manager"}
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "remove-company"})
	invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: "company", Name: "New company", RequestID: "new-company"})
	writeDoc(t, s, "company", "new", "new-import", "NEW COMPANY SECRET")
	s.b.Soots = []string{"manager", "marketing", "support"}
	for _, actor := range []string{"marketing", "support"} {
		s.actor = actor
		pools := invoke(t, s, "pools", poolsInput{}).(map[string]any)
		if len(pools["pools"].([]pool)) != 0 {
			t.Fatal("stale pool membership", actor, pools)
		}
		denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "new"})
	}
}

func TestManagerReconcilesRemovedReceiptOwner(t *testing.T) {
	f, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	grant(t, s, "company", "writer", "write")
	f.pending = true
	s.actor = "writer"
	r := writeDoc(t, s, "company", "handbook", "pending-removed", "Durable company data")
	if r.Status != "pending" {
		t.Fatal(r)
	}
	s.b.Soots = []string{"manager", "marketing"}
	s.actor = "marketing"
	denied(t, s, "status", statusInput{RequestID: r.ID, Owner: "writer"})
	f.mu.Lock()
	f.tasks[*r.Task]["status"] = "succeeded"
	f.mu.Unlock()
	s.actor = "manager"
	r = invoke(t, s, "status", statusInput{RequestID: r.ID, Owner: "writer"}).(receipt)
	if r.Status != "succeeded" {
		t.Fatal(r)
	}
	f.pending = false
	if writeDoc(t, s, "company", "handbook", "after-reconcile", "Updated safely").Status != "succeeded" {
		t.Fatal("fence survived")
	}
}

func TestUTF8ReadAlwaysProgressesOrErrors(t *testing.T) {
	_, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	writeDoc(t, s, "company", "unicode", "unicode-import", "Đ😀")
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Limit: 1})
	first := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Limit: 4}).(map[string]any)
	if first["content"] != "Đ" || first["next_offset"] != 2 || first["complete"] != false {
		t.Fatal(first)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Offset: 2, Limit: 3})
	last := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Offset: 2, Limit: 4}).(map[string]any)
	if last["content"] != "😀" || last["next_offset"] != 6 || last["complete"] != true {
		t.Fatal(last)
	}
}

func TestEscapedHostEnvelopeAndWireLimit(t *testing.T) {
	_, srv := newFake(t)
	s := testService(t, srv.URL)
	b := s.b
	s.close()
	rawBinding, _ := json.Marshal(b)
	call := map[string]any{"api_version": "soot/v1", "hook": "tool.call", "soot": "manager", "operation": "data-pool_pools", "input": map[string]any{}, "event": map[string]any{"text": strings.Repeat("<", 16384)}}
	data, _ := json.Marshal(call)
	if len(data) <= 32<<10 {
		t.Fatal("test did not exercise escaped wire size")
	}
	var out bytes.Buffer
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err != nil {
		t.Fatal(err)
	}
	call["event"] = map[string]any{"text": strings.Repeat("<", maxInput)}
	data, _ = json.Marshal(call)
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err == nil {
		t.Fatal("unbounded envelope accepted")
	}
}

func TestReplacementPoolCannotExposeHistoricalReceipts(t *testing.T) {
	_, srv := newFake(t)
	s := testService(t, srv.URL)
	create(t, s, "company")
	grant(t, s, "company", "writer", "write")
	s.actor = "writer"
	old := writeDoc(t, s, "company", "handbook", "old-import", "Old private company data")
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "remove-old"})
	if invoke(t, s, "status", statusInput{Owner: "writer", RequestID: "old-import"}).(receipt).PoolGeneration != old.PoolGeneration {
		t.Fatal("audit identity changed")
	}
	fresh := invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Replacement", RequestID: "create-new"}).(receipt)
	if fresh.PoolGeneration == old.PoolGeneration {
		t.Fatal("pool generation reused")
	}
	grant(t, s, "company", "support", "manage")
	s.actor = "support"
	denied(t, s, "status", statusInput{Owner: "writer", RequestID: "old-import"})
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "writer", Level: "write", RequestID: "new-writer-grant"})
	s.actor = "writer"
	denied(t, s, "status", statusInput{RequestID: "old-import"})
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "old-import", Title: "Company handbook", Content: "Old private company data", Source: "urn:company:handbook", Tags: []string{"brand"}})
	if writeDoc(t, s, "company", "handbook", "new-import", "New company data").PoolGeneration != fresh.PoolGeneration {
		t.Fatal("wrong receipt generation")
	}
}
