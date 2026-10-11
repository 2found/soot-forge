package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

const macHostToken = "synthetic-mac-host-token-1234567890"
const vmHostToken = "synthetic-vm-host-token-12345678900"

// Two machines, each with its own host credential bounded to its own Soots.
func hostConfig(t *testing.T, endpoint string) serverConfig {
	c := gatewayConfig(t, endpoint)
	c.Storage.Writers = []string{"support"}
	c.Clients = append(c.Clients,
		serviceClient{Soot: hostClient, Name: "mac", Soots: []string{"manager", "marketing"}, TokenSHA256: hash(macHostToken)},
		serviceClient{Soot: hostClient, Name: "vm", Soots: []string{"support"}, TokenSHA256: hash(vmHostToken)})
	return c
}
func toolRequest(t *testing.T, g *gateway, token, actor, op string, human bool, in any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(in)
	body, _ := json.Marshal(toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: actor, Operation: "data-pool_" + op, Interaction: human, Input: raw})
	req := httptest.NewRequest("POST", "/v1/tool", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	g.ServeHTTP(w, req)
	return w
}

func TestGatewayParallelReadsShareNoRequestState(t *testing.T) {
	_, backend := newFake(t)
	g, err := newGateway(hostConfig(t, backend.URL))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(g)
	t.Cleanup(func() { server.Close(); g.base.close() })
	for i := 0; i < 8; i++ {
		mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: fmt.Sprintf("pool-%d", i), Name: "Pool", RequestID: fmt.Sprintf("create-%d", i)})
	}
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "pool-0", Soot: "marketing", Level: "read", RequestID: "grant"})
	// Four principals at their concurrency cap: 64 requests in flight, readers
	// probing ungranted pools so every one fills its permission memo.
	principals := []struct{ token, actor string }{{readerToken, "marketing"}, {vmToken, "support"}, {macHostToken, "marketing"}, {vmHostToken, "support"}}
	var wg sync.WaitGroup
	failures := make(chan string, 64*6)
	for _, p := range principals {
		for i := 0; i < perPrincipal; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for round := 0; round < 3; round++ {
					if w := toolRequest(t, g, p.token, p.actor, "pools", false, poolsInput{}); w.Code != 200 {
						failures <- fmt.Sprint(p.actor, w.Code)
					}
					if w := toolRequest(t, g, p.token, p.actor, "pools", false, poolsInput{Pool: "pool-5"}); w.Code != 400 {
						failures <- fmt.Sprint("ungranted detail ", p.actor, w.Code)
					}
				}
			}()
		}
	}
	wg.Wait()
	close(failures)
	for f := range failures {
		t.Fatal(f)
	}
	var page struct{ Pools []pool }
	if json.Unmarshal(toolRequest(t, g, macHostToken, "marketing", "pools", false, poolsInput{}).Body.Bytes(), &page) != nil || len(page.Pools) != 1 || page.Pools[0].ID != "pool-0" {
		t.Fatal("host-claimed reader saw another identity's cached permission", page)
	}
}

func TestHostCredentialsAreBoundedPerMachine(t *testing.T) {
	_, backend := newFake(t)
	c := hostConfig(t, backend.URL)
	var log bytes.Buffer
	g, err := newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	g.accessLog = &log
	call := func(token, actor, op string, human bool, in any) int {
		return toolRequest(t, g, token, actor, op, human, in).Code
	}
	if code := call(macHostToken, "manager", "manage", false, manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create", Scope: "workspace", Level: "write"}); code != 200 {
		t.Fatal("manager role through host credential", code)
	}
	secret := writeInput{Action: "upsert", Pool: "company", ID: "handbook-doc", RequestID: "write", Title: "Handbook", Content: "confidential-body-text"}
	for _, denied := range []struct {
		token, actor, op string
		human            bool
		in               any
	}{
		{macHostToken, "support", "pools", false, poolsInput{}},  // outside mac's allowlist
		{vmHostToken, "marketing", "pools", false, poolsInput{}}, // outside vm's allowlist
		{vmHostToken, "manager", "manage", false, manageInput{}}, // manager not on vm
		{macHostToken, "marketing", "write", false, secret},      // reader role
		{macHostToken, "manager", "view", true, uiInput("overview", map[string]any{})},
		{macHostToken, "manager", "view", false, uiInput("overview", map[string]any{})},
		{macHostToken, "manager", "pools", true, poolsInput{}}, // no human marker on machine credentials
	} {
		if code := call(denied.token, denied.actor, denied.op, denied.human, denied.in); code != 403 {
			t.Fatal("host credential exceeded its allowlist", denied.token[:14], denied.actor, denied.op, code)
		}
	}
	if code := call(vmHostToken, "support", "write", false, secret); code != 200 {
		t.Fatal("writer role through vm host", code)
	}
	if code := call(macHostToken, "marketing", "query", false, queryInput{Action: "search", Pool: "company", Query: "confidential"}); code != 200 {
		t.Fatal("workspace read through mac host", code)
	}
	// The access log names the client and outcome, never secrets or data.
	text := log.String()
	for _, leak := range []string{macHostToken, vmHostToken, "confidential", "handbook-doc", hash(macHostToken)} {
		if strings.Contains(text, leak) {
			t.Fatal("access log leaked", leak)
		}
	}
	var first accessEntry
	if json.Unmarshal([]byte(strings.SplitN(text, "\n", 2)[0]), &first) != nil || first.Client != "host:mac" || first.Soot != "manager" || first.Op != "manage" || first.Status != 200 || first.Time == "" {
		t.Fatal(text)
	}
	if !strings.Contains(text, `"soot":"marketing","client":"host:vm","op":"pools","status":403`) {
		t.Fatal("denial not logged", text)
	}
	// Revoking one machine is removing its client entry; the other keeps working.
	g.base.close()
	c.Clients = c.Clients[:len(c.Clients)-1]
	g, err = newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	defer g.base.close()
	if code := call(vmHostToken, "support", "pools", false, poolsInput{}); code != 401 {
		t.Fatal("revoked host still authenticated", code)
	}
	if code := call(macHostToken, "marketing", "pools", false, poolsInput{}); code != 200 {
		t.Fatal("unrelated host lost access", code)
	}
}

