// vibe-cloudflare is the Cloudflare pack executable: R2 object sharing
// (SigV4 presigned GET), Workers deploy/list/delete, D1 database ops, and
// DNS record CRUD inside the bound zone. Standalone tool; reads a ToolCall
// JSON envelope on stdin, writes one JSON result or exits non-zero.
//
// Exit contract (internal/operations): 0 = decided success, 1 = refused /
// decided failure (nothing applied), 2 = uncertain — an effect may already
// have reached Cloudflare; the host keeps the resource fenced.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---- envelope ------------------------------------------------------------

const maxEnvelopeBytes = 128 * 1024
const maxInlineBytes = 1 << 20 // worker scripts / d1 statements / r2 inline payloads

func readCall(in io.Reader) (toolCall, error) {
	var call toolCall
	raw, err := readResponse(in, maxEnvelopeBytes)
	if err != nil || json.Unmarshal(raw, &call) != nil {
		return call, fmt.Errorf("invalid or oversized tool envelope")
	}
	if call.APIVersion != "soot/v1" || call.Hook != toolCallHook || call.Soot == "" {
		return call, fmt.Errorf("invalid tool context")
	}
	return call, nil
}

func decodeStrict(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return fmt.Errorf("missing input")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid input: %w", err)
	}
	if dec.Decode(new(any)) != io.EOF {
		return fmt.Errorf("expected one input object")
	}
	return nil
}

// errUncertain marks failures raised after a request may already have
// reached Cloudflare — main exits 2 so the host journals uncertain.
var errUncertain = errors.New("uncertain effect")
var errNotFound = errors.New("not found")

// ---- binding --------------------------------------------------------------

// cfBinding is the host-bound credential JSON (env/file per deployment):
//
//	{"api_token":"…","account_id":"…","zone_id":"…",
//	 "r2_access_key":"…","r2_secret_key":"…","r2_bucket":"…",
//	 "workers_subdomain":"myaccount"}
//
// zone_id is required for dns ops only; r2_* for r2 ops; workers_subdomain
// for the public URL after deploy (derived, not required to deploy).
type cfBinding struct {
	APIToken         string `json:"api_token"`
	AccountID        string `json:"account_id"`
	ZoneID           string `json:"zone_id"`
	R2AccessKey      string `json:"r2_access_key"`
	R2SecretKey      string `json:"r2_secret_key"`
	R2Bucket         string `json:"r2_bucket"`
	WorkersSubdomain string `json:"workers_subdomain"`
	APIBase          string `json:"api_base"` // override for tests/fixtures
	R2Endpoint       string `json:"r2_endpoint"`
}

func loadBinding(getenv func(string) string) (cfBinding, error) {
	var b cfBinding
	raw := getenv("CF_BINDING")
	if raw == "" {
		return b, fmt.Errorf("CF_BINDING credential not bound")
	}
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		return b, fmt.Errorf("CF_BINDING is not valid JSON")
	}
	if b.APIBase == "" {
		b.APIBase = "https://api.cloudflare.com/client/v4"
	}
	if b.R2Endpoint == "" && b.AccountID != "" {
		b.R2Endpoint = "https://" + b.AccountID + ".r2.cloudflarestorage.com"
	}
	return b, nil
}

func (b cfBinding) need(fields ...string) error {
	have := map[string]string{
		"api_token": b.APIToken, "account_id": b.AccountID, "zone_id": b.ZoneID,
		"r2_access_key": b.R2AccessKey, "r2_secret_key": b.R2SecretKey,
		"r2_bucket": b.R2Bucket, "workers_subdomain": b.WorkersSubdomain,
	}
	for _, f := range fields {
		if have[f] == "" {
			return fmt.Errorf("binding missing %s", f)
		}
	}
	return nil
}

// ---- CF REST client -------------------------------------------------------

type cfClient struct {
	base  string
	token string
	http  *http.Client
}

func newCFClient(b cfBinding) *cfClient {
	return &cfClient{base: strings.TrimRight(b.APIBase, "/"), token: b.APIToken,
		http: boundClient(30 * time.Second)}
}

// Never forward credentials or replay a mutation at a redirect destination.
func boundClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func readResponse(body io.Reader, maximum int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maximum+1))
	if err == nil && int64(len(raw)) > maximum {
		err = errors.New("response exceeds size limit")
	}
	return raw, err
}

// cfDo issues one request. Failures are classified by where they happened:
// transport/timeout before a response → uncertain (the effect may be queued
// at CF); 5xx cannot prove a mutation was not applied. No automatic retries.
type pageInfo struct {
	Page       int `json:"page"`
	PerPage    int `json:"per_page"`
	TotalCount int `json:"total_count"`
}

func (c *cfClient) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	return c.doPage(ctx, method, path, body, nil)
}

