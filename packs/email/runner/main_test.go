package main

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- fake SMTP server -----------------------------------------------------

type fakeSMTP struct {
	ln            net.Listener
	port          int
	startTLS      bool
	dropAfterData atomic.Bool
	refuseRCPT    atomic.Bool
	requireAuth   bool
	gotAuth       atomic.Value // string
	mu            sync.Mutex
	gotMsgs       []string
	cert          tls.Certificate
	caPool        *x509.CertPool
	caFile        string
}

func testCA(t *testing.T, host string) (tls.Certificate, *x509.CertPool, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{host},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certPEM) {
		t.Fatal("bad ca pem")
	}
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, certPEM, 0600); err != nil {
		t.Fatal(err)
	}
	return cert, pool, caFile
}

func newFakeSMTP(t *testing.T, opts func(*fakeSMTP)) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSMTP{ln: ln, port: ln.Addr().(*net.TCPAddr).Port}
	if opts != nil {
		opts(f)
	}
	go f.serve()
	t.Cleanup(func() { f.ln.Close() })
	return f
}

func (f *fakeSMTP) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(conn)
	}
}

func (f *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	write := func(format string, a ...any) {
		fmt.Fprintf(w, format+"\r\n", a...)
		w.Flush()
	}
	write("220 fake ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		up := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(up, "EHLO"):
			var exts []string
			exts = append(exts, "250-fake greets you")
			if f.startTLS {
				exts = append(exts, "250-STARTTLS")
			}
			if f.requireAuth {
				exts = append(exts, "250-AUTH PLAIN")
			}
			exts = append(exts, "250 8BITMIME")
			for _, e := range exts {
				write("%s", e)
			}
		case strings.HasPrefix(up, "STARTTLS"):
			write("220 Go ahead")
			tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{f.cert}})
			if err := tc.Handshake(); err != nil {
				return
			}
			conn = tc
			r = bufio.NewReader(tc)
			w = bufio.NewWriter(tc)
		case strings.HasPrefix(up, "AUTH"):
			f.gotAuth.Store(line)
			write("235 2.7.0 Authentication successful")
		case strings.HasPrefix(up, "MAIL FROM"):
			write("250 2.1.0 Ok")
		case strings.HasPrefix(up, "RCPT TO"):
			if f.refuseRCPT.Load() {
				write("550 5.1.1 no such user")
			} else {
				write("250 2.1.5 Ok")
			}
		case up == "DATA":
			write("354 End data with <CR><LF>.<CR><LF>")
			var msg strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" || l == ".\n" {
					break
				}
				msg.WriteString(l)
			}
			if f.dropAfterData.Load() {
				return // connection dies before 250: client must record unknown
			}
			f.mu.Lock()
			f.gotMsgs = append(f.gotMsgs, msg.String())
			n := len(f.gotMsgs)
			f.mu.Unlock()
			write("250 2.0.0 Ok queued-%d", n)
		case up == "QUIT":
			write("221 Bye")
			return
		case up == "RSET" || up == "NOOP":
			write("250 Ok")
		default:
			write("502 not implemented")
		}
	}
}

// ---- helpers ---------------------------------------------------------------

func testBinding(t *testing.T, f *fakeSMTP, journal string) binding {
	t.Helper()
	b := binding{
		Server: "127.0.0.1", Port: f.port, TLS: "none",
		From: "agent@example.com", Journal: journal,
	}
	if f.startTLS {
		b.Server = "localhost"
		b.TLS = "starttls"
		b.CAFile = f.caFile
	}
	if f.requireAuth {
		b.Username = "user1"
		b.Password = "secret"
	}
	raw, _ := json.Marshal(b)
	t.Setenv("EMAIL_BINDING", string(raw))
	return b
}

func callJSON(input map[string]any) string {
	b, _ := json.Marshal(input)
	env := map[string]any{
		"api_version": "soot/v1", "hook": "tool.call", "soot": "helper",
		"operation": "email_send", "input": json.RawMessage(b),
	}
	raw, _ := json.Marshal(env)
	return string(raw)
}

