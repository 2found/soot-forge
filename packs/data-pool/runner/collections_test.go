package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func organizationFixture(t *testing.T) (*gateway, *httptest.Server, serverConfig) {
	t.Helper()
	c := serverConfig{Storage: freshBinding(t), Clients: []serviceClient{
		{Soot: "manager", TokenSHA256: hash(managerToken), Operations: operations},
		{Soot: "marketing", TokenSHA256: hash(readerToken), Operations: operations},
		{Soot: "support", TokenSHA256: hash(vmToken), Operations: []string{"pools", "query", "status"}},
	}}
	c.Storage.Groups = map[string][]string{"creative": {"marketing"}, "sales": {"support"}}
	c.Storage.Defaults = map[string]string{"marketing": "project"}
	g, server := newTestGatewayWith(t, c)
	return g, server, c
}

func orgManage(t *testing.T, server *httptest.Server, in manageInput) []byte {
	t.Helper()
	return mustRemote(t, server.URL, managerToken, "manager", "manage", in)
}

func orgCreate(t *testing.T, server *httptest.Server, id, parent string, inherit *bool) {
	t.Helper()
	orgManage(t, server, manageInput{Action: "pool_create", Pool: id, Name: id, Parent: &parent, Inherit: inherit, RequestID: "create-" + id})
}

func orgPage(t *testing.T, server *httptest.Server, token, actor string, in poolsInput) []pool {
	t.Helper()
	var page struct{ Pools []pool }
	if err := json.Unmarshal(mustRemote(t, server.URL, token, actor, "pools", in), &page); err != nil {
		t.Fatal(err)
	}
	return page.Pools
}

func TestCollectionHierarchyGroupInheritanceAndMove(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgCreate(t, server, "project", "company", nil)
	private := false
	orgCreate(t, server, "payroll", "project", &private)
	orgCreate(t, server, "other", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Group: "creative", Level: "write", RequestID: "group-grant"})
	page := orgPage(t, server, readerToken, "marketing", poolsInput{Limit: 20})
	if len(page) != 2 || page[0].ID != "company" || page[1].ID != "project" {
		t.Fatal(page)
	}
	if len(orgPage(t, server, vmToken, "support", poolsInput{})) != 0 {
		t.Fatal("foreign group visibility")
	}
	raw := json.RawMessage(`{"action":"read","pool":"project","id":"one"}`)
	if _, err := contextCall(t, server, vmToken, toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "support", GroupID: "creative", Operation: "data-pool_query", Input: raw}); err == nil {
		t.Fatal("forged group asserted membership")
	}
	in := writeInput{Action: "append", Content: "duplicate-friendly default destination", RequestID: "observation"}
	var receipt receipt
	if err := json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "write", in), &receipt); err != nil || receipt.Pool != "project" || receipt.Status != "succeeded" {
		t.Fatal(receipt, err)
	}
	if _, err := remoteCall(t, server.URL, readerToken, "marketing", "query", queryInput{Action: "list", Pool: "payroll"}); err == nil {
		t.Fatal("private child inherited")
	}
	parent := "other"
	orgManage(t, server, manageInput{Action: "pool_update", Pool: "project", Parent: &parent, Name: "Launch", RequestID: "move"})
	if len(orgPage(t, server, readerToken, "marketing", poolsInput{})) != 1 {
		t.Fatal("moved collection retained stale permission")
	}
	// Existing bytes survive a metadata-only move; there is no content rewrite.
	read := mustRemote(t, server.URL, managerToken, "manager", "query", queryInput{Action: "read", Pool: "project", ID: receipt.Document.ID})
	if !bytes.Contains(read, []byte(in.Content)) {
		t.Fatal(string(read))
	}
	orgManage(t, server, manageInput{Action: "grant", Pool: "project", Soot: "support", Level: "read", RequestID: "explicit"})
	if len(orgPage(t, server, vmToken, "support", poolsInput{})) != 1 {
		t.Fatal("direct access to moved collection missing")
	}
}

