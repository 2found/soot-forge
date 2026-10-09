// soot-email is the email pack executable. `send` delivers one message over
// SMTP with mandatory TLS semantics, a durable intent journal (disconnect
// after DATA must leave an `unknown` receipt, never an automatic resend)
// and strict header-injection guards. Standalone tool: it re-implements
// the artifacts store layout for attachment refs.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/2found/soot-forge/packs/email/runner/contract"
)

// ---- envelope -----------------------------------------------------------

const maxEnvelopeBytes = 128 * 1024

func readCall(in io.Reader) (contract.ToolCall, error) {
	var call contract.ToolCall
	raw, err := io.ReadAll(io.LimitReader(in, maxEnvelopeBytes+1))
	if err != nil || len(raw) > maxEnvelopeBytes || json.Unmarshal(raw, &call) != nil {
		return call, fmt.Errorf("invalid or oversized tool envelope")
	}
	if call.APIVersion != contract.APIVersion || call.Hook != contract.ToolCallHook || call.Soot == "" {
		return call, fmt.Errorf("invalid tool context")
	}
	return call, nil
}

// ---- binding ------------------------------------------------------------

type binding struct {
	Server   string `json:"server"`
	Port     int    `json:"port"`
	TLS      string `json:"tls"` // starttls | implicit | none (loopback only)
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	CAFile   string `json:"ca_file,omitempty"` // pinned CA bundle for private PKI; absent = system roots
	From     string `json:"from"`
	FromName string `json:"from_name,omitempty"`
	Journal  string `json:"journal"` // absolute dir for durable intent
}

func loadBinding() (binding, error) {
	var b binding
	raw := os.Getenv("EMAIL_BINDING")
	if raw == "" {
		return b, fmt.Errorf("email binding missing")
	}
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		return b, fmt.Errorf("email binding is not valid JSON")
	}
	if b.Server == "" || strings.ContainsAny(b.Server, "/\\\x00") {
		return b, fmt.Errorf("invalid binding server")
	}
	if b.Port < 1 || b.Port > 65535 {
		return b, fmt.Errorf("invalid binding port")
	}
	switch b.TLS {
	case "starttls", "implicit":
	case "none":
		if !isLoopback(b.Server) {
			return b, fmt.Errorf("tls none is only allowed for loopback test servers")
		}
	default:
		return b, fmt.Errorf("binding tls must be starttls, implicit or none")
	}
	if err := validAddress(b.From); err != nil {
		return b, fmt.Errorf("invalid binding from address")
	}
	if b.FromName != "" && strings.ContainsAny(b.FromName, "\r\n\x00") {
		return b, fmt.Errorf("invalid binding from name")
	}
	if b.Journal == "" || !filepath.IsAbs(b.Journal) {
		return b, fmt.Errorf("binding journal must be an absolute directory")
	}
	if (b.Username == "") != (b.Password == "") {
		return b, fmt.Errorf("binding username and password must be set together")
	}
	return b, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ---- input ---------------------------------------------------------------

var addrPattern = regexp.MustCompile(`^[^@\s\x00-\x1f]+@[^@\s\x00-\x1f]+\.[^@\s\x00-\x1f]+$`)

type sendInput struct {
	To          []string        `json:"to"`
	Subject     string          `json:"subject"`
	Text        string          `json:"text"`
	HTML        string          `json:"html"`
	Attachments []attachmentRef `json:"attachments"`
	ActionID    string          `json:"action_id"`
}

type attachmentRef struct {
	Ref string `json:"ref"`
}

var actionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validAddress(addr string) error {
	parsed, err := mail.ParseAddress(addr)
	if len(addr) > 254 || !isASCII(addr) || !addrPattern.MatchString(addr) || err != nil || parsed.Address != addr || parsed.Name != "" || strings.ContainsAny(addr, "<>") {
		return fmt.Errorf("invalid address")
	}
	return nil
}