func (c *cfClient) doPage(ctx context.Context, method, path string, body any, info *pageInfo) (json.RawMessage, error) {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUncertain, err)
	}
	defer resp.Body.Close()
	raw, err := readResponse(resp.Body, 4<<20)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUncertain, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout {
		return nil, fmt.Errorf("%w: cloudflare HTTP %d", errUncertain, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("cloudflare %d: %s", resp.StatusCode, truncate(string(raw), 400))
	}
	var env struct {
		ResultInfo pageInfo        `json:"result_info"`
		Success    bool            `json:"success"`
		Result     json.RawMessage `json:"result"`
		Errors     []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("%w: undecodable response: %v", errUncertain, err)
	}
	if !env.Success {
		msg := "cloudflare api error"
		if len(env.Errors) > 0 {
			msg = env.Errors[0].Message
		}
		return nil, fmt.Errorf("%s", msg)
	}
	if info != nil {
		*info = env.ResultInfo
	}
	return env.Result, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- SigV4 presign (R2) ---------------------------------------------------

var r2KeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,999}$`)

func signHMAC(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

// presignGet builds a SigV4 presigned GET for one R2 object. Region "auto",
// UNSIGNED-PAYLOAD; URL is the shareable artifact.
func presignGet(b cfBinding, key string, ttl time.Duration, now time.Time) (string, error) {
	if !r2KeyPattern.MatchString(key) || len(key) > 1024 || strings.Contains(key, "..") {
		return "", fmt.Errorf("invalid object key")
	}
	if ttl <= 0 || ttl > 24*time.Hour {
		return "", fmt.Errorf("ttl must be 1s..24h")
	}
	stamp := now.UTC()
	datestamp := stamp.Format("20060102")
	amzdate := stamp.Format("20060102T150405Z")
	scope := datestamp + "/auto/s3/aws4_request"
	host := strings.TrimPrefix(strings.TrimPrefix(b.R2Endpoint, "https://"), "http://")
	host = strings.SplitN(host, "/", 2)[0]

	q := url.Values{
		"X-Amz-Algorithm":     {"AWS4-HMAC-SHA256"},
		"X-Amz-Credential":    {b.R2AccessKey + "/" + scope},
		"X-Amz-Date":          {amzdate},
		"X-Amz-Expires":       {strconv.FormatInt(int64(ttl/time.Second), 10)},
		"X-Amz-SignedHeaders": {"host"},
	}
	// Canonical query: keys sorted, values RFC3986-encoded.
	var keys []string
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var cq strings.Builder
	for i, k := range keys {
		if i > 0 {
			cq.WriteByte('&')
		}
		cq.WriteString(k + "=" + awsEncode(q[k][0]))
	}
	canonicalURI := "/" + awsEncodePath(b.R2Bucket) + "/" + awsEncodePath(key)
	canonical := strings.Join([]string{
		"GET", canonicalURI, cq.String(),
		"host:" + host + "\n", "host", "UNSIGNED-PAYLOAD",
	}, "\n")
	hash := sha256.Sum256([]byte(canonical))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzdate + "\n" + scope + "\n" + hex.EncodeToString(hash[:])
	kDate := signHMAC([]byte("AWS4"+b.R2SecretKey), datestamp)
	kRegion := signHMAC(kDate, "auto")
	kService := signHMAC(kRegion, "s3")
	kSigning := signHMAC(kService, "aws4_request")
	sig := hex.EncodeToString(signHMAC(kSigning, stringToSign))
	return b.R2Endpoint + canonicalURI + "?" + cq.String() + "&X-Amz-Signature=" + sig, nil
}

// awsEncode is RFC3986 for query values (space as %20, not +).
func awsEncode(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

// awsEncodePath keeps '/' separators, encodes each segment.
func awsEncodePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = awsEncode(s)
	}
	return strings.Join(segs, "/")
}

// r2Do issues an S3 REST call against R2 (DELETE/ListObjectsV2) signed inline.
func r2Do(ctx context.Context, b cfBinding, method, pathQuery string) ([]byte, int, error) {
	host := strings.TrimPrefix(strings.TrimPrefix(b.R2Endpoint, "https://"), "http://")
	host = strings.SplitN(host, "/", 2)[0]
	now := time.Now().UTC()
	amzdate := now.Format("20060102T150405Z")
	datestamp := now.Format("20060102")
	scope := datestamp + "/auto/s3/aws4_request"
	payloadHash := sha256.Sum256(nil)
	payloadHex := hex.EncodeToString(payloadHash[:])

	canonicalURI, rawQuery, _ := strings.Cut(pathQuery, "?")
	// Canonical query params must be sorted + encoded.
	var cq string
	if rawQuery != "" {
		vals, _ := url.ParseQuery(rawQuery)
		var ks []string
		for k := range vals {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		var parts []string
		for _, k := range ks {
			for _, v := range vals[k] {
				parts = append(parts, awsEncode(k)+"="+awsEncode(v))
			}
		}
		cq = strings.Join(parts, "&")
	}
	headers := "host:" + host + "\nx-amz-content-sha256:" + payloadHex + "\nx-amz-date:" + amzdate + "\n"
	canonical := strings.Join([]string{method, canonicalURI, cq, headers,
		"host;x-amz-content-sha256;x-amz-date", payloadHex}, "\n")
	hash := sha256.Sum256([]byte(canonical))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzdate + "\n" + scope + "\n" + hex.EncodeToString(hash[:])
	kDate := signHMAC([]byte("AWS4"+b.R2SecretKey), datestamp)
	kRegion := signHMAC(kDate, "auto")
	kService := signHMAC(kRegion, "s3")
	kSigning := signHMAC(kService, "aws4_request")
	sig := hex.EncodeToString(signHMAC(kSigning, stringToSign))

	req, err := http.NewRequestWithContext(ctx, method, b.R2Endpoint+pathQuery, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+b.R2AccessKey+"/"+scope+
		", SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="+sig)
	req.Header.Set("x-amz-content-sha256", payloadHex)
	req.Header.Set("x-amz-date", amzdate)
	client := boundClient(60 * time.Second)
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: %v", errUncertain, err)
	}
	defer resp.Body.Close()
	raw, err := readResponse(resp.Body, 8<<20)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("%w: %v", errUncertain, err)
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout {
		return nil, resp.StatusCode, fmt.Errorf("%w: r2 HTTP %d", errUncertain, resp.StatusCode)
	}
	return raw, resp.StatusCode, nil
}

// r2Put uploads bytes (context cancelled → uncertain; response decides).
func r2Put(ctx context.Context, b cfBinding, key string, body []byte) error {
	if !r2KeyPattern.MatchString(key) || strings.Contains(key, "..") {
		return fmt.Errorf("invalid object key")
	}
	// PUT with signed headers including content hash.
	host := strings.TrimPrefix(strings.TrimPrefix(b.R2Endpoint, "https://"), "http://")
	host = strings.SplitN(host, "/", 2)[0]
	now := time.Now().UTC()
	amzdate := now.Format("20060102T150405Z")
	datestamp := now.Format("20060102")
	scope := datestamp + "/auto/s3/aws4_request"
	sum := sha256.Sum256(body)
	payloadHex := hex.EncodeToString(sum[:])
	uri := "/" + awsEncodePath(b.R2Bucket) + "/" + awsEncodePath(key)
	headers := "host:" + host + "\nx-amz-content-sha256:" + payloadHex + "\nx-amz-date:" + amzdate + "\n"
	canonical := strings.Join([]string{"PUT", uri, "", headers,
		"host;x-amz-content-sha256;x-amz-date", payloadHex}, "\n")
	hash := sha256.Sum256([]byte(canonical))
	stringToSign := "AWS4-HMAC-SHA256\n" + amzdate + "\n" + scope + "\n" + hex.EncodeToString(hash[:])
	kDate := signHMAC([]byte("AWS4"+b.R2SecretKey), datestamp)
	kRegion := signHMAC(kDate, "auto")
	kService := signHMAC(kRegion, "s3")
	kSigning := signHMAC(kService, "aws4_request")
	sig := hex.EncodeToString(signHMAC(kSigning, stringToSign))

	req, err := http.NewRequestWithContext(ctx, "PUT", b.R2Endpoint+uri, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+b.R2AccessKey+"/"+scope+
		", SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="+sig)
	req.Header.Set("x-amz-content-sha256", payloadHex)
	req.Header.Set("x-amz-date", amzdate)
	client := boundClient(120 * time.Second)
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errUncertain, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout {
		return fmt.Errorf("%w: r2 put HTTP %d", errUncertain, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("r2 put %d", resp.StatusCode)
	}
	return nil
}

// ---- artifact store (contract-compatible re-implementation) ---------------

var (
	artRefPattern  = regexp.MustCompile(`^art_[0-9a-f]{32}$`)
	artShaPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	maxStoreObject = int64(64 << 20)
)

type artMeta struct {
	ID       string `json:"id"`
	MimeType string `json:"mimeType"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Name     string `json:"name"`
}

