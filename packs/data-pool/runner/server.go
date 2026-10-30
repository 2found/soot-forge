package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// toolOperation names the service operation a tool call asks for. The model
// tools are data-pool_<op>; the human view and action tools ship in the
// data-pool-console pack as data-pool-console_view and data-pool-console_action.
// Anything else yields "", which no credential allows.
func toolOperation(operation string) string {
	if op, ok := strings.CutPrefix(operation, "data-pool-console_"); ok {
		if op == "view" || op == "action" {
			return op
		}
		return ""
	}
	if op, ok := strings.CutPrefix(operation, "data-pool_"); ok && slices.Contains(operations, op) {
		return op
	}
	return ""
}

var operations = []string{"pools", "query", "write", "manage", "status", "view", "action"}

const (
	hostClient   = "@host"
	perPrincipal = 16 // concurrent requests per token + claimed Soot
	maxConfig    = 2 << 20
)

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type serviceClient struct {
	// Soot "@host" is one machine's credential: Name identifies it (and its
	// revocation), Soots bounds which identities its envelopes may claim. A
	// named Soot binds the credential to that identity only.
	Soot        string   `json:"soot"`
	Name        string   `json:"name,omitempty"`
	Soots       []string `json:"soots,omitempty"`
	TokenSHA256 string   `json:"token_sha256"`
	Operations  []string `json:"operations,omitempty"`
}

func (c serviceClient) kind() string {
	switch {
	case c.Soot == hostClient:
		return "host:" + c.Name
	case slices.Contains(c.Operations, "view") || slices.Contains(c.Operations, "action"):
		return "ui"
	}
	return "soot"
}

type serverConfig struct {
	Listen  string `json:"listen"`
	TLSCert string `json:"tls_cert,omitempty"`
	TLSKey  string `json:"tls_key,omitempty"`
	// PrivateNetwork is the container opt-in: cleartext behind a TLS-terminating
	// proxy, and a cleartext database that resolves only to private addresses.
	PrivateNetwork bool            `json:"private_network,omitempty"`
	Storage        binding         `json:"storage"`
	Clients        []serviceClient `json:"clients"`
}

// roleOperations derives what a host credential may do for one claimed
// identity: managers and pool managers manage, writers write, others read.
// A machine credential never reaches the human view/action surface.
func roleOperations(b binding, soot string) []string {
	ops := []string{"pools", "query", "status"}
	switch {
	case slices.Contains(b.Managers, soot), slices.Contains(b.PoolManagers, soot):
		ops = append(ops, "write", "manage")
	case slices.Contains(b.Writers, soot):
		ops = append(ops, "write")
	}
	return ops
}

func (c serverConfig) storage() (binding, error) {
	data, _ := json.Marshal(c.Storage)
	b, err := parseBinding(string(data), c.PrivateNetwork)
	if err == nil && b.ServiceURL != "" {
		err = errors.New("service requires local authoritative storage configuration")
	}
	return b, err
}

func validateServerConfig(c serverConfig) error {
	b, err := c.storage()
	if err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(c.Listen)
	ip := net.ParseIP(host)
	if err != nil || (c.TLSCert == "") != (c.TLSKey == "") || (c.TLSCert == "" && (ip == nil || !ip.IsLoopback() && !c.PrivateNetwork)) {
		return errors.New("listen must be an explicit loopback address, use TLS certificate and key, or set private_network behind a TLS proxy")
	}
	if len(c.Clients) == 0 || len(c.Clients) > 4096 {
		return errors.New("bind between 1 and 4096 service clients")
	}
	seen, names := map[string]bool{}, map[string]bool{}
	for _, client := range c.Clients {
		digest, e := hex.DecodeString(client.TokenSHA256)
		if e != nil || len(digest) != 32 || strings.ToLower(client.TokenSHA256) != client.TokenSHA256 || seen[client.TokenSHA256] {
			return errors.New("invalid or duplicate client credential")
		}
		seen[client.TokenSHA256] = true
		if client.Soot == hostClient {
			// Operations are derived per claimed identity at request time; the
			// allowlist is what keeps one machine's token off the other's Soots.
			if !identifier.MatchString(client.Name) || names[client.Name] || len(client.Operations) != 0 {
				return errors.New("each @host client needs a distinct identifier name and no operations")
			}
			names[client.Name] = true
			if len(client.Soots) == 0 {
				return fmt.Errorf("@host client %q needs a non-empty \"soots\" allowlist of bound Soots it may act as", client.Name)
			}
			allow := map[string]bool{}
			for _, s := range client.Soots {
				if !slices.Contains(b.Soots, s) || allow[s] {
					return fmt.Errorf("@host client %q soots must be distinct bound Soots", client.Name)
				}
				allow[s] = true
			}
			continue
		}
		if client.Name != "" || len(client.Soots) != 0 || !slices.Contains(b.Soots, client.Soot) || len(client.Operations) == 0 || len(client.Operations) > len(operations) {
			return errors.New("invalid client credential")
		}
		opSeen := map[string]bool{}
		for _, op := range client.Operations {
			if !slices.Contains(operations, op) || opSeen[op] {
				return errors.New("invalid client operations")
			}
			opSeen[op] = true
		}
	}
	return nil
}

