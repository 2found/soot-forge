package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeObservations(t *testing.T) {
	for _, status := range []int{200, 503, 302} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/" {
					t.Error("followed redirect")
				}
				w.Header().Set("Location", "/private")
				w.WriteHeader(status)
				fmt.Fprint(w, "private-response-body")
			}))
			defer target.Close()
			var out bytes.Buffer
			if err := probe(context.Background(), []string{target.URL}, &out); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), fmt.Sprintf("status=%d", status)) || strings.Contains(out.String(), "private") {
				t.Fatal(out.String())
			}
		})
	}
}
func TestInvalidAndUnreachable(t *testing.T) {
	for _, args := range [][]string{nil, {"file:///etc/passwd"}, {"http://user:password@localhost"}, {"http://localhost", "extra"}} {
		var out bytes.Buffer
		if err := probe(context.Background(), args, &out); err == nil || out.Len() != 0 {
			t.Fatal("invalid input accepted", args)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	if err := probe(ctx, []string{"http://127.0.0.1:1"}, &out); err != nil || !strings.Contains(out.String(), "unreachable") {
		t.Fatal(out.String(), err)
	}
}