func storeRead(root, ref string) (artMeta, []byte, error) {
	var m artMeta
	if !artRefPattern.MatchString(ref) {
		return m, nil, fmt.Errorf("invalid artifact ref")
	}
	metaBytes, err := readBoundedFile(root+"/meta/"+ref+".json", 64<<10)
	if err != nil {
		return m, nil, fmt.Errorf("artifact not found")
	}
	if err := json.Unmarshal(metaBytes, &m); err != nil || m.ID != ref || !artShaPattern.MatchString(m.SHA256) {
		return m, nil, fmt.Errorf("corrupt artifact meta")
	}
	if m.Bytes < 0 || m.Bytes > maxStoreObject {
		return m, nil, fmt.Errorf("artifact exceeds %d byte limit", maxStoreObject)
	}
	content, err := readBoundedFile(root+"/objects/"+m.SHA256[:2]+"/"+m.SHA256, m.Bytes)
	if err != nil {
		return m, nil, fmt.Errorf("artifact object missing")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != m.SHA256 || int64(len(content)) != m.Bytes {
		return m, nil, fmt.Errorf("artifact checksum mismatch")
	}
	return m, content, nil
}

func readBoundedFile(path string, maximum int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("expected regular artifact file")
	}
	return readResponse(f, maximum)
}

// ---- inputs ---------------------------------------------------------------

type r2ShareInput struct {
	Ref    string `json:"ref"`
	Key    string `json:"key"`
	TTLSec int    `json:"ttlSec"`
}

type r2UploadInput struct {
	Ref  string `json:"ref"`
	Key  string `json:"key"`
	Name string `json:"name,omitempty"`
}

type workerDeployInput struct {
	Name   string `json:"name"`
	Script string `json:"script"`
	D1     string `json:"d1,omitempty"` // optional D1 database (uuid or name) bound as env.LINKS
}

type d1CreateInput struct {
	Name string `json:"name"`
}
type d1ExecInput struct {
	Database string `json:"database"` // uuid or name
	SQL      string `json:"sql"`
	Params   []any  `json:"params,omitempty"`
}

type dnsInput struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
	Record  string `json:"record"` // for delete
}

// ---- ops ------------------------------------------------------------------

func emit(out io.Writer, v any) error {
	return json.NewEncoder(out).Encode(v)
}

func receipt(actionID, state string, remote map[string]string, errMsg string) map[string]any {
	r := map[string]any{"actionId": actionID, "state": state}
	if len(remote) > 0 {
		r["remoteIds"] = remote
	}
	if errMsg != "" {
		r["error"] = errMsg
	}
	return map[string]any{"kind": "receipt", "receipt": r}
}

func stableActionID(call toolCall, seed string) string {
	sum := sha256.Sum256([]byte(call.Soot + "|" + call.Operation + "|" + seed))
	return hex.EncodeToString(sum[:16])
}

func cmdR2Share(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("r2_access_key", "r2_secret_key", "r2_bucket"); err != nil {
		return err
	}
	var in r2ShareInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	ttl := time.Duration(in.TTLSec) * time.Second
	if in.TTLSec == 0 {
		ttl = time.Hour
	}
	if in.TTLSec < 0 || in.TTLSec > 86400 {
		return fmt.Errorf("ttlSec must be 0..86400")
	}
	key := in.Key
	m := artMeta{}
	if in.Ref != "" {
		// Sharing an artifact copies it under an immutable object key first,
		// so the presigned URL cannot drift if the artifact is re-uploaded.
		var content []byte
		var err error
		m, content, err = storeRead(os.Getenv("ARTIFACT_STORE"), in.Ref)
		if err != nil {
			return err
		}
		key = m.SHA256[:16] + "/" + sanitizeName(m.Name)
		if err := r2Put(ctx, b, key, content); err != nil {
			return err
		}
	}
	if key == "" {
		return fmt.Errorf("key or ref is required")
	}
	link, err := presignGet(b, key, ttl, time.Now())
	if err != nil {
		return err
	}
	return emit(out, map[string]any{
		"kind": "share",
		"share": map[string]any{
			"key":       key,
			"url":       link,
			"expiresAt": time.Now().Add(ttl).UTC().Format(time.RFC3339),
		},
	})
}

