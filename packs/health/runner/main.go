// Standalone tool: no Soot or AgentRay imports. All network destinations are
// fixed operator-configured argv, never event text or model arguments.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

func probe(ctx context.Context, args []string, out io.Writer) error {
	if len(args) != 1 {
		return fmt.Errorf("expected one configured HTTP(S) health URL")
	}
	u, err := url.Parse(args[0])
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("invalid health URL")
	}
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return fmt.Errorf("invalid health URL")
	}
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		// Unreachable is an observation, not a failed execution of this read tool.
		_, err = fmt.Fprintln(out, "unreachable (network, TLS or timeout)")
		return err
	}
	// Never expose response bodies or redirect destinations to the model.
	resp.Body.Close()
	_, err = fmt.Fprintf(out, "status=%d latency_ms=%d\n", resp.StatusCode, time.Since(started).Milliseconds())
	return err
}

func main() {
	if err := probe(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