type gateway struct {
	base      *service
	clients   map[string]serviceClient
	policy    policyGate
	keys      keyedGate
	slots     chan struct{}
	mu        sync.Mutex
	active    map[string]int
	accessLog io.Writer
	logMu     sync.Mutex
	readyMu   sync.Mutex
	readyAt   time.Time
	readyOK   bool
}

func newGateway(ctx context.Context, c serverConfig) (*gateway, error) {
	if err := validateServerConfig(c); err != nil {
		return nil, err
	}
	b, _ := c.storage()
	s, err := openService(ctx, b, "")
	if err != nil {
		return nil, err
	}
	clients := make(map[string]serviceClient, len(c.Clients))
	for _, client := range c.Clients {
		clients[client.TokenSHA256] = client
		if client.Soot == hostClient {
			s.hosts = append(s.hosts, client.Name)
		}
	}
	slices.Sort(s.hosts)
	return &gateway{base: s, clients: clients, slots: make(chan struct{}, 256), active: map[string]int{}}, nil
}

// session gives each request its own service view. The permission memo and
// group list are per-actor request state; sharing the base map races.
func (g *gateway) session(ctx context.Context, actor string) *service {
	s := *g.base
	s.withAdmitted(ctx)
	s.actor, s.perms = actor, map[string]string{}
	s.membership, s.groupsFor = actorGroups(s.b, actor), actor
	s.human, s.origin = false, nil
	return &s
}

// enter caps one principal's concurrent work so a single caller spamming
// requests cannot hold all global slots.
func (g *gateway) enter(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[key] >= perPrincipal {
		return false
	}
	g.active[key]++
	return true
}
func (g *gateway) leave(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[key]--; g.active[key] <= 0 {
		delete(g.active, key)
	}
}

// One line per tool request. Never tokens, bodies, queries, document ids or
// content: only the claimed identity, credential kind and outcome.
type accessEntry struct {
	Time     string `json:"time"`
	Soot     string `json:"soot,omitempty"`
	Client   string `json:"client"`
	Op       string `json:"op,omitempty"`
	Status   int    `json:"status"`
	Duration int64  `json:"duration_ms"`
	// Refused names the input rule a 400 failed ("write.id"), never a value.
	Refused string `json:"refused,omitempty"`
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status, w.wrote = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *statusWriter) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{\"status\":\"available\"}\n")
	case r.Method == http.MethodGet && r.URL.Path == "/readyz":
		w.Header().Set("Content-Type", "application/json")
		if !g.ready(r.Context()) {
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, "{\"status\":\"unavailable\"}\n")
			return
		}
		io.WriteString(w, "{\"status\":\"ready\"}\n")
	case r.Method == http.MethodPost && r.URL.Path == "/v1/tool":
		start := time.Now()
		rec := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		entry := accessEntry{Client: "unauthenticated"}
		g.tool(rec, r, &entry)
		if g.accessLog != nil {
			entry.Time, entry.Status, entry.Duration = start.UTC().Format(time.RFC3339Nano), rec.status, time.Since(start).Milliseconds()
			line, _ := json.Marshal(entry)
			g.logMu.Lock()
			g.accessLog.Write(append(line, '\n'))
			g.logMu.Unlock()
		}
	default:
		http.NotFound(w, r)
	}
}

