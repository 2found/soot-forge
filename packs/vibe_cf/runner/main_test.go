package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func callWith(op string, input any) toolCall {
	raw, _ := json.Marshal(input)
	return toolCall{APIVersion: "soot/v1", Hook: toolCallHook,
		Soot: "helper", Operation: op, Input: raw}
}

func envBinding(t *testing.T, api, r2 string) func(string) string {
	b, _ := json.Marshal(cfBinding{APIToken: "tok", AccountID: "acct", ZoneID: "zone",
		R2AccessKey: "ak", R2SecretKey: "sk", R2Bucket: "bucket",
		WorkersSubdomain: "acct", APIBase: api, R2Endpoint: r2})
	return func(k string) string {
		if k == "CF_BINDING" {
			return string(b)
		}
		return ""
	}
}

func TestPresignGetShape(t *testing.T) {
	b := cfBinding{R2AccessKey: "AKIDEXAMPLE", R2SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		R2Bucket: "files", R2Endpoint: "https://acct.r2.cloudflarestorage.com"}
	url, err := presignGet(b, "ab/report.pdf", time.Hour, time.Date(2026, 10, 6, 1, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	for _, frag := range []string{"https://acct.r2.cloudflarestorage.com/files/ab/report.pdf?",
		"X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Expires=3600", "X-Amz-Signature=", "auto%2Fs3%2Faws4_request"} {
		if !strings.Contains(url, frag) {
			t.Fatalf("presigned url missing %q: %s", frag, url)
		}
	}
	if _, err := presignGet(b, "../escape", time.Hour, time.Now()); err == nil {
		t.Fatal("traversal key accepted")
	}
	if _, err := presignGet(b, "ok/key", 25*time.Hour, time.Now()); err == nil {
		t.Fatal("ttl > 24h accepted")
	}
}

func TestR2ShareAndListAgainstStub(t *testing.T) {
	var putKey string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PUT" {
			putKey = r.URL.Path
			w.WriteHeader(200)
			return
		}
		if r.Method == "GET" && r.URL.Query().Get("list-type") == "2" {
			w.Header().Set("Content-Type", "application/xml")
			w.Write([]byte(`<ListBucketResult><Contents><Key>` + strings.TrimPrefix(putKey, "/bucket/") + `</Key><Size>3</Size></Contents></ListBucketResult>`))
			return
		}
		w.WriteHeader(404)
	}))
	defer stub.Close()
	b := cfBinding{R2AccessKey: "ak", R2SecretKey: "sk", R2Bucket: "bucket", R2Endpoint: stub.URL}
	var out strings.Builder
	if err := cmdR2Share(context.Background(), b, callWith("vibe_cf_r2_share", map[string]any{"key": "a/b.txt", "ttlSec": 60}), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"kind":"share"`) {
		t.Fatalf("no share result: %s", out.String())
	}
}

func TestWorkerDeployAgainstStub(t *testing.T) {
	var sawSubdomain bool
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/subdomain") {
			sawSubdomain = true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true,"result":{"id":"qa-hello"}}`))
	}))
	defer stub.Close()
	b := cfBinding{APIToken: "tok", AccountID: "acct", APIBase: stub.URL, WorkersSubdomain: "acct"}
	var out strings.Builder
	if err := cmdWorkerDeploy(context.Background(), b, callWith("vibe_cf_worker_deploy",
		map[string]any{"name": "qa-hello", "script": "export default {fetch(){return new Response('hi')}}"}), &out); err != nil {
		t.Fatal(err)
	}
	if !sawSubdomain {
		t.Fatal("subdomain enable call missing")
	}
	if !strings.Contains(out.String(), "qa-hello.acct.workers.dev") {
		t.Fatalf("no public url in receipt: %s", out.String())
	}
}

