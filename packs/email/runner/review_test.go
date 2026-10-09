package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestCorruptOrDifferentCompletedIntentNeverSends(t *testing.T) {
	f := newFakeSMTP(t, nil)
	dir := t.TempDir()
	testBinding(t, f, dir)
	in := map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "one", "action_id": "completed"}
	if _, err := runSend(t, callJSON(in)); err != nil {
		t.Fatal(err)
	}
	in["text"] = "two"
	if _, err := runSend(t, callJSON(in)); err == nil {
		t.Fatal("changed completed input accepted")
	}
	if err := os.WriteFile(journalPath(dir, "corrupt"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	in["action_id"] = "corrupt"
	if _, err := runSend(t, callJSON(in)); err == nil {
		t.Fatal("corrupt journal was ignored")
	}
	if len(f.messages()) != 1 {
		t.Fatalf("duplicate delivery: %d", len(f.messages()))
	}
}

func TestConcurrentSameIntentHasOnlyOneSMTPDelivery(t *testing.T) {
	f := newFakeSMTP(t, nil)
	dir := t.TempDir()
	testBinding(t, f, dir)
	wire := callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "concurrent"})
	var wg sync.WaitGroup
	results := make(chan error, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out bytes.Buffer
			results <- run(strings.NewReader(wire), &out, []string{"send"})
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(f.messages()) != 1 {
		t.Fatalf("concurrent sends delivered %d times", len(f.messages()))
	}
	if _, err := os.Stat(filepath.Join(dir, ".send-concurrent.lock")); !os.IsNotExist(err) {
		t.Fatal("completed claim not released")
	}
}

func TestInterruptedClaimNeverAutomaticallyResends(t *testing.T) {
	f := newFakeSMTP(t, nil)
	dir := t.TempDir()
	testBinding(t, f, dir)
	os.Mkdir(filepath.Join(dir, ".send-interrupted.lock"), 0700)
	result, err := runSend(t, callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b", "action_id": "interrupted"}))
	if err != nil || receiptOf(t, result)["state"] != "unknown" || len(f.messages()) != 0 {
		t.Fatalf("interrupted action sent: %v %v", result, err)
	}
}

func TestCanonicalIntentSeparatesAmbiguousBodiesAndAccounts(t *testing.T) {
	a := sendInput{To: []string{"a@x.com"}, Subject: "s", Text: "a", HTML: "bc"}
	b := a
	b.Text = "ab"
	b.HTML = "c"
	account := binding{From: "sender@x.com", Server: "smtp.example.com", Port: 587}
	if a.payloadHash() != b.payloadHash() {
		t.Fatal("fixture no longer reproduces legacy collision")
	}
	if intentHash(a, account) == intentHash(b, account) {
		t.Fatal("canonical payload remains ambiguous")
	}
	other := account
	other.From = "another@x.com"
	if intentHash(a, account) == intentHash(a, other) {
		t.Fatal("sender is not bound to receipt")
	}
}

func TestAttachmentMIMEBase64LinesAndDecodedBytes(t *testing.T) {
	content := bytes.Repeat([]byte("0123456789"), 300)
	message, err := buildMessage(binding{From: "sender@x.com"}, sendInput{To: []string{"a@x.com"}, Subject: "fixture", Text: "body"}, "fixture-id", []attachment{{meta: artifactMeta{Name: "fixture.txt", MimeType: "text/plain"}, content: content}})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(message))
	if err != nil {
		t.Fatal(err)
	}
	_, params, err := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(parsed.Body, params["boundary"])
	reader.NextPart()
	part, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(part)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\r\n") {
		if len(line) > 76 {
			t.Fatalf("MIME base64 line exceeds 76 chars: %d", len(line))
		}
	}
	decoded, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, bytes.NewReader(raw)))
	if err != nil || !bytes.Equal(decoded, content) {
		t.Fatalf("attachment bytes changed: %v", err)
	}
}

func TestInvalidWireAndSMTPMailboxSyntaxFailBeforeNetwork(t *testing.T) {
	for _, address := range []string{"a>@x.com", "A <a@x.com>", "ü@x.com", "a@x.com\r\nRCPT TO:<b@x.com>"} {
		if validAddress(address) == nil {
			t.Fatalf("invalid bare mailbox accepted: %s", address)
		}
	}
	valid := callJSON(map[string]any{"to": []string{"a@x.com"}, "subject": "s", "text": "b"})
	for _, wire := range []string{valid + "{}", valid + strings.Repeat(" ", maxEnvelopeBytes), "null"} {
		if _, err := readCall(strings.NewReader(wire)); err == nil {
			t.Fatal("invalid wire accepted")
		}
	}
}
