package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCaseWireRejectsMalformedInputBeforeOpeningAStore(t *testing.T) {
	wire := `{"api_version":"soot/v1","hook":"tool.call","soot":"fixture","operation":"casework_upsert","event":{"subject":"fixture"},"input":{"title":"t","summary":"s","status":"open"}}`
	for _, raw := range []string{wire + "{}", wire + strings.Repeat(" ", 65536), strings.Replace(wire, `"status":"open"`, `"status":"open","owner":"admin"`, 1), strings.Replace(wire, "casework_upsert", "casework_read", 1)} {
		dir := filepath.Join(t.TempDir(), "never-created")
		if err := run(strings.NewReader(raw), &bytes.Buffer{}, []string{"upsert", dir}); err == nil {
			t.Fatal("invalid case call accepted")
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatal("invalid input created store state")
		}
	}
}