func runSend(t *testing.T, stdin string) (map[string]any, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(strings.NewReader(stdin), &out, []string{"send"})
	var res map[string]any
	json.Unmarshal(out.Bytes(), &res)
	return res, err
}

func receiptOf(t *testing.T, res map[string]any) map[string]any {
	t.Helper()
	r, ok := res["receipt"].(map[string]any)
	if !ok {
		t.Fatalf("no receipt in %v", res)
	}
	return r
}

func (f *fakeSMTP) messages() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.gotMsgs...)
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ---- tests -----------------------------------------------------------------

func TestHappyPath(t *testing.T) {
	f := newFakeSMTP(t, nil)
	dir := t.TempDir()
	testBinding(t, f, dir)
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "Xin chào",
		"text": "body", "action_id": "t1",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	r := receiptOf(t, res)
	if r["state"] != "succeeded" {
		t.Fatalf("state: %v", r)
	}
	if len(f.messages()) != 1 {
		t.Fatalf("messages: %d", len(f.messages()))
	}
	if !strings.Contains(f.messages()[0], "Message-ID:") {
		t.Fatal("no message-id recorded")
	}
	j, err := readJournal(dir, "t1")
	if err != nil || j.State != stateDone || j.MessageID == "" {
		t.Fatalf("journal: %+v %v", j, err)
	}
}

func TestDedupNoResend(t *testing.T) {
	f := newFakeSMTP(t, nil)
	dir := t.TempDir()
	testBinding(t, f, dir)
	in := callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "dup1",
	})
	if _, err := runSend(t, in); err != nil {
		t.Fatal(err)
	}
	res, err := runSend(t, in)
	if err != nil {
		t.Fatal(err)
	}
	if receiptOf(t, res)["deduplicated"] != true {
		t.Fatalf("expected dedup: %v", res)
	}
	if len(f.messages()) != 1 {
		t.Fatalf("resent: %d messages", len(f.messages()))
	}
}

func TestDisconnectAfterDataIsUnknown(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.dropAfterData.Store(true) })
	dir := t.TempDir()
	testBinding(t, f, dir)
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "lost1",
	}))
	if err != nil {
		t.Fatalf("expected receipt not error: %v", err)
	}
	if receiptOf(t, res)["state"] != "unknown" {
		t.Fatalf("expected unknown: %v", res)
	}
	j, err := readJournal(dir, "lost1")
	if err != nil || j.State != stateAwaitAck {
		t.Fatalf("journal: %+v %v", j, err)
	}
	// Same action again: still unknown, zero new messages.
	res2, _ := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "lost1",
	}))
	if receiptOf(t, res2)["state"] != "unknown" {
		t.Fatalf("retry should stay unknown: %v", res2)
	}
}

func TestRefusedRCPTIsFailedAndRetryable(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.refuseRCPT.Store(true) })
	dir := t.TempDir()
	testBinding(t, f, dir)
	res, _ := runSend(t, callJSON(map[string]any{
		"to": []string{"bad@x.com"}, "subject": "s", "text": "b", "action_id": "ref1",
	}))
	if receiptOf(t, res)["state"] != "failed" {
		t.Fatalf("expected failed: %v", res)
	}
	f.refuseRCPT.Store(false)
	res2, err := runSend(t, callJSON(map[string]any{
		"to": []string{"good@x.com"}, "subject": "s", "text": "b", "action_id": "ref1",
	}))
	if err != nil || receiptOf(t, res2)["state"] != "succeeded" {
		t.Fatalf("retry after refuse: %v %v", res2, err)
	}
}

func TestSTARTTLSVerifiedAndUnverified(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) {
		f.startTLS = true
		f.cert, f.caPool, f.caFile = testCA(t, "localhost")
	})
	dir := t.TempDir()
	testBinding(t, f, dir)

	// Happy path over verified STARTTLS.
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "tls", "text": "b", "action_id": "tls1",
	}))
	if err != nil || receiptOf(t, res)["state"] != "succeeded" {
		t.Fatalf("verified starttls send: %v %v", res, err)
	}

	// Same server, but no ca_file: verification must reject the cert.
	b := binding{Server: "localhost", Port: f.port, TLS: "starttls",
		From: "a@x.com", Journal: dir}
	raw, _ := json.Marshal(b)
	t.Setenv("EMAIL_BINDING", string(raw))
	res2, _ := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "tls", "text": "b", "action_id": "tls2",
	}))
	if receiptOf(t, res2)["state"] != "failed" {
		t.Fatalf("unverified cert accepted: %v", res2)
	}
	if len(f.messages()) != 1 {
		t.Fatalf("unverified send delivered: %d", len(f.messages()))
	}
}