func TestHostClientConfigurationIsExplicit(t *testing.T) {
	base := hostConfig(t, "http://127.0.0.1:7700")
	if err := validateServerConfig(base); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*serviceClient){
		"missing soots":  func(c *serviceClient) { c.Soots = nil },
		"missing name":   func(c *serviceClient) { c.Name = "" },
		"duplicate name": func(c *serviceClient) { c.Name = "vm" },
		"unbound soot":   func(c *serviceClient) { c.Soots = []string{"manager", "stranger"} },
		"repeated soot":  func(c *serviceClient) { c.Soots = []string{"manager", "manager"} },
		"operations":     func(c *serviceClient) { c.Operations = []string{"pools"} },
		"invalid name":   func(c *serviceClient) { c.Name = "mac/../x" },
	} {
		c := hostConfig(t, "http://127.0.0.1:7700")
		mutate(&c.Clients[3])
		err := validateServerConfig(c)
		if err == nil {
			t.Fatal("accepted host client with", name)
		}
		if name == "missing soots" && !strings.Contains(err.Error(), `"soots" allowlist`) {
			t.Fatal("unclear startup error", err)
		}
	}
	c := hostConfig(t, "http://127.0.0.1:7700")
	c.Clients[0].Soots = []string{"manager"}
	if validateServerConfig(c) == nil {
		t.Fatal("per-Soot client accepted an allowlist")
	}
}

func TestWorkspaceGrantIsVisibleCappedAndRevocable(t *testing.T) {
	_, server, _ := organizationFixture(t)
	// Seeding defaults to read and never reaches manage.
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "everyone", Name: "Everyone", Scope: "workspace", Level: "manage", RequestID: "seed-manage"}); err == nil {
		t.Fatal("workspace scope seeded manage")
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "team", Name: "Team", Scope: "group", Subject: "creative", Level: "manage", RequestID: "seed-group-manage"}); err == nil {
		t.Fatal("group scope seeded manage")
	}
	orgManage(t, server, manageInput{Action: "pool_create", Pool: "everyone", Name: "Everyone", Scope: "workspace", RequestID: "seed"})
	detail := func() map[string]any {
		var d map[string]any
		json.Unmarshal(mustRemote(t, server.URL, managerToken, "manager", "pools", poolsInput{Pool: "everyone"}), &d)
		return d
	}
	if grants := detail()["grants"].(map[string]any); grants[workspaceSubject] != "read" {
		t.Fatal("workspace grant hidden or not read by default", grants)
	}
	if len(orgPage(t, server, vmToken, "support", poolsInput{})) != 1 {
		t.Fatal("workspace audience missing")
	}
	write := writeInput{Action: "upsert", Pool: "everyone", ID: "doc", RequestID: "w", Title: "Doc", Content: "text"}
	if _, err := remoteCall(t, server.URL, readerToken, "marketing", "write", write); err == nil {
		t.Fatal("read-level workspace grant allowed write")
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "everyone", Group: workspaceSubject, Level: "manage", RequestID: "grant-manage"}); err == nil {
		t.Fatal("workspace granted manage")
	}
	orgManage(t, server, manageInput{Action: "grant", Pool: "everyone", Group: workspaceSubject, Level: "write", RequestID: "grant-write"})
	mustRemote(t, server.URL, readerToken, "marketing", "write", write)
	orgManage(t, server, manageInput{Action: "revoke", Pool: "everyone", Group: workspaceSubject, RequestID: "revoke"})
	d := detail()
	if _, still := d["grants"].(map[string]any)[workspaceSubject]; still || d["pool"].(map[string]any)["scope"] != "own" {
		t.Fatal("workspace revoke left grant or stale scope", d)
	}
	if len(orgPage(t, server, vmToken, "support", poolsInput{})) != 0 {
		t.Fatal("workspace revoke did not remove access")
	}
}