func (in *sendInput) validate() error {
	if len(in.To) == 0 || len(in.To) > 20 {
		return fmt.Errorf("to must contain 1..20 addresses")
	}
	for _, a := range in.To {
		if err := validAddress(a); err != nil {
			return err
		}
	}
	if in.Subject == "" || len(in.Subject) > 998 || strings.ContainsAny(in.Subject, "\r\n\x00") {
		return fmt.Errorf("invalid subject")
	}
	if !utf8.ValidString(in.Subject) || (in.Text != "" && !utf8.ValidString(in.Text)) || (in.HTML != "" && !utf8.ValidString(in.HTML)) {
		return fmt.Errorf("message must be valid UTF-8")
	}
	if in.Text == "" && in.HTML == "" {
		return fmt.Errorf("text or html body required")
	}
	if len(in.Text)+len(in.HTML) > 512*1024 {
		return fmt.Errorf("body too large")
	}
	if len(in.Attachments) > 8 {
		return fmt.Errorf("at most 8 attachments")
	}
	if in.ActionID != "" && !actionIDPattern.MatchString(in.ActionID) {
		return fmt.Errorf("invalid action_id")
	}
	return nil
}

// payloadHash dedups identical intent when action_id is absent. Attachments
// join the hash — two sends differing only in attachments are different sends.
func (in *sendInput) payloadHash() string {
	h := sha256.New()
	h.Write([]byte(in.Subject))
	for _, a := range in.To {
		h.Write([]byte{0})
		h.Write([]byte(a))
	}
	h.Write([]byte(in.Text))
	h.Write([]byte(in.HTML))
	for _, a := range in.Attachments {
		h.Write([]byte{0})
		h.Write([]byte(a.Ref))
	}
	return "auto_" + hex.EncodeToString(h.Sum(nil))[:32]
}

