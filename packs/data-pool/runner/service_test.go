package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSharedDataPermissionsRevocationAndRestart(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	create(t, s, "private")
	grant(t, s, "company", "marketing", "read")
	grant(t, s, "company", "support", "read")
	grant(t, s, "company", "writer", "write")
	r := writeDoc(t, s, "company", "handbook", "import-1", "Doanh nghiệp Việt Nam — sản phẩm hữu ích.")
	if r.Status != "succeeded" || r.Document.Revision != 1 {
		t.Fatalf("bad receipt %+v", r)
	}
	for _, actor := range []string{"marketing", "support"} {
		s.actor = actor
		read := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"}).(map[string]any)
		if !strings.Contains(read["content"].(string), "Việt Nam") {
			t.Fatal(read)
		}
		denied(t, s, "query", queryInput{Action: "read", Pool: "private", ID: "handbook"})
		denied(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "bad-remove"})
		denied(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "outsider", Level: "read", RequestID: "bad-grant"})
		denied(t, s, "status", statusInput{RequestID: "import-1", Owner: "manager"})
	}
	s.actor = "writer"
	denied(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "outsider", Level: "manage", RequestID: "writer-grant"})
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "revoke", Pool: "company", Soot: "marketing", RequestID: "revoke"})
	s.actor = "marketing"
	denied(t, s, "query", queryInput{Action: "search", Pool: "company", Query: "doanh"})
	pools := invoke(t, s, "pools", poolsInput{}).(map[string]any)["pools"].([]collectionSummary)
	if len(pools) != 0 {
		t.Fatal("revoked pool leaked", pools)
	}
	b := s.b
	s.close()
	reopened, err := openService(context.Background(), b, "support")
	if err != nil {
		t.Fatal(err)
	}
	s.db = reopened.db
	s.actor = "support"
	invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
}

func TestDuplicateUpdatesAndDeletion(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	r := writeDoc(t, s, "company", "handbook", "import-1", "First document")
	r2 := writeDoc(t, s, "company", "handbook", "import-1", "First document")
	if r2.Document.Revision != r.Document.Revision || !r2.Replay {
		t.Fatal("duplicate was rewritten")
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "import-1", Title: "Different", Content: "Second"})
	r2 = writeDoc(t, s, "company", "handbook", "unchanged", "First document")
	if r2.Document.Revision != 1 {
		t.Fatal("unchanged import was rewritten", r2)
	}
	r2 = writeDoc(t, s, "company", "handbook", "import-2", "Second document")
	if r2.Document.Revision != 2 {
		t.Fatal(r2)
	}
	r2 = invoke(t, s, "write", writeInput{Action: "remove", Pool: "company", ID: "handbook", RequestID: "remove"}).(receipt)
	if r2.Status != "succeeded" {
		t.Fatal(r2)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "handbook"})
	list := invoke(t, s, "query", queryInput{Action: "list", Pool: "company"}).(map[string]any)
	if len(list["documents"].([]document)) != 0 {
		t.Fatal(list)
	}
	create(t, s, "other")
	grant(t, s, "other", "support", "read")
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "drop"})
	if _, err := s.doc(context.Background(), "company", "handbook"); err == nil {
		t.Fatal("removed pool survived")
	}
}