func TestCollectionRejectsCyclesParentsAndStalePolicy(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgCreate(t, server, "project", "company", nil)
	var detail struct{ Pool pool }
	json.Unmarshal(mustRemote(t, server.URL, managerToken, "manager", "pools", poolsInput{Pool: "project"}), &detail)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Group: "creative", Level: "read", RequestID: "grant"})
	raw, _ := json.Marshal(manageInput{Action: "pool_update", Pool: "project", Name: "Stale edit", RequestID: "stale", Generation: detail.Pool.Generation, ExpectedPolicyRevision: &detail.Pool.PolicyRevision})
	envelope, _ := json.Marshal(interfaceInput{Kind: "manage", Input: raw})
	out, err := contextCall(t, server, managerToken, toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "manager", Operation: "data-pool_action", Interaction: true, Input: envelope})
	if err != nil || !bytes.Contains(out, []byte(`"code":"conflict"`)) {
		t.Fatal("stale inherited-policy edit accepted", string(out), err)
	}
	p := "project"
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_update", Pool: "company", Parent: &p, RequestID: "cycle"}); err == nil {
		t.Fatal("cycle accepted")
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "delete-parent"}); err == nil {
		t.Fatal("recursive deletion allowed")
	}
}

func TestCollectionReferencesRevokeAndRestart(t *testing.T) {
	g, server, cfg := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgCreate(t, server, "project", "company", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Group: "creative", Level: "write", RequestID: "grant"})
	call := toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "marketing", GroupID: "creative", Operation: "data-pool_write", Event: &callEvent{ID: "run-1", Source: "conversation", Subject: "conversation-1"}, Input: json.RawMessage(`{"action":"upsert","pool":"project","id":"draft","content":"Durable reference","request_id":"write"}`)}
	out, err := contextCall(t, server, readerToken, call)
	if err != nil {
		t.Fatal(err)
	}
	var r receipt
	json.Unmarshal(out, &r)
	if r.Document.Origin == nil || r.Document.Origin.Workspace != "company" || r.Document.Origin.Conversation != "conversation-1" || r.Document.Origin.Group != "creative" {
		t.Fatal(string(out))
	}
	if _, err := contextCall(t, server, readerToken, call); err != nil {
		t.Fatal(err)
	} // replay adds no duplicate reference
	call.Operation = "data-pool_query"
	call.Input = json.RawMessage(`{"action":"read","pool":"project","id":"draft"}`)
	if _, err := contextCall(t, server, readerToken, call); err != nil {
		t.Fatal(err)
	}
	query := queryInput{Action: "references", Conversation: "conversation-1", Run: "run-1", Limit: 20}
	var refs struct{ References []dataReference }
	json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "query", query), &refs)
	if len(refs.References) != 2 || refs.References[0].SHA256 != hash("Durable reference") {
		t.Fatal(refs)
	}
	orgManage(t, server, manageInput{Action: "revoke", Pool: "company", Group: "creative", RequestID: "revoke"})
	if len(orgPage(t, server, readerToken, "marketing", poolsInput{})) != 0 {
		t.Fatal("revoked group index retained access")
	}
	json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "query", query), &refs)
	if len(refs.References) != 0 {
		t.Fatal("reference metadata leaked after revoke")
	}
	server.Close()
	g.base.close()
	cfg.Listen = "127.0.0.1:0"
	next, err := newGateway(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(next.base.close)
	restarted := httptest.NewServer(next)
	defer restarted.Close()
	if len(orgPage(t, restarted, readerToken, "marketing", poolsInput{})) != 0 {
		t.Fatal("revoke lost after restart")
	}
	if _, err := remoteCall(t, restarted.URL, readerToken, "marketing", "write", writeInput{Action: "append", Content: "denied default", RequestID: "denied"}); err == nil {
		t.Fatal("default destination bypassed revoke")
	}
}

func TestCollectionDepthBound(t *testing.T) {
	_, server, _ := organizationFixture(t)
	parent := ""
	for i := 0; i < maxCollectionDepth; i++ {
		id := fmt.Sprintf("c%d", i)
		orgCreate(t, server, id, parent, nil)
		parent = id
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "too-deep", Name: "Deep", Parent: &parent, RequestID: "deep"}); err == nil {
		t.Fatal("unbounded collection depth")
	}
}

