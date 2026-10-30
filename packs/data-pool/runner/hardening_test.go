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
)

const macHostToken = "synthetic-mac-host-token-1234567890"
const vmHostToken = "synthetic-vm-host-token-12345678900"

// Two machines, each with its own host credential bounded to its own Soots.
func hostConfig(t *testing.T) serverConfig {
	c := serverConfig{Storage: freshBinding(t), Listen: "127.0.0.1:0", Clients: []serviceClient{
		{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations},
		{Soot: "marketing", TokenSHA256: hash(readerToken), Operations: []string{"pools", "query", "status"}},
		{Soot: "support", TokenSHA256: hash(vmToken), Operations: []string{"pools", "query", "status"}},
		{Soot: hostClient, Name: "mac", Soots: []string{"manager", "marketing"}, TokenSHA256: hash(macHostToken)},
		{Soot: hostClient, Name: "vm", Soots: []string{"support"}, TokenSHA256: hash(vmHostToken)},
	}}
	c.Storage.Writers = []string{"support"}
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
	g, server := newTestGatewayWith(t, hostConfig(t))
	for i := range 8 {
		mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: fmt.Sprintf("pool-%d", i), Name: "Pool", RequestID: fmt.Sprintf("create-%d", i)})
	}
	mustRemote(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "pool-0", Soot: "marketing", Level: "read", RequestID: "grant"})
	// Four principals at their concurrency cap: readers probing ungranted pools
	// so every one fills its permission memo.
	principals := []struct{ token, actor string }{{readerToken, "marketing"}, {vmToken, "support"}, {macHostToken, "marketing"}, {vmHostToken, "support"}}
	var wg sync.WaitGroup
	failures := make(chan string, 64*6)
	for _, p := range principals {
		for range perPrincipal {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range 3 {
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
	c := hostConfig(t)
	var log bytes.Buffer
	g, err := newGateway(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { g.base.close() })
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
		{macHostToken, "marketing", "write", false, secret}, // reader role
		{macHostToken, "manager", "view", true, uiInput("overview", map[string]any{})},
		{macHostToken, "manager", "view", false, uiInput("overview", map[string]any{})},
		{macHostToken, "manager", "pools", true, poolsInput{}}, // no human marker on machine credentials
	} {
		if code := call(denied.token, denied.actor, denied.op, denied.human, denied.in); code != 403 {
			t.Fatal("host credential exceeded its allowlist", denied.token[:14], denied.actor, denied.op, code)
		}
	}
	// A Soot outside a machine's allowlist (and not admitted for it) is refused
	// with a reason the model can act on, never with data.
	for _, outside := range []struct{ token, actor, op string }{
		{macHostToken, "support", "pools"}, {vmHostToken, "marketing", "pools"}, {vmHostToken, "manager", "manage"},
	} {
		w := toolRequest(t, g, outside.token, outside.actor, outside.op, false, poolsInput{})
		if w.Code != 400 || !strings.Contains(w.Body.String(), "not admitted to the shared data pool") || strings.Contains(w.Body.String(), "company") {
			t.Fatal("host credential exceeded its allowlist", outside.token[:14], outside.actor, outside.op, w.Code, w.Body.String())
		}
	}
	if code := call(vmHostToken, "support", "write", false, secret); code != 200 {
		t.Fatal("writer role through vm host", code)
	}
	if code := call(macHostToken, "marketing", "query", false, queryInput{Action: "search", Pool: "company", Query: "confidential"}); code != 200 {
		t.Fatal("workspace read through mac host", code)
	}
	// A refused write names the one field it got wrong, to the Soot and in the log.
	bad := secret
	bad.ID, bad.RequestID = "leaky id", "write-2"
	if w := toolRequest(t, g, vmHostToken, "support", "write", false, bad); w.Code != 400 || !strings.Contains(w.Body.String(), `id \"leaky id\" is not a document ID`) || strings.Contains(w.Body.String(), "pool") {
		t.Fatal("refusal does not name the bad field", w.Code, w.Body.String())
	}
	// Without a pool or a default, the refusal names the collections it may write.
	bad.ID, bad.Pool, bad.RequestID = "handbook-doc", "", "write-3"
	if w := toolRequest(t, g, vmHostToken, "support", "write", false, bad); w.Code != 400 || !strings.Contains(w.Body.String(), "it may write to: company") {
		t.Fatal("missing pool does not name the writable collections", w.Code, w.Body.String())
	}
	// The access log names the client and outcome, never secrets or data.
	text := log.String()
	if !strings.Contains(text, `"op":"write","status":400,`) || !strings.Contains(text, `"refused":"write.id"`) {
		t.Fatal("refused rule not logged", text)
	}
	for _, leak := range []string{macHostToken, vmHostToken, "confidential", "handbook-doc", "leaky", hash(macHostToken)} {
		if strings.Contains(text, leak) {
			t.Fatal("access log leaked", leak)
		}
	}
	var first accessEntry
	if json.Unmarshal([]byte(strings.SplitN(text, "\n", 2)[0]), &first) != nil || first.Client != "host:mac" || first.Soot != "manager" || first.Op != "manage" || first.Status != 200 || first.Time == "" {
		t.Fatal(text)
	}
	if !strings.Contains(text, `"soot":"marketing","client":"host:vm","op":"pools","status":400`) || !strings.Contains(text, `"refused":"soot.unadmitted"`) {
		t.Fatal("denial not logged", text)
	}
	// Revoking one machine is removing its client entry; the other keeps working.
	g.base.close()
	c.Clients = c.Clients[:len(c.Clients)-1]
	g, err = newGateway(context.Background(), c)
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
	base := hostConfig(t)
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
		c := hostConfig(t)
		mutate(&c.Clients[3])
		err := validateServerConfig(c)
		if err == nil {
			t.Fatal("accepted host client with", name)
		}
		if name == "missing soots" && !strings.Contains(err.Error(), `"soots" allowlist`) {
			t.Fatal("unclear startup error", err)
		}
	}
	c := hostConfig(t)
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
	c := hostConfig(t)
	c.Listen = "0.0.0.0:8091"
	if validateServerConfig(c) == nil {
		t.Fatal("cleartext public listen without private_network")
	}
	c.PrivateNetwork = true
	c.Storage.DatabaseURL = "postgres://user:secret@postgres:5432/app?sslmode=disable"
	if err := validateServerConfig(c); err != nil {
		t.Fatal(err)
	}
	for dsn, ok := range map[string]bool{
		"postgres://user:secret@10.1.2.3:5432/app?sslmode=disable":   true,
		"postgres://user:secret@[fd00::5]:5432/app?sslmode=disable":  true,
		"postgres://user:secret@8.8.8.8:5432/app?sslmode=disable":    false,
		"postgres://user:secret@169.254.169.254/app?sslmode=disable": false,
		"mysql://user:secret@10.1.2.3/app":                           false,
	} {
		c.Storage.DatabaseURL = dsn
		if (validateServerConfig(c) == nil) != ok {
			t.Fatal("private database validation", dsn)
		}
	}
	// Direct-mode bindings never gain the opt-in.
	raw, _ := json.Marshal(binding{DatabaseURL: "postgres://user:secret@postgres:5432/app?sslmode=disable", Namespace: "company", Soots: []string{"manager"}, Managers: []string{"manager"}})
	if _, err := loadBinding(string(raw)); err == nil {
		t.Fatal("direct mode accepted a named cleartext database")
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
		if _, err := guardedDial(context.Background(), "tcp", "source.example:443", publicAddress, answers(bad...), dial); err == nil {
			t.Fatal("dialed non-public source answer", bad)
		}
	}
	conn, err := guardedDial(context.Background(), "tcp", "source.example:443", publicAddress, answers("93.184.216.34"), dial)
	if err != nil || len(dials) != 1 || dials[0] != "93.184.216.34:443" {
		t.Fatal("public source not pinned", err, dials)
	}
	conn.Close()
}

