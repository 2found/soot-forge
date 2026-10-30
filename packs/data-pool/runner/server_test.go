package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const managerToken = "synthetic-manager-token-1234567890"
const readerToken = "synthetic-reader-token-12345678900"
const vmToken = "synthetic-vm-token-1234567890000000"

func remoteCall(t *testing.T, endpoint, token, actor, op string, in any) ([]byte, error) {
	t.Helper()
	input, _ := json.Marshal(in)
	call := toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: actor, Operation: "data-pool_" + op, Input: input}
	envelope, _ := json.Marshal(call)
	raw, _ := json.Marshal(binding{ServiceURL: endpoint, ServiceToken: token})
	var out bytes.Buffer
	err := execute(context.Background(), []string{op}, bytes.NewReader(envelope), &out, string(raw))
	return out.Bytes(), err
}
func mustRemote(t *testing.T, endpoint, token, actor, op string, in any) []byte {
	t.Helper()
	data, err := remoteCall(t, endpoint, token, actor, op, in)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestGatewaySharesPolicyAcrossClientsAndRestarts(t *testing.T) {
	cfg := serverConfig{Storage: freshBinding(t)}
	_, server := newTestGatewayWith(t, cfg)
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"})
	for _, actor := range []string{"marketing", "support"} {
		mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "company", Soot: actor, Level: "read", RequestID: "grant-" + actor})
	}
	write := writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "import", Title: "Company", Content: "Việt Nam — shared source"}
	mustRemote(t, server.URL, managerToken, "manager", "write", write)
	read := queryInput{Action: "read", Pool: "company", ID: "handbook"}
	for _, client := range []struct{ actor, token string }{{"marketing", readerToken}, {"support", vmToken}} {
		out := mustRemote(t, server.URL, client.token, client.actor, "query", read)
		if !strings.Contains(string(out), "Việt Nam") {
			t.Fatal(string(out))
		}
	}
	// Both clients share the durable receipt; duplicate mutation never reimports.
	if out := mustRemote(t, server.URL, managerToken, "manager", "write", write); !strings.Contains(string(out), `"replay":true`) {
		t.Fatal(string(out))
	}
	for _, test := range []struct {
		token, actor, op string
		input            any
	}{
		{strings.Repeat("x", 32), "manager", "query", read},
		{readerToken, "manager", "query", read},
		{readerToken, "marketing", "write", write},
		{vmToken, "support", "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "forge"}},
		{readerToken, "marketing", "query", map[string]any{"action": "read", "pool": "company", "id": "handbook", "soot": "manager"}},
	} {
		out, e := remoteCall(t, server.URL, test.token, test.actor, test.op, test.input)
		if e == nil || len(out) != 0 {
			t.Fatal("forged identity/operation/input accepted")
		}
	}
	// A malformed input names what to fix over the service, as it does locally.
	for _, test := range []struct {
		op    string
		input any
		want  string
	}{
		{"query", map[string]any{"action": "read", "pool": "company", "id": "handbook", "bogus": 1}, "check the tool's parameters"},
		{"status", map[string]any{}, "request_id"},
	} {
		if _, e := remoteCall(t, server.URL, vmToken, "support", test.op, test.input); e == nil || !strings.Contains(e.Error(), test.want) {
			t.Fatalf("%s: invalid input not explained: %v", test.op, e)
		}
	}
	// A guessed collection ID points the agent at discovery and creation, with
	// one answer for missing and forbidden so it is no existence oracle.
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "private", Name: "Private", RequestID: "create-private"})
	var answers []string
	for _, pool := range []string{"ghost", "private"} {
		_, e := remoteCall(t, server.URL, vmToken, "support", "pools", poolsInput{Pool: pool})
		if e == nil || !strings.Contains(e.Error(), "data-pool_pools without a pool argument") {
			t.Fatalf("%s: inaccessible collection not explained: %v", pool, e)
		}
		answers = append(answers, strings.Replace(e.Error(), pool, "ID", 1))
	}
	if answers[0] != answers[1] {
		t.Fatalf("missing and forbidden collections answer differently: %q vs %q", answers[0], answers[1])
	}
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "revoke", Pool: "company", Soot: "marketing", RequestID: "revoke"})
	if out, e := remoteCall(t, server.URL, readerToken, "marketing", "query", read); e == nil || len(out) > 0 {
		t.Fatal("revoke not shared")
	}
	mustRemote(t, server.URL, vmToken, "support", "query", read)
}