func TestCollectionMergedPaginationAndMembershipRestart(t *testing.T) {
	g, server, cfg := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Group: "creative", Level: "read", RequestID: "group"})
	for i := range 27 {
		id := fmt.Sprintf("child-%02d", i)
		orgCreate(t, server, id, "company", nil)
		if i%2 == 0 {
			orgManage(t, server, manageInput{Action: "grant", Pool: id, Soot: "marketing", Level: "write", RequestID: "direct-" + id})
		}
	}
	var ids []string
	after := ""
	for {
		var page struct {
			Pools []pool
			Next  string
		}
		if err := json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "pools", poolsInput{After: after, Limit: 7}), &page); err != nil {
			t.Fatal(err)
		}
		for _, p := range page.Pools {
			ids = append(ids, p.ID)
		}
		if page.Next == "" {
			break
		}
		after = page.Next
		if len(ids) > 28 {
			t.Fatal("pagination did not advance", ids)
		}
	}
	if len(ids) != 28 {
		t.Fatal("merged page lost or duplicated collections", ids)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i-1] >= ids[i] {
			t.Fatal("unstable ordering or duplicate", ids)
		}
	}
	// Membership is operator configuration: changing it is authoritative on restart.
	server.Close()
	g.base.close()
	cfg.Storage.Groups = map[string][]string{"creative": {"support"}}
	cfg.Listen = "127.0.0.1:0"
	next, err := newGateway(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(next.base.close)
	restarted := httptest.NewServer(next)
	defer restarted.Close()
	page := orgPage(t, restarted, readerToken, "marketing", poolsInput{Limit: 20})
	if len(page) != 14 {
		t.Fatal("removed membership retained inherited access or lost direct grants", page)
	}
	if len(orgPage(t, restarted, vmToken, "support", poolsInput{Limit: 20})) != 20 {
		t.Fatal("new membership missing indexed access")
	}
}

func TestCollectionReferenceRetentionAndGeneration(t *testing.T) {
	g, server, _ := organizationFixture(t)
	orgCreate(t, server, "project", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "project", Group: "creative", Level: "read", RequestID: "grant"})
	pool, err := pgxpool.New(context.Background(), g.base.b.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var generation string
	if err := pool.QueryRow(context.Background(), `SELECT generation FROM data_pool.pools WHERE id = 'project'`).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `INSERT INTO data_pool.references_log
		(conversation, at, pool, generation, id, revision, sha256, action, origin)
		SELECT 'retention', now(), 'project', $1, 'doc', 1, $2, 'read',
			'{"workspace":"company","soot":"marketing","conversation_id":"retention","run_id":"run"}'
		FROM generate_series(1, $3)`, generation, hash("content"), referenceRetention+2); err != nil {
		t.Fatal(err)
	}
	// One more append applies the retained window to the seeded history.
	if err := g.base.db.update(context.Background(), func(tx pgx.Tx) error {
		return appendReference(context.Background(), tx, &originRef{Workspace: "company", Soot: "marketing", Conversation: "retention", Run: "run"}, "project", generation, "read", &document{ID: "doc", Revision: 1, SHA256: hash("content")})
	}); err != nil {
		t.Fatal(err)
	}
	query := queryInput{Action: "references", Conversation: "retention", Limit: 20}
	var page struct {
		References []dataReference
		Next       string
		Oldest     uint64 `json:"oldest_sequence"`
	}
	if err := json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "query", query), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.References) != 20 || page.Oldest != 4 || page.References[0].Sequence != 4 || page.Next != "23" {
		t.Fatal(page)
	}
	orgManage(t, server, manageInput{Action: "grant", Pool: "project", Soot: "support", Level: "read", RequestID: "support"})
	var other struct{ References []dataReference }
	json.Unmarshal(mustRemote(t, server.URL, vmToken, "support", "query", query), &other)
	if len(other.References) != 0 {
		t.Fatal("another actor's conversation references leaked", len(other.References))
	}
	orgManage(t, server, manageInput{Action: "pool_remove", Pool: "project", RequestID: "remove"})
	orgManage(t, server, manageInput{Action: "pool_create", Pool: "project", Name: "Reused ID", RequestID: "recreate"})
	orgManage(t, server, manageInput{Action: "grant", Pool: "project", Group: "creative", Level: "read", RequestID: "regrant"})
	json.Unmarshal(mustRemote(t, server.URL, readerToken, "marketing", "query", query), &other)
	if len(other.References) != 0 {
		t.Fatal("references from deleted collection generation leaked")
	}
}