func cmdR2Upload(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("r2_access_key", "r2_secret_key", "r2_bucket"); err != nil {
		return err
	}
	var in r2UploadInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	m, content, err := storeRead(os.Getenv("ARTIFACT_STORE"), in.Ref)
	if err != nil {
		return err
	}
	key := in.Key
	if key == "" {
		key = m.SHA256[:16] + "/" + sanitizeName(m.Name)
	}
	if err := r2Put(ctx, b, key, content); err != nil {
		return err
	}
	return emit(out, receipt(stableActionID(call, key), "succeeded",
		map[string]string{"objectKey": key, "contentSha256": m.SHA256}, ""))
}

func cmdR2Unshare(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("r2_access_key", "r2_secret_key", "r2_bucket"); err != nil {
		return err
	}
	var in struct {
		Key string `json:"key"`
	}
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !r2KeyPattern.MatchString(in.Key) || len(in.Key) > 1024 || strings.Contains(in.Key, "..") {
		return fmt.Errorf("invalid object key")
	}
	_, code, err := r2Do(ctx, b, "DELETE", "/"+awsEncodePath(b.R2Bucket)+"/"+awsEncodePath(in.Key))
	if err != nil {
		return err
	}
	if code != 204 && code != 200 && code != 404 {
		return fmt.Errorf("r2 delete %d", code)
	}
	return emit(out, receipt(stableActionID(call, in.Key), "succeeded",
		map[string]string{"objectKey": in.Key}, ""))
}

func cmdR2List(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("r2_access_key", "r2_secret_key", "r2_bucket"); err != nil {
		return err
	}
	var in struct {
		Prefix string `json:"prefix"`
		Cursor string `json:"cursor"`
		Max    int    `json:"max"`
	}
	if len(bytes.TrimSpace(call.Input)) > 0 {
		if err := decodeStrict(call.Input, &in); err != nil {
			return err
		}
	}
	if in.Max < 0 || in.Max > 1000 {
		return fmt.Errorf("max must be 1..1000 or omitted")
	}
	if in.Max == 0 {
		in.Max = 100
	}
	if len(in.Prefix) > 1024 || len(in.Cursor) > 4096 || in.Max < 0 || in.Max > 1000 {
		return fmt.Errorf("invalid R2 page")
	}
	q := "?list-type=2&max-keys=" + strconv.Itoa(in.Max)
	if in.Cursor != "" {
		q += "&continuation-token=" + url.QueryEscape(in.Cursor)
	}
	if in.Prefix != "" {
		q += "&prefix=" + url.QueryEscape(in.Prefix)
	}
	raw, code, err := r2Do(ctx, b, "GET", "/"+awsEncodePath(b.R2Bucket)+q)
	if err != nil {
		return err
	}
	if code != 200 {
		return fmt.Errorf("r2 list %d", code)
	}
	var lr struct {
		XMLName   xml.Name `xml:"ListBucketResult"`
		Truncated bool     `xml:"IsTruncated"`
		Cursor    string   `xml:"NextContinuationToken"`
		Contents  []struct {
			Key  string `xml:"Key"`
			Size int64  `xml:"Size"`
			ETag string `xml:"ETag"`
		} `xml:"Contents"`
	}
	if err := xml.Unmarshal(raw, &lr); err != nil {
		return fmt.Errorf("undecodable list response")
	}
	items := make([]map[string]any, 0, len(lr.Contents))
	for _, o := range lr.Contents {
		items = append(items, map[string]any{"key": o.Key, "bytes": o.Size})
	}
	if lr.Truncated && lr.Cursor == "" {
		return fmt.Errorf("truncated R2 response missing continuation token")
	}
	return emit(out, map[string]any{"kind": "list", "objects": items, "truncated": lr.Truncated, "next_cursor": lr.Cursor})
}

// ---- worker ---------------------------------------------------------------

var workerNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$`)
var dnsRecordPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func cmdWorkerDeploy(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in workerDeployInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Name) {
		return fmt.Errorf("worker name must be [a-z0-9-]{2,63}")
	}
	if len(in.Script) == 0 || len(in.Script) > maxInlineBytes {
		return fmt.Errorf("script must be 1..%d bytes", maxInlineBytes)
	}
	c := newCFClient(b)
	var d1ID string
	if in.D1 != "" {
		var err error
		d1ID, err = d1Resolve(ctx, c, b, in.D1)
		if err != nil {
			return err
		}
	}
	publicURL, err := workerDeploy(ctx, c, b, in.Name, in.Script, d1ID)
	if err != nil {
		return err
	}
	return emit(out, receipt(stableActionID(call, in.Name), "succeeded",
		map[string]string{"worker": in.Name, "url": publicURL}, ""))
}

// workerDeploy PUTs one ES-module script and enables its workers.dev
// subdomain route. d1DB, when set, is bound as env.LINKS.
func workerDeploy(ctx context.Context, c *cfClient, b cfBinding, name, script, d1DB string) (string, error) {
	path := "/accounts/" + b.AccountID + "/workers/scripts/" + name
	// PUT script body — multipart per CF API, main module "worker.js".
	metadata := `{"main_module":"worker.js"}`
	if d1DB != "" {
		metadata = fmt.Sprintf(`{"main_module":"worker.js","bindings":[{"type":"d1","name":"LINKS","id":%q}]}`, d1DB)
	}
	var buf bytes.Buffer
	nb := sha256.Sum256([]byte(name))
	boundary := "----vibecloudflare" + hex.EncodeToString(nb[:8])
	buf.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n")
	buf.WriteString(metadata + "\r\n")
	buf.WriteString("--" + boundary + "\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n")
	buf.WriteString(script)
	buf.WriteString("\r\n--" + boundary + "--\r\n")
	req, err := http.NewRequestWithContext(ctx, "PUT", c.base+path, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errUncertain, err)
	}
	raw, err := readResponse(resp.Body, 4<<20)
	resp.Body.Close()
	if err != nil {
		return "", fmt.Errorf("%w: %v", errUncertain, err)
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusRequestTimeout {
		return "", fmt.Errorf("%w: worker deploy HTTP %d", errUncertain, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("worker deploy %d: %s", resp.StatusCode, truncate(string(raw), 400))
	}
	var ack struct {
		Success bool `json:"success"`
	}
	if json.Unmarshal(raw, &ack) != nil || !ack.Success {
		return "", fmt.Errorf("%w: invalid worker deployment acknowledgement", errUncertain)
	}
	// Enable the workers.dev subdomain so the script is publicly reachable.
	_, subErr := c.do(ctx, "POST", "/accounts/"+b.AccountID+"/workers/scripts/"+name+"/subdomain",
		map[string]any{"enabled": true, "previews_enabled": false})
	if subErr != nil {
		// Script is already deployed, so even a decided route failure is partial.
		return "", fmt.Errorf("%w: script deployed but route activation failed: %v", errUncertain, subErr)
	}
	publicURL := ""
	if subErr == nil && b.WorkersSubdomain != "" {
		publicURL = "https://" + name + "." + b.WorkersSubdomain + ".workers.dev"
	}
	return publicURL, nil
}

func cmdWorkerDelete(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Name) {
		return fmt.Errorf("invalid worker name")
	}
	c := newCFClient(b)
	_, err := c.do(ctx, "DELETE", "/accounts/"+b.AccountID+"/workers/scripts/"+in.Name, nil)
	if err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	return emit(out, receipt(stableActionID(call, in.Name), "succeeded",
		map[string]string{"worker": in.Name}, ""))
}

func cmdWorkerList(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	c := newCFClient(b)
	res, err := c.do(ctx, "GET", "/accounts/"+b.AccountID+"/workers/scripts", nil)
	if err != nil {
		return err
	}
	var items []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(res, &items); err != nil || bytes.Equal(bytes.TrimSpace(res), []byte("null")) {
		return fmt.Errorf("invalid worker list response")
	}
	names := make([]string, 0, len(items))
	for _, it := range items {
		names = append(names, it.ID)
	}
	return emit(out, map[string]any{"kind": "list", "workers": names})
}

// ---- d1 -------------------------------------------------------------------

var d1NamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var d1IDPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func cmdD1Create(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in d1CreateInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !d1NamePattern.MatchString(in.Name) {
		return fmt.Errorf("invalid database name")
	}
	c := newCFClient(b)
	res, err := c.do(ctx, "POST", "/accounts/"+b.AccountID+"/d1/database",
		map[string]any{"name": in.Name})
	if err != nil {
		return err
	}
	var db struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(res, &db); err != nil || db.UUID == "" {
		return fmt.Errorf("%w: missing created database identity", errUncertain)
	}
	return emit(out, receipt(stableActionID(call, in.Name), "succeeded",
		map[string]string{"database": db.UUID, "name": db.Name}, ""))
}

func cmdD1Exec(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in d1ExecInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if in.Database == "" || len(in.Database) > 64 {
		return fmt.Errorf("database is required (uuid or name)")
	}
	if in.SQL == "" || len(in.SQL) > 8192 {
		return fmt.Errorf("sql must be 1..8192 bytes")
	}
	// CF query endpoint accepts one statement per call; reject multi-statement
	// strings up front instead of relying on the API error.
	if hasMultipleStatements(in.SQL) {
		return fmt.Errorf("one statement per call")
	}
	c := newCFClient(b)
	dbID, err := d1Resolve(ctx, c, b, in.Database)
	if err != nil {
		return err
	}
	qr, err := d1Query(ctx, c, b, dbID, in.SQL, in.Params)
	if err != nil {
		return err
	}
	return emit(out, map[string]any{"kind": "query", "database": dbID, "results": qr})
}

// d1Resolve maps a database name or uuid to its uuid.
func d1Resolve(ctx context.Context, c *cfClient, b cfBinding, nameOrID string) (string, error) {
	if d1IDPattern.MatchString(nameOrID) {
		return nameOrID, nil
	}
	res, err := c.do(ctx, "GET", "/accounts/"+b.AccountID+"/d1/database?name="+url.QueryEscape(nameOrID), nil)
	if err != nil {
		return "", err
	}
	var list []struct {
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal(res, &list); err != nil || bytes.Equal(bytes.TrimSpace(res), []byte("null")) {
		return "", fmt.Errorf("invalid database lookup response")
	}
	if len(list) == 0 {
		return "", fmt.Errorf("%w: d1 database %q", errNotFound, nameOrID)
	}
	if list[0].UUID == "" {
		return "", fmt.Errorf("invalid database lookup identity")
	}
	return list[0].UUID, nil
}

// hasMultipleStatements ignores semicolons inside SQLite quotes and comments.
// SQLite validates statement syntax; this only enforces the one-statement API.
func hasMultipleStatements(sql string) bool {
	ended := false
	for i := 0; i < len(sql); i++ {
		ch := sql[i]
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
			continue
		}
		if ch == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			continue
		}
		if ch == '/' && i+1 < len(sql) && sql[i+1] == '*' {
			i += 2
			for i+1 < len(sql) && !(sql[i] == '*' && sql[i+1] == '/') {
				i++
			}
			i++
			continue
		}
		if ch == ';' {
			ended = true
			continue
		}
		if ended {
			return true
		}
		if ch == '\'' || ch == '"' || ch == '`' || ch == '[' {
			end := ch
			if ch == '[' {
				end = ']'
			}
			for i++; i < len(sql); i++ {
				if sql[i] != end {
					continue
				}
				if end != ']' && i+1 < len(sql) && sql[i+1] == end {
					i++
					continue
				}
				break
			}
		}
	}
	return false
}

