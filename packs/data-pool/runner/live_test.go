package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in real-backend suite; never contacts an existing deployment. The
// caller supplies a verified CE v1.54.3 executable, not a network installer.
func TestLiveMeilisearch(t *testing.T) {
	binary := os.Getenv("DATA_POOL_TEST_MEILI")
	if binary == "" {
		t.Skip("set DATA_POOL_TEST_MEILI to verified Meilisearch CE v1.54.3")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	dir := t.TempDir()
	key := "synthetic-live-test-key-1234567890"
	endpoint := "http://" + addr
	var cmd *exec.Cmd
	stop := func() {
		if cmd == nil {
			return
		}
		done := make(chan error, 1)
		cmd.Process.Signal(os.Interrupt)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-done
		}
		cmd = nil
	}
	start := func() {
		cmd = exec.Command(binary, "--db-path", filepath.Join(dir, "meili"), "--http-addr", addr, "--master-key", key, "--no-analytics", "--log-level", "ERROR")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		client := &http.Client{Timeout: time.Second}
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			r, err := client.Get(endpoint + "/health")
			if err == nil {
				r.Body.Close()
				if r.StatusCode == 200 {
					return
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("isolated Meilisearch did not become healthy")
	}
	t.Cleanup(stop)
	start()
	s := testService(t, endpoint)
	s.backend.key = key
	s.b.APIKey = key
	create(t, s, "company")
	create(t, s, "restricted")
	grant(t, s, "company", "marketing", "read")
	grant(t, s, "company", "support", "read")
	r := writeDoc(t, s, "company", "handbook", "import", "Doanh nghiệp Việt Nam cung cấp sản phẩm hỗ trợ khách hàng. Đường dẫn thương hiệu.")
	if r.Status != "succeeded" {
		t.Fatalf("import not completed: %+v", r)
	}
	for _, actor := range []string{"marketing", "support"} {
		s.actor = actor
		for _, q := range []string{"doanh nghiep", "doanh nghiemp", "duong dan", "khach hang"} {
			result := invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: q}).(map[string]any)
			if len(result["hits"].([]any)) != 1 {
				t.Fatalf("%s/%s: %v", actor, q, result)
			}
		}
		denied(t, s, "query", queryInput{Action: "search", Pool: "restricted", Query: "company"})
	}
	// Same backend and policy survive independent backend and runner restarts.
	b := s.b
	s.close()
	stop()
	start()
	again, err := openService(b, "support")
	if err != nil {
		t.Fatal(err)
	}
	s.db = again.db
	s.backend = again.backend
	s.actor = "support"
	read := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"}).(map[string]any)
	if !strings.Contains(read["content"].(string), "Việt Nam") {
		t.Fatal(read)
	}
	s.actor = "manager"
	r = writeDoc(t, s, "company", "handbook", "update", "Chính sách hoàn tiền trong ba mươi ngày.")
	if r.Status != "succeeded" || r.Document.Revision != 2 {
		t.Fatal(r)
	}
	result := invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: "hoan tien"}).(map[string]any)
	if len(result["hits"].([]any)) != 1 {
		t.Fatal(result)
	}
	invoke(t, s, "manage", manageInput{Action: "revoke", Pool: "company", Soot: "marketing", RequestID: "revoke"})
	s.actor = "marketing"
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
	s.actor = "manager"
	r = invoke(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "remove"}).(receipt)
	if r.Status != "succeeded" {
		t.Fatal(r)
	}
	result = invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: "hoan tien"}).(map[string]any)
	if len(result["hits"].([]any)) != 0 {
		t.Fatal("deleted text remained searchable", result)
	}
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "remove-pool"})
	t.Log("Real CE v1.54.3: shared reuse, typo/accent/đ search, CRUD, isolated grants, revoke and both restarts PASS; owned backend stopped by finalizer")
}

func TestLivePublicWebpage(t *testing.T) {
	if os.Getenv("DATA_POOL_TEST_PUBLIC_WEB") != "1" {
		t.Skip("set DATA_POOL_TEST_PUBLIC_WEB=1 to verify explicit public-page fetch")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	text, err := fetchPage(ctx, "https://example.com")
	if err != nil || !strings.Contains(text, "documentation examples") {
		t.Fatalf("public source fetch: %v (%d bytes)", err, len(text))
	}
	t.Log("Explicit public webpage fetched with public-IP guard and HTML extraction; no source subscription created")
}
