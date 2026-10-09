package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriterParticipatesInSharedArtifactLock(t *testing.T) {
	root := t.TempDir()
	unlock, err := lockArtifactStore(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = storeWrite(root, []byte("content"), "text/plain", "fixture.txt", "writing_export", "fixture")
	unlock()
	if !errors.Is(err, errStoreBusy) {
		t.Fatalf("writer ignored shared lock: %v", err)
	}
	if _, err = storeWrite(root, []byte("content"), "text/plain", "fixture.txt", "writing_export", "fixture"); err != nil {
		t.Fatal(err)
	}
}

func TestWritingDoesNotAcknowledgeCorruptCachedContent(t *testing.T) {
	root := storeFixture(t)
	wire := call(map[string]any{"format": "markdown", "text": "content"})
	result, err := runExport(t, wire)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := readArtifactRef(t, root, result)
	os.WriteFile(filepath.Join(root, "objects", meta.SHA256[:2], meta.SHA256), []byte("tampered"), 0600)
	if output, err := runExport(t, wire); err == nil || output != "" {
		t.Fatalf("corruption was acknowledged: %s %v", output, err)
	}
}

func TestWritingWireAndArtifactByteBounds(t *testing.T) {
	wire := call(map[string]any{"format": "markdown", "text": "content"})
	for _, raw := range []string{wire + "{}", wire + strings.Repeat(" ", maxEnvelopeBytes), "null"} {
		if _, err := readCall(strings.NewReader(raw)); err == nil {
			t.Fatal("invalid wire accepted")
		}
	}
	file := filepath.Join(t.TempDir(), "bounded")
	os.WriteFile(file, []byte("12345"), 0600)
	if _, err := readBoundedFile(file, 4); err == nil {
		t.Fatal("artifact byte limit ignored")
	}
}
