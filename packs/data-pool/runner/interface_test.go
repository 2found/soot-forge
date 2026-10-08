package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func uiInput(kind string, input any) interfaceInput {
	raw, _ := json.Marshal(input)
	return interfaceInput{Kind: kind, Input: raw}
}
func pointer[T any](v T) *T { return &v }
func TestHumanRevisionProtectionReceiptsAndProvenance(t *testing.T) {
	f, b := newFake(t)
	s := testService(t, b.URL)
	s.human = true
	invoke(t, s, "action", uiInput("manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"}))
	generation, _ := s.poolGeneration("company")
	w := writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "human-import", Title: "Company", Content: "Private human content", Generation: generation, ExpectedRevision: pointer(0)}
	r := invoke(t, s, "action", uiInput("write", w)).(receipt)
	if r.Status != "succeeded" || r.Document.Writer == nil || r.Document.Writer.Kind != "human" || r.Document.Writer.Soot != "manager" {
		t.Fatal(r)
	}
	s.human = false
	writeDoc(t, s, "company", "handbook", "agent-update", "Agent updated content")
	s.human = true
	// Replay is evaluated before stale revision conflicts and adds no duplicate effect.
	replay := invoke(t, s, "action", uiInput("write", w)).(receipt)
	if !replay.Replay || replay.Document.Revision != 1 || f.posts != 2 {
		t.Fatal(replay, f.posts)
	}
	w.RequestID = "stale-edit"
	w.ExpectedRevision = pointer(1)
	conflict := invoke(t, s, "action", uiInput("write", w)).(map[string]any)
	if conflict["code"] != "conflict" || f.posts != 2 {
		t.Fatal(conflict, f.posts)
	}
	w.RequestID = "missing-guard"
	w.ExpectedRevision = nil
	if invoke(t, s, "action", uiInput("write", w)).(map[string]any)["code"] != "rejected" {
		t.Fatal("unguarded human mutation")
	}
	g := manageInput{Action: "grant", Pool: "company", Soot: "marketing", Level: "read", RequestID: "grant", Generation: generation, ExpectedPolicyRevision: pointer(uint64(0))}
	invoke(t, s, "action", uiInput("manage", g))
	g.RequestID = "stale-policy"
	g.Soot = "support"
	if invoke(t, s, "action", uiInput("manage", g)).(map[string]any)["code"] != "conflict" {
		t.Fatal("stale policy overwritten")
	}
	g.RequestID = "host-revoke"
	g.Soot = "manager"
	g.Action = "revoke"
	g.Level = ""
	g.ExpectedPolicyRevision = pointer(uint64(1))
	if invoke(t, s, "action", uiInput("manage", g)).(map[string]any)["code"] != "rejected" {
		t.Fatal("host grant falsely revocable")
	}
	// Human read is recorded; activity probes do not record themselves.
	invoke(t, s, "view", uiInput("query", queryInput{Action: "read", Pool: "company", ID: "handbook"}))
	page := invoke(t, s, "view", uiInput("activity", activityInput{Pool: "company", Limit: 20})).(map[string]any)
	items := page["activity"].([]activity)
	if len(items) != 7 {
		t.Fatal("unexpected event count", len(items), items)
	}
	if items[0].Actor.Kind != "human" || items[0].Documents[0].Revision != 2 {
		t.Fatal(items[0])
	}
	if items[1].Action != "grant" || items[1].TargetSoot != "marketing" {
		t.Fatal(items[1])
	}
	if items[2].Actor.Kind != "soot" || items[2].Documents[0].Revision != 2 {
		t.Fatal(items[2])
	}
	encoded, _ := json.Marshal(page)
	for _, secret := range []string{"Private human content", "Agent updated content", s.b.APIKey} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("activity stores private payload")
		}
	}
	page2 := invoke(t, s, "view", uiInput("activity", activityInput{Pool: "company", Limit: 20})).(map[string]any)
	if len(page2["activity"].([]activity)) != len(items) {
		t.Fatal("audit feedback loop")
	}
	// Agent-authored input cannot assign writer/actor; nonhuman view/action is denied.
	s.human = false
	denied(t, s, "action", uiInput("manage", g))
	denied(t, s, "write", map[string]any{"actor": "human", "action": "upsert", "pool": "company", "id": "forge", "request_id": "forge", "title": "Forged", "content": "bad"})
	s.actor = "marketing"
	if _, err := s.activities(activityInput{Pool: "company"}); err == nil {
		t.Fatal("reader can inspect management activity")
	}
}

func TestActivityRetentionPaginationRestartAndLegacyMetadata(t *testing.T) {
	_, backend := newFake(t)
	s := testService(t, backend.URL)
	create(t, s, "company")
	for i := 0; i < activityRetention+5; i++ {
		if err := s.db.Update(func(tx *bolt.Tx) error {
			return appendActivity(tx, activity{Pool: "company", Actor: *s.actorReference(), Action: "search", Status: "succeeded"})
		}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.activities(activityInput{Pool: "company", Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	p := page.(map[string]any)
	if p["oldest_sequence"].(uint64) != 7 {
		t.Fatal(p)
	}
	seen := 0
	last := uint64(1 << 63)
	next := ""
	for {
		v, err := s.activities(activityInput{Pool: "company", Limit: 20, After: next})
		if err != nil {
			t.Fatal(err)
		}
		p := v.(map[string]any)
		for _, a := range p["activity"].([]activity) {
			if a.Sequence >= last {
				t.Fatal("cursor repeated", a)
			}
			last = a.Sequence
			seen++
		}
		next = p["next"].(string)
		if next == "" {
			break
		}
	}
	if seen != activityRetention {
		t.Fatal(seen)
	}
	// Reopening changes neither backend identity/index IDs nor retained evidence.
	b := s.b
	index := s.index("company")
	s.close()
	reopened, err := openService(b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if reopened.index("company") != index {
		t.Fatal("index remapped")
	}
	if _, err := reopened.activities(activityInput{Pool: "company", After: "not-a-cursor"}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	if err := reopened.db.View(func(tx *bolt.Tx) error {
		if tx.Bucket([]byte("activity")).Bucket([]byte("company")).Stats().KeyN != activityRetention {
			return fmt.Errorf("unbounded activity")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var legacy document
	if json.Unmarshal([]byte(`{"id":"old","revision":3}`), &legacy) != nil || legacy.Writer != nil {
		t.Fatal("legacy writer fabricated")
	}
	// Old state is readable without rebuilding provenance on startup.
	if _, err := reopened.dispatch(context.Background(), "pools", json.RawMessage(`{"pool":"company"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestHumanLostSubmissionReconcilesOriginalReceipt(t *testing.T) {
	f, backend := newFake(t)
	s := testService(t, backend.URL)
	create(t, s, "company")
	s.human = true
	generation, _ := s.poolGeneration("company")
	f.loseResponse = true
	w := writeInput{Action: "upsert", Pool: "company", ID: "doc", RequestID: "original", Title: "Doc", Content: "Original content", ExpectedRevision: pointer(0), Generation: generation}
	r := invoke(t, s, "action", uiInput("write", w)).(receipt)
	if r.Status != "uncertain" {
		t.Fatal(r)
	}
	r = invoke(t, s, "view", uiInput("status", statusInput{RequestID: "original"})).(receipt)
	if r.Status != "succeeded" || r.Actor.Kind != "human" || f.posts != 1 {
		t.Fatal(r, f.posts)
	}
}
