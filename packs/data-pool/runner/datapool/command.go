// Package datapool is the Soot data pool: collections, grants, revisions,
// receipts and fuzzy search over PostgreSQL or an embedded SQLite file. The
// soot-data-pool executable is a thin main over Main; a host that embeds the
// pool calls Execute with the same envelope. No Soot runtime or provider state
// is imported or opened here.
package datapool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// Host event text and model input may be JSON-escaped and appear together.
	// Field limits below remain independent of this wire-envelope bound.
	maxInput     = 256 << 10
	maxContent   = 128 << 10
	maxPools     = 256
	maxDocuments = 10000
)

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// Keep the public soot/v1 envelope shape; unknown envelope fields remain
// forward compatible. Model-authored Input is decoded separately and strictly.
type toolCall struct {
	APIVersion  string          `json:"api_version"`
	Hook        string          `json:"hook"`
	Soot        string          `json:"soot"`
	Operation   string          `json:"operation"`
	Input       json.RawMessage `json:"input"`
	Interaction bool            `json:"interaction,omitempty"`
	GroupID     string          `json:"group_id,omitempty"`
	Event       *callEvent      `json:"event,omitempty"`
}

type binding struct {
	ServiceURL   string   `json:"service_url,omitempty"`
	ServiceToken string   `json:"service_token,omitempty"`
	DatabaseURL  string   `json:"database_url"`
	Namespace    string   `json:"namespace"`
	Soots        []string `json:"soots"`
	Managers     []string `json:"managers"`
	// Role lists derive a host client's operations for each identity in its
	// allowlist. Writers gain write, pool managers gain manage (and write).
	// Managers own the namespace and are neither listed here nor grantable.
	Writers      []string            `json:"writers,omitempty"`
	PoolManagers []string            `json:"pool_managers,omitempty"`
	Groups       map[string][]string `json:"groups,omitempty"`
	Defaults     map[string]string   `json:"defaults,omitempty"`
}

func decodeStrict(data []byte, into any) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' || !utf8.Valid(data) {
		return errors.New("input must be one UTF-8 JSON object")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return errors.New("invalid input fields or JSON")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}

func loadBinding(raw string) (binding, error) { return parseBinding(raw, false) }

// privateNetwork additionally admits a cleartext database connection by name;
// without it a DSN that does not require TLS must reach loopback or a literal
// private address.
func parseBinding(raw string, privateNetwork bool) (binding, error) {
	var b binding
	if len(raw) > 2<<20 || decodeStrict([]byte(raw), &b) != nil {
		return b, errors.New("invalid DATA_POOL binding")
	}
	if b.ServiceURL != "" || b.ServiceToken != "" {
		if b.DatabaseURL != "" || b.Namespace != "" || len(b.Soots) != 0 || len(b.Managers) != 0 || len(b.Writers) != 0 || len(b.PoolManagers) != 0 || len(b.Groups) != 0 || len(b.Defaults) != 0 {
			return b, errors.New("remote binding cannot contain local database or policy fields")
		}
		if err := validateEndpoint(b.ServiceURL); err != nil || !validToken(b.ServiceToken) {
			return b, errors.New("invalid data-pool service binding")
		}
		b.ServiceURL = strings.TrimRight(b.ServiceURL, "/")
		return b, nil
	}
	if isSQLiteURL(b.DatabaseURL) {
		// An embedded file is local by construction: no network, no TLS.
		if _, err := sqlitePath(b.DatabaseURL); err != nil {
			return b, err
		}
	} else if err := validatePostgresURL(b.DatabaseURL, privateNetwork); err != nil {
		return b, err
	}
	if !identifier.MatchString(b.Namespace) {
		return b, errors.New("invalid namespace")
	}
	if len(b.Soots) == 0 || len(b.Soots) > 4096 || len(b.Managers) == 0 || len(b.Managers) > 16 {
		return b, errors.New("bind allowed Soots and at least one manager")
	}
	seen := map[string]bool{}
	for _, s := range b.Soots {
		if !identifier.MatchString(s) || seen[s] {
			return b, errors.New("invalid or duplicate bound Soot")
		}
		seen[s] = true
	}
	for _, s := range b.Managers {
		if !seen[s] {
			return b, errors.New("manager must be a bound Soot")
		}
	}
	for _, s := range append(append([]string{}, b.Writers...), b.PoolManagers...) {
		if !seen[s] {
			return b, errors.New("writer/pool manager must be a bound Soot")
		}
	}
	if err := validateOrganization(b); err != nil {
		return b, err
	}
	return b, nil
}