func TestD1CreateAndQuery(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/d1/database"):
			w.Write([]byte(`{"success":true,"result":{"uuid":"db-uuid-1","name":"qa-db"}}`))
		case strings.Contains(r.URL.Path, "/query"):
			w.Write([]byte(`{"success":true,"result":[{"results":[{"ok":1}],"success":true}]}`))
		default:
			w.Write([]byte(`{"success":true,"result":[{"uuid":"db-uuid-1","name":"qa-db"}]}`))
		}
	}))
	defer stub.Close()
	b := cfBinding{APIToken: "tok", AccountID: "acct", APIBase: stub.URL}
	var out strings.Builder
	if err := cmdD1Create(context.Background(), b, callWith("vibe_cf_d1_create", map[string]any{"name": "qa-db"}), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "db-uuid-1") {
		t.Fatalf("no uuid in receipt: %s", out.String())
	}
	out.Reset()
	if err := cmdD1Exec(context.Background(), b, callWith("vibe_cf_d1_exec",
		map[string]any{"database": "db-uuid-1", "sql": "select 1"}), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"ok":1`) {
		t.Fatalf("no rows: %s", out.String())
	}
	var result struct {
		Results []d1Result `json:"results"`
	}
	if err := json.Unmarshal([]byte(out.String()), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Results) != 1 || !result.Results[0].Success || len(result.Results[0].Results) != 1 {
		t.Fatalf("public D1 envelope changed: %s", out.String())
	}
}

func TestD1StatementBoundaries(t *testing.T) {
	for _, sql := range []string{
		"SELECT 'hello;world';", "SELECT 'it''s;fine'; -- trailing ; comment",
		"SELECT \"column;name\" FROM notes;", "SELECT [column;name] FROM notes;",
		"SELECT `column;name` FROM notes;", "/* ; */ SELECT 1; /* ; */",
	} {
		if hasMultipleStatements(sql) {
			t.Errorf("rejected one statement: %s", sql)
		}
	}
	for _, sql := range []string{"SELECT 1; SELECT 2", "SELECT ';'; /* comment */ DELETE FROM notes"} {
		if !hasMultipleStatements(sql) {
			t.Errorf("accepted multiple statements: %s", sql)
		}
	}
}

func TestDNSValidation(t *testing.T) {
	b := cfBinding{APIToken: "tok", AccountID: "acct", ZoneID: "zone", APIBase: "http://x"}
	var out strings.Builder
	if err := cmdDNSCreate(context.Background(), b, callWith("vibe_cf_dns_create",
		map[string]any{"type": "MX", "name": "x", "content": "10 mail.x"}), &out); err == nil {
		t.Fatal("MX accepted")
	}
	if err := cmdDNSCreate(context.Background(), b, callWith("vibe_cf_dns_create",
		map[string]any{"type": "A", "name": "x", "content": "not-an-ip"}), &out); err == nil {
		t.Fatal("bad IPv4 accepted")
	}
}

func TestRefusalVsUncertain(t *testing.T) {
	// validation refusal: exit-1 class error (no errUncertain wrap)
	b := cfBinding{APIToken: "tok", AccountID: "acct", APIBase: "http://x"}
	var out strings.Builder
	err := cmdWorkerDeploy(context.Background(), b, callWith("vibe_cf_worker_deploy",
		map[string]any{"name": "BAD!", "script": "x"}), &out)
	if err == nil || errors.Is(err, errUncertain) {
		t.Fatalf("bad name should refuse cleanly, got %v", err)
	}
	// unreachable API: exit-2 class error
	b.APIBase = "http://127.0.0.1:1"
	err = cmdWorkerList(context.Background(), b, callWith("vibe_cf_worker_list", map[string]any{}), &out)
	if !errors.Is(err, errUncertain) {
		t.Fatalf("unreachable api should be uncertain, got %v", err)
	}
}

func TestNewShortcodeShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		c := newShortcode()
		if !shortcodePattern.MatchString(c) {
			t.Fatalf("bad code %q", c)
		}
		if seen[c] {
			t.Fatalf("collision %q", c)
		}
		seen[c] = true
	}
}

func TestShortlinkSetupAndMint(t *testing.T) {
	created := false
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/d1/database"):
			if created {
				w.Write([]byte(`{"success":true,"result":[{"uuid":"db-uuid-1","name":"qa-go-links"}]}`))
			} else {
				w.Write([]byte(`{"success":true,"result":[]}`))
			}
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/d1/database"):
			created = true
			w.Write([]byte(`{"success":true,"result":{"uuid":"db-uuid-1","name":"qa-go-links"}}`))
		case strings.Contains(r.URL.Path, "/query"):
			w.Write([]byte(`{"success":true,"result":[{"results":[],"success":true}]}`))
		default:
			w.Write([]byte(`{"success":true,"result":{"id":"qa-go"}}`))
		}
	}))
	defer stub.Close()
	b := cfBinding{APIToken: "tok", AccountID: "acct", APIBase: stub.URL, WorkersSubdomain: "acct"}
	var out strings.Builder
	if err := cmdShortlinkSetup(context.Background(), b, callWith("vibe_cf_shortlink_setup",
		map[string]any{"worker": "qa-go"}), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "qa-go.acct.workers.dev") {
		t.Fatalf("no public url: %s", out.String())
	}
	out.Reset()
	if err := cmdShortlinkMint(context.Background(), b, callWith("vibe_cf_shortlink_mint",
		map[string]any{"worker": "qa-go", "url": "https://example.com/x", "code": "hello"}), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "/hello") {
		t.Fatalf("no short url: %s", out.String())
	}
}
