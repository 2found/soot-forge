package main

import (
	"bytes"
	"encoding/json"
	"github.com/2found/soot-forge/packs/casework/runner/contract"
	"path/filepath"
	"testing"
)

func TestPassiveCaseToolsScopeAndHumanFence(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cases")
	invoke := func(scope, command, input string) error {
		call := contract.ToolCall{APIVersion: contract.APIVersion, Hook: contract.ToolCallHook, Soot: "helper", Event: contract.Event{Subject: scope}, Input: json.RawMessage(input)}
		b, _ := json.Marshal(call)
		return run(bytes.NewReader(b), &bytes.Buffer{}, []string{command, dir})
	}
	if err := invoke("a", "read", ""); err == nil {
		t.Fatal("reading silently created a case")
	}
	if err := invoke("a", "upsert", `{"title":"Task","summary":"Evidence","status":"open"}`); err != nil {
		t.Fatal(err)
	}
	if err := invoke("b", "read", ""); err == nil {
		t.Fatal("cross-conversation record exposed")
	}
	if err := invoke("a", "handoff", `{"to":"ungranted","summary":"next"}`); err == nil {
		t.Fatal("arbitrary assignee accepted")
	}
	if err := invoke("a", "handoff", `{"to":"human","summary":"next"}`); err != nil {
		t.Fatal(err)
	}
	if err := invoke("a", "upsert", `{"title":"Task","summary":"overwrite","status":"resolved"}`); err == nil {
		t.Fatal("human record overwritten")
	}
}
