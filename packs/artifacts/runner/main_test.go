package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/2found/soot-forge/packs/artifacts/runner/contract"
)

func invoke(in string, getenv func(string) string, args ...string) (string, error) {
	var out bytes.Buffer
	err := run(strings.NewReader(in), &out, getenv, args)
	return out.String(), err
}

func toolCallJSON(soot, operation, inputJSON string) string {
	call := contract.ToolCall{
		APIVersion: contract.APIVersion,
		Hook:       contract.ToolCallHook,
		Soot:       soot,
		Operation:  operation,
		Input:      json.RawMessage(inputJSON),
	}
	b, _ := json.Marshal(call)
	return string(b)
}

func envMap(m map[string]string) func(string) string {
	return func(k string) string {
		return m[k]
	}
}

func TestArtifactRoundtripAndInlineThreshold(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	payload := []byte("Hello, Soot artifact store!")
	b64 := base64.StdEncoding.EncodeToString(payload)

	createCall := toolCallJSON("helper", "artifacts_create", `{"name":"greeting.txt","mimeType":"text/plain","data_b64":"`+b64+`"}`)
	out, err := invoke(createCall, env, "create")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	var created artifactResult
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatalf("failed to decode create output: %v (raw: %s)", err, out)
	}
	if created.Kind != "artifact" {
		t.Errorf("expected kind 'artifact', got %q", created.Kind)
	}
	if !strings.HasPrefix(created.Artifact.Ref, "art_") {
		t.Errorf("expected ref to start with art_, got %q", created.Artifact.Ref)
	}
	if created.Artifact.Name != "greeting.txt" {
		t.Errorf("expected name greeting.txt, got %q", created.Artifact.Name)
	}
	if created.Artifact.Bytes != int64(len(payload)) {
		t.Errorf("expected %d bytes, got %d", len(payload), created.Artifact.Bytes)
	}
	h := sha256.Sum256(payload)
	expectedSHA := hex.EncodeToString(h[:])
	if created.Artifact.SHA256 != expectedSHA {
		t.Errorf("expected sha %s, got %s", expectedSHA, created.Artifact.SHA256)
	}

	// Read within inline-max (default 256KiB) returns data_b64.
	readCall := toolCallJSON("helper", "artifacts_read", `{"ref":"`+created.Artifact.Ref+`"}`)
	readOut, err := invoke(readCall, env, "read")
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	var readRes artifactResult
	if err := json.Unmarshal([]byte(readOut), &readRes); err != nil {
		t.Fatalf("failed to decode read output: %v", err)
	}
	if readRes.DataB64 != b64 {
		t.Errorf("expected inline data_b64 %q, got %q", b64, readRes.DataB64)
	}
	if readRes.Path != "" {
		t.Errorf("expected empty path for inline read, got %q", readRes.Path)
	}

	// Read with --inline-max=10 forces host-visible path output.
	readLargeOut, err := invoke(readCall, env, "read", "--inline-max=10")
	if err != nil {
		t.Fatalf("read with low inline-max failed: %v", err)
	}
	var readLargeRes artifactResult
	if err := json.Unmarshal([]byte(readLargeOut), &readLargeRes); err != nil {
		t.Fatalf("failed to decode read output: %v", err)
	}
	if readLargeRes.DataB64 != "" {
		t.Errorf("expected empty data_b64 when bytes exceed inline-max, got %q", readLargeRes.DataB64)
	}
	if !strings.HasPrefix(readLargeRes.Path, storeDir) {
		t.Errorf("expected path inside storeDir, got %q", readLargeRes.Path)
	}
	data, err := os.ReadFile(readLargeRes.Path)
	if err != nil || !bytes.Equal(data, payload) {
		t.Errorf("file at returned path did not match payload")
	}
}

func TestRefTraversalAndFormatRejection(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	invalidRefs := []string{
		"../escape",
		"art_1234",
		"art_0123456789abcdef0123456789abcdef/sub",
		"art_0123456789abcdef0123456789abcdef..",
		"/art_0123456789abcdef0123456789abcdef",
		"ART_0123456789abcdef0123456789abcdef", // must be lowercase hex
		"art_0123456789abcdef0123456789abcdeg", // non-hex
	}
	for _, ref := range invalidRefs {
		call := toolCallJSON("helper", "artifacts_read", `{"ref":"`+ref+`"}`)
		if _, err := invoke(call, env, "read"); err == nil {
			t.Errorf("expected error for invalid ref %q, got nil", ref)
		}
	}
}

