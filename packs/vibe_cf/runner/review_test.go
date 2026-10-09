package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBoundedListPaginationNeverHidesMoreResults(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("list-type") == "2" {
			if r.URL.Query().Get("continuation-token") != "opaque/+ cursor" {
				t.Error("R2 cursor was not preserved")
			}
			w.Write([]byte(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next/+ token</NextContinuationToken><Contents><Key>fixture.txt</Key><Size>4</Size></Contents></ListBucketResult>`))
			return
		}
		if r.URL.Query().Get("page") != "2" || r.URL.Query().Get("per_page") != "1" {
			t.Error("wrong requested page")
		}
		w.Write([]byte(`{"success":true,"result":[{"uuid":"db","id":"record","name":"fixture"}],"result_info":{"page":2,"per_page":1,"total_count":3}}`))
	}))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, R2Endpoint: server.URL, APIToken: "fixture", AccountID: "acct", ZoneID: "zone", R2Bucket: "files", R2AccessKey: "fixture", R2SecretKey: "fixture"}
	for _, name := range []string{"d1", "dns", "r2"} {
		var out strings.Builder
		input := map[string]any{"page": 2, "limit": 1}
		if name == "r2" {
			input = map[string]any{"cursor": "opaque/+ cursor", "max": 1}
		}
		call := callWith("vibe_cf_"+name+"_list", input)
		var err error
		switch name {
		case "d1":
			err = cmdD1List(context.Background(), b, call, &out)
		case "dns":
			err = cmdDNSList(context.Background(), b, call, &out)
		case "r2":
			err = cmdR2List(context.Background(), b, call, &out)
		}
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal([]byte(out.String()), &result); err != nil {
			t.Fatal(err)
		}
		if name == "r2" {
			if result["truncated"] != true || result["next_cursor"] != "next/+ token" {
				t.Fatal(result)
			}
		} else if result["pagination"].(map[string]any)["next_page"] != float64(3) {
			t.Fatal(result)
		}
	}
}

func TestInvalidLifetimeAndFalseD1AckNeverCauseFalseSuccess(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Write([]byte(`{"success":true,"result":[{"success":false}]}`))
	}))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, R2Endpoint: server.URL, APIToken: "fixture", AccountID: "acct", WorkersSubdomain: "acct", R2Bucket: "files", R2AccessKey: "fixture", R2SecretKey: "fixture"}
	for _, command := range []string{"share", "mint"} {
		call := callWith("vibe_cf_r2_share", map[string]any{"ref": "fixture", "ttlSec": 86401})
		var out strings.Builder
		var err error
		if command == "share" {
			err = cmdR2Share(context.Background(), b, call, &out)
		} else {
			call = callWith("vibe_cf_shortlink_mint", map[string]any{"worker": "fixture", "ref": "fixture", "ttlSec": 86401})
			err = cmdShortlinkMint(context.Background(), b, call, &out)
		}
		if err == nil || out.Len() != 0 || requests != 0 {
			t.Fatalf("invalid TTL contacted provider: %v", err)
		}
	}
	c := newCFClient(b)
	if _, err := d1Query(context.Background(), c, b, "db", "select 1", nil); err == nil {
		t.Fatal("false D1 ack accepted")
	}
}

func TestServerFailuresPreserveMutationUncertainty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, R2Endpoint: server.URL, APIToken: "fixture", AccountID: "acct", R2Bucket: "files", R2AccessKey: "fixture", R2SecretKey: "fixture"}
	c := newCFClient(b)
	defer c.http.CloseIdleConnections()
	_, err := c.do(context.Background(), "POST", "/apply", map[string]string{"name": "fixture"})
	if !errors.Is(err, errUncertain) {
		t.Fatalf("REST 503 is not uncertain: %v", err)
	}
	_, err = workerDeploy(context.Background(), c, b, "fixture-worker", "export default {}", "")
	if !errors.Is(err, errUncertain) {
		t.Fatalf("deploy 503 is not uncertain: %v", err)
	}
	if err = r2Put(context.Background(), b, "fixture.txt", []byte("content")); !errors.Is(err, errUncertain) {
		t.Fatalf("PUT 503 is not uncertain: %v", err)
	}
	_, _, err = r2Do(context.Background(), b, "DELETE", "/files/fixture.txt")
	if !errors.Is(err, errUncertain) {
		t.Fatalf("DELETE 503 is not uncertain: %v", err)
	}
}

func TestRequestTimeoutLeavesMutationUncertain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(408) }))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, APIToken: "fixture"}
	c := newCFClient(b)
	if _, err := c.do(context.Background(), "POST", "/apply", map[string]string{"name": "fixture"}); !errors.Is(err, errUncertain) {
		t.Fatalf("408 is safe to retry: %v", err)
	}
}

func TestCredentialedRequestsNeverFollowRedirects(t *testing.T) {
	followed := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/private" {
			followed++
			w.Write([]byte(`{"success":true,"result":{}}`))
			return
		}
		w.Header().Set("Location", "/private")
		w.WriteHeader(307)
	}))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, R2Endpoint: server.URL, APIToken: "fixture", R2Bucket: "files", R2AccessKey: "fixture", R2SecretKey: "fixture"}
	c := newCFClient(b)
	defer c.http.CloseIdleConnections()
	if _, err := c.do(context.Background(), "POST", "/apply", map[string]string{"x": "y"}); err == nil {
		t.Fatal("redirect accepted")
	}
	if err := r2Put(context.Background(), b, "fixture.txt", []byte("x")); err == nil {
		t.Fatal("PUT redirect accepted")
	}
	if _, code, err := r2Do(context.Background(), b, "DELETE", "/files/x"); err != nil || code != 307 {
		t.Fatalf("unexpected delete redirect: %d %v", code, err)
	}
	if followed != 0 {
		t.Fatalf("replayed credentialed request %d times", followed)
	}
}

func TestSetupNeverCreatesAfterLookupFailure(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
		}
		w.WriteHeader(503)
	}))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, APIToken: "fixture", AccountID: "acct", WorkersSubdomain: "acct"}
	err := cmdShortlinkSetup(context.Background(), b, callWith("vibe_cf_shortlink_setup", map[string]any{"worker": "fixture"}), &strings.Builder{})
	if !errors.Is(err, errUncertain) || writes != 0 {
		t.Fatalf("lookup caused writes: %d %v", writes, err)
	}
}

func TestExhaustedShortlinkCollisionsNeverClaimSuccess(t *testing.T) {
	inserts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Write([]byte(`{"success":true,"result":[{"uuid":"fixture-db"}]}`))
			return
		}
		inserts++
		w.Write([]byte(`{"success":false,"errors":[{"message":"UNIQUE constraint failed"}]}`))
	}))
	defer server.Close()
	b := cfBinding{APIBase: server.URL, APIToken: "fixture", AccountID: "acct", WorkersSubdomain: "acct"}
	var out strings.Builder
	err := cmdShortlinkMint(context.Background(), b, callWith("vibe_cf_shortlink_mint", map[string]any{"worker": "fixture", "url": "https://example.com"}), &out)
	if err == nil || inserts != 4 || out.Len() != 0 {
		t.Fatalf("false success: %d %v %s", inserts, err, out.String())
	}
}

func TestWorkerPartialDeploymentAndMalformedAckAreUncertain(t *testing.T) {
	for _, ack := range []string{`{"success":false}`, `not-json`, `{"success":true,"result":{}}`} {
		t.Run(ack, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/subdomain") {
					w.WriteHeader(403)
					return
				}
				w.Write([]byte(ack))
			}))
			defer server.Close()
			b := cfBinding{APIBase: server.URL, APIToken: "fixture", AccountID: "acct"}
			c := newCFClient(b)
			defer c.http.CloseIdleConnections()
			if _, err := workerDeploy(context.Background(), c, b, "fixture-worker", "export default {}", ""); !errors.Is(err, errUncertain) {
				t.Fatalf("partial or malformed result accepted: %v", err)
			}
		})
	}
}

func TestBoundedWireAndObjectKeysRejectBeforeAnyEffect(t *testing.T) {
	valid := `{"api_version":"soot/v1","hook":"tool.call","soot":"fixture","operation":"vibe_cf_r2_list","input":{}}`
	for _, wire := range []string{valid + `{}`, valid + strings.Repeat(" ", maxEnvelopeBytes), "null"} {
		if _, err := readCall(strings.NewReader(wire)); err == nil {
			t.Fatal("invalid envelope accepted")
		}
	}
	if _, err := readResponse(strings.NewReader(strings.Repeat("x", 11)), 10); err == nil {
		t.Fatal("overlong response accepted")
	}
	for _, key := range []string{"../escape", "a/../escape", "", "key?override=true"} {
		if err := r2Put(context.Background(), cfBinding{R2Endpoint: "http://127.0.0.1:1"}, key, []byte("x")); err == nil || errors.Is(err, errUncertain) {
			t.Fatalf("invalid key reached network: %s %v", key, err)
		}
	}
	if err := decodeStrict([]byte("null"), new(dnsInput)); err == nil {
		t.Fatal("null input accepted")
	}
	if err := cmdDNSDelete(context.Background(), cfBinding{APIToken: "fixture", AccountID: "acct", ZoneID: "zone"}, callWith("vibe_cf_dns_delete", map[string]string{"record": "../other?x=y"}), &strings.Builder{}); err == nil {
		t.Fatal("unsafe record id accepted")
	}
}