// newTestGatewayWith starts a gateway over a binding the caller already reset
// (and its own client list unless the caller supplied one).
func newTestGatewayWith(t *testing.T, c serverConfig) (*gateway, *httptest.Server) {
	t.Helper()
	c.Listen = "127.0.0.1:0"
	if len(c.Clients) == 0 {
		c.Clients = []serviceClient{
			{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations},
			{Soot: "marketing", TokenSHA256: hash(readerToken), Operations: []string{"pools", "query", "status"}},
			{Soot: "support", TokenSHA256: hash(vmToken), Operations: []string{"pools", "query", "status"}},
		}
	}
	g, err := newGateway(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(g)
	t.Cleanup(func() { server.Close(); g.base.close() })
	return g, server
}

func TestRemoteTransportNeverRedirectsOrRetriesAndBoundsResponses(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; io.WriteString(w, "{}") }))
	defer target.Close()
	for _, kind := range []string{"redirect", "error", "oversize", "invalid"} {
		originCalls := 0
		origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			originCalls++
			switch kind {
			case "redirect":
				http.Redirect(w, r, target.URL, 307)
			case "error":
				http.Error(w, "secret backend diagnostic", 500)
			case "oversize":
				io.WriteString(w, strings.Repeat(" ", maxOutput+1))
			case "invalid":
				io.WriteString(w, "not JSON")
			}
		}))
		data, err := remoteCall(t, origin.URL, managerToken, "manager", "write", writeInput{RequestID: "stable"})
		origin.Close()
		if err == nil || len(data) != 0 || originCalls != 1 || calls != 0 || strings.Contains(err.Error(), "secret") {
			t.Fatal(kind, data, err, originCalls, calls)
		}
	}
}
func TestRemoteAndServerConfigurationRejectsAmbiguousOrInsecureBindings(t *testing.T) {
	for _, raw := range []string{
		`{"service_url":"http://remote.example.com","service_token":"` + readerToken + `"}`,
		`{"service_url":"https://example.com/path","service_token":"` + readerToken + `"}`,
		`{"service_url":"https://example.com","service_token":"` + readerToken + `","database_url":"postgres://x/y"}`,
		`{"service_url":"https://example.com","service_token":"short"}`,
	} {
		if _, err := loadBinding(raw); err == nil {
			t.Fatal("unsafe binding", raw)
		}
	}
	c := serverConfig{Storage: freshBinding(t), Listen: "127.0.0.1:0"}
	if err := validateServerConfig(c); err == nil {
		t.Fatal("missing clients accepted")
	}
	c.Clients = []serviceClient{{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations}}
	if err := validateServerConfig(c); err != nil {
		t.Fatal(err)
	}
	c.Listen = "0.0.0.0:8091"
	if validateServerConfig(c) == nil {
		t.Fatal("insecure listener")
	}
	c.Listen = "127.0.0.1:0"
	c.Clients = append(c.Clients, serviceClient{Soot: "marketing", TokenSHA256: hash(managerToken), Operations: []string{"pools"}})
	if validateServerConfig(c) == nil {
		t.Fatal("duplicate token")
	}
}

type blockedWriter struct {
	header           http.Header
	entered, release chan struct{}
}

func (w *blockedWriter) Header() http.Header { return w.header }
func (w *blockedWriter) WriteHeader(int)     {}
func (w *blockedWriter) Write(b []byte) (int, error) {
	close(w.entered)
	<-w.release
	return len(b), nil
}
func TestGatewayRevokeWaitsForReadPublication(t *testing.T) {
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	s := g.session(context.Background(), "manager")
	create(t, s, "company")
	grant(t, s, "company", "marketing", "read")
	writeDoc(t, s, "company", "doc", "import", "Saved content")
	input, _ := json.Marshal(queryInput{Action: "read", Pool: "company", ID: "doc"})
	data, _ := json.Marshal(toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "marketing", Operation: "data-pool_query", Input: input})
	req := httptest.NewRequest("POST", "/v1/tool", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+readerToken)
	writer := &blockedWriter{header: http.Header{}, entered: make(chan struct{}), release: make(chan struct{})}
	readDone := make(chan struct{})
	go func() { g.ServeHTTP(writer, req); close(readDone) }()
	<-writer.entered
	revInput, _ := json.Marshal(manageInput{Action: "revoke", Pool: "company", Soot: "marketing", RequestID: "revoke"})
	revData, _ := json.Marshal(toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "manager", Operation: "data-pool_manage", Input: revInput})
	revoke := httptest.NewRequest("POST", "/v1/tool", bytes.NewReader(revData))
	revoke.Header.Set("Authorization", "Bearer "+managerToken)
	revoked := make(chan struct{})
	rec := httptest.NewRecorder()
	go func() { g.ServeHTTP(rec, revoke); close(revoked) }()
	select {
	case <-revoked:
		t.Fatal("revoke published before previous read")
	case <-time.After(50 * time.Millisecond):
	}
	close(writer.release)
	<-readDone
	<-revoked
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	// A fresh read is rejected after revoke.
	req = httptest.NewRequest("POST", "/v1/tool", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+readerToken)
	denial := httptest.NewRecorder()
	g.ServeHTTP(denial, req)
	if denial.Code == 200 {
		t.Fatal("late read allowed")
	}
}