func TestMIMELieByExtensionAndAllowlist(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	// Lie: declare application/pdf but body is plain text.
	fakePDF := base64.StdEncoding.EncodeToString([]byte("I am not a PDF document"))
	call := toolCallJSON("helper", "artifacts_create", `{"name":"fake.pdf","mimeType":"application/pdf","data_b64":"`+fakePDF+`"}`)
	if _, err := invoke(call, env, "create"); err == nil {
		t.Error("expected error for fake PDF, got nil")
	}

	// Lie: declare application/json but body is invalid JSON.
	fakeJSON := base64.StdEncoding.EncodeToString([]byte("this is: {not: valid json}"))
	call = toolCallJSON("helper", "artifacts_create", `{"name":"bad.json","mimeType":"application/json","data_b64":"`+fakeJSON+`"}`)
	if _, err := invoke(call, env, "create"); err == nil {
		t.Error("expected error for invalid JSON declared as application/json, got nil")
	}

	// Disallowed MIME: executable script declared as application/x-sh.
	shData := base64.StdEncoding.EncodeToString([]byte("#!/bin/sh\necho hi"))
	call = toolCallJSON("helper", "artifacts_create", `{"name":"run.sh","mimeType":"application/x-sh","data_b64":"`+shData+`"}`)
	if _, err := invoke(call, env, "create"); err == nil {
		t.Error("expected error for unallowlisted MIME application/x-sh, got nil")
	}

	// Legitimate JSON passes.
	goodJSON := base64.StdEncoding.EncodeToString([]byte(`{"valid":true,"count":42}`))
	call = toolCallJSON("helper", "artifacts_create", `{"name":"data.json","mimeType":"application/json","data_b64":"`+goodJSON+`"}`)
	if _, err := invoke(call, env, "create"); err != nil {
		t.Errorf("expected valid JSON to succeed, got %v", err)
	}

	// Legitimate PNG passes.
	pngHeader := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01")
	goodPNG := base64.StdEncoding.EncodeToString(pngHeader)
	call = toolCallJSON("helper", "artifacts_create", `{"name":"dot.png","mimeType":"image/png","data_b64":"`+goodPNG+`"}`)
	if _, err := invoke(call, env, "create"); err != nil {
		t.Errorf("expected valid PNG to succeed, got %v", err)
	}
}

