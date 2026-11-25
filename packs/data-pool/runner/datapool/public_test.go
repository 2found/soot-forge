package datapool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// publicFixture has a public pool "open" (two documents), a private pool
// "secret" and a child of the public pool that is private ("child").
func publicFixture(t *testing.T) *service {
	t.Helper()
	s := testService(t)
	create(t, s, "open")
	create(t, s, "secret")
	invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: "child", Name: "Child", Parent: pointer("open"), RequestID: "create-child"})
	writeDoc(t, s, "open", "refund", "refund-1", "Chính sách hoàn tiền trong ba mươi ngày.")
	invoke(t, s, "write", writeInput{Action: "upsert", Pool: "open", ID: "pricing", RequestID: "pricing-1", Title: "Bảng giá", Content: "Gói Plus và gói Pro."})
	writeDoc(t, s, "secret", "payroll", "payroll-1", "Lương nhân viên: bí mật.")
	writeDoc(t, s, "child", "draft", "draft-1", "Bản nháp nội bộ.")
	invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "publish-open"})
	return s
}

func asReader(s *service) *service {
	s.actor = knowledgeIdentity
	clear(s.perms)
	return s
}

func poolIDs(t *testing.T, s *service) []string {
	t.Helper()
	page := invoke(t, s, "pools", poolsInput{}).(map[string]any)
	ids := []string{}
	for _, p := range page["pools"].([]collectionSummary) {
		ids = append(ids, p.ID)
	}
	return ids
}

func TestKnowledgeReaderListsOnlyPublicPools(t *testing.T) {
	s := publicFixture(t)
	if got := poolIDs(t, s); len(got) != 3 {
		t.Fatal("the manager sees every pool", got)
	}
	asReader(s)
	if got := poolIDs(t, s); len(got) != 1 || got[0] != "open" {
		t.Fatal("the reader must see only the public pool", got)
	}
	// A parent filter narrows the public list; it never reveals a private child.
	page := invoke(t, s, "pools", poolsInput{Parent: pointer("open")}).(map[string]any)
	if len(page["pools"].([]collectionSummary)) != 0 {
		t.Fatal("a public parent exposed its private child", page)
	}
	detail := invoke(t, s, "pools", poolsInput{Pool: "open"}).(map[string]any)
	if detail["permission"] != "read" || detail["grants"] != nil || detail["bound_soots"] != nil {
		t.Fatal("the reader's detail is read-only and carries no policy", detail)
	}
	if !detail["pool"].(pool).Public {
		t.Fatal("the pool reports its visibility")
	}
}

func TestKnowledgeReaderSearchesAndReadsPublicPoolsOnly(t *testing.T) {
	s := asReader(publicFixture(t))
	hits := invoke(t, s, "query", queryInput{Action: "search", Pool: "open", Query: "HOAN TIEN"}).(map[string]any)["hits"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["document"].(document).ID != "refund" {
		t.Fatal("accent-insensitive search on a public pool", hits)
	}
	if typo := invoke(t, s, "query", queryInput{Action: "search", Pool: "open", Query: "bang gai"}).(map[string]any)["hits"].([]any); len(typo) == 0 {
		t.Fatal("typo search on a public pool")
	}
	read := invoke(t, s, "query", queryInput{Action: "read", Pool: "open", ID: "pricing"}).(map[string]any)
	if !strings.Contains(read["content"].(string), "Gói Plus") {
		t.Fatal(read)
	}
	if list := invoke(t, s, "query", queryInput{Action: "list", Pool: "open"}).(map[string]any); len(list["documents"].([]document)) != 2 {
		t.Fatal(list)
	}
	// Private pool, private child of a public pool, and a pool that does not
	// exist all answer the same way: no existence oracle.
	messages := map[string]bool{}
	for _, pool := range []string{"secret", "child", "nonexistent"} {
		for _, in := range []queryInput{{Action: "search", Pool: pool, Query: "luong"}, {Action: "read", Pool: pool, ID: "payroll"}, {Action: "list", Pool: pool}} {
			raw, _ := json.Marshal(in)
			_, err := s.dispatch(context.Background(), "query", raw)
			if err == nil {
				t.Fatal("the reader read a pool that is not public", pool, in.Action)
			}
			messages[strings.ReplaceAll(err.Error(), safeID(pool), "X")] = true
		}
		denied(t, s, "pools", poolsInput{Pool: pool})
	}
	if len(messages) != 1 {
		t.Fatal("private and missing pools must be indistinguishable", messages)
	}
}

func TestKnowledgeReaderCannotWriteManageOrObserve(t *testing.T) {
	s := asReader(publicFixture(t))
	before := countRows(t, s, "receipts")
	for op, in := range map[string]any{
		"write":  writeInput{Action: "upsert", Pool: "open", ID: "evil", RequestID: "evil-1", Title: "x", Content: "y"},
		"manage": manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), RequestID: "evil-2"},
		"status": statusInput{RequestID: "publish-open", Owner: "manager"},
		"view":   struct{}{},
		"action": interfaceInput{Kind: "manage"},
	} {
		raw, _ := json.Marshal(in)
		if _, err := s.dispatch(context.Background(), op, raw); !errors.Is(err, errAccessDenied) {
			t.Fatalf("%s: expected the stable denial, got %v", op, err)
		}
	}
	for _, action := range []string{"references", "bogus", ""} {
		raw, _ := json.Marshal(queryInput{Action: action, Pool: "open", Conversation: "c1"})
		if _, err := s.dispatch(context.Background(), "query", raw); !errors.Is(err, errAccessDenied) {
			t.Fatalf("query %q: expected the stable denial, got %v", action, err)
		}
	}
	if countRows(t, s, "receipts") != before {
		t.Fatal("a denied call left a receipt")
	}
	// Reading is not recorded: a public reader never writes to the database.
	activity := countRows(t, s, "activity")
	invoke(t, s, "query", queryInput{Action: "read", Pool: "open", ID: "refund"})
	invoke(t, s, "query", queryInput{Action: "search", Pool: "open", Query: "hoan"})
	if countRows(t, s, "activity") != activity {
		t.Fatal("the reader's reads were recorded in the activity log")
	}
	if countRows(t, s, "documents") != 4 {
		t.Fatal("the reader changed the documents")
	}
}