func TestPrivateNetworkOptIn(t *testing.T) {
	c := gatewayConfig(t, "http://meilisearch:7700")
	c.Listen = "0.0.0.0:8091"
	if validateServerConfig(c) == nil {
		t.Fatal("cleartext public listen or named http backend without private_network")
	}
	c.PrivateNetwork = true
	if err := validateServerConfig(c); err != nil {
		t.Fatal(err)
	}
	for endpoint, ok := range map[string]bool{"http://10.1.2.3:7700": true, "http://[fd00::5]:7700": true, "http://8.8.8.8:7700": false, "http://169.254.169.254": false, "ftp://meilisearch": false} {
		c.Storage.Endpoint = endpoint
		if (validateServerConfig(c) == nil) != ok {
			t.Fatal("private backend validation", endpoint)
		}
	}
	// Direct-mode bindings never gain the opt-in.
	raw, _ := json.Marshal(binding{Endpoint: "http://meilisearch:7700", APIKey: "synthetic-backend-key-1234567890", Namespace: "company", StateDir: "/tmp/x", Soots: []string{"manager"}, Managers: []string{"manager"}})
	if _, err := loadBinding(string(raw)); err == nil {
		t.Fatal("direct mode accepted named http backend")
	}
	dials := []string{}
	dial := func(_ context.Context, _, address string) (net.Conn, error) {
		dials = append(dials, address)
		a, b := net.Pipe()
		b.Close()
		return a, nil
	}
	answers := func(ips ...string) lookupFunc {
		return func(context.Context, string, string) ([]netip.Addr, error) {
			out := []netip.Addr{}
			for _, ip := range ips {
				out = append(out, netip.MustParseAddr(ip))
			}
			return out, nil
		}
	}
	for _, bad := range [][]string{{"172.18.0.2", "93.184.216.34"}, {"169.254.169.254"}, {"100.64.0.1"}} {
		if _, err := guardedDial(context.Background(), "tcp", "meilisearch:7700", privateAddress, answers(bad...), dial); err == nil {
			t.Fatal("dialed non-private backend answer", bad)
		}
	}
	conn, err := guardedDial(context.Background(), "tcp", "meilisearch:7700", privateAddress, answers("172.18.0.2", "::ffff:10.0.0.9"), dial)
	if err != nil || len(dials) != 1 || dials[0] != "172.18.0.2:7700" {
		t.Fatal("private backend not pinned", err, dials)
	}
	conn.Close()
	if newBackend(binding{Endpoint: "https://search.example.com"}).client.Transport.(*http.Transport).DialContext != nil {
		t.Fatal("HTTPS backend should use the default dialer")
	}
	if newBackend(binding{Endpoint: "http://meilisearch:7700"}).client.Transport.(*http.Transport).DialContext == nil {
		t.Fatal("cleartext backend dial is unguarded")
	}
}