func TestOversizeArtifactRejected(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	// 64 bytes with --max-bytes=32
	data := make([]byte, 64)
	for i := range data {
		data[i] = 'A'
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	call := toolCallJSON("helper", "artifacts_create", `{"mimeType":"text/plain","data_b64":"`+b64+`"}`)
	if _, err := invoke(call, env, "create", "--max-bytes=32"); err == nil {
		t.Error("expected error for data exceeding --max-bytes, got nil")
	}

	// Attempting to loosen --max-bytes beyond 16MiB flag fails.
	if _, err := invoke(call, env, "create", "--max-bytes=33554432"); err == nil {
		t.Error("expected error for --max-bytes > 16MiB, got nil")
	}
}

func TestMissingBindingEnv(t *testing.T) {
	call := toolCallJSON("helper", "artifacts_create", `{"mimeType":"text/plain","data_b64":"aGVsbG8="}`)
	if _, err := invoke(call, envMap(nil), "create"); err == nil {
		t.Error("expected error when ARTIFACT_STORE is not set, got nil")
	}

	// Relative ARTIFACT_STORE rejected.
	if _, err := invoke(call, envMap(map[string]string{"ARTIFACT_STORE": "relative/path"}), "create"); err == nil {
		t.Error("expected error when ARTIFACT_STORE is relative, got nil")
	}

	// Export requires ARTIFACT_EXPORT in addition to ARTIFACT_STORE.
	storeDir := filepath.Join(t.TempDir(), "store")
	exportCall := toolCallJSON("helper", "artifacts_export", `{"ref":"art_0123456789abcdef0123456789abcdef"}`)
	if _, err := invoke(exportCall, envMap(map[string]string{"ARTIFACT_STORE": storeDir}), "export"); err == nil {
		t.Error("expected error when ARTIFACT_EXPORT is missing, got nil")
	}
}

func TestExportExpiryWriteAndSweep(t *testing.T) {
	tmp := t.TempDir()
	storeDir := filepath.Join(tmp, "store")
	exportDir := filepath.Join(tmp, "export")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir, "ARTIFACT_EXPORT": exportDir})

	b64 := base64.StdEncoding.EncodeToString([]byte("exportable content"))
	createCall := toolCallJSON("helper", "artifacts_create", `{"name":"export.txt","mimeType":"text/plain","data_b64":"`+b64+`"}`)
	out, err := invoke(createCall, env, "create")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	var created artifactResult
	_ = json.Unmarshal([]byte(out), &created)

	// First export: ttlSec = 60
	now := time.Now().UTC()
	exportCall := toolCallJSON("helper", "artifacts_export", `{"ref":"`+created.Artifact.Ref+`","ttlSec":60}`)
	var expOut bytes.Buffer
	var o options
	o.storeDir = storeDir
	o.exportDir = exportDir
	o.maxBytes = hardMaxBytes
	o.inlineMax = defaultInlineMax
	call, _ := decodeCall(strings.NewReader(exportCall))

	if err := cmdExport(o, call, &expOut, now); err != nil {
		t.Fatalf("cmdExport failed: %v", err)
	}
	var expRes exportResult
	if err := json.Unmarshal(expOut.Bytes(), &expRes); err != nil {
		t.Fatalf("failed to decode export result: %v", err)
	}
	if expRes.Kind != "export" {
		t.Errorf("expected kind 'export', got %q", expRes.Kind)
	}
	if !strings.HasPrefix(expRes.ExportID, "exp_") {
		t.Errorf("expected exportId starting with exp_, got %q", expRes.ExportID)
	}

	// Verify expiry.json was written inside the export directory.
	expFolder := filepath.Dir(expRes.Path)
	expiryFile := filepath.Join(expFolder, "expiry.json")
	expBytes, err := os.ReadFile(expiryFile)
	if err != nil {
		t.Fatalf("expiry.json not found: %v", err)
	}
	var expiryData struct {
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.Unmarshal(expBytes, &expiryData); err != nil {
		t.Fatalf("expiry.json failed to parse: %v", err)
	}
	if expiryData.ExpiresAt != expRes.ExpiresAt {
		t.Errorf("expiry.json expiresAt %q != result %q", expiryData.ExpiresAt, expRes.ExpiresAt)
	}

	// Sweep run at now + 30s: should NOT delete this export.
	sweepExports(filepath.Join(exportDir, "exports"), now.Add(30*time.Second))
	if _, err := os.Stat(expFolder); err != nil {
		t.Errorf("unexpired export directory was prematurely removed: %v", err)
	}

	// Sweep run at now + 70s: SHOULD delete this expired export directory.
	sweepExports(filepath.Join(exportDir, "exports"), now.Add(70*time.Second))
	if _, err := os.Stat(expFolder); !os.IsNotExist(err) {
		t.Errorf("expired export directory was not removed after expiry")
	}
}

func TestRemoveExportsBeyondExpirySweepLimit(t *testing.T) {
	dir := t.TempDir()
	ref := "art_0123456789abcdef0123456789abcdef"
	for i := 0; i <= maxExportSweep; i++ {
		path := filepath.Join(dir, fmt.Sprintf("exp_%032x", i))
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(map[string]string{"ref": ref})
		if err := os.WriteFile(filepath.Join(path, "expiry.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeExportsForRef(dir, ref); err != nil {
		t.Fatal(err)
	}
	remaining, err := os.ReadDir(dir)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("exports survived: %d, %v", len(remaining), err)
	}
}

func TestRemoveArtifactAndExport(t *testing.T) {
	tmp := t.TempDir()
	storeDir := filepath.Join(tmp, "store")
	exportDir := filepath.Join(tmp, "export")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir, "ARTIFACT_EXPORT": exportDir})
	b64 := base64.StdEncoding.EncodeToString([]byte("to be removed"))
	out, err := invoke(toolCallJSON("helper", "artifacts_create", `{"name":"gone.txt","mimeType":"text/plain","data_b64":"`+b64+`"}`), env, "create")
	if err != nil {
		t.Fatal(err)
	}
	var created artifactResult
	if json.Unmarshal([]byte(out), &created) != nil {
		t.Fatal(out)
	}
	expOut, err := invoke(toolCallJSON("helper", "artifacts_export", `{"ref":"`+created.Artifact.Ref+`","ttlSec":60}`), env, "export")
	if err != nil {
		t.Fatal(err)
	}
	var expRes exportResult
	if json.Unmarshal([]byte(expOut), &expRes) != nil {
		t.Fatal(expOut)
	}
	removed, err := invoke(toolCallJSON("helper", "artifacts_remove", `{"ref":"`+created.Artifact.Ref+`"}`), env, "remove")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(removed, created.Artifact.Ref) {
		t.Fatal(removed)
	}
	if _, err := invoke(toolCallJSON("helper", "artifacts_read", `{"ref":"`+created.Artifact.Ref+`"}`), env, "read"); err == nil {
		t.Fatal("read succeeded after remove")
	}
	if _, err := os.Stat(filepath.Dir(expRes.Path)); !os.IsNotExist(err) {
		t.Fatal("export directory survived artifact remove")
	}
	if _, err := invoke(toolCallJSON("helper", "artifacts_remove", `{"exportId":"`+expRes.ExportID+`"}`), env, "remove"); err == nil {
		t.Fatal("second export remove succeeded")
	}
}

