package main

import "encoding/json"

// toolCall decodes the soot/v1 public wire envelope directly, so an installed
// source pack does not need access to the private Soot runtime module. Unknown
// fields are tolerated, as required by the v1 contract. Only consumed fields
// are declared here; this is not a runtime API implementation.
type toolCall struct {
	APIVersion string          `json:"api_version"`
	Hook       string          `json:"hook"`
	Soot       string          `json:"soot"`
	Operation  string          `json:"operation"`
	Input      json.RawMessage `json:"input,omitempty"`
	Event      toolEvent       `json:"event"`
}

type toolEvent struct {
	ID string `json:"id"`
}

const toolCallHook = "tool.call"