// ready checks the policy database. Results are reused for a second so an
// unauthenticated probe flood cannot fan out into database traffic.
func (g *gateway) ready(ctx context.Context) bool {
	g.readyMu.Lock()
	defer g.readyMu.Unlock()
	if time.Since(g.readyAt) < time.Second {
		return g.readyOK
	}
	check, cancel := context.WithTimeout(ctx, 2*time.Second)
	ok := g.base.db.pool.Ping(check) == nil
	cancel()
	g.readyAt, g.readyOK = time.Now(), ok
	return ok
}

func (g *gateway) tool(w http.ResponseWriter, r *http.Request, entry *accessEntry) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || !validToken(strings.TrimPrefix(auth, "Bearer ")) {
		http.Error(w, "access denied", 401)
		return
	}
	principal, authorized := g.clients[hash(strings.TrimPrefix(auth, "Bearer "))]
	if !authorized {
		http.Error(w, "access denied", 401)
		return
	}
	entry.Client = principal.kind()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	// Bound memory and waiting work before reading authenticated request bodies.
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		http.Error(w, "service busy; inspect original request before retrying", 503)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxInput))
	var call toolCall
	if err != nil || decodeStrict(data, &call) != nil || call.APIVersion != "soot/v1" || call.Hook != "tool.call" {
		http.Error(w, "invalid tool context", 400)
		return
	}
	if identifier.MatchString(call.Soot) {
		entry.Soot = call.Soot
	}
	op := toolOperation(call.Operation)
	if op != "" {
		entry.Op = op
	}
	allowed := principal.Operations
	actor := principal.Soot
	var session *service
	if principal.Soot == hostClient {
		// The host asserts its Soot identity in the envelope; the service bounds
		// the claim to this machine's allowlist. Human UI needs the separate UI
		// token, so a machine credential never carries the interaction marker.
		if call.Interaction || !identifier.MatchString(call.Soot) {
			http.Error(w, "access denied", 403)
			return
		}
		admitted, admitErr := g.base.admitted(ctx, call.Soot, principal.Name)
		if admitErr != nil {
			http.Error(w, "service busy; inspect original request before retrying", 503)
			return
		}
		if !slices.Contains(principal.Soots, call.Soot) && !admitted {
			// The machine is authenticated, so say what is missing: a model that
			// only sees "403" guesses collection ids and asks for the wrong grant.
			entry.Refused = "soot.unadmitted"
			writeInvalid(w, "this Soot is not admitted to the shared data pool yet, so no collection is visible to it; do not guess collection ids. Report a blocker with grant kind data_pool so a pool manager turns Kho dữ liệu on for this Soot in Nest")
			return
		}
		actor = call.Soot
		session = g.session(ctx, actor) // one admission read serves the role check and the call
		allowed = roleOperations(session.b, actor)
	} else if call.Soot != principal.Soot {
		http.Error(w, "invalid tool context", 400)
		return
	}
	if entry.Op == "" || !slices.Contains(allowed, op) {
		http.Error(w, "access denied", 403)
		return
	}
	if key := principal.TokenSHA256 + "/" + actor; g.enter(key) {
		defer g.leave(key)
	} else {
		http.Error(w, "too many concurrent requests; inspect original request before retrying", 429)
		return
	}
	if op == "write" {
		var in writeInput
		if decodeStrict(call.Input, &in) == nil && in.Pool == "" && g.base.b.Defaults[actor] != "" {
			in.Pool = g.base.b.Defaults[actor]
			call.Input, _ = json.Marshal(in)
		}
	}
	release, err := g.admit(ctx, op, actor, call)
	if err != nil {
		http.Error(w, "service busy; inspect original request before retrying", 503)
		return
	}
	defer release()
	if ctx.Err() != nil {
		http.Error(w, "service busy; inspect original request before retrying", 503)
		return
	}
	s := session // Identity is credential-bound, never model-selected.
	if s == nil {
		s = g.session(ctx, actor)
	}
	s.human = call.Interaction && (op == "view" || op == "action")
	s.origin = s.callOrigin(call)
	result, err := s.dispatch(ctx, op, call.Input)
	if err != nil {
		var invalid inputError
		if errors.Is(err, errConflict) {
			// Stale expected_revision or generation: nothing was written.
			invalid = inputError{err.Error()}
		}
		if invalid.message != "" || errors.As(err, &invalid) {
			entry.Refused = op + ".input"
			if field := (fieldError{}); errors.As(err, &field) {
				entry.Refused = op + "." + field.field
			}
			writeInvalid(w, invalid.Error())
			return
		}
		http.Error(w, "request denied or failed; inspect original request before retrying", 400)
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded)+1 > maxOutput {
		http.Error(w, "result unavailable; inspect original request", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// Serialize through the final write, just as local executable mode does.
	// A revoke cannot finish while an earlier read is still being published.
	w.Write(append(encoded, '\n'))
	// net/http otherwise buffers small responses until after handler return.
	// Flush while holding the policy lock so revoke follows publication.
	http.NewResponseController(w).Flush()
}

// readServiceConfig loads the private JSON config from a mode-0600 file or,
// for containers, an environment variable. Both use the same strict decode.
func readServiceConfig(args []string) (serverConfig, error) {
	var c serverConfig
	var data []byte
	switch {
	case len(args) == 2 && args[0] == "--config":
		f, err := os.Open(args[1])
		if err != nil {
			return c, errors.New("cannot open private service config")
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return c, errors.New("service config must be a private regular file (mode 0600)")
		}
		if data, err = io.ReadAll(io.LimitReader(f, maxConfig+1)); err != nil {
			return c, errors.New("invalid service config")
		}
	case len(args) == 2 && args[0] == "--config-env" && envName.MatchString(args[1]):
		raw, ok := os.LookupEnv(args[1])
		if !ok || strings.TrimSpace(raw) == "" {
			return c, errors.New("service config environment variable is unset or empty")
		}
		data = []byte(raw)
	default:
		return c, errors.New("usage: soot-data-pool serve --config PRIVATE_JSON | --config-env VARIABLE")
	}
	if len(data) > maxConfig || decodeStrict(data, &c) != nil {
		return c, errors.New("invalid service config")
	}
	return c, nil
}

// This operator command is not an installed Pack tool and never provisions a database.
func serveCommand(args []string) error {
	c, err := readServiceConfig(args)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	g, err := newGateway(ctx, c)
	if err != nil {
		return err
	}
	g.accessLog = os.Stderr
	defer func() {
		// Bounded so close still fits a 30s container stop grace period.
		wait, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if release, err := g.policy.acquire(wait, true); err == nil {
			defer release()
		}
		g.base.close()
	}()
	listener, err := net.Listen("tcp", c.Listen)
	if err != nil {
		return errors.New("cannot listen for data-pool requests")
	}
	defer listener.Close()
	server := &http.Server{Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	done := make(chan error, 1)
	go func() {
		if c.TLSCert != "" {
			done <- server.ServeTLS(listener, c.TLSCert, c.TLSKey)
		} else {
			done <- server.Serve(listener)
		}
	}()
	select {
	case err = <-done:
	case <-ctx.Done():
		// Requests run at most 15s (+flush); 20s drain plus 5s close stays
		// inside Docker's stop_grace_period: 30s before SIGKILL.
		shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if server.Shutdown(shutdown) != nil {
			server.Close()
		}
		err = <-done
	}
	if err != nil && err != http.ErrServerClosed {
		return errors.New("data-pool service stopped unexpectedly")
	}
	return nil
}

// healthcheck lets distroless images (no curl) probe liveness.
func healthcheck(args []string) error {
	target := "http://127.0.0.1:8091/healthz"
	if len(args) > 1 {
		return errors.New("usage: soot-data-pool healthcheck [URL]")
	}
	if len(args) == 1 {
		target = args[0]
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errors.New("healthcheck URL must be http(s) without credentials")
	}
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(u.String())
	if err != nil {
		return errors.New("unhealthy: no response")
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unhealthy: HTTP %d", resp.StatusCode)
	}
	return nil
}

// writeInvalid is the one invalid_input envelope the host passes through to
// the model (remote.go parses the same shape).
func writeInvalid(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(400)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "invalid_input", "message": message}})
}