// Keep legacy automatic action ids, but bind every acknowledged attempt to an
// unambiguous input and account fingerprint. Credential rotation is harmless.
func intentHash(in sendInput, b binding) string {
	in.ActionID = ""
	data, _ := json.Marshal(struct {
		Input          sendInput
		Server         string
		Port           int
		From, Username string
	}{in, b.Server, b.Port, b.From, b.Username})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ---- journal (durable intent) --------------------------------------------

const (
	stateIntent   = "intent"    // recorded before network I/O
	stateAccepted = "accepted"  // MAIL/RCPT accepted, DATA in progress
	stateAwaitAck = "await_ack" // message bytes + terminator sent, no 250 yet
	stateDone     = "succeeded" // server accepted the message
	stateFailed   = "failed"    // refused before DATA terminator
)

type journal struct {
	ActionID   string `json:"actionId"`
	State      string `json:"state"`
	MessageID  string `json:"messageId,omitempty"`
	Remote     string `json:"remoteId,omitempty"`
	Error      string `json:"error,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
	IntentHash string `json:"intentHash,omitempty"`
}

func journalPath(dir, id string) string { return filepath.Join(dir, "send-"+id+".json") }

func writeJournal(dir string, j journal) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	j.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), journalPath(dir, j.ActionID)); err != nil {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func readJournal(dir, id string) (journal, error) {
	var j journal
	f, err := os.Open(journalPath(dir, id))
	if err != nil {
		return j, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 16*1024+1))
	if err != nil || len(b) > 16*1024 || json.Unmarshal(b, &j) != nil || j.ActionID != id {
		return journal{}, fmt.Errorf("corrupt journal")
	}
	return j, nil
}

// ---- artifact refs (layout contract) --------------------------------------

var (
	refPattern = regexp.MustCompile(`^art_[0-9a-f]{32}$`)
	shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type artifactMeta struct {
	ID       string `json:"id"`
	MimeType string `json:"mimeType"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Name     string `json:"name,omitempty"`
}

func storeRead(root, ref string) (artifactMeta, []byte, error) {
	if !refPattern.MatchString(ref) {
		return artifactMeta{}, nil, fmt.Errorf("invalid artifact ref")
	}
	mb, err := readBoundedFile(filepath.Join(root, "meta", ref+".json"), 64<<10)
	if err != nil {
		return artifactMeta{}, nil, fmt.Errorf("attachment artifact not found")
	}
	var m artifactMeta
	if err := json.Unmarshal(mb, &m); err != nil || m.ID != ref || !shaPattern.MatchString(m.SHA256) {
		return artifactMeta{}, nil, fmt.Errorf("corrupt attachment meta")
	}
	if m.Bytes < 0 || m.Bytes > 8<<20 {
		return m, nil, fmt.Errorf("attachment exceeds 8 MiB limit")
	}
	if _, _, err := mime.ParseMediaType(m.MimeType); err != nil || strings.ContainsAny(m.MimeType, "\r\n\x00") {
		return m, nil, fmt.Errorf("invalid attachment MIME type")
	}
	content, err := readBoundedFile(filepath.Join(root, "objects", m.SHA256[:2], m.SHA256), m.Bytes)
	if err != nil || len(content) > 8<<20 {
		return m, nil, fmt.Errorf("attachment exceeds 8 MiB limit or is unreadable")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != m.SHA256 || int64(len(content)) != m.Bytes {
		return artifactMeta{}, nil, fmt.Errorf("attachment checksum mismatch")
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
	data, err := io.ReadAll(io.LimitReader(f, maximum+1))
	if err == nil && int64(len(data)) > maximum {
		return nil, fmt.Errorf("artifact exceeds byte limit")
	}
	return data, err
}

// ---- MIME message ----------------------------------------------------------

type attachment struct {
	meta    artifactMeta
	content []byte
}

func encodeHeaderText(s string) string {
	if isASCII(s) {
		return s
	}
	return mime.QEncoding.Encode("utf-8", s)
}

func isASCII(s string) bool {
	for _, r := range s {
		if r > 127 {
			return false
		}
	}
	return true
}

func qpWriter(w io.Writer) *quotedprintable.Writer { return quotedprintable.NewWriter(w) }

// textBody returns content-type header value + encoded body for the text
// portion: plain, html, or multipart/alternative.
func textBody(in sendInput) (string, []byte) {
	switch {
	case in.Text != "" && in.HTML != "":
		var b bytes.Buffer
		w := multipart.NewWriter(&b)
		p1, _ := w.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {"text/plain; charset=utf-8"},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		q := qpWriter(p1)
		q.Write([]byte(in.Text))
		q.Close()
		p2, _ := w.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {"text/html; charset=utf-8"},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		q = qpWriter(p2)
		q.Write([]byte(in.HTML))
		q.Close()
		w.Close()
		return `multipart/alternative; boundary="` + w.Boundary() + `"`, b.Bytes()
	case in.HTML != "":
		var b bytes.Buffer
		q := qpWriter(&b)
		q.Write([]byte(in.HTML))
		q.Close()
		return "text/html; charset=utf-8", b.Bytes()
	default:
		var b bytes.Buffer
		q := qpWriter(&b)
		q.Write([]byte(in.Text))
		q.Close()
		return "text/plain; charset=utf-8", b.Bytes()
	}
}

var fileNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

func safeFilename(name, fallback string) string {
	name = fileNameUnsafe.ReplaceAllString(filepath.Base(name), "-")
	name = strings.Trim(name, ".- ")
	if name == "" || len(name) > 96 {
		name = fallback
	}
	return name
}

func buildMessage(b binding, in sendInput, messageID string, attach []attachment) ([]byte, error) {
	var out bytes.Buffer
	from := b.From
	if b.FromName != "" {
		from = fmt.Sprintf("%s <%s>", encodeHeaderText(b.FromName), b.From)
	}
	fmt.Fprintf(&out, "From: %s\r\n", from)
	fmt.Fprintf(&out, "To: %s\r\n", strings.Join(in.To, ", "))
	fmt.Fprintf(&out, "Subject: %s\r\n", encodeHeaderText(in.Subject))
	fmt.Fprintf(&out, "Date: %s\r\n", time.Now().UTC().Format("Mon, 02 Jan 2006 15:04:05 -0700"))
	fmt.Fprintf(&out, "Message-ID: <%s>\r\n", messageID)
	out.WriteString("MIME-Version: 1.0\r\n")

	ct, body := textBody(in)
	multipartBody := strings.HasPrefix(ct, "multipart/")
	if len(attach) == 0 {
		fmt.Fprintf(&out, "Content-Type: %s\r\n", ct)
		if multipartBody {
			// Multipart entities must not be transfer-encoded (RFC 2045 §6.4);
			// the inner leaf parts already carry quoted-printable.
			out.WriteString("\r\n")
		} else {
			out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		}
		out.Write(body)
		out.WriteString("\r\n")
		return out.Bytes(), nil
	}
	w := multipart.NewWriter(&out)
	fmt.Fprintf(&out, "Content-Type: multipart/mixed; boundary=\"%s\"\r\n\r\n", w.Boundary())
	hdr := textproto.MIMEHeader{"Content-Type": {ct}}
	if !multipartBody {
		hdr["Content-Transfer-Encoding"] = []string{"quoted-printable"}
	}
	tp, _ := w.CreatePart(hdr)
	tp.Write(body)
	for i, a := range attach {
		fname := safeFilename(a.meta.Name, fmt.Sprintf("attachment-%d", i+1))
		mt := a.meta.MimeType
		if mt == "" {
			mt = "application/octet-stream"
		}
		ap, err := w.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {mt + `; name="` + fname + `"`},
			"Content-Transfer-Encoding": {"base64"},
			"Content-Disposition":       {`attachment; filename="` + fname + `"`},
		})
		if err != nil {
			return nil, err
		}
		// RFC 2045: MIME base64 lines are at most 76 characters (57 bytes).
		for remaining := a.content; len(remaining) > 0; {
			n := min(57, len(remaining))
			if _, err := io.WriteString(ap, base64.StdEncoding.EncodeToString(remaining[:n])+"\r\n"); err != nil {
				return nil, err
			}
			remaining = remaining[n:]
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func main() {
	if err := run(os.Stdin, os.Stdout, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer, args []string) error {
	if len(args) != 1 || args[0] != "send" {
		return fmt.Errorf("usage: soot-email send")
	}
	call, err := readCall(in)
	if err != nil {
		return err
	}
	if call.Operation != "email_send" {
		return fmt.Errorf("operation mismatch")
	}
	var input sendInput
	if len(bytes.TrimSpace(call.Input)) == 0 || bytes.TrimSpace(call.Input)[0] != '{' {
		return fmt.Errorf("missing input")
	}
	dec := json.NewDecoder(bytes.NewReader(call.Input))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&input); err != nil {
		return fmt.Errorf("invalid input")
	}
	if err := input.validate(); err != nil {
		return err
	}
	b, err := loadBinding()
	if err != nil {
		return err
	}
	actionID := input.ActionID
	if actionID == "" {
		actionID = input.payloadHash()
	}
	// A directory claim works across processes without a platform dependency.
	// An interrupted owner leaves the claim fenced for operator reconciliation.
	if err := os.MkdirAll(b.Journal, 0700); err != nil {
		return err
	}
	claim := filepath.Join(b.Journal, ".send-"+actionID+".lock")
	if err := os.Mkdir(claim, 0700); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		return json.NewEncoder(out).Encode(receiptUnknown(actionID, "action is active or interrupted; reconcile its journal before retrying"))
	}
	defer os.Remove(claim)
	fingerprint := intentHash(input, b)
	// Durable intent check before any network I/O.
	if prior, err := readJournal(b.Journal, actionID); err == nil {
		if prior.State != stateFailed && prior.State != stateIntent && prior.IntentHash != fingerprint {
			return fmt.Errorf("action_id belongs to a different or legacy intent; inspect its journal")
		}
		switch prior.State {
		case stateDone:
			return json.NewEncoder(out).Encode(map[string]any{
				"kind": "receipt",
				"receipt": map[string]any{
					"actionId": actionID, "state": "succeeded", "deduplicated": true,
					"remoteIds": map[string]string{"messageId": prior.MessageID},
				},
			})
		case stateAccepted, stateAwaitAck:
			return json.NewEncoder(out).Encode(map[string]any{
				"kind": "receipt",
				"receipt": map[string]any{
					"actionId": actionID, "state": "unknown",
					"error": "prior attempt lost connection after accepting data; inspect the server before retrying",
				},
			})
		case stateFailed, stateIntent:
			// Failed before DATA terminator or crashed after intent write but
			// before any send — nothing reached the server; safe to retry.
		default:
			return fmt.Errorf("journal for %s in unexpected state %q", actionID, prior.State)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("journal unreadable or corrupt; reconcile before retrying")
	}
	// Assemble message (headers + MIME) before connecting.
	var attach []attachment
	var attachmentBytes int
	for _, a := range input.Attachments {
		m, c, err := storeRead(os.Getenv("ARTIFACT_STORE"), a.Ref)
		if err != nil {
			return err
		}
		attachmentBytes += len(c)
		if attachmentBytes > 16<<20 {
			return fmt.Errorf("attachments exceed 16 MiB total limit")
		}
		attach = append(attach, attachment{meta: m, content: c})
	}
	idHash := sha256.Sum256([]byte(actionID))
	messageID := fmt.Sprintf("%d.%x@soot", time.Now().UnixNano(), idHash[:8])
	msg, err := buildMessage(b, input, messageID, attach)
	if err != nil {
		return err
	}
	j := journal{ActionID: actionID, State: stateIntent, MessageID: messageID, IntentHash: fingerprint}
	if err := writeJournal(b.Journal, j); err != nil {
		return err
	}
	result := deliver(context.Background(), b, input.To, msg, func(state string) error {
		j.State = state
		return writeJournal(b.Journal, j)
	})
	switch result.err {
	case nil:
		j.State = stateDone
		j.Remote = result.remoteID
		if err := writeJournal(b.Journal, j); err != nil {
			return json.NewEncoder(out).Encode(receiptUnknown(actionID, "SMTP accepted the message but final journal failed; reconcile before retrying"))
		}
		return json.NewEncoder(out).Encode(map[string]any{
			"kind": "receipt",
			"receipt": map[string]any{
				"actionId": actionID, "state": "succeeded",
				"remoteIds": map[string]string{"messageId": messageID, "server": result.remoteID},
			},
		})
	default:
		if result.afterData {
			j.State = stateAwaitAck
			j.Error = result.err.Error()
			writeJournal(b.Journal, j)
			return json.NewEncoder(out).Encode(map[string]any{
				"kind": "receipt",
				"receipt": map[string]any{
					"actionId": actionID, "state": "unknown",
					"remoteIds": map[string]string{"messageId": messageID},
					"error":     "connection lost after data was sent; inspect the server before retrying",
				},
			})
		}
		j.State = stateFailed
		j.Error = result.err.Error()
		writeJournal(b.Journal, j)
		return json.NewEncoder(out).Encode(map[string]any{
			"kind": "receipt",
			"receipt": map[string]any{
				"actionId": actionID, "state": "failed", "error": result.err.Error(),
			},
		})
	}
}

func receiptUnknown(actionID, message string) map[string]any {
	return map[string]any{"kind": "receipt", "receipt": map[string]any{"actionId": actionID, "state": "unknown", "error": message}}
}

// ---- SMTP client -----------------------------------------------------------

type deliverResult struct {
	err       error
	remoteID  string
	afterData bool // failure happened after the DATA terminator was sent
}

type smtpConn struct {
	conn   net.Conn
	tp     *textproto.Conn
	tlsCfg *tls.Config
}

func (b binding) tlsConfig() (*tls.Config, error) {
	cfg := &tls.Config{ServerName: b.Server, MinVersion: tls.VersionTLS12}
	if b.CAFile != "" {
		pemBytes, err := os.ReadFile(b.CAFile)
		if err != nil {
			return nil, fmt.Errorf("ca_file unreadable")
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, fmt.Errorf("ca_file has no valid certificates")
		}
		cfg.RootCAs = pool
	}
	return cfg, nil
}

func dialSMTP(b binding) (*smtpConn, error) {
	addr := net.JoinHostPort(b.Server, intToPort(b.Port))
	dialer := &net.Dialer{Timeout: 30 * time.Second}
	tlsCfg, err := b.tlsConfig()
	if err != nil {
		return nil, err
	}
	var conn net.Conn
	if b.TLS == "implicit" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	c := &smtpConn{conn: conn, tp: textproto.NewConn(conn), tlsCfg: tlsCfg}
	c.conn.SetDeadline(time.Now().Add(60 * time.Second))
	if _, _, err := c.tp.ReadResponse(220); err != nil {
		conn.Close()
		return nil, err
	}
	return c, nil
}

func intToPort(p int) string { return fmt.Sprintf("%d", p) }

func (c *smtpConn) cmd(expect int, format string, args ...any) (string, error) {
	if _, err := c.tp.Cmd(format, args...); err != nil {
		return "", err
	}
	_, msg, err := c.tp.ReadResponse(expect)
	return msg, err
}

func (c *smtpConn) extensions() (map[string]string, error) {
	msg, err := c.cmd(250, "EHLO soot.local")
	exts := map[string]string{}
	for _, line := range strings.Split(msg, "\n") {
		parts := strings.Fields(line)
		if len(parts) > 0 {
			exts[strings.ToUpper(parts[0])] = strings.Join(parts[1:], " ")
		}
	}
	return exts, err
}

func deliver(ctx context.Context, b binding, to []string, msg []byte, onState func(string) error) (r deliverResult) {
	c, err := dialSMTP(b)
	if err != nil {
		return deliverResult{err: err}
	}
	defer c.conn.Close()
	exts, err := c.extensions()
	if err != nil {
		return deliverResult{err: err}
	}
	if b.TLS == "starttls" {
		if _, ok := exts["STARTTLS"]; !ok {
			return deliverResult{err: fmt.Errorf("server does not offer STARTTLS")}
		}
		if _, err := c.cmd(220, "STARTTLS"); err != nil {
			return deliverResult{err: err}
		}
		tconn := tls.Client(c.conn, c.tlsCfg)
		if err := tconn.HandshakeContext(ctx); err != nil {
			return deliverResult{err: err}
		}
		c.conn = tconn
		c.tp = textproto.NewConn(tconn)
		if _, err := c.extensions(); err != nil {
			return deliverResult{err: err}
		}
	}
	if b.Username != "" {
		auth := base64.StdEncoding.EncodeToString([]byte("\x00" + b.Username + "\x00" + b.Password))
		if _, err := c.cmd(235, "AUTH PLAIN %s", auth); err != nil {
			return deliverResult{err: err}
		}
	}
	if _, err := c.cmd(250, "MAIL FROM:<%s>", b.From); err != nil {
		return deliverResult{err: err}
	}
	for _, rcpt := range to {
		if _, err := c.cmd(250, "RCPT TO:<%s>", rcpt); err != nil {
			return deliverResult{err: err}
		}
	}
	if err := onState(stateAccepted); err != nil {
		// The durable intent was never marked accepted; continuing would leave
		// a sent message journaled as safe-to-retry. Abort before DATA instead.
		return deliverResult{err: fmt.Errorf("journal write failed: %w", err)}
	}
	if _, err := c.cmd(354, "DATA"); err != nil {
		return deliverResult{err: err}
	}
	// Dot-stuffed message then the terminator.
	w := c.tp.DotWriter()
	if _, err := w.Write(msg); err != nil {
		return deliverResult{err: err, afterData: false}
	}
	if err := w.Close(); err != nil {
		return deliverResult{err: err, afterData: true}
	}
	// From here the server may or may not have the message: any failure is unknown.
	_, msg250, err := c.tp.ReadResponse(250)
	if err != nil {
		return deliverResult{err: err, afterData: true}
	}
	c.cmd(221, "QUIT") // best effort
	fields := strings.Fields(msg250)
	remote := ""
	if len(fields) > 1 {
		remote = fields[len(fields)-1]
	}
	return deliverResult{remoteID: remote}
}