func TestAuthPlain(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.requireAuth = true })
	dir := t.TempDir()
	testBinding(t, f, dir)
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "auth1",
	}))
	if err != nil || receiptOf(t, res)["state"] != "succeeded" {
		t.Fatalf("auth send: %v %v", res, err)
	}
	got := f.gotAuth.Load()
	authLine, _ := got.(string)
	if !strings.Contains(authLine, "AUTH PLAIN") {
		t.Fatalf("no auth attempt: %q", authLine)
	}
	// Credential must be base64("\0user1\0secret"), not plaintext.
	want := base64.StdEncoding.EncodeToString([]byte("\x00user1\x00secret"))
	if !strings.Contains(authLine, want) || strings.Contains(authLine, "secret") {
		t.Fatalf("bad auth payload: %q", authLine)
	}
}

func TestTLSNoneNonLoopbackRejected(t *testing.T) {
	dir := t.TempDir()
	raw, _ := json.Marshal(binding{Server: "smtp.example.com", Port: 25, TLS: "none", From: "a@x.com", Journal: dir})
	t.Setenv("EMAIL_BINDING", string(raw))
	_, err := runSend(t, callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b"}))
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("tls none on remote accepted: %v", err)
	}
}

func TestHeaderInjectionRejected(t *testing.T) {
	f := newFakeSMTP(t, nil)
	testBinding(t, f, t.TempDir())
	for _, bad := range []map[string]any{
		{"to": []string{"a@x.com"}, "subject": "ok\r\nBCC: evil@x.com", "text": "b"},
		{"to": []string{"a@x.com\nBCC:evil@x.com"}, "subject": "s", "text": "b"},
		{"to": []string{"a@x.com"}, "subject": "", "text": "b"},
		{"to": []string{"a@x.com"}, "subject": "s"},
	} {
		if _, err := runSend(t, callJSON(bad)); err == nil {
			t.Fatalf("injection accepted: %v", bad)
		}
	}
	if len(f.messages()) != 0 {
		t.Fatal("injected message reached server")
	}
}

func TestMultipartWithAttachmentAndHTML(t *testing.T) {
	root := t.TempDir()
	content := []byte("ATTACH-BYTES")
	realSum := sha256Hex(content)
	os.MkdirAll(filepath.Join(root, "objects", realSum[:2]), 0700)
	os.WriteFile(filepath.Join(root, "objects", realSum[:2], realSum), content, 0600)
	os.MkdirAll(filepath.Join(root, "meta"), 0700)
	ref := "art_" + strings.Repeat("a", 32)
	meta, _ := json.Marshal(map[string]any{
		"id": ref, "mimeType": "application/pdf", "sha256": realSum,
		"bytes": len(content), "name": "report.pdf", "createdAt": "t",
	})
	os.WriteFile(filepath.Join(root, "meta", ref+".json"), meta, 0600)
	t.Setenv("ARTIFACT_STORE", root)

	f := newFakeSMTP(t, nil)
	testBinding(t, f, t.TempDir())
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "Báo cáo",
		"text": "see attached", "html": "<p>see <b>attached</b></p>",
		"attachments": []map[string]any{{"ref": ref}}, "action_id": "att1",
	}))
	if err != nil || receiptOf(t, res)["state"] != "succeeded" {
		t.Fatalf("send: %v %v", res, err)
	}
	msg := strings.ReplaceAll(f.messages()[0], "\r\n..", "\r\n.")
	m, err := mail.ReadMessage(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("message parse: %v", err)
	}
	if m.Header.Get("Message-ID") == "" {
		t.Fatal("no message-id header")
	}
	mt, params, err := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/mixed" {
		t.Fatalf("content-type: %v %v", mt, err)
	}
	mr := multipart.NewReader(m.Body, params["boundary"])
	parts := 0
	var attachBody, altBody []byte
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		parts++
		if strings.HasPrefix(p.Header.Get("Content-Disposition"), "attachment") {
			raw, _ := io.ReadAll(p)
			attachBody, err = io.ReadAll(base64.NewDecoder(base64.StdEncoding, bytes.NewReader(raw)))
			if err != nil {
				t.Fatalf("attach decode: %v", err)
			}
		} else {
			altBody, _ = io.ReadAll(p)
		}
	}
	if parts != 2 {
		t.Fatalf("parts: %d", parts)
	}
	if string(attachBody) != "ATTACH-BYTES" {
		t.Fatalf("attachment body: %q", attachBody)
	}
	if !strings.Contains(string(altBody), "text/plain") || !strings.Contains(string(altBody), "text/html") {
		t.Fatalf("first part lacks both text bodies: %s", altBody)
	}
	if !strings.Contains(string(altBody), "attached") {
		t.Fatalf("first part lost html body: %s", altBody)
	}
}

