package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"
)

var operations = []string{"pools", "query", "write", "manage", "status", "view", "action"}

const hostClient = "@host"

type serviceClient struct {
	// Soot "@host" shares one credential across the whole bound Soot set: the
	// envelope's host-stamped soot picks the identity and role-derived
	// operations. A named Soot binds this credential to that identity only.
	Soot        string   `json:"soot"`
	TokenSHA256 string   `json:"token_sha256"`
	Operations  []string `json:"operations,omitempty"`
}

type serverConfig struct {
	Listen  string          `json:"listen"`
	TLSCert string          `json:"tls_cert,omitempty"`
	TLSKey  string          `json:"tls_key,omitempty"`
	Storage binding         `json:"storage"`
	Clients []serviceClient `json:"clients"`
}

// roleOperations derives a claimed identity's operation set under a shared host
// credential: namespace managers manage and see the configuration surface,
// pool managers manage, writers write, everyone else reads.
func roleOperations(b binding, soot string) []string {
	ops := []string{"pools", "query", "status"}
	switch {
	case slices.Contains(b.Managers, soot):
		ops = append(ops, "write", "manage", "view", "action")
	case slices.Contains(b.PoolManagers, soot):
		ops = append(ops, "write", "manage")
	case slices.Contains(b.Writers, soot):
		ops = append(ops, "write")
	}
	return ops
}

func validateServerConfig(c serverConfig) error {
	data, _ := json.Marshal(c.Storage)
	b, err := loadBinding(string(data))
	if err != nil || b.ServiceURL != "" {
		return errors.New("service requires local authoritative storage configuration")
	}
	host, _, err := net.SplitHostPort(c.Listen)
	ip := net.ParseIP(host)
	if err != nil || (c.TLSCert == "") != (c.TLSKey == "") || (c.TLSCert == "" && (ip == nil || !ip.IsLoopback())) {
		return errors.New("listen must be an explicit loopback address or use TLS certificate and key")
	}
	if len(c.Clients) == 0 || len(c.Clients) > 4096 {
		return errors.New("bind between 1 and 4096 service clients")
	}
	seen := map[string]bool{}
	for _, client := range c.Clients {
		digest, e := hex.DecodeString(client.TokenSHA256)
		if client.Soot == hostClient {
			// A shared host credential lists no operations; they are derived per
			// claimed identity at request time from the bound roles.
			if e != nil || len(digest) != 32 || strings.ToLower(client.TokenSHA256) != client.TokenSHA256 || seen[client.TokenSHA256] || len(client.Operations) != 0 {
				return errors.New("invalid or duplicate host credential")
			}
			seen[client.TokenSHA256] = true
			continue
		}
		if e != nil || len(digest) != 32 || strings.ToLower(client.TokenSHA256) != client.TokenSHA256 || seen[client.TokenSHA256] || !slices.Contains(b.Soots, client.Soot) || len(client.Operations) == 0 || len(client.Operations) > len(operations) {
			return errors.New("invalid or duplicate client credential")
		}
		seen[client.TokenSHA256] = true
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
	base    *service
	clients map[string]serviceClient
	policy  policyGate
	keys    keyedGate
	slots   chan struct{}
}

func newGateway(c serverConfig) (*gateway, error) {
	if err := validateServerConfig(c); err != nil {
		return nil, err
	}
	data, _ := json.Marshal(c.Storage)
	b, _ := loadBinding(string(data))
	s, err := openService(b, "") // Lifetime DB ownership prevents competing servers.
	if err != nil {
		return nil, err
	}
	clients := make(map[string]serviceClient, len(c.Clients))
	for _, client := range c.Clients {
		clients[client.TokenSHA256] = client
	}
	return &gateway{base: s, clients: clients, slots: make(chan struct{}, 256)}, nil
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{\"status\":\"available\"}\n")
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/v1/tool" {
		http.NotFound(w, r)
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || !validToken(strings.TrimPrefix(auth, "Bearer ")) {
		http.Error(w, "access denied", 401)
		return
	}
	digest := hash(strings.TrimPrefix(auth, "Bearer "))
	principal, authorized := g.clients[digest]
	if !authorized {
		http.Error(w, "access denied", 401)
		return
	}
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
	allowed := principal.Operations
	actor := principal.Soot
	if principal.Soot == hostClient {
		// The host asserts its Soot identity in the envelope; the service bounds
		// the claim to the bound set and derives operations from bound roles.
		if !slices.Contains(g.base.b.Soots, call.Soot) {
			http.Error(w, "access denied", 403)
			return
		}
		actor = call.Soot
		allowed = roleOperations(g.base.b, call.Soot)
	} else if call.Soot != principal.Soot {
		http.Error(w, "invalid tool context", 400)
		return
	}
	op := strings.TrimPrefix(call.Operation, "data-pool_")
	if call.Operation != "data-pool_"+op || !slices.Contains(allowed, op) {
		http.Error(w, "access denied", 403)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if op == "write" {
		var in writeInput
		if decodeStrict(call.Input, &in) == nil && in.Pool == "" && g.base.b.Defaults[actor] != "" {
			in.Pool = g.base.b.Defaults[actor]
			call.Input, _ = json.Marshal(in)
		}
	}
	release, err := g.admit(ctx, op, call)
	if err != nil {
		http.Error(w, "service busy; inspect original request before retrying", 503)
		return
	}
	defer release()
	if ctx.Err() != nil {
		return
	}
	s := *g.base
	s.actor = actor // Identity is credential-bound, never model-selected.
	s.human = call.Interaction && (op == "view" || op == "action")
	s.origin = s.callOrigin(call)
	result, err := s.dispatch(ctx, op, call.Input)
	if err != nil {
		var invalid inputError
		if errors.As(err, &invalid) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "invalid_input", "message": invalid.Error()}})
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

// This operator command is not an installed Pack tool and never provisions Meili.
func serveCommand(args []string) error {
	if len(args) != 2 || args[0] != "--config" {
		return errors.New("usage: soot-data-pool serve --config PRIVATE_JSON")
	}
	f, err := os.Open(args[1])
	if err != nil {
		return errors.New("cannot open private service config")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("service config must be a private regular file (mode 0600)")
	}
	data, err := io.ReadAll(io.LimitReader(f, 2<<20+1))
	var c serverConfig
	if err != nil || len(data) > 2<<20 || decodeStrict(data, &c) != nil {
		return errors.New("invalid service config")
	}
	g, err := newGateway(c)
	if err != nil {
		return err
	}
	defer func() {
		release, _ := g.policy.acquire(context.Background(), true)
		defer release()
		g.base.close()
	}()
	listener, err := net.Listen("tcp", c.Listen)
	if err != nil {
		return errors.New("cannot listen for data-pool requests")
	}
	defer listener.Close()
	server := &http.Server{Handler: g, ReadTimeout: 5 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
		shutdown, cancel := context.WithTimeout(context.Background(), 25*time.Second)
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
