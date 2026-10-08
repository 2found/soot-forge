// Package contract holds the public wire contract for independently built
// Soot tools. The contract has no dependency on the runtime or AgentRay;
// tools in other languages can consume the same JSON without an SDK.
package contract

import "encoding/json"

const (
	APIVersion   = "soot/v1"
	ToolCallHook = "tool.call"
)

// ToolCall is delivered as one JSON object followed by a newline and EOF when
// run.stdin is "context". Consumers should reject unsupported versions/hooks
// and tolerate new fields within v1. Output remains text on stdout/stderr;
// exit status determines success. Returning JSON does not mutate runtime state.
type ToolCall struct {
	// Interaction is set only by the authenticated human interface transport.
	Interaction bool            `json:"interaction,omitempty"`
	APIVersion  string          `json:"api_version"`
	Hook        string          `json:"hook"`
	Soot        string          `json:"soot"`
	Root        string          `json:"root"`
	CaseID      string          `json:"case_id,omitempty"` // legacy optional field; core does not create cases
	Input       json.RawMessage `json:"input,omitempty"`
	Operation   string          `json:"operation"`
	Event       Event           `json:"event"`
}

// Event contains only the triggering input, not case history, prompts, provider
// config or credential bindings. Text and subject are untrusted external data.
type Event struct {
	ID          string `json:"id"`
	Source      string `json:"source"`
	Subject     string `json:"subject"`
	Text        string `json:"text"`
	Observation string `json:"observation,omitempty"`
	VersionFrom string `json:"version_from,omitempty"`
	VersionTo   string `json:"version_to,omitempty"`
}