func TestAttachmentTamperRejected(t *testing.T) {
	root := t.TempDir()
	realSum := sha256Hex([]byte("original"))
	os.MkdirAll(filepath.Join(root, "objects", realSum[:2]), 0700)
	os.WriteFile(filepath.Join(root, "objects", realSum[:2], realSum), []byte("tampered"), 0600)
	os.MkdirAll(filepath.Join(root, "meta"), 0700)
	ref := "art_" + strings.Repeat("b", 32)
	meta, _ := json.Marshal(map[string]any{"id": ref, "sha256": realSum, "bytes": 8})
	os.WriteFile(filepath.Join(root, "meta", ref+".json"), meta, 0600)
	t.Setenv("ARTIFACT_STORE", root)

	f := newFakeSMTP(t, nil)
	testBinding(t, f, t.TempDir())
	if _, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b",
		"attachments": []map[string]any{{"ref": ref}},
	})); err == nil {
		t.Fatal("tampered attachment accepted")
	}
	if len(f.messages()) != 0 {
		t.Fatal("tampered attachment sent")
	}
}

func TestMissingBinding(t *testing.T) {
	t.Setenv("EMAIL_BINDING", "")
	if _, err := runSend(t, callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b"})); err == nil {
		t.Fatal("missing binding accepted")
	}
}

func TestJournalUnknownAcrossRestart(t *testing.T) {
	f := newFakeSMTP(t, func(f *fakeSMTP) { f.dropAfterData.Store(true) })
	dir := t.TempDir()
	testBinding(t, f, dir)
	runSend(t, callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "rx1"}))
	f.dropAfterData.Store(false)
	res, _ := runSend(t, callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "rx1"}))
	if receiptOf(t, res)["state"] != "unknown" {
		t.Fatalf("restart resend: %v", res)
	}
	if len(f.messages()) != 0 {
		t.Fatal("unknown action resent")
	}
}

func TestPayloadHashIncludesAttachments(t *testing.T) {
	a := sendInput{To: []string{"a@x.com"}, Subject: "s", Text: "b"}
	b := sendInput{To: []string{"a@x.com"}, Subject: "s", Text: "b",
		Attachments: []attachmentRef{{Ref: "art_" + strings.Repeat("1", 32)}}}
	if a.payloadHash() == b.payloadHash() {
		t.Fatal("attachments not part of dedup hash")
	}
}

func TestRetryAfterIntentCrash(t *testing.T) {
	// Process died after writing intent but before connecting.
	dir := t.TempDir()
	if err := writeJournal(dir, journal{ActionID: "crash1", State: stateIntent, MessageID: "m1"}); err != nil {
		t.Fatal(err)
	}
	f := newFakeSMTP(t, nil)
	testBinding(t, f, dir)
	res, err := runSend(t, callJSON(map[string]any{
		"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "crash1",
	}))
	if err != nil || receiptOf(t, res)["state"] != "succeeded" {
		t.Fatalf("intent-state retry: %v %v", res, err)
	}
}
