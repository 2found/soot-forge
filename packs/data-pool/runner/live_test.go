package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

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
