package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxOutput = 131072

func validateEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Hostname() == "" || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return errors.New("invalid endpoint")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1" || u.Hostname() == "localhost")) {
		return errors.New("endpoint requires HTTPS or loopback HTTP")
	}
	return nil
}

func validToken(token string) bool {
	return len(token) >= 32 && len(token) <= 4096 && strings.IndexFunc(token, func(r rune) bool { return r < 33 || r > 126 }) < 0
}

// Send only the public tool context, never host event/provider internals.
// This client does not retry or follow redirects, including on mutations.
func remoteExecute(ctx context.Context, b binding, call toolCall, out io.Writer) error {
	data, err := json.Marshal(call)
	if err != nil {
		return errors.New("invalid tool envelope")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.ServiceURL+"/v1/tool", bytes.NewReader(data))
	if err != nil {
		return errors.New("invalid service request")
	}
	req.Header.Set("Authorization", "Bearer "+b.ServiceToken)
	req.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("data-pool service unavailable; inspect the original request_id before retrying a mutation")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("data-pool service denied or failed the request; inspect the original request_id before retrying a mutation")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxOutput+1))
	if err != nil || len(body) > maxOutput || !json.Valid(body) {
		return errors.New("invalid service response; inspect the original request_id")
	}
	_, err = out.Write(body)
	return err
}
