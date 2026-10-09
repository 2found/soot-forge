// soot-case is an optional executable pack. The Soot binary does not link it.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/2found/soot-forge/packs/casework/runner/contract"
	"github.com/2found/soot-forge/packs/casework/runner/storage"
	"io"
	"os"
)

func run(in io.Reader, out io.Writer, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: soot-case <read|upsert|handoff> <data-directory>")
	}
	var call contract.ToolCall
	raw, err := io.ReadAll(io.LimitReader(in, 65537))
	if err != nil || len(raw) > 65536 || json.Unmarshal(raw, &call) != nil {
		return fmt.Errorf("invalid or oversized tool envelope")
	}
	if call.APIVersion != contract.APIVersion || call.Hook != contract.ToolCallHook || call.Event.Subject == "" || call.Soot == "" {
		return fmt.Errorf("invalid tool context")
	}
	if call.Operation != "casework_"+args[0] {
		return fmt.Errorf("operation mismatch")
	}
	var input struct{ Title, Summary, Status, To string }
	if len(call.Input) > 0 {
		d := json.NewDecoder(bytes.NewReader(call.Input))
		d.DisallowUnknownFields()
		if err := d.Decode(&input); err != nil || d.Decode(new(any)) != io.EOF || bytes.Equal(bytes.TrimSpace(call.Input), []byte("null")) {
			return fmt.Errorf("invalid input fields")
		}
	}
	store, err := storage.OpenStore(args[1], 256, 64)
	if err != nil {
		return err
	}
	defer store.Close()
	switch args[0] {
	case "read":
		c, err := store.RecordFor(call.Event.Subject)
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(c)
	case "upsert":
		c, err := store.Record(call.Event.Subject, call.Soot, input.Title, input.Summary, input.Status, "")
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(c)
	case "handoff":
		// Example deliberately grants one target. Customize this executable/config
		// when integrating a real team; model input cannot invent recipients.
		if input.To != "human" {
			return fmt.Errorf("only human handoff is configured")
		}
		c, err := store.RecordFor(call.Event.Subject)
		if err != nil {
			return err
		}
		c, err = store.Record(call.Event.Subject, call.Soot, c.Ticket.Title, input.Summary, c.Ticket.Status, input.To)
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(c)
	default:
		return fmt.Errorf("unknown case command")
	}
}
func main() {
	if err := run(os.Stdin, os.Stdout, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