func TestRestartReReadDurabilityAndIntegrity(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	original := []byte("persistent artifact across process restarts")
	b64 := base64.StdEncoding.EncodeToString(original)

	createCall := toolCallJSON("helper", "artifacts_create", `{"name":"data.txt","mimeType":"text/plain","data_b64":"`+b64+`"}`)
	out, err := invoke(createCall, env, "create")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	var created artifactResult
	_ = json.Unmarshal([]byte(out), &created)
	ref := created.Artifact.Ref

	// Simulate restart: fresh invoke, reading the same storeDir.
	readCall := toolCallJSON("helper", "artifacts_read", `{"ref":"`+ref+`"}`)
	readOut, err := invoke(readCall, env, "read")
	if err != nil {
		t.Fatalf("read after restart failed: %v", err)
	}
	var readRes artifactResult
	if err := json.Unmarshal([]byte(readOut), &readRes); err != nil {
		t.Fatalf("read json decode failed: %v", err)
	}
	if readRes.Artifact.Ref != ref {
		t.Errorf("ref mismatch: %s vs %s", readRes.Artifact.Ref, ref)
	}

	// Verify tampering with object bytes is caught by SHA check.
	objPath := objectPath(storeDir, created.Artifact.SHA256)
	if err := os.WriteFile(objPath, []byte("tampered data"), 0600); err != nil {
		t.Fatalf("failed to tamper file: %v", err)
	}
	if _, err := invoke(readCall, env, "read"); err == nil {
		t.Error("expected sha256 verification failure after file tampering, got nil")
	}
}

func TestStagingFileInputAndEscapeDenial(t *testing.T) {
	tmp := t.TempDir()
	storeDir := filepath.Join(tmp, "store")
	stageDir := filepath.Join(tmp, "stage")
	if err := os.MkdirAll(stageDir, 0700); err != nil {
		t.Fatal(err)
	}
	stagedFile := filepath.Join(stageDir, "upload.txt")
	content := []byte("content from staged file")
	if err := os.WriteFile(stagedFile, content, 0600); err != nil {
		t.Fatal(err)
	}

	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	// Without --stage flag: file input is denied.
	call := toolCallJSON("helper", "artifacts_create", `{"name":"up.txt","mimeType":"text/plain","file":"upload.txt"}`)
	if _, err := invoke(call, env, "create"); err == nil {
		t.Error("expected error when using file input without --stage flag, got nil")
	}

	// With --stage flag: file input succeeds.
	out, err := invoke(call, env, "create", "--stage="+stageDir)
	if err != nil {
		t.Fatalf("create with --stage failed: %v", err)
	}
	var res artifactResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if res.Artifact.Bytes != int64(len(content)) {
		t.Errorf("expected %d bytes, got %d", len(content), res.Artifact.Bytes)
	}

	// Traversal attempt escaping the stage dir is denied.
	outsideCall := toolCallJSON("helper", "artifacts_create", `{"name":"outside.txt","mimeType":"text/plain","file":"../secret.txt"}`)
	if _, err := invoke(outsideCall, env, "create", "--stage="+stageDir); err == nil {
		t.Error("expected error for escaping staging path, got nil")
	}
}

func TestStrictInputRejectsScopeAndUnknownFields(t *testing.T) {
	storeDir := filepath.Join(t.TempDir(), "store")
	env := envMap(map[string]string{"ARTIFACT_STORE": storeDir})

	// Model tries to smuggle "scope" or "owner" or "root" into input.
	for _, badField := range []string{
		`"scope":"tenant-abc"`,
		`"owner":"user-xyz"`,
		`"root":"/arbitrary/path"`,
	} {
		input := `{"mimeType":"text/plain","data_b64":"aGVsbG8=",` + badField + `}`
		call := toolCallJSON("helper", "artifacts_create", input)
		if _, err := invoke(call, env, "create"); err == nil {
			t.Errorf("expected rejection of field %s via strict decode, got nil", badField)
		}
	}
}