func countRows(t *testing.T, s *service, table string) int {
	t.Helper()
	var n int
	if err := s.db.view(context.Background(), func(tx dbTx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM data_pool.`+table).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

// A binding that lists the reserved name gains nothing from it: its authority
// is the public rule, not a grant, a manager entry or a writer entry.
func TestKnowledgeReaderAuthorityIsNotConfigurable(t *testing.T) {
	b := freshBinding(t, "manager", "knowledge")
	b.Managers = []string{"manager", "knowledge"}
	b.Writers = []string{"knowledge"}
	b.PoolManagers = []string{"knowledge"}
	s, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	create(t, s, "private")
	writeDoc(t, s, "private", "doc", "doc-1", "private text")
	denied(t, s, "manage", manageInput{Action: "grant", Pool: "private", Soot: "knowledge", Level: "read", RequestID: "grant-reader"})
	asReader(s)
	if s.manager() {
		t.Fatal("the reader became a manager through the binding")
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "private", ID: "x", RequestID: "x-1", Title: "x", Content: "x"})
	denied(t, s, "query", queryInput{Action: "read", Pool: "private", ID: "doc"})
	if len(poolIDs(t, s)) != 0 {
		t.Fatal("a listed reader saw a private pool")
	}
	if got := roleOperations(s.b, knowledgeIdentity); strings.Join(got, ",") != "pools,query" {
		t.Fatal(got)
	}
}

func TestPoolUpdatePublicIsManagerOnlyIdempotentAndReversible(t *testing.T) {
	s := testService(t)
	create(t, s, "open")
	grant(t, s, "open", "marketing", "manage") // a pool manager, not a host manager
	s.actor = "marketing"
	clear(s.perms)
	denied(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "mk-public"})
	s.actor = "manager"
	clear(s.perms)
	read := func() pool { return invoke(t, s, "pools", poolsInput{Pool: "open"}).(map[string]any)["pool"].(pool) }
	if read().Public {
		t.Fatal("pools start private")
	}
	r := invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "pub-1"}).(receipt)
	first := read()
	if r.Status != "succeeded" || !first.Public || first.PolicyRevision == 0 {
		t.Fatal(r, first)
	}
	// Same target state under a new request_id: succeeds, changes nothing.
	r = invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "pub-2"}).(receipt)
	if r.Status != "succeeded" || r.Reason != "unchanged" || read().PolicyRevision != first.PolicyRevision {
		t.Fatal("restating the state must be a no-op", r, read())
	}
	// The same request_id replays; with a different body it is refused.
	if r = invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "pub-1"}).(receipt); !r.Replay {
		t.Fatal("replay", r)
	}
	denied(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), RequestID: "pub-1"})
	// Public belongs to pool_update on an existing pool.
	denied(t, s, "manage", manageInput{Action: "pool_create", Pool: "born-public", Name: "x", Public: pointer(true), RequestID: "born"})
	denied(t, s, "manage", manageInput{Action: "grant", Pool: "open", Soot: "support", Level: "read", Public: pointer(true), RequestID: "grant-public"})
	// Stale revisions still conflict.
	stale := uint64(0)
	denied(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), ExpectedPolicyRevision: &stale, RequestID: "pub-stale"})
	// Reversible: private again, and the reader loses access at once.
	invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), RequestID: "unpub"})
	if read().Public {
		t.Fatal("still public")
	}
	asReader(s)
	denied(t, s, "query", queryInput{Action: "list", Pool: "open"})
	if len(poolIDs(t, s)) != 0 {
		t.Fatal("an unpublished pool is still listed")
	}
}

func TestReservedReaderCannotBeGrantedOrAdmitted(t *testing.T) {
	s := testService(t)
	create(t, s, "open")
	denied(t, s, "manage", manageInput{Action: "grant", Pool: "open", Soot: knowledgeIdentity, Level: "read", RequestID: "grant-k"})
	s.human = true
	raw, _ := json.Marshal(manageInput{Action: "admit", Soot: knowledgeIdentity, Host: "mac", RequestID: "admit-k"})
	if _, err := s.dispatch(context.Background(), "manage", raw); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatal("admitting the reserved reader", err)
	}
}

// The executable path: the reader needs no entry in the binding, every other
// unlisted identity is still refused.
func TestExecuteAdmitsKnowledgeWithoutAllowlistEntry(t *testing.T) {
	b := freshBinding(t, "manager", "marketing")
	s, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	create(t, s, "open")
	create(t, s, "secret")
	writeDoc(t, s, "open", "refund", "refund-1", "Chính sách hoàn tiền trong ba mươi ngày.")
	writeDoc(t, s, "secret", "payroll", "payroll-1", "Lương: bí mật.")
	invoke(t, s, "manage", manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "pub"})
	s.close()
	raw, _ := json.Marshal(b)
	run := func(soot, op string, in any) (string, error) {
		input, _ := json.Marshal(in)
		env, _ := json.Marshal(toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: soot, Operation: "data-pool_" + op, Input: input})
		var out bytes.Buffer
		err := Execute(context.Background(), op, bytes.NewReader(env), &out, string(raw))
		return out.String(), err
	}
	out, err := run("knowledge", "pools", poolsInput{})
	if err != nil || !strings.Contains(out, `"id":"open"`) || strings.Contains(out, "secret") {
		t.Fatal("knowledge lists the public pool only", out, err)
	}
	if out, err = run("knowledge", "query", queryInput{Action: "search", Pool: "open", Query: "hoan tien"}); err != nil || !strings.Contains(out, "refund") {
		t.Fatal(out, err)
	}
	if _, err = run("knowledge", "query", queryInput{Action: "read", Pool: "secret", ID: "payroll"}); err == nil {
		t.Fatal("the reader read a private pool through the executable")
	}
	for op, in := range map[string]any{"write": writeInput{Action: "upsert", Pool: "open", ID: "x", RequestID: "x-1", Title: "x", Content: "y"}, "manage": manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), RequestID: "x-2"}, "status": statusInput{RequestID: "pub"}} {
		if _, err = run("knowledge", op, in); err == nil || err.Error() != "access denied" {
			t.Fatalf("%s: %v", op, err)
		}
	}
	if _, err = run("stranger", "pools", poolsInput{}); err == nil || err.Error() != "access denied" {
		t.Fatal("an unlisted identity other than the reader must stay refused", err)
	}
}

// The shared service: any host credential may claim the reader, which is held
// to pools and query; the other operations are 403 and nothing is written.
func TestGatewayServesKnowledgeToAnyHostCredential(t *testing.T) {
	g, err := newGateway(context.Background(), hostConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.base.close)
	call := func(token, op string, in any) (int, string) {
		w := toolRequest(t, g, token, "knowledge", op, false, in)
		return w.Code, w.Body.String()
	}
	mustOK := func(code int, body string) {
		t.Helper()
		if code != 200 {
			t.Fatal(code, body)
		}
	}
	mustOK(func() (int, string) {
		w := toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "pool_create", Pool: "open", Name: "Open", RequestID: "c1"})
		return w.Code, w.Body.String()
	}())
	toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "pool_create", Pool: "secret", Name: "Secret", RequestID: "c2"})
	toolRequest(t, g, macHostToken, "manager", "write", false, writeInput{Action: "upsert", Pool: "open", ID: "refund", RequestID: "w1", Title: "Hoàn tiền", Content: "Chính sách hoàn tiền"})
	toolRequest(t, g, macHostToken, "manager", "write", false, writeInput{Action: "upsert", Pool: "secret", ID: "pay", RequestID: "w2", Title: "Lương", Content: "bí mật"})
	if w := toolRequest(t, g, macHostToken, "marketing", "manage", false, manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "p1"}); w.Code == 200 {
		t.Fatal("a reader published a pool", w.Body.String())
	}
	mustOK(func() (int, string) {
		w := toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "pool_update", Pool: "open", Public: pointer(true), RequestID: "p2"})
		return w.Code, w.Body.String()
	}())
	for _, token := range []string{macHostToken, vmHostToken} { // neither lists "knowledge" in its soots
		code, body := call(token, "pools", poolsInput{})
		if code != 200 || !strings.Contains(body, `"id":"open"`) || strings.Contains(body, "secret") {
			t.Fatal("pools through a host credential", code, body)
		}
		if code, body = call(token, "query", queryInput{Action: "search", Pool: "open", Query: "hoan tien"}); code != 200 || !strings.Contains(body, "refund") {
			t.Fatal(code, body)
		}
		if code, _ = call(token, "query", queryInput{Action: "read", Pool: "secret", ID: "pay"}); code == 200 {
			t.Fatal("private pool readable through the gateway")
		}
		for op, in := range map[string]any{"write": writeInput{Action: "upsert", Pool: "open", ID: "x", RequestID: "x-" + token[:4], Title: "x", Content: "y"}, "manage": manageInput{Action: "pool_update", Pool: "open", Public: pointer(false), RequestID: "m-" + token[:4]}, "status": statusInput{RequestID: "p2"}, "view": struct{}{}} {
			if code, body = call(token, op, in); code != 403 {
				t.Fatalf("%s via %s: %d %s", op, token[:4], code, body)
			}
		}
	}
	// The user-interface credential is not a host credential: no claim.
	if code, _ := call(managerToken, "pools", poolsInput{}); code == 200 {
		t.Fatal("a Soot-bound credential must not claim the reader")
	}
	if w := toolRequest(t, g, macHostToken, "stranger", "pools", false, poolsInput{}); w.Code == 200 {
		t.Fatal("an unlisted identity other than the reader must stay refused")
	}
}

// The console switch: a person's pool_update carries the generation and policy
// revision they read; a stale one is a conflict and changes nothing.
func TestConsoleSwitchGuardsPublicWithGenerationAndRevision(t *testing.T) {
	s := testService(t)
	create(t, s, "faq")
	s.human = true
	p := invoke(t, s, "pools", poolsInput{Pool: "faq"}).(map[string]any)["pool"].(pool)
	stale := p.PolicyRevision + 5
	if r, ok := invoke(t, s, "action", uiInput("manage", manageInput{Action: "pool_update", Pool: "faq", Public: pointer(true), Generation: p.Generation, ExpectedPolicyRevision: &stale, RequestID: "ui-stale"})).(map[string]any); !ok || r["code"] != "conflict" {
		t.Fatal("a stale switch must be a conflict", r)
	}
	if r, ok := invoke(t, s, "action", uiInput("manage", manageInput{Action: "pool_update", Pool: "faq", Public: pointer(true), RequestID: "ui-bare"})).(map[string]any); !ok || r["status"] != "error" {
		t.Fatal("an unguarded switch must be refused", r)
	}
	if invoke(t, s, "pools", poolsInput{Pool: "faq"}).(map[string]any)["pool"].(pool).Public {
		t.Fatal("a stale switch changed the pool")
	}
	invoke(t, s, "action", uiInput("manage", manageInput{Action: "pool_update", Pool: "faq", Public: pointer(true), Generation: p.Generation, ExpectedPolicyRevision: &p.PolicyRevision, RequestID: "ui-ok"}))
	if !invoke(t, s, "pools", poolsInput{Pool: "faq"}).(map[string]any)["pool"].(pool).Public {
		t.Fatal("the switch did not apply")
	}
}

// A PostgreSQL pools table from before the public flag gets the column when
// the service opens it, and a later open finds it there and leaves the table
// alone. (The SQLite store was born with the flag.)
func TestOpeningAnOlderSchemaAddsThePublicFlag(t *testing.T) {
	if !testPostgres() {
		t.Skip("the older schema only exists on PostgreSQL")
	}
	b := freshBinding(t)
	s, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	create(t, s, "kb")
	rawExec(t, s.db, `ALTER TABLE data_pool.pools DROP COLUMN public`, "")
	s.close()
	for i := range 2 {
		again, err := openService(context.Background(), b, "manager")
		if err != nil {
			t.Fatal(err)
		}
		invoke(t, again, "manage", manageInput{Action: "pool_update", Pool: "kb", Public: pointer(i == 0), RequestID: fmt.Sprintf("public-%d", i)})
		again.close()
	}
}
