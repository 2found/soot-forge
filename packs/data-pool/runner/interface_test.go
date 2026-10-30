package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func uiInput(kind string, input any) interfaceInput {
	raw, _ := json.Marshal(input)
	return interfaceInput{Kind: kind, Input: raw}
}
func pointer[T any](v T) *T { return &v }

func TestSearchKeepsWildcardCharactersLiteral(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	invoke(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "discount", RequestID: "pct", Title: "Giảm 100% hôm nay", Content: "khuyến mãi"})
	writeDoc(t, s, "company", "handbook", "handbook", "Không có ký tự đặc biệt")
	hits := func(query string) int {
		page := invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: query}).(map[string]any)
		return len(page["hits"].([]any))
	}
	if got := hits("%"); got != 1 {
		t.Fatalf("wildcard percent matched %d documents", got)
	}
	if got := hits("_"); got != 0 {
		t.Fatalf("wildcard underscore matched %d documents", got)
	}
	if got := hits("handbook"); got != 1 {
		t.Fatalf("ordinary search matched %d documents", got)
	}
}

func TestHumanRevisionProtectionReceiptsAndProvenance(t *testing.T) {
	s := testService(t)
	s.human = true
	invoke(t, s, "action", uiInput("manage", manageInput{Action: "pool_create", Pool: "company", Name: "Company", RequestID: "create"}))
	generation, _ := s.poolGeneration(context.Background(), "company")
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
	if !replay.Replay || replay.Document.Revision != 1 {
		t.Fatal(replay)
	}
	w.RequestID = "stale-edit"
	w.ExpectedRevision = pointer(1)
	conflict := invoke(t, s, "action", uiInput("write", w)).(map[string]any)
	if conflict["code"] != "conflict" {
		t.Fatal(conflict)
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
	if len(items) == 0 {
		t.Fatal("no audit history")
	}
	if items[0].Actor.Kind != "human" || items[0].Documents[0].Revision != 2 {
		t.Fatal(items[0])
	}
	foundGrant := false
	for _, a := range items {
		if a.Action == "grant" && a.TargetSoot == "marketing" {
			foundGrant = true
		}
	}
	if !foundGrant {
		t.Fatal("grant not audited", items)
	}
	encoded, _ := json.Marshal(page)
	for _, secret := range []string{"Private human content", "Agent updated content", s.b.DatabaseURL} {
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
	if _, err := s.activities(context.Background(), activityInput{Pool: "company"}); err == nil {
		t.Fatal("reader can inspect management activity")
	}
}

func TestActivityRetentionPaginationRestart(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	if err := s.db.update(context.Background(), func(tx pgx.Tx) error {
		for range activityRetention + 5 {
			if err := appendActivity(context.Background(), tx, activity{Pool: "company", Actor: *s.actorReference(), Action: "search", Status: "succeeded"}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	page, err := s.activities(context.Background(), activityInput{Pool: "company", Limit: 20})
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
		v, err := s.activities(context.Background(), activityInput{Pool: "company", Limit: 20, After: next})
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
	// Reopening keeps the retained evidence in the database.
	b := s.b
	s.close()
	reopened, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if _, err := reopened.activities(context.Background(), activityInput{Pool: "company", After: "not-a-cursor"}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	var count int
	if err := reopened.db.view(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM data_pool.activity WHERE pool_id = 'company'`).Scan(&count)
	}); err != nil || count != activityRetention {
		t.Fatal("unbounded activity", count, err)
	}
	if _, err := reopened.dispatch(context.Background(), "pools", json.RawMessage(`{"pool":"company"}`)); err != nil {
		t.Fatal(err)
	}
}