// validatePostgresURL checks a shared-service database_url: a PostgreSQL URL
// that requires TLS, or a cleartext one that reaches loopback or a private
// address (or, with privateNetwork, a container network name).
func validatePostgresURL(raw string, privateNetwork bool) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || u.Fragment != "" || len(raw) > 4096 {
		return errors.New("invalid database_url; use postgres://user:password@host/database")
	}
	sslmode := u.Query().Get("sslmode")
	if sslmode == "" || sslmode == "disable" || sslmode == "allow" {
		host := u.Hostname()
		ip, ipErr := netip.ParseAddr(host)
		isIP := ipErr == nil
		loopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
		private := isIP && privateAddress(ip)
		switch {
		case loopback || private:
		case privateNetwork && !isIP:
			// A container network name is resolved inside the operator's
			// private network; the flag is the operator's explicit opt-in.
		case !privateNetwork:
			return errors.New("database_url requires sslmode=require outside loopback, or private_network behind a private network")
		default:
			return errors.New("database_url with a cleartext mode cannot reach a public address")
		}
	}
	return nil
}

// databaseIdentity names the server and database without credentials or
// options, so the operator-visible service identity stays stable.
func databaseIdentity(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "postgres"
	}
	return strings.TrimSuffix(u.Scheme+"://"+u.Host+u.Path, "/")
}

func execute(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer, rawBinding string) error {
	if len(args) != 1 || !slices.Contains(operations, args[0]) {
		return errors.New("usage: soot-data-pool pools|query|write|manage|status|view|action")
	}
	data, err := io.ReadAll(io.LimitReader(stdin, maxInput+1))
	if err != nil || len(data) > maxInput {
		return errors.New("tool envelope is too large")
	}
	var call toolCall
	d := json.NewDecoder(bytes.NewReader(data))
	if err = d.Decode(&call); err != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("invalid tool envelope")
	}
	if call.APIVersion != "soot/v1" || call.Hook != "tool.call" || call.Operation != "data-pool_"+args[0] || !identifier.MatchString(call.Soot) {
		return errors.New("invalid tool context")
	}
	b, err := loadBinding(rawBinding)
	if err != nil {
		return err
	}
	if b.ServiceURL != "" {
		return remoteExecute(ctx, b, call, stdout)
	}
	// Refuse a malformed identity before touching state.
	if !identifier.MatchString(call.Soot) {
		return errors.New("access denied")
	}
	s, err := openService(ctx, b, call.Soot)
	if err != nil {
		return err
	}
	defer s.close()
	if !slices.Contains(s.b.Soots, call.Soot) && call.Soot != knowledgeIdentity { // static ∪ admitted; the reserved reader needs no entry
		return errors.New("access denied")
	}
	// Only separate, explicitly granted UI operations may claim human provenance.
	s.human = call.Interaction && (args[0] == "view" || args[0] == "action")
	s.origin = s.callOrigin(call)
	result, err := s.dispatch(ctx, args[0], call.Input)
	if err != nil {
		return err
	}
	// The namespace store's exclusive process lock stays held through output.
	// Revocation is committed only between calls, so late reads cannot publish
	// after a successful revoke. All executable instances use this same store.
	return json.NewEncoder(stdout).Encode(result)
}

// Operations lists the tool operations Execute accepts, in tool order.
func Operations() []string { return slices.Clone(operations) }

// Execute runs one data-pool tool call: op is one of Operations, stdin carries
// the soot/v1 tool.call envelope, rawBinding is the DATA_POOL credential JSON,
// and the JSON result goes to stdout. An error is the message the model sees.
func Execute(ctx context.Context, op string, stdin io.Reader, stdout io.Writer, rawBinding string) error {
	return execute(ctx, []string{op}, stdin, stdout, rawBinding)
}

// Main is the soot-data-pool executable: serve, healthcheck, or one tool
// operation read from stdin. It returns the process exit code.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer, env func(string) string) int {
	if len(args) > 0 && (args[0] == "serve" || args[0] == "healthcheck") {
		command := serveCommand
		if args[0] == "healthcheck" {
			command = healthcheck
		}
		if err := command(args[1:]); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := execute(ctx, args, stdin, stdout, env("DATA_POOL")); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func validText(s string, limit int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && len(s) <= limit
}
