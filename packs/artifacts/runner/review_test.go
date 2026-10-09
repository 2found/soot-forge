package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestArtifactLockProcessHelper(t *testing.T) {
	root := os.Getenv("FORGE_TEST_ARTIFACT_LOCK_ROOT")
	if root == "" {
		return
	}
	unlock, err := lockArtifactStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	println("held")
	// The parent deliberately kills this process to exercise kernel recovery.
	time.Sleep(time.Minute)
}

func TestArtifactMutationLockCoordinatesProcessesAndRecoversAfterDeath(t *testing.T) {
	root := t.TempDir()
	env := envMap(map[string]string{"ARTIFACT_STORE": root})
	wire := toolCallJSON("fixture", "artifacts_create", `{"mimeType":"text/plain","data_b64":"Y29udGVudA=="}`)
	result, err := invoke(wire, env, "create")
	if err != nil {
		t.Fatal(err)
	}
	var artifact artifactResult
	if err := json.Unmarshal([]byte(result), &artifact); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestArtifactLockProcessHelper$")
	child.Env = append(os.Environ(), "FORGE_TEST_ARTIFACT_LOCK_ROOT="+root)
	pipe, err := child.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	ready := make(chan bool, 1)
	go func() { scanner := bufio.NewScanner(pipe); ready <- scanner.Scan() && scanner.Text() == "held" }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("lock process not ready")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("lock process timed out")
	}
	for _, command := range []string{"create", "remove"} {
		input := wire
		if command == "remove" {
			input = toolCallJSON("fixture", "artifacts_remove", `{"ref":"`+artifact.Artifact.Ref+`"}`)
		}
		if out, err := invoke(input, env, command); !errors.Is(err, errStoreBusy) || out != "" {
			t.Fatalf("busy mutation started: %s %v", out, err)
		}
	}
	if err := verifyObject(objectPath(root, artifact.Artifact.SHA256), artifactMeta{SHA256: artifact.Artifact.SHA256, Bytes: artifact.Artifact.Bytes}); err != nil {
		t.Fatal("busy removal changed object", err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	if _, err := invoke(wire, env, "create"); err != nil {
		t.Fatal("dead process left stale lock", err)
	}
	if _, err := invoke(toolCallJSON("fixture", "artifacts_remove", `{"ref":"`+artifact.Artifact.Ref+`"}`), env, "remove"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(objectPath(root, artifact.Artifact.SHA256)); err != nil {
		t.Fatal("removed object still referenced by new artifact", err)
	}
}

func TestRemovePreflightsAllTargetsBeforeDeletingAny(t *testing.T) {
	store, export := t.TempDir(), t.TempDir()
	id := "exp_" + strings.Repeat("a", 32)
	dir := filepath.Join(export, "exports", id)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0600)
	env := envMap(map[string]string{"ARTIFACT_STORE": store, "ARTIFACT_EXPORT": export})
	if _, err := invoke(toolCallJSON("fixture", "artifacts_remove", `{"exportId":"`+id+`","ref":"missing"}`), env, "remove"); err == nil {
		t.Fatal("missing artifact accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "keep.txt")); err != nil {
		t.Fatal("export deleted before artifact validation", err)
	}
}

func TestExistingCorruptObjectCannotReceiveANewSuccessfulReference(t *testing.T) {
	store := t.TempDir()
	env := envMap(map[string]string{"ARTIFACT_STORE": store})
	wire := toolCallJSON("fixture", "artifacts_create", `{"mimeType":"text/plain","data_b64":"`+base64.StdEncoding.EncodeToString([]byte("content"))+`"}`)
	result, err := invoke(wire, env, "create")
	if err != nil {
		t.Fatal(err)
	}
	var artifact artifactResult
	if json.Unmarshal([]byte(result), &artifact) != nil {
		t.Fatal(result)
	}
	os.WriteFile(objectPath(store, artifact.Artifact.SHA256), []byte("tampered"), 0600)
	if result, err := invoke(wire, env, "create"); err == nil || result != "" {
		t.Fatalf("corrupt cached object acknowledged: %s %v", result, err)
	}
}

func TestBoundedReadsAndCleanupNeverTouchUnmanagedDirectories(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "large")
	os.WriteFile(file, []byte("12345"), 0600)
	if _, err := readFileBounded(file, 4); err == nil {
		t.Fatal("read exceeded byte bound")
	}
	unrelated := filepath.Join(dir, "operator-files")
	os.Mkdir(unrelated, 0700)
	raw, _ := json.Marshal(map[string]string{"expiresAt": time.Now().Add(-time.Hour).Format(time.RFC3339), "ref": "art_" + strings.Repeat("a", 32)})
	os.WriteFile(filepath.Join(unrelated, "expiry.json"), raw, 0600)
	sweepExports(dir, time.Now())
	if err := removeExportsForRef(dir, "art_"+strings.Repeat("a", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatal("unmanaged operator directory removed", err)
	}
}

func TestArtifactWireRejectsTrailingDataAndNullInput(t *testing.T) {
	wire := toolCallJSON("fixture", "artifacts_read", `{}`)
	if _, err := decodeCall(strings.NewReader(wire + "{}")); err == nil {
		t.Fatal("multiple wire objects accepted")
	}
	if err := decodeStrict([]byte("null"), new(readInput)); err == nil {
		t.Fatal("null input accepted")
	}
}