func TestStatusSharesAdmissionAndPrincipalsAreCapped(t *testing.T) {
	g, _ := newTestGatewayWith(t, serverConfig{Storage: freshBinding(t)})
	s := g.session(context.Background(), "manager")
	create(t, s, "company")
	grant(t, s, "company", "marketing", "read")
	writeDoc(t, s, "company", "doc", "pending", "Pending text")
	status := func(token, actor string) chan int {
		done := make(chan int, 1)
		go func() {
			done <- toolRequest(t, g, token, actor, "status", false, statusInput{RequestID: "pending"}).Code
		}()
		return done
	}
	// An in-flight read holds shared admission; status does not wait on it.
	read, _ := g.policy.acquire(context.Background(), false)
	select {
	case code := <-status(readerToken, "marketing"):
		if code != 400 { // marketing owns no such request
			t.Fatal(code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("status waited for exclusive admission")
	}
	// Status rides with the original request's key.
	held, _ := g.keys.acquire(context.Background(), "request/manager/pending")
	done := status(managerToken, "manager")
	select {
	case <-done:
		t.Fatal("status read while its request was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	held()
	if code := <-done; code != 200 {
		t.Fatal(code)
	}
	read()
	// One principal cannot hold more than its share of the global slots.
	key := hash(readerToken) + "/marketing"
	for range perPrincipal {
		g.enter(key)
	}
	if w := toolRequest(t, g, readerToken, "marketing", "pools", false, poolsInput{}); w.Code != 429 || strings.Contains(w.Body.String(), "marketing") {
		t.Fatal("principal cap", w.Code, w.Body)
	}
	if w := toolRequest(t, g, vmToken, "support", "pools", false, poolsInput{}); w.Code != 200 {
		t.Fatal("cap leaked to another principal", w.Code)
	}
	for range perPrincipal {
		g.leave(key)
	}
	if w := toolRequest(t, g, readerToken, "marketing", "pools", false, poolsInput{}); w.Code != 200 || len(g.active) != 0 {
		t.Fatal("cap not released", w.Code, g.active)
	}
}

func TestReadinessConfigEnvAndHealthcheck(t *testing.T) {
	c := serverConfig{Storage: freshBinding(t), Listen: "127.0.0.1:0", Clients: []serviceClient{
		{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations},
	}}
	g, err := newGateway(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	defer g.base.close()
	probe := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		g.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}
	if w := probe("/readyz"); w.Code != 200 || w.Body.String() != "{\"status\":\"ready\"}\n" {
		t.Fatal(w.Code, w.Body)
	}
	g.base.close()
	g.readyAt = time.Time{}
	if w := probe("/readyz"); w.Code != 503 || strings.Contains(w.Body.String(), "postgres://") {
		t.Fatal("unready database reported ready", w.Code, w.Body)
	}
	if w := probe("/healthz"); w.Code != 200 {
		t.Fatal("liveness depends on database")
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