func TestCollectionDefaultDoesNotDiscardInvalidInput(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "project", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "project", Group: "creative", Level: "write", RequestID: "grant"})
	call := toolCall{APIVersion: "soot/v1", Hook: "tool.call", Soot: "marketing", Operation: "data-pool_write", Input: json.RawMessage(`{"action":"append","content":"typo must not write","request_id":"typo","pol":"project"}`)}
	if _, err := contextCall(t, server, readerToken, call); err == nil {
		t.Fatal("default normalization discarded unknown input")
	}
	var page struct{ Documents []document }
	json.Unmarshal(mustRemote(t, server.URL, managerToken, "manager", "query", queryInput{Action: "list", Pool: "project"}), &page)
	if len(page.Documents) != 0 {
		t.Fatal("invalid request changed storage")
	}
}

// Nest turning the pool on is only the host half; a grant to a Soot the
// service does not bind says which config to change instead of a bare refusal.
func TestGrantToUnboundSootSaysWhatToChange(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	_, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "company", Soot: "newcomer", Level: "read", RequestID: "unbound"})
	if err == nil || !strings.Contains(err.Error(), "newcomer is not admitted to this data service; a pool manager admits it") {
		t.Fatalf("err = %v", err)
	}
	_, err = remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "grant", Pool: "company", Soot: "manager", Level: "read", RequestID: "manager"})
	if err == nil || !strings.Contains(err.Error(), "manages this namespace already") {
		t.Fatalf("err = %v", err)
	}
}

// A write refused before any mutation tells the Soot what to change; a
// managing Soot used to get only "denied or failed" and gave up on its brief.
func TestRefusedWritesSayWhy(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Soot: "marketing", Level: "write", RequestID: "g"})
	write := func(body string) error {
		_, err := remoteCall(t, server.URL, readerToken, "marketing", "write", json.RawMessage(body))
		return err
	}
	if err := write(`{"action":"upsert","pool":"company","id":"brief","content":"first","request_id":"brief-1"}`); err != nil {
		t.Fatal(err)
	}
	for body, want := range map[string]string{
		`{"action":"upsert","pool":"company","id":"brief","content":"second","request_id":"brief-1"}`:                                        "a new intent needs a new request_id",
		`{"action":"upsert","pool":"company","id":"brief","content":"second","expected_revision":7,"request_id":"brief-2"}`:                  "revision conflict: document brief is at revision 1, not 7; read it again",
		`{"action":"upsert","pool":"company","id":"brief","content":"   ","request_id":"brief-3"}`:                                           "over 128 KiB; shorten or split it",
		`{"action":"upsert","pool":"company","id":"fresh","content":"new","generation":"AAAAAAAAAAAAAAAAAAAAAAAAAA","request_id":"fresh-2"}`: "collection company is not at generation AAAAAAAAAAAAAAAAAAAAAAAAAA; omit generation",
		`{"action":"upsert","pool":"company","id":"fresh","content":"new","expected_revision":1,"request_id":"fresh-1"}`:                     "document fresh does not exist yet; omit expected_revision to create it",
	} {
		if err := write(body); err == nil || !strings.Contains(err.Error(), "no mutation submitted: ") || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", body, err)
		}
	}
	_, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(`{"action":"read","pool":"company","id":"missing"}`))
	if err == nil || !strings.Contains(err.Error(), "document missing is not in collection company") {
		t.Errorf("read missing: err = %v", err)
	}
	// The shapes a lite model actually sends: every optional field filled in.
	for _, body := range []string{
		`{"action":"upsert","pool":"company","id":"radar-2026-10-14","request_id":"radar-1","title":"Brief","content":"x","source":"","url":"","tags":[],"generation":"","expected_revision":0}`,
		`{"action":"append","pool":"company","id":"","request_id":"note-1","title":"Note","content":"x","source":"","url":"","tags":[],"generation":"","expected_revision":0}`,
		`{"action":"upsert","content":"probe","expected_revision":0,"generation":"probe-radar-v1","id":"probe-radar","pool":"company","request_id":"probe-radar-20261014-01","source":"operator probe","tags":[],"title":"probe","url":""}`,
	} {
		if err := write(body); err != nil {
			t.Errorf("placeholder %s: %v", body, err)
		}
	}
	if out, err := remoteCall(t, server.URL, readerToken, "marketing", "pools", json.RawMessage(`{"after":"0","limit":20,"parent":"","pool":"company"}`)); err != nil || !strings.Contains(string(out), `"company"`) {
		t.Errorf("placeholder pool detail: %s %v", out, err)
	}
	for _, body := range []string{
		`{"action":"search","after":"0","conversation_id":"","id":"0","limit":20,"offset":0,"pool":"company","query":"brief","run_id":""}`,
		`{"action":"list","after":"0","conversation_id":"","id":"0","limit":20,"offset":0,"pool":"company","query":"","run_id":""}`,
	} {
		if _, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(body)); err != nil {
			t.Errorf("placeholder %s: %v", body, err)
		}
	}
	out, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(`{"action":"read","after":"0","conversation_id":"","id":"brief","limit":8192,"offset":0,"pool":"company","query":"","run_id":""}`))
	if err != nil || !strings.Contains(string(out), `"complete":true`) {
		t.Errorf("placeholder read: %s %v", out, err)
	}
	for body, want := range map[string]string{
		`{"action":"read","pool":"company","id":"brief","limit":20000}`: "read: limit is 20000 bytes; use 4 to 8192",
		`{"action":"read","pool":"company"}`:                            "read: id is required",
		`{"action":"list","pool":"company","limit":50}`:                 "list: limit is 50; use 1 to 20",
		`{"action":"list","pool":"company","query":"x"}`:                "list: query belongs to action search",
		`{"action":"search","pool":"company"}`:                          "search: query is required",
	} {
		_, err = remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", body, err)
		}
	}
}

