package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The shared-service tests run against a real PostgreSQL database. Set
// DATA_POOL_TEST_DATABASE_URL to a disposable database; each test starts from
// an empty data_pool schema. CI without a database skips this lane.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("DATA_POOL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set DATA_POOL_TEST_DATABASE_URL to a disposable PostgreSQL database")
	}
	return dsn
}

func freshBinding(t *testing.T, soots ...string) binding {
	t.Helper()
	dsn := testDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+databaseSchema+` CASCADE`); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	pool.Close()
	if len(soots) == 0 {
		soots = []string{"manager", "marketing", "support", "writer", "outsider"}
	}
	return binding{DatabaseURL: dsn, Namespace: "company", Soots: soots, Managers: []string{"manager"}}
}

func testService(t *testing.T, soots ...string) *service {
	t.Helper()
	s, err := openService(context.Background(), freshBinding(t, soots...), "manager")
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

// newTestGateway starts the shared service on a random port over its own
// freshly emptied schema.
func newTestGateway(t *testing.T, extra func(*serverConfig)) (*gateway, *httptest.Server) {
	t.Helper()
	c := serverConfig{Listen: "127.0.0.1:0", Storage: freshBinding(t), Clients: []serviceClient{
		{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations},
		{Soot: "marketing", TokenSHA256: hash(readerToken), Operations: []string{"pools", "query", "status"}},
		{Soot: "support", TokenSHA256: hash(vmToken), Operations: []string{"pools", "query", "status"}},
	}}
	if extra != nil {
		extra(&c)
	}
	g, err := newGateway(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(g)
	t.Cleanup(func() { server.Close(); g.base.close() })
	return g, server
}

func contextCall(t *testing.T, server *httptest.Server, token string, call toolCall) ([]byte, error) {
	t.Helper()
	data, _ := json.Marshal(call)
	raw, _ := json.Marshal(binding{ServiceURL: server.URL, ServiceToken: token})
	var out bytes.Buffer
	err := execute(context.Background(), []string{trimOp(call.Operation)}, bytes.NewReader(data), &out, string(raw))
	return out.Bytes(), err
}

func trimOp(operation string) string {
	for _, op := range operations {
		if operation == "data-pool_"+op {
			return op
		}
	}
	return operation
}