type d1Result struct {
	Results []map[string]any `json:"results"`
	Success bool             `json:"success"`
}

// d1Query preserves D1's public per-statement result envelope.
func d1Query(ctx context.Context, c *cfClient, b cfBinding, dbID, sql string, params []any) ([]d1Result, error) {
	res, err := c.do(ctx, "POST", "/accounts/"+b.AccountID+"/d1/database/"+dbID+"/query",
		map[string]any{"sql": sql, "params": params})
	if err != nil {
		return nil, err
	}
	var qr []d1Result
	if err := json.Unmarshal(res, &qr); err != nil || len(qr) == 0 {
		return nil, fmt.Errorf("%w: undecodable or empty d1 response", errUncertain)
	}
	for _, statement := range qr {
		if !statement.Success {
			return nil, fmt.Errorf("D1 statement failed")
		}
	}
	return qr, nil
}

type listPage struct {
	Page  int `json:"page"`
	Limit int `json:"limit"`
}

func readListPage(input json.RawMessage) (listPage, error) {
	var in listPage
	if err := decodeStrict(input, &in); err != nil {
		return in, err
	}
	if in.Page < 0 || in.Page > 1000000 || in.Limit < 0 || in.Limit > 100 {
		return in, fmt.Errorf("page must be 1..1000000 and limit 1..100, or omitted")
	}
	if in.Page == 0 {
		in.Page = 1
	}
	if in.Limit == 0 {
		in.Limit = 100
	}
	return in, nil
}
func listPagination(in listPage, info pageInfo, count int) map[string]any {
	next := 0
	// A full page without provider totals is potentially incomplete; permit one
	// additional bounded request rather than inventing an exhaustive list.
	if in.Page*in.Limit < info.TotalCount || info.TotalCount == 0 && count == in.Limit {
		next = in.Page + 1
	}
	return map[string]any{"page": in.Page, "limit": in.Limit, "total_count": info.TotalCount, "next_page": next}
}

func cmdD1List(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	in, err := readListPage(call.Input)
	if err != nil {
		return err
	}
	c := newCFClient(b)
	var info pageInfo
	res, err := c.doPage(ctx, "GET", "/accounts/"+b.AccountID+"/d1/database?page="+strconv.Itoa(in.Page)+"&per_page="+strconv.Itoa(in.Limit), nil, &info)
	if err != nil {
		return err
	}
	var dbs []struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(res, &dbs); err != nil || bytes.Equal(bytes.TrimSpace(res), []byte("null")) {
		return fmt.Errorf("invalid database list response")
	}
	return emit(out, map[string]any{"kind": "list", "databases": dbs, "pagination": listPagination(in, info, len(dbs))})
}

// ---- dns ------------------------------------------------------------------

var dnsTypeAllow = map[string]bool{"A": true, "AAAA": true, "CNAME": true, "TXT": true}

func cmdDNSCreate(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id", "zone_id"); err != nil {
		return err
	}
	var in dnsInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !dnsTypeAllow[in.Type] {
		return fmt.Errorf("type must be A/AAAA/CNAME/TXT")
	}
	if in.Name == "" || in.Content == "" {
		return fmt.Errorf("name and content are required")
	}
	// Basic shape checks — keep bogus records out of the bound zone.
	switch in.Type {
	case "A":
		if net.ParseIP(in.Content) == nil || strings.Contains(in.Content, ":") {
			return fmt.Errorf("A record needs an IPv4 address")
		}
	case "AAAA":
		ip := net.ParseIP(in.Content)
		if ip == nil || !strings.Contains(in.Content, ":") {
			return fmt.Errorf("AAAA record needs an IPv6 address")
		}
	case "CNAME", "TXT":
		if strings.ContainsAny(in.Content, "\r\n\x00") {
			return fmt.Errorf("invalid record content")
		}
	}
	ttl := in.TTL
	if ttl == 0 {
		ttl = 1 // 1 = automatic
	}
	c := newCFClient(b)
	res, err := c.do(ctx, "POST", "/zones/"+b.ZoneID+"/dns_records", map[string]any{
		"type": in.Type, "name": in.Name, "content": in.Content,
		"ttl": ttl, "proxied": in.Proxied,
	})
	if err != nil {
		return err
	}
	var rec struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(res, &rec); err != nil || !dnsRecordPattern.MatchString(rec.ID) {
		return fmt.Errorf("%w: missing created DNS identity", errUncertain)
	}
	return emit(out, receipt(stableActionID(call, in.Name+"|"+in.Type), "succeeded",
		map[string]string{"record": rec.ID, "name": in.Name}, ""))
}

func cmdDNSDelete(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id", "zone_id"); err != nil {
		return err
	}
	var in dnsInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !dnsRecordPattern.MatchString(in.Record) {
		return fmt.Errorf("record id is required")
	}
	c := newCFClient(b)
	_, err := c.do(ctx, "DELETE", "/zones/"+b.ZoneID+"/dns_records/"+in.Record, nil)
	if err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	return emit(out, receipt(stableActionID(call, in.Record), "succeeded",
		map[string]string{"record": in.Record}, ""))
}

