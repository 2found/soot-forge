package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func storeFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("ARTIFACT_STORE", root)
	return root
}

func call(input map[string]any) string {
	b, _ := json.Marshal(input)
	env := map[string]any{
		"api_version": "soot/v1", "hook": "tool.call", "soot": "helper",
		"operation": "writing_export", "input": json.RawMessage(b),
	}
	raw, _ := json.Marshal(env)
	return string(raw)
}

func runExport(t *testing.T, stdin string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(strings.NewReader(stdin), &out, []string{"export"})
	return out.String(), err
}

func readArtifactRef(t *testing.T, root, out string) (artifactMeta, []byte) {
	t.Helper()
	var res struct {
		Kind     string `json:"kind"`
		Artifact struct {
			Ref      string `json:"ref"`
			MimeType string `json:"mimeType"`
		} `json:"artifact"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil || res.Kind != "artifact" {
		t.Fatalf("bad output: %s", out)
	}
	m, content, err := storeRead(root, res.Artifact.Ref)
	if err != nil {
		t.Fatalf("storeRead: %v", err)
	}
	return m, content
}

func TestExportInlineMarkdown(t *testing.T) {
	root := storeFixture(t)
	out, err := runExport(t, call(map[string]any{"format": "markdown", "text": "# Title\n\nBody"}))
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	m, content := readArtifactRef(t, root, out)
	if m.MimeType != "text/markdown" || string(content) != "# Title\n\nBody" {
		t.Fatalf("roundtrip failed: %s", content)
	}
}

func TestExportMarkdownToHTMLSanitized(t *testing.T) {
	root := storeFixture(t)
	out, err := runExport(t, call(map[string]any{
		"format": "html", "source_format": "markdown",
		"text": "# Hi\n\n- **bold**\n- [xss](javascript:alert(1))\n- [ok](https://a.b/c)\n\n<script>x</script>",
	}))
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	_, content := readArtifactRef(t, root, out)
	html := string(content)
	if strings.Contains(html, "javascript:") || strings.Contains(html, "<script") {
		t.Fatalf("unsanitized content: %s", html)
	}
	if !strings.Contains(html, `<a href="https://a.b/c">`) {
		t.Fatalf("safe link lost: %s", html)
	}
}

func TestExportHTMLSanitize(t *testing.T) {
	cases := []struct{ in, mustNot, must string }{
		{`<p onclick="x()">hi</p>`, `onclick`, `<p>hi</p>`},
		{`<script>alert(1)</script><p>ok</p>`, `alert`, `<p>ok</p>`},
		{`<a href="javascript:x()">l</a>`, `javascript`, `<a>l</a>`},
		{`<img src="https://a/b.png" onerror="x()">`, `onerror`, `src=`},
		{`<div style="color:red">t</div>`, `style=`, `<div>t</div>`},
		{`<svg><script>x</script></svg><p>y</p>`, `<svg`, `<p>y</p>`},
	}
	for _, tc := range cases {
		out, err := sanitizeHTML([]byte(tc.in))
		if err != nil {
			t.Fatalf("sanitize %q: %v", tc.in, err)
		}
		s := string(out)
		if strings.Contains(s, tc.mustNot) {
			t.Fatalf("sanitize %q kept %q: %s", tc.in, tc.mustNot, s)
		}
		if !strings.Contains(s, tc.must) {
			t.Fatalf("sanitize %q lost %q: %s", tc.in, tc.must, s)
		}
	}
}

func TestExportRefTraversalAndMissing(t *testing.T) {
	storeFixture(t)
	bad := []string{"../etc/passwd", "art_", "art_" + strings.Repeat("g", 32), "art_" + strings.Repeat("0", 32)}
	for _, ref := range bad {
		if _, err := runExport(t, call(map[string]any{"format": "markdown", "ref": ref})); err == nil {
			t.Fatalf("ref %q accepted", ref)
		}
	}
}

func TestExportInputValidation(t *testing.T) {
	storeFixture(t)
	for _, in := range []map[string]any{
		{"format": "markdown"},
		{"format": "markdown", "ref": "x", "text": "y"},
		{"format": "pdf", "text": "x"},
		{"format": "markdown", "text": "x", "scope": "other"},
	} {
		if _, err := runExport(t, call(in)); err == nil {
			t.Fatalf("input %v accepted", in)
		}
	}
}

func TestStoreRestartReRead(t *testing.T) {
	root := storeFixture(t)
	m, err := storeWrite(root, []byte("persist me"), "text/plain", "n.txt", "writing_export", "helper")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate restart: same path, fresh read.
	_, content, err := storeRead(root, m.ID)
	if err != nil || string(content) != "persist me" {
		t.Fatalf("restart re-read failed: %v", err)
	}
}

func TestStoreRejectsTamper(t *testing.T) {
	root := storeFixture(t)
	m, _ := storeWrite(root, []byte("good"), "text/plain", "", "op", "s")
	obj := filepath.Join(root, "objects", m.SHA256[:2], m.SHA256)
	if err := os.WriteFile(obj, []byte("evil"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := storeRead(root, m.ID); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered object accepted: %v", err)
	}
}

func TestMissingStoreBinding(t *testing.T) {
	t.Setenv("ARTIFACT_STORE", "")
	if _, err := runExport(t, call(map[string]any{"format": "markdown", "text": "x"})); err == nil {
		t.Fatal("missing binding accepted")
	}
}

func TestUnsafeLinkDropsWholeSyntax(t *testing.T) {
	out := string(renderMarkdownHTML("[x](javascript:alert(1)) [ok](https://a.b/c)"))
	if strings.Contains(out, "javascript") || strings.Contains(out, "x)") {
		t.Fatalf("unsafe link remnants: %s", out)
	}
	if !strings.Contains(out, ">x <a href") {
		t.Fatalf("link text lost: %s", out)
	}
}
