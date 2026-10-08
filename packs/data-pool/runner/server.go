package main

import (
	"context"
	"crypto/subtle"
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

type serviceClient struct {
	Soot        string   `json:"soot"`
	TokenSHA256 string   `json:"token_sha256"`
	Operations  []string `json:"operations"`
}

type serverConfig struct {
	Listen  string          `json:"listen"`
	TLSCert string          `json:"tls_cert,omitempty"`
	TLSKey  string          `json:"tls_key,omitempty"`
	Storage binding         `json:"storage"`
	Clients []serviceClient `json:"clients"`
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
	if len(c.Clients) == 0 || len(c.Clients) > 256 {
		return errors.New("bind between 1 and 256 service clients")
	}
	seen := map[string]bool{}
	for _, client := range c.Clients {
		digest, e := hex.DecodeString(client.TokenSHA256)
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
	clients []serviceClient
	lock    chan struct{}
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
	return &gateway{base: s, clients: c.Clients, lock: make(chan struct{}, 1), slots: make(chan struct{}, 32)}, nil
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
	var principal *serviceClient
	for i := range g.clients {
		if subtle.ConstantTimeCompare([]byte(digest), []byte(g.clients[i].TokenSHA256)) == 1 {
			principal = &g.clients[i]
		}
	}
	if principal == nil {
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
	if err != nil || decodeStrict(data, &call) != nil || call.APIVersion != "soot/v1" || call.Hook != "tool.call" || call.Soot != principal.Soot {
		http.Error(w, "invalid tool context", 400)
		return
	}
	op := strings.TrimPrefix(call.Operation, "data-pool_")
	if call.Operation != "data-pool_"+op || !slices.Contains(principal.Operations, op) {
		http.Error(w, "access denied", 403)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case g.lock <- struct{}{}:
	case <-ctx.Done():
		return
	case <-timer.C:
		http.Error(w, "service busy; inspect original request before retrying", 503)
		return
	}
	defer func() { <-g.lock }()
	if ctx.Err() != nil {
		return
	}
	s := *g.base
	s.actor = principal.Soot // Identity is credential-bound, never model-selected.
	s.human = call.Interaction && (op == "view" || op == "action")
	result, err := s.dispatch(ctx, op, call.Input)
	if err != nil {
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
	data, err := io.ReadAll(io.LimitReader(f, 128<<10+1))
	var c serverConfig
	if err != nil || len(data) > 128<<10 || decodeStrict(data, &c) != nil {
		return errors.New("invalid service config")
	}
	g, err := newGateway(c)
	if err != nil {
		return err
	}
	defer func() {
		g.lock <- struct{}{}
		g.base.close()
		<-g.lock
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
