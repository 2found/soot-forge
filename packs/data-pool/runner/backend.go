package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type backend struct {
	endpoint, key string
	client        *http.Client
}
type backendError struct{ status int }

func (e backendError) Error() string { return fmt.Sprintf("backend rejected request (%d)", e.status) }

func newBackend(b binding) *backend {
	tr := &http.Transport{Proxy: nil, MaxIdleConns: 256, MaxIdleConnsPerHost: 128, MaxConnsPerHost: 256, IdleConnTimeout: 30 * time.Second}
	if strings.HasPrefix(b.Endpoint, "http://") {
		// Cleartext carries the backend key, so it may only reach loopback or
		// a private network; every dial re-resolves and checks all answers.
		dialer := &net.Dialer{Timeout: 3 * time.Second}
		tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return guardedDial(ctx, network, address, privateAddress, net.DefaultResolver.LookupNetIP, dialer.DialContext)
		}
	}
	return &backend{endpoint: b.Endpoint, key: b.APIKey, client: &http.Client{
		Timeout:       5 * time.Second,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (b *backend) call(ctx context.Context, method, path string, body, out any) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return errors.New("cannot encode backend input")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, b.endpoint+path, bytes.NewReader(data))
	if err != nil {
		return errors.New("invalid backend request")
	}
	req.Header.Set("Authorization", "Bearer "+b.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.client.Do(req)
	if err != nil {
		return errors.New("backend unavailable; mutation outcome may be uncertain")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return backendError{resp.StatusCode}
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, 4<<20+1))
	if err != nil || len(data) > 4<<20 {
		return errors.New("backend response unavailable or too large")
	}
	if out != nil && json.Unmarshal(data, out) != nil {
		return errors.New("invalid backend response")
	}
	return nil
}

func (s *service) submit(ctx context.Context, r receipt, method, path string, body any) (receipt, error) {
	// The uncertain intent/fence is durable before the first network byte.
	if err := s.begin(r); err != nil {
		return r, err
	}
	var result struct {
		TaskUID *int64 `json:"taskUid"`
	}
	err := s.backend.call(ctx, method, path, body, &result)
	if err != nil {
		var rejected backendError
		if errors.As(err, &rejected) && rejected.status >= 400 && rejected.status < 500 && rejected.status != 408 {
			r.Reason = "backend_rejected"
			return s.finish(r, "failed")
		}
		r.Reason = "submission_uncertain"
		if e := s.saveReceipt(r); e != nil {
			return r, e
		}
		return r, nil
	}
	if result.TaskUID == nil || *result.TaskUID < 0 {
		r.Reason = "submission_uncertain"
		if e := s.saveReceipt(r); e != nil {
			return r, e
		}
		return r, nil
	}
	r.Task = result.TaskUID
	r.Status = "pending"
	if err = s.saveReceipt(r); err != nil {
		return r, err
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		r, err = s.reconcile(ctx, r)
		if err != nil || r.Status != "pending" || time.Now().After(deadline) {
			return r, err
		}
		select {
		case <-ctx.Done():
			return r, nil
		case <-time.After(40 * time.Millisecond):
		}
	}
}

func (s *service) reconcile(ctx context.Context, r receipt) (receipt, error) {
	if r.Status == "succeeded" || r.Status == "failed" {
		return r, nil
	}
	if r.Task == nil {
		// Reconcile a lost submission response by its immutable document token,
		// or a proven absence after deletion. Never submit the original POST again.
		var doc storedDocument
		path := "/indexes/" + s.index(r.Pool)
		if r.Document != nil {
			path += "/documents/" + url.PathEscape(r.Document.ID)
		}
		err := s.backend.call(ctx, "GET", path, nil, &doc)
		var rejected backendError
		if (r.Action == "upsert" || r.Action == "append") && err == nil && doc.Receipt == receiptToken(s, r) && sameDocument(doc.document, *r.Document) && hash(doc.Content) == r.Document.SHA256 {
			return s.finish(r, "succeeded")
		}
		if (r.Action == "remove" || r.Action == "pool_remove") && errors.As(err, &rejected) && rejected.status == 404 {
			return s.finish(r, "succeeded")
		}
		return r, nil
	}
	var task struct {
		UID    int64  `json:"uid"`
		Index  string `json:"indexUid"`
		Status string `json:"status"`
	}
	if err := s.backend.call(ctx, "GET", fmt.Sprintf("/tasks/%d", *r.Task), nil, &task); err != nil {
		return r, nil
	}
	if task.UID != *r.Task || task.Index != s.index(r.Pool) {
		return r, errors.New("backend task does not describe this pool")
	}
	switch task.Status {
	case "succeeded":
		return s.finish(r, "succeeded")
	case "failed", "canceled":
		r.Reason = "backend_task_failed"
		return s.finish(r, "failed")
	case "enqueued", "processing":
		return r, nil
	default:
		return r, errors.New("unknown backend task state")
	}
}

func sameDocument(a, b document) bool {
	writerMatches := a.Writer == nil && b.Writer == nil || a.Writer != nil && b.Writer != nil && *a.Writer == *b.Writer
	return writerMatches && a.ID == b.ID && a.Title == b.Title && a.Source == b.Source && a.SHA256 == b.SHA256 && a.Revision == b.Revision && a.UpdatedAt == b.UpdatedAt && strings.Join(a.Tags, "\x00") == strings.Join(b.Tags, "\x00")
}
