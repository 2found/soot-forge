package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func organizationFixture(t *testing.T) (*gateway, *httptest.Server, serverConfig) {
	t.Helper()
	_, backend := newFake(t)
	c := gatewayConfig(t, backend.URL)
	c.Storage.Groups = map[string][]string{"creative": {"marketing"}, "sales": {"support"}}
	c.Storage.Defaults = map[string]string{"marketing": "project"}
	c.Clients[1].Operations = operations
	g, err := newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(g)
	t.Cleanup(func() { server.Close(); g.base.close() })
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
func contextCall(t *testing.T, server *httptest.Server, token string, call toolCall) ([]byte, error) {
	t.Helper()
	data, _ := json.Marshal(call)
	binding, _ := json.Marshal(binding{ServiceURL: server.URL, ServiceToken: token})
	var out bytes.Buffer
	err := execute(context.Background(), []string{strings.TrimPrefix(call.Operation, "data-pool_")}, bytes.NewReader(data), &out, string(binding))
	return out.Bytes(), err
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
	g, server, _ := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgCreate(t, server, "project", "company", nil)
	var detail struct{ Pool pool }
	json.Unmarshal(orgManageRead(t, server, "project"), &detail)
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
	if err := g.base.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("fences")).Put([]byte("project/*"), []byte("unknown"))
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "orphan", Name: "Orphan", Parent: &p, RequestID: "orphan"}); err == nil {
		t.Fatal("created under unresolved removal")
	}
}
func orgManageRead(t *testing.T, server *httptest.Server, id string) []byte {
	return mustRemote(t, server.URL, managerToken, "manager", "pools", poolsInput{Pool: id})
}
func TestCollectionReferencesRevokeAndRestart(t *testing.T) {
	g, server, c := organizationFixture(t)
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
	next, err := newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	g.base = next.base
	g.clients = next.clients
	restarted := httptest.NewServer(next)
	defer restarted.Close()
	if len(orgPage(t, restarted, readerToken, "marketing", poolsInput{})) != 0 {
		t.Fatal("revoke lost after restart")
	}
	if _, err := remoteCall(t, restarted.URL, readerToken, "marketing", "write", writeInput{Action: "append", Content: "denied default", RequestID: "denied"}); err == nil {
		t.Fatal("default destination bypassed revoke")
	}
}
func TestCollectionDepthBoundAndPrivateLegacyMigration(t *testing.T) {
	g, server, _ := organizationFixture(t)
	parent := ""
	for i := 0; i < maxCollectionDepth; i++ {
		id := fmt.Sprintf("c%d", i)
		orgCreate(t, server, id, parent, nil)
		parent = id
	}
	if _, err := remoteCall(t, server.URL, managerToken, "manager", "manage", manageInput{Action: "pool_create", Pool: "too-deep", Name: "Deep", Parent: &parent, RequestID: "deep"}); err == nil {
		t.Fatal("unbounded collection depth")
	}
	if err := g.base.db.Update(func(tx *bolt.Tx) error {
		// Exact old metadata shape: no parent/inherit, and direct grant index only.
		if err := tx.Bucket([]byte("pools")).Put([]byte("legacy"), []byte(`{"id":"legacy","name":"Legacy","generation":"legacy-generation","policy_revision":0}`)); err != nil {
			return err
		}
		if _, err := tx.Bucket([]byte("documents")).CreateBucket([]byte("legacy")); err != nil {
			return err
		}
		if err := tx.Bucket([]byte("grants")).Put([]byte("legacy/support"), []byte("read")); err != nil {
			return err
		}
		if err := tx.Bucket([]byte("config")).Delete([]byte("collections-v1")); err != nil {
			return err
		}
		return g.base.initializeCollections(tx)
	}); err != nil {
		t.Fatal(err)
	}
	page := orgPage(t, server, vmToken, "support", poolsInput{})
	if len(page) != 1 || page[0].ID != "legacy" || page[0].Inherit {
		t.Fatal("legacy root privacy/visibility changed", page)
	}
}

func TestCollectionMergedPaginationAndMembershipRestart(t *testing.T) {
	g, server, cfg := organizationFixture(t)
	orgCreate(t, server, "company", "", nil)
	orgManage(t, server, manageInput{Action: "grant", Pool: "company", Group: "creative", Level: "read", RequestID: "group"})
	for i := 0; i < 27; i++ {
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
	// Group index persists, but current host membership is authoritative on restart.
	server.Close()
	g.base.close()
	cfg.Storage.Groups = map[string][]string{"creative": {"support"}}
	next, err := newGateway(cfg)
	if err != nil {
		t.Fatal(err)
	}
	g.base = next.base
	g.clients = next.clients
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
	var p pool
	if err := g.base.db.Update(func(tx *bolt.Tx) error {
		if err := getJSON(tx.Bucket([]byte("pools")), "project", &p); err != nil {
			return err
		}
		origin := &originRef{Workspace: "company", Soot: "marketing", Conversation: "retention", Run: "run"}
		for i := 0; i < referenceRetention+3; i++ {
			if err := appendReference(tx, origin, p.ID, p.Generation, "read", &document{ID: "doc", Revision: 1, SHA256: hash("content")}); err != nil {
				return err
			}
		}
		return nil
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
		t.Fatal("another actor's conversation references leaked")
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