func cmdDNSList(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id", "zone_id"); err != nil {
		return err
	}
	in, err := readListPage(call.Input)
	if err != nil {
		return err
	}
	c := newCFClient(b)
	var info pageInfo
	res, err := c.doPage(ctx, "GET", "/zones/"+b.ZoneID+"/dns_records?page="+strconv.Itoa(in.Page)+"&per_page="+strconv.Itoa(in.Limit), nil, &info)
	if err != nil {
		return err
	}
	var recs []struct {
		ID, Type, Name, Content string
	}
	if err := json.Unmarshal(res, &recs); err != nil || bytes.Equal(bytes.TrimSpace(res), []byte("null")) {
		return fmt.Errorf("invalid DNS list response")
	}
	return emit(out, map[string]any{"kind": "list", "records": recs, "pagination": listPagination(in, info, len(recs))})
}

// ---- shortlink ------------------------------------------------------------
// A named shortlink service = one Worker (LINKS D1 binding) + one D1
// database "<worker>-links". All state lives in the operator's CF account;
// the runner is stateless and derives everything from the worker name.

const shortlinkScript = `export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const code = url.pathname.replace(/^\/+/, "");
    if (!/^[a-z0-9_-]{1,64}$/.test(code)) return new Response("not found", { status: 404 });
    const row = await env.LINKS.prepare(
      "SELECT url, expires_at FROM links WHERE code = ?").bind(code).first();
    if (!row) return new Response("not found", { status: 404 });
    if (row.expires_at && row.expires_at < Date.now() / 1000)
      return new Response("link expired", { status: 410 });
    return Response.redirect(row.url, 302);
  }
};`

var shortcodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type shortlinkMintInput struct {
	Worker string `json:"worker"`
	URL    string `json:"url"`
	Ref    string `json:"ref"`
	Code   string `json:"code"`
	TTLSec int    `json:"ttlSec"`
}

func shortlinkDBName(worker string) string { return worker + "-links" }

// shortlinkSetup provisions or verifies the service: creates the D1
// database when missing, creates the links table, deploys the worker.
func cmdShortlinkSetup(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id", "workers_subdomain"); err != nil {
		return err
	}
	var in struct {
		Worker string `json:"worker"`
	}
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Worker) {
		return fmt.Errorf("invalid worker name")
	}
	c := newCFClient(b)
	dbID, err := d1Resolve(ctx, c, b, shortlinkDBName(in.Worker))
	if err != nil {
		if !errors.Is(err, errNotFound) {
			return err
		}
		// Database missing → create it.
		res, err := c.do(ctx, "POST", "/accounts/"+b.AccountID+"/d1/database",
			map[string]any{"name": shortlinkDBName(in.Worker)})
		if err != nil {
			return err
		}
		var db struct{ UUID string }
		if err := json.Unmarshal(res, &db); err != nil || db.UUID == "" {
			return fmt.Errorf("%w: missing created D1 identity", errUncertain)
		}
		dbID = db.UUID
	}
	if _, err := d1Query(ctx, c, b, dbID,
		"create table if not exists links (code text primary key, url text not null, expires_at integer, created_at integer)", nil); err != nil {
		return fmt.Errorf("%w: shortlink D1 stage requires reconciliation: %v", errUncertain, err)
	}
	publicURL, err := workerDeploy(ctx, c, b, in.Worker, shortlinkScript, dbID)
	if err != nil {
		return fmt.Errorf("%w: D1 ready; worker deployment requires reconciliation: %v", errUncertain, err)
	}
	return emit(out, map[string]any{
		"kind": "service",
		"service": map[string]any{
			"worker": in.Worker, "database": dbID, "url": publicURL,
		},
	})
}

func cmdShortlinkMint(ctx context.Context, b cfBinding, call toolCall, out io.Writer) (resultErr error) {
	if err := b.need("api_token", "account_id", "workers_subdomain"); err != nil {
		return err
	}
	var in shortlinkMintInput
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Worker) {
		return fmt.Errorf("invalid worker name")
	}
	if in.TTLSec < 0 || in.Ref != "" && in.TTLSec > 86400 {
		return fmt.Errorf("invalid shortlink lifetime; artifact URLs expire within 24 hours")
	}
	code := in.Code
	if code == "" {
		code = newShortcode()
	}
	if !shortcodePattern.MatchString(code) {
		return fmt.Errorf("code must match [a-z0-9_-]{1,64}")
	}
	c := newCFClient(b)
	dbID, err := d1Resolve(ctx, c, b, shortlinkDBName(in.Worker))
	if err != nil {
		return fmt.Errorf("shortlink service not set up: run vibe_cf_shortlink_setup first (%w)", err)
	}
	uploaded := false
	defer func() {
		if uploaded && resultErr != nil {
			resultErr = fmt.Errorf("%w: R2 object uploaded; shortlink requires reconciliation: %v", errUncertain, resultErr)
		}
	}()
	// Target: explicit https URL, or an artifact ref shared into R2 first.
	target := in.URL
	if in.Ref != "" {
		if target != "" {
			return fmt.Errorf("supply url or ref, not both")
		}
		if err := b.need("r2_access_key", "r2_secret_key", "r2_bucket"); err != nil {
			return err
		}
		m, content, err := storeRead(os.Getenv("ARTIFACT_STORE"), in.Ref)
		if err != nil {
			return err
		}
		key := m.SHA256[:16] + "/" + sanitizeName(m.Name)
		if err := r2Put(ctx, b, key, content); err != nil {
			return err
		}
		uploaded = true
		ttl := time.Duration(in.TTLSec) * time.Second
		if in.TTLSec <= 0 {
			ttl = 24 * time.Hour
		}
		target, err = presignGet(b, key, ttl, time.Now())
		if err != nil {
			return err
		}
	}
	u, err := url.ParseRequestURI(target)
	if err != nil || u.Scheme != "https" {
		return fmt.Errorf("url must be an https URL")
	}
	var expiresAt int64
	if in.TTLSec > 0 {
		expiresAt = time.Now().Unix() + int64(in.TTLSec)
	}
	inserted := false
	for range 4 {
		_, qerr := d1Query(ctx, c, b, dbID,
			"insert into links (code, url, expires_at, created_at) values (?, ?, ?, ?)",
			[]any{code, target, expiresAt, time.Now().Unix()})
		if qerr == nil {
			inserted = true
			break
		}
		if in.Code != "" {
			return fmt.Errorf("code %q is taken or insert failed: %v", code, qerr)
		}
		if !strings.Contains(strings.ToLower(qerr.Error()), "unique") &&
			!strings.Contains(strings.ToLower(qerr.Error()), "constraint") {
			return qerr
		}
		code = newShortcode() // random code collided; retry
	}
	if !inserted {
		return fmt.Errorf("could not allocate a shortlink code after four collisions")
	}
	return emit(out, map[string]any{
		"kind": "shortlink",
		"shortlink": map[string]any{
			"code":      code,
			"url":       "https://" + in.Worker + "." + b.WorkersSubdomain + ".workers.dev/" + code,
			"target":    target[:min(len(target), 80)],
			"targetLen": len(target),
			"expiresAt": expiresAt,
		},
	})
}