func TestGatewayBoundsBodiesAndWaitingRequests(t *testing.T) {
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	for i := range cap(g.slots) {
		_ = i
		g.slots <- struct{}{}
	}
	req := httptest.NewRequest("POST", "/v1/tool", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+readerToken)
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	if rec.Code != 503 {
		t.Fatal("admitted unbounded work", rec.Code)
	}
	for range cap(g.slots) {
		<-g.slots
	}
	req = httptest.NewRequest("POST", "/v1/tool", strings.NewReader(strings.Repeat(" ", maxInput+1)))
	req.Header.Set("Authorization", "Bearer "+readerToken)
	rec = httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	if rec.Code == 200 {
		t.Fatal("unbounded body accepted")
	}
}

func TestGatewayHumanOperationsRequireSeparateScopeAndPreserveAuditOnRestart(t *testing.T) {
	uiToken := "synthetic-ui-token-123456789000000000"
	cfg := serverConfig{Storage: freshBinding(t), Clients: []serviceClient{
		{Soot: "manager", TokenSHA256: hash(managerToken), Operations: []string{"pools", "query", "write", "manage", "status"}},
		{Soot: "manager", TokenSHA256: hash(uiToken), Operations: []string{"view", "action"}},
	}}
	g, server := newTestGatewayWith(t, cfg)
	call := func(token, op string, human bool, input any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(input)
		body, _ := json.Marshal(toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "manager", Operation: "data-pool_" + op, Interaction: human, Input: raw})
		req := httptest.NewRequest("POST", "/v1/tool", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		return w
	}
	for _, candidate := range []struct {
		token, op string
		human     bool
	}{{managerToken, "view", true}, {uiToken, "view", false}, {uiToken, "manage", true}} {
		if w := call(candidate.token, candidate.op, candidate.human, uiInput("overview", map[string]any{})); w.Code == 200 {
			t.Fatal("forged human operation accepted", candidate)
		}
	}
	if w := call(uiToken, "action", true, uiInput("manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "human-create"})); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	generation, _ := g.base.poolGeneration(context.Background(), "company")
	w := writeInput{Action: "upsert", Pool: "company", ID: "doc", RequestID: "human-write", Title: "Doc", Content: "Saved privately", Generation: generation, ExpectedRevision: pointer(0)}
	if out := call(uiToken, "action", true, uiInput("write", w)); out.Code != 200 || !strings.Contains(out.Body.String(), `"kind":"human"`) {
		t.Fatal(out.Code, out.Body)
	}
	// A forged interaction marker on an ordinary agent operation cannot change
	// the writer kind. UI tokens cannot call that operation at all.
	w.RequestID = "agent-write"
	w.ExpectedRevision = nil
	w.Content = "Agent update"
	if out := call(managerToken, "write", true, w); out.Code != 200 || !strings.Contains(out.Body.String(), `"kind":"soot"`) {
		t.Fatal(out.Code, out.Body)
	}
	server.Close()
	g.base.close()
	cfg.Listen = "127.0.0.1:0"
	next, err := newGateway(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(next.base.close)
	restarted := httptest.NewServer(next)
	defer restarted.Close()
	g = next
	out := call(uiToken, "view", true, uiInput("activity", activityInput{Pool: "company", Limit: 20}))
	var page struct {
		Activity []activity `json:"activity"`
	}
	if out.Code != 200 || json.Unmarshal(out.Body.Bytes(), &page) != nil || len(page.Activity) < 3 {
		t.Fatal(out.Code, out.Body)
	}
	kinds := map[string]bool{}
	for _, a := range page.Activity {
		kinds[a.Actor.Kind] = true
		if a.Pool != "company" {
			t.Fatal("activity lost its pool", a)
		}
	}
	if !kinds["human"] || !kinds["soot"] {
		t.Fatal("activity lost provenance", kinds)
	}
}