func TestStatusSharesAdmissionAndPrincipalsAreCapped(t *testing.T) {
	f, backend := newFake(t)
	g, err := newGateway(gatewayConfig(t, backend.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer g.base.close()
	s := g.session("manager")
	create(t, s, "company")
	grant(t, s, "company", "marketing", "read")
	f.pending = true
	writeDoc(t, s, "company", "doc", "pending", "Pending text")
	f.pending = false
	status := func(token, actor string) chan int {
		done := make(chan int, 1)
		go func() {
			done <- toolRequest(t, g, token, actor, "status", false, statusInput{RequestID: "pending"}).Code
		}()
		return done
	}
	// An in-flight read holds shared admission; status no longer waits on it.
	read, _ := g.policy.acquire(context.Background(), false)
	select {
	case code := <-status(readerToken, "marketing"):
		if code != 400 { // marketing owns no such request
			t.Fatal(code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("status waited for exclusive admission")
	}
	// Reconciling the pending write serializes with that request's own key.
	held, _ := g.keys.acquire(context.Background(), "request/manager/pending")
	done := status(managerToken, "manager")
	select {
	case <-done:
		t.Fatal("status reconciled while its request was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	held()
	if code := <-done; code != 200 {
		t.Fatal(code)
	}
	read()
	// An unresolved pool removal still takes exclusive admission.
	if err := g.base.db.Update(func(tx *bolt.Tx) error {
		return putJSON(tx.Bucket([]byte("receipts")), "manager/removal", receipt{ID: "removal", Owner: "manager", Pool: "company", Action: "pool_remove", Status: "uncertain"})
	}); err != nil {
		t.Fatal(err)
	}
	read, _ = g.policy.acquire(context.Background(), false)
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	input, _ := json.Marshal(statusInput{RequestID: "removal"})
	if release, err := g.admit(short, "status", "manager", toolCall{Input: input}); err == nil {
		release()
		t.Fatal("pool removal reconciliation shared admission")
	}
	read()
	// One principal cannot hold more than its share of the global slots.
	key := hash(readerToken) + "/marketing"
	for i := 0; i < perPrincipal; i++ {
		g.enter(key)
	}
	if w := toolRequest(t, g, readerToken, "marketing", "pools", false, poolsInput{}); w.Code != 429 || strings.Contains(w.Body.String(), "marketing") {
		t.Fatal("principal cap", w.Code, w.Body)
	}
	if w := toolRequest(t, g, vmToken, "support", "pools", false, poolsInput{}); w.Code != 200 {
		t.Fatal("cap leaked to another principal", w.Code)
	}
	for i := 0; i < perPrincipal; i++ {
		g.leave(key)
	}
	if w := toolRequest(t, g, readerToken, "marketing", "pools", false, poolsInput{}); w.Code != 200 || len(g.active) != 0 {
		t.Fatal("cap not released", w.Code, g.active)
	}
}

func TestReadinessConfigEnvAndHealthcheck(t *testing.T) {
	_, backend := newFake(t)
	c := gatewayConfig(t, backend.URL)
	g, err := newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	probe := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	if w := probe("/readyz"); w.Code != 200 || w.Body.String() != "{\"status\":\"ready\"}\n" {
		t.Fatal(w.Code, w.Body)
	}
	backend.Close()
	g.readyAt = time.Time{}
	if w := probe("/readyz"); w.Code != 503 || strings.Contains(w.Body.String(), "127.0.0.1") {
		t.Fatal("unready backend reported ready", w.Code, w.Body)
	}
	if w := probe("/healthz"); w.Code != 200 {
		t.Fatal("liveness depends on backend")
	}
	g.base.close()
	_, backend = newFake(t)
	c.Storage.Endpoint = backend.URL
	g.readyAt = time.Time{}
	g.base.backend = newBackend(binding{Endpoint: backend.URL, APIKey: "synthetic-backend-key-1234567890"})
	if w := probe("/readyz"); w.Code != 503 {
		t.Fatal("closed policy DB reported ready")
	}

	data, _ := json.Marshal(c)
	t.Setenv("DP_CONFIG", string(data))
	if got, err := readServiceConfig([]string{"--config-env", "DP_CONFIG"}); err != nil || got.Storage.Namespace != "company" {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"listen":"x","unknown":1}`, strings.Repeat(" ", maxConfig+1) + "{}", ""} {
		t.Setenv("DP_CONFIG", bad)
		if _, err := readServiceConfig([]string{"--config-env", "DP_CONFIG"}); err == nil {
			t.Fatal("accepted invalid environment config")
		}
	}
	for _, args := range [][]string{{"--config-env", "BAD-NAME"}, {"--config-env"}, {"--config", "a", "b"}} {
		if _, err := readServiceConfig(args); err == nil {
			t.Fatal("accepted", args)
		}
	}
	path := filepath.Join(t.TempDir(), "service.json")
	os.WriteFile(path, data, 0644)
	if _, err := readServiceConfig([]string{"--config", path}); err == nil {
		t.Fatal("accepted a group/world-readable config file")
	}
	os.Chmod(path, 0600)
	if _, err := readServiceConfig([]string{"--config", path}); err != nil {
		t.Fatal(err)
	}

	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			w.WriteHeader(503)
		}
	}))
	defer healthy.Close()
	if healthcheck([]string{healthy.URL + "/healthz"}) != nil || healthcheck([]string{healthy.URL + "/down"}) == nil || healthcheck([]string{"file:///etc/passwd"}) == nil || healthcheck([]string{"a", "b"}) == nil {
		t.Fatal("healthcheck outcome")
	}
}