// A failed transaction leaves neither the document nor a receipt: the retry
// with the same request_id is the only way to learn the outcome.
func TestWriteTransactionIsAtomic(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	pool, err := pgxpool.New(context.Background(), s.b.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `CREATE FUNCTION data_pool.refuse_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `CREATE TRIGGER refuse_receipt BEFORE INSERT ON data_pool.receipts FOR EACH ROW EXECUTE FUNCTION data_pool.refuse_receipt()`); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(writeInput{Action: "upsert", Pool: "company", ID: "atomic", RequestID: "atomic-1", Title: "Atomic", Content: "half written?"})
	if _, err := s.dispatch(context.Background(), "write", raw); err == nil {
		t.Fatal("failed transaction reported success")
	}
	if _, err := s.doc(context.Background(), "company", "atomic"); err == nil {
		t.Fatal("document survived a rolled-back transaction")
	}
	if _, err := s.loadReceipt(context.Background(), "manager", "atomic-1"); err == nil {
		t.Fatal("receipt survived a rolled-back transaction")
	}
	if _, err := pool.Exec(context.Background(), `DROP TRIGGER refuse_receipt ON data_pool.receipts`); err != nil {
		t.Fatal(err)
	}
	if r := invoke(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "atomic", RequestID: "atomic-1", Title: "Atomic", Content: "half written?"}).(receipt); r.Status != "succeeded" {
		t.Fatal(r)
	}
}

func TestEnvelopeBindingValidationAndNoSecretLeak(t *testing.T) {
	s := testService(t)
	b := s.b
	s.close()
	rawBinding, _ := json.Marshal(b)
	call := map[string]any{"api_version": "soot/v1", "hook": "tool.call", "soot": "outsider", "operation": "data-pool_pools", "future_field": true, "input": map[string]any{}}
	data, _ := json.Marshal(call)
	var out bytes.Buffer
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "postgres://") || strings.Contains(out.String(), "password") {
		t.Fatal("connection material leaked:", out.String())
	}
	for _, change := range []map[string]any{{"soot": "intruder"}, {"operation": "data-pool_manage"}, {"input": map[string]any{"soot": "manager"}}, {"input": map[string]any{"root": "/etc"}}, {"api_version": "soot/v2"}} {
		for k, v := range change {
			call[k] = v
		}
		data, _ = json.Marshal(call)
		if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err == nil {
			t.Fatal("accepted forged input", call)
		}
		call["soot"] = "outsider"
		call["operation"] = "data-pool_pools"
		call["input"] = map[string]any{}
		call["api_version"] = "soot/v1"
	}
	for _, dsn := range []string{"mysql://user:secret@db.example/app", "postgres://user:secret@public.example/app", "postgres:///local", "postgres://host/db#fragment"} {
		b.DatabaseURL = dsn
		v, _ := json.Marshal(b)
		if _, err := loadBinding(string(v)); err == nil {
			t.Fatal(dsn)
		}
	}
	for _, dsn := range []string{"postgres://user:secret@127.0.0.1/db", "postgres://user:secret@10.1.2.3/db?sslmode=disable", "postgres://user:secret@db.example/app?sslmode=verify-full"} {
		b.DatabaseURL = dsn
		v, _ := json.Marshal(b)
		if _, err := loadBinding(string(v)); err != nil {
			t.Fatalf("%s: %v", dsn, err)
		}
	}
}

func TestPaginationIntegrityAndInputBoundaries(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	for _, id := range []string{"a", "b", "c"} {
		writeDoc(t, s, "company", id, "import-"+id, "Công ty đàng hoàng")
	}
	first := invoke(t, s, "query", queryInput{Action: "list", Pool: "company", Limit: 2}).(map[string]any)
	if first["next"] != "b" || len(first["documents"].([]document)) != 2 {
		t.Fatal(first)
	}
	last := invoke(t, s, "query", queryInput{Action: "list", Pool: "company", Limit: 2, After: "b"}).(map[string]any)
	if last["next"] != "" || len(last["documents"].([]document)) != 1 {
		t.Fatal(last)
	}
	for _, in := range []queryInput{{Action: "search", Pool: "company", Query: ""}, {Action: "search", Pool: "company", Query: "company", Limit: 21}, {Action: "list", Pool: "company", After: "../x"}, {Action: "read", Pool: "company", ID: "a", Offset: 2}, {Action: "read", Pool: "company", ID: "../a"}} {
		denied(t, s, "query", in)
	}
	pool, err := pgxpool.New(context.Background(), s.b.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `UPDATE data_pool.documents SET content = 'tampered' WHERE pool_id = 'company' AND id = 'a'`); err != nil {
		t.Fatal(err)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "a"})
	if normalize("ĐÀNG Hoàng Việt Nam") != "dang hoang viet nam" {
		t.Fatal("Vietnamese normalization drift")
	}
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "big", RequestID: "big", Title: "Big", Content: strings.Repeat("x", 13<<10)})
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "nul", RequestID: "nul", Title: "Nul", Content: "bad\x00text"})
}

// Search is served by pg_trgm indexes over the normalized key: accents and
// case fold away, and a typo in a short title still matches.
func TestSearchToleratesAccentsAndTypos(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	writeDoc(t, s, "company", "refund", "refund-1", "Chính sách hoàn tiền trong ba mươi ngày.")
	writeDoc(t, s, "company", "other", "other-1", "Company handbook for partners.")
	for _, query := range []string{"hoan tien", "HOÀN TIỀN", "hoàn tiền"} {
		result := invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: query}).(map[string]any)
		hits := result["hits"].([]any)
		if len(hits) != 1 || hits[0].(map[string]any)["document"].(document).ID != "refund" {
			t.Fatalf("%s: %v", query, result)
		}
		if !strings.Contains(hits[0].(map[string]any)["snippet"].(string), "hoàn tiền") {
			t.Fatalf("snippet lost the match: %v", hits[0])
		}
	}
	if result := invoke(t, s, "query", queryInput{Action: "search", Pool: "company", Query: "handbok"}).(map[string]any); len(result["hits"].([]any)) == 0 {
		t.Fatal("typo did not match the title", result)
	}
}

func TestDocumentLimit(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	pool, err := pgxpool.New(context.Background(), s.b.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `INSERT INTO data_pool.documents
		(pool_id, id, title, source, tags, sha256, revision, updated_at, content, title_norm, content_norm, receipt)
		SELECT 'company', 'd' || g, 'T', 'urn:x', '[]', 'sha', 1, now(), 'x', 't', 'x', 'r'
		FROM generate_series(1, $1) g`, maxDocuments); err != nil {
		t.Fatal(err)
	}
	denied(t, s, "write", writeInput{Action: "append", Pool: "company", Content: "one too many", RequestID: "overflow"})
}

func TestPoolRemovalClearsHistoricalGrants(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	grant(t, s, "company", "marketing", "read")
	grant(t, s, "company", "support", "write")
	writeDoc(t, s, "company", "old", "old-import", "Old company")
	s.b.Soots = []string{"manager"}
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "remove-company"})
	invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: "company", Name: "New company", RequestID: "new-company"})
	writeDoc(t, s, "company", "new", "new-import", "NEW COMPANY SECRET")
	s.b.Soots = []string{"manager", "marketing", "support"}
	for _, actor := range []string{"marketing", "support"} {
		s.actor = actor
		pools := invoke(t, s, "pools", poolsInput{}).(map[string]any)
		if len(pools["pools"].([]collectionSummary)) != 0 {
			t.Fatal("stale pool membership", actor, pools)
		}
		denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "new"})
	}
}

func TestUTF8ReadAlwaysProgressesOrErrors(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	writeDoc(t, s, "company", "unicode", "unicode-import", "Đ😀")
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Limit: 1})
	first := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Limit: 4}).(map[string]any)
	if first["content"] != "Đ" || first["next_offset"] != 2 || first["complete"] != false {
		t.Fatal(first)
	}
	denied(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Offset: 2, Limit: 3})
	last := invoke(t, s, "query", queryInput{Action: "read", Pool: "company", ID: "unicode", Offset: 2, Limit: 4}).(map[string]any)
	if last["content"] != "😀" || last["next_offset"] != 6 || last["complete"] != true {
		t.Fatal(last)
	}
}

func TestEscapedHostEnvelopeAndWireLimit(t *testing.T) {
	s := testService(t)
	b := s.b
	s.close()
	rawBinding, _ := json.Marshal(b)
	call := map[string]any{"api_version": "soot/v1", "hook": "tool.call", "soot": "manager", "operation": "data-pool_pools", "input": map[string]any{}, "event": map[string]any{"text": strings.Repeat("<", 16384)}}
	data, _ := json.Marshal(call)
	if len(data) <= 32<<10 {
		t.Fatal("test did not exercise escaped wire size")
	}
	var out bytes.Buffer
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err != nil {
		t.Fatal(err)
	}
	call["event"] = map[string]any{"text": strings.Repeat("<", maxInput)}
	data, _ = json.Marshal(call)
	if err := execute(context.Background(), []string{"pools"}, bytes.NewReader(data), &out, string(rawBinding)); err == nil {
		t.Fatal("unbounded envelope accepted")
	}
}

func TestReplacementPoolCannotExposeHistoricalReceipts(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	grant(t, s, "company", "writer", "write")
	s.actor = "writer"
	old := writeDoc(t, s, "company", "handbook", "old-import", "Old private company data")
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "pool_remove", Pool: "company", RequestID: "remove-old"})
	if invoke(t, s, "status", statusInput{Owner: "writer", RequestID: "old-import"}).(receipt).PoolGeneration != old.PoolGeneration {
		t.Fatal("audit identity changed")
	}
	fresh := invoke(t, s, "manage", manageInput{Action: "pool_create", Pool: "company", Name: "Replacement", RequestID: "create-new"}).(receipt)
	if fresh.PoolGeneration == old.PoolGeneration {
		t.Fatal("pool generation reused")
	}
	grant(t, s, "company", "support", "manage")
	s.actor = "support"
	denied(t, s, "status", statusInput{Owner: "writer", RequestID: "old-import"})
	s.actor = "manager"
	invoke(t, s, "manage", manageInput{Action: "grant", Pool: "company", Soot: "writer", Level: "write", RequestID: "new-writer-grant"})
	s.actor = "writer"
	denied(t, s, "status", statusInput{RequestID: "old-import"})
	denied(t, s, "write", writeInput{Action: "upsert", Pool: "company", ID: "handbook", RequestID: "old-import", Title: "Company handbook", Content: "Old private company data", Source: "urn:company:handbook", Tags: []string{"brand"}})
	if writeDoc(t, s, "company", "handbook", "new-import", "New company data").PoolGeneration != fresh.PoolGeneration {
		t.Fatal("wrong receipt generation")
	}
}

// status is a read: a request_id the caller cannot see says what to do instead,
// in one sentence for missing and for another Soot's, so it is no oracle.
func TestStatusOfAnInvisibleRequestIsActionableAndNoOracle(t *testing.T) {
	s := testService(t)
	create(t, s, "company")
	grant(t, s, "company", "writer", "write")
	s.actor = "writer"
	writeDoc(t, s, "company", "handbook", "import-1", "Doanh nghiệp Việt Nam.")
	s.actor = "marketing"
	var answers []string
	for _, id := range []string{"import-1", "never-sent"} {
		raw, _ := json.Marshal(statusInput{RequestID: id})
		_, err := s.dispatch(context.Background(), "status", raw)
		var invalid inputError
		if !errors.As(err, &invalid) || !strings.Contains(err.Error(), "Nothing was changed") {
			t.Fatalf("status %s: %v", id, err)
		}
		answers = append(answers, strings.Replace(err.Error(), id, "<id>", 1))
	}
	if answers[0] != answers[1] {
		t.Fatalf("another Soot's request reads differently from a missing one:\n%s\n%s", answers[0], answers[1])
	}
}