func cmdShortlinkRevoke(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in struct {
		Worker string `json:"worker"`
		Code   string `json:"code"`
	}
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Worker) || !shortcodePattern.MatchString(in.Code) {
		return fmt.Errorf("worker and code are required")
	}
	c := newCFClient(b)
	dbID, err := d1Resolve(ctx, c, b, shortlinkDBName(in.Worker))
	if err != nil {
		return err
	}
	if _, err := d1Query(ctx, c, b, dbID, "delete from links where code = ?", []any{in.Code}); err != nil {
		return err
	}
	return emit(out, receipt(stableActionID(call, in.Worker+"|"+in.Code), "succeeded",
		map[string]string{"code": in.Code}, ""))
}

func cmdShortlinkList(ctx context.Context, b cfBinding, call toolCall, out io.Writer) error {
	if err := b.need("api_token", "account_id"); err != nil {
		return err
	}
	var in struct {
		Worker string `json:"worker"`
	}
	if err := decodeStrict(call.Input, &in); err != nil {
		return err
	}
	if !workerNamePattern.MatchString(in.Worker) {
		return fmt.Errorf("invalid worker name")
	}
	c := newCFClient(b)
	dbID, err := d1Resolve(ctx, c, b, shortlinkDBName(in.Worker))
	if err != nil {
		return err
	}
	results, err := d1Query(ctx, c, b, dbID,
		"select code, url, expires_at, created_at from links order by created_at desc limit 100", nil)
	if err != nil {
		return err
	}
	var rows []map[string]any
	for _, result := range results {
		rows = append(rows, result.Results...)
	}
	return emit(out, map[string]any{"kind": "list", "links": rows})
}

const shortcodeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

func newShortcode() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "x" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	var sb strings.Builder
	for _, c := range b[:6] {
		sb.WriteByte(shortcodeAlphabet[int(c)%len(shortcodeAlphabet)])
	}
	return sb.String()
}

// ---- name sanitize (artifacts contract) ------------------------------------

var nameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func sanitizeName(name string) string {
	name = nameUnsafe.ReplaceAllString(strings.TrimSpace(name), "-")
	name = strings.Trim(name, ".-")
	if len(name) > 80 {
		name = name[:80]
	}
	if name == "" {
		name = "artifact"
	}
	return name
}

// ---- dispatch --------------------------------------------------------------

func run(ctx context.Context, in io.Reader, out io.Writer, getenv func(string) string, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: vibe-cloudflare <r2|worker|d1|dns> <op>")
	}
	call, err := readCall(in)
	if err != nil {
		return err
	}
	if call.Operation != "vibe_cf_"+args[0]+"_"+args[1] {
		return fmt.Errorf("operation mismatch")
	}
	b, err := loadBinding(getenv)
	if err != nil {
		return err
	}
	switch args[0] + "/" + args[1] {
	case "r2/share":
		return cmdR2Share(ctx, b, call, out)
	case "r2/upload":
		return cmdR2Upload(ctx, b, call, out)
	case "r2/unshare":
		return cmdR2Unshare(ctx, b, call, out)
	case "r2/list":
		return cmdR2List(ctx, b, call, out)
	case "worker/deploy":
		return cmdWorkerDeploy(ctx, b, call, out)
	case "worker/delete":
		return cmdWorkerDelete(ctx, b, call, out)
	case "worker/list":
		return cmdWorkerList(ctx, b, call, out)
	case "d1/create":
		return cmdD1Create(ctx, b, call, out)
	case "d1/exec":
		return cmdD1Exec(ctx, b, call, out)
	case "d1/list":
		return cmdD1List(ctx, b, call, out)
	case "dns/create":
		return cmdDNSCreate(ctx, b, call, out)
	case "dns/delete":
		return cmdDNSDelete(ctx, b, call, out)
	case "dns/list":
		return cmdDNSList(ctx, b, call, out)
	case "shortlink/setup":
		return cmdShortlinkSetup(ctx, b, call, out)
	case "shortlink/mint":
		return cmdShortlinkMint(ctx, b, call, out)
	case "shortlink/revoke":
		return cmdShortlinkRevoke(ctx, b, call, out)
	case "shortlink/list":
		return cmdShortlinkList(ctx, b, call, out)
	}
	return fmt.Errorf("unknown operation %s/%s", args[0], args[1])
}

func main() {
	if err := run(context.Background(), os.Stdin, os.Stdout, os.Getenv, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, errUncertain) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}