// A digest reads the day's documents in one call: id and ids together, a
// placeholder or repeat dropped, an absent one reported instead of failing the
// read, and the content held to one budget so the page fits the tool output.
func TestBatchReadReturnsSeveralDocuments(t *testing.T) {
	_, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Soot: "marketing", Level: "write", RequestID: "g"})
	long := strings.Repeat("phản hồi ", 900)
	for id, content := range map[string]string{"fb-1": "first", "fb-2": "second", "fb-3": long} {
		body, _ := json.Marshal(writeInput{Action: "upsert", Pool: "company", ID: id, Content: content, RequestID: "w-" + id})
		if _, err := remoteCall(t, server.URL, readerToken, "marketing", "write", json.RawMessage(body)); err != nil {
			t.Fatal(err)
		}
	}
	out, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(`{"action":"read","pool":"company","id":"fb-1","ids":["fb-2","fb-1","","fb-3","gone"],"limit":8192,"offset":0}`))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Documents []readPage
		Missing   []string
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Documents) != 3 || got.Documents[0].Content != "first" || got.Documents[1].Content != "second" || !got.Documents[0].Complete {
		t.Fatalf("documents = %s", out)
	}
	if third := got.Documents[2]; third.Complete || len(third.Content) > batchContentBytes/4 || third.NextOffset != len(third.Content) {
		t.Fatalf("long document page: complete=%v len=%d next=%d", third.Complete, len(third.Content), third.NextOffset)
	}
	if !slices.Equal(got.Missing, []string{"gone"}) {
		t.Fatalf("missing = %v", got.Missing)
	}
	// The rest of a long document continues alone from its next_offset.
	if _, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(fmt.Sprintf(`{"action":"read","pool":"company","ids":["fb-3"],"offset":%d}`, got.Documents[2].NextOffset))); err != nil {
		t.Fatal(err)
	}
	for body, want := range map[string]string{
		`{"action":"read","pool":"company","ids":["a","b","c","d","e","f","g","h","i"]}`: "read: ids names 9 documents; read at most 8 per call",
		`{"action":"read","pool":"company","ids":["fb-1","fb-2"],"offset":5}`:            "read: offset continues one document",
		`{"action":"read","pool":"company","ids":["fb 1"]}`:                              `read: id "fb 1" is not a document ID`,
		`{"action":"read","pool":"company","ids":["gone"]}`:                              "document gone is not in collection company",
	} {
		_, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", body, err)
		}
	}
	// A list or search ignores ids a model filled in.
	if _, err := remoteCall(t, server.URL, readerToken, "marketing", "query", json.RawMessage(`{"action":"list","pool":"company","ids":["0"]}`)); err != nil {
		t.Error(err)
	}
}
