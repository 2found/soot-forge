package datapool

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSQLiteURLValidation(t *testing.T) {
	good := func(url string) bool {
		raw, _ := json.Marshal(binding{DatabaseURL: url, Namespace: "company", Soots: []string{"manager"}, Managers: []string{"manager"}})
		_, err := parseBinding(string(raw), false)
		return err == nil
	}
	for _, url := range []string{"sqlite:///var/lib/data-pool/pool.db", "sqlite:///tmp/a b/pool.db"} {
		if !good(url) {
			t.Fatal("rejected", url)
		}
	}
	for _, url := range []string{"sqlite:pool.db", "sqlite://pool.db", "sqlite://host/abs/pool.db", "sqlite:///abs/", "sqlite:///abs/pool.db?mode=ro", "sqlite://user@/abs/pool.db", "sqlite:///", "sqlite:///a%00b"} {
		if good(url) {
			t.Fatal("accepted", url)
		}
	}
}

func TestSQLiteFilePersistsAndIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "pool.db")
	b := binding{DatabaseURL: "sqlite://" + path, Namespace: "company", Soots: []string{"manager"}, Managers: []string{"manager"}}
	s, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	create(t, s, "kept")
	writeDoc(t, s, "kept", "doc", "doc-1", "still here after a restart")
	s.close()
	for p, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != want {
			t.Fatal(p, info, err)
		}
	}
	s, err = openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	read := invoke(t, s, "query", queryInput{Action: "read", Pool: "kept", ID: "doc"}).(map[string]any)
	if read["content"] != "still here after a restart" {
		t.Fatal(read)
	}
	var version string
	if err := s.db.view(context.Background(), func(tx dbTx) error {
		return tx.QueryRow(context.Background(), `SELECT value FROM data_pool.meta WHERE key = 'schema_version'`).Scan(&version)
	}); err != nil || version != "2" {
		t.Fatal("schema_version", version, err)
	}
}

// The trigram engine is pg_trgm's: these are values PostgreSQL itself returns
// (show_trgm / similarity with the default 0.3 threshold).
func TestTrigramsMatchPgTrgm(t *testing.T) {
	cat := trigramsOf("cat")
	if len(cat) != 4 {
		t.Fatal(cat)
	}
	for _, g := range []string{"  c", " ca", "cat", "at "} {
		if _, ok := cat[g]; !ok {
			t.Fatal("missing", g)
		}
	}
	if got := cat.similarity(trigramsOf("cats")); got != 0.5 {
		t.Fatal(got)
	}
	// Punctuation separates words; accents are kept by the engine (the
	// normalized key is what is indexed), case is folded.
	if got := trigramsOf("Foo-Bar"); len(got) != len(trigramsOf("foo bar")) {
		t.Fatal(got)
	}
	if trigramsOf("").similarity(cat) != 0 || trigramsOf("!!").similarity(cat) != 0 {
		t.Fatal("empty sets share nothing")
	}
}

func TestSQLiteSearchIsFuzzyAndIndexBacked(t *testing.T) {
	b := binding{DatabaseURL: "sqlite://" + filepath.Join(t.TempDir(), "pool.db"), Namespace: "company", Soots: []string{"manager"}, Managers: []string{"manager"}}
	s, err := openService(context.Background(), b, "manager")
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	create(t, s, "kb")
	for id, title := range map[string]string{"refund": "Chính sách hoàn tiền", "shipping": "Vận chuyển nội địa", "warranty": "Bảo hành sản phẩm"} {
		invoke(t, s, "write", writeInput{Action: "upsert", Pool: "kb", ID: id, RequestID: "w-" + id, Title: title, Content: "Nội dung " + title})
	}
	ids := func(q string) []string {
		var out []string
		for _, h := range invoke(t, s, "query", queryInput{Action: "search", Pool: "kb", Query: q}).(map[string]any)["hits"].([]any) {
			out = append(out, h.(map[string]any)["document"].(document).ID)
		}
		return out
	}
	for q, want := range map[string]string{
		"hoan tien":            "refund",
		"HOÀN TIỀN":            "refund",
		"chinh sach hoan tein": "refund", // transposed typo, no accents
		"van chuyen noi dia":   "shipping",
		"bao hanh san phm":     "warranty", // dropped letter
	} {
		if got := ids(q); len(got) == 0 || got[0] != want {
			t.Fatalf("%q: got %v want first %s", q, got, want)
		}
	}
	if got := ids("zzzzqqqq"); len(got) != 0 {
		t.Fatal("noise matched", got)
	}
	// A query of one-letter words around punctuation has no word trigram in
	// common with the text, but the text contains it: still a hit.
	invoke(t, s, "write", writeInput{Action: "upsert", Pool: "kb", ID: "faq", RequestID: "w-faq", Title: "Official Q&A page", Content: "Range 1-2 items, code a&b, \"quoted\" text."})
	for _, q := range []string{"q&a", "Q&A", "1-2", "a&b", `"quoted"`} {
		if got := ids(q); !slices.Contains(got, "faq") {
			t.Fatalf("%q: got %v, want faq", q, got)
		}
	}
	// The statement is served by the FTS trigram index, not a table scan.
	plan := ""
	if err := s.db.view(context.Background(), func(tx dbTx) error {
		rows, err := tx.Query(context.Background(), `EXPLAIN QUERY PLAN SELECT rowid FROM documents_fts WHERE documents_fts MATCH '"hoa"'`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a, b, c int
			var detail string
			if err := rows.Scan(&a, &b, &c, &detail); err != nil {
				return err
			}
			plan += detail + ";"
		}
		return rows.Err()
	}); err != nil || !strings.Contains(strings.ToUpper(plan), "VIRTUAL TABLE") {
		t.Fatal("no index plan", plan, err)
	}
	// A removed or rewritten document leaves no stale index entry.
	invoke(t, s, "write", writeInput{Action: "upsert", Pool: "kb", ID: "refund", RequestID: "w-refund-2", Title: "Đổi trả hàng", Content: "Đổi trả trong bảy ngày"})
	if got := ids("hoan tien"); slices.Contains(got, "refund") {
		t.Fatal("stale index entry after an update", got)
	}
	if got := ids("doi tra"); len(got) == 0 || got[0] != "refund" {
		t.Fatal("updated text not searchable", got)
	}
}

// With a PostgreSQL available, the two backends must rank the same corpus the
// same way for every query: SQLite is a drop-in, not an approximation.
func TestSQLiteAndPostgresRankIdentically(t *testing.T) {
	dsn := os.Getenv("DATA_POOL_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set DATA_POOL_TEST_DATABASE_URL to compare against PostgreSQL")
	}
	pg, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+databaseSchema+` CASCADE`); err != nil {
		t.Fatal(err)
	}
	pg.Close()
	open := func(url string) *service {
		s, err := openService(context.Background(), binding{DatabaseURL: url, Namespace: "company", Soots: []string{"manager"}, Managers: []string{"manager"}}, "manager")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.close)
		create(t, s, "kb")
		return s
	}
	pgs, lite := open(dsn), open("sqlite://"+filepath.Join(t.TempDir(), "pool.db"))
	corpus := []struct{ id, title, content string }{
		{"refund", "Chính sách hoàn tiền", "Khách được hoàn tiền trong ba mươi ngày kể từ ngày mua."},
		{"shipping", "Vận chuyển nội địa", "Giao hàng toàn quốc trong hai đến năm ngày làm việc."},
		{"warranty", "Bảo hành sản phẩm", "Bảo hành mười hai tháng cho mọi sản phẩm chính hãng."},
		{"handbook", "Company handbook", "Handbook for partners and resellers."},
		{"pricing", "Bảng giá", "Gói Plus và gói Pro, thanh toán hàng tháng hoặc hàng năm."},
		{"short", "Q", "x"},
		{"long", "Tài liệu dài", strings.Repeat("hoàn tiền vận chuyển bảo hành ", 200)},
		{"punct", "100% off - đừng bỏ lỡ", "Giảm 100% hôm nay_only (khuyến mãi)"},
		{"upper", "ĐIỀU KHOẢN SỬ DỤNG", "ĐIỀU KHOẢN và chính sách bảo mật."},
		{"faq", "Official Q&A page", "Range 1-2 items, code a&b, \"quoted\" text."},
	}
	for _, s := range []*service{pgs, lite} {
		for _, d := range corpus {
			invoke(t, s, "write", writeInput{Action: "upsert", Pool: "kb", ID: d.id, RequestID: "w-" + d.id, Title: d.title, Content: d.content})
		}
	}
	run := func(s *service, q string) []string {
		var out []string
		for _, h := range invoke(t, s, "query", queryInput{Action: "search", Pool: "kb", Query: q, Limit: 20}).(map[string]any)["hits"].([]any) {
			out = append(out, h.(map[string]any)["document"].(document).ID)
		}
		return out
	}
	queries := []string{"hoan tien", "HOÀN TIỀN", "hoan tein", "chinh sach", "chinh sch hoan", "van chuyen", "bao hanh", "bang gia", "bang gai", "gia", "x", "q", "handbok", "handbook partners", "100%", "_", "%", "khuyen mai", "dieu khoan", "dieu khoan su dung va chinh sach bao mat day du", "zzzz", "plus pro", "thanh toan hang thang", "tài liệu", "ng ", "a b c", "q&a", "1-2", "a&b", `"quoted"`}
	// A generated corpus and mutated queries (deleted, swapped and replaced
	// letters, accents stripped) widen the comparison beyond hand-picked cases.
	vocab := []string{"hoàn", "tiền", "chính", "sách", "vận", "chuyển", "bảo", "hành", "sản", "phẩm", "khách", "hàng", "giá", "gói", "thanh", "toán", "điều", "khoản", "mật", "đặt", "giao", "nhận", "cửa", "hiệu", "support", "refund", "order", "plan", "pro", "plus", "ship"}
	rng := rand.New(rand.NewPCG(7, 11))
	pick := func(n int) string {
		w := make([]string, n)
		for i := range w {
			w[i] = vocab[rng.IntN(len(vocab))]
		}
		return strings.Join(w, " ")
	}
	for i := range 60 {
		in := writeInput{Action: "upsert", Pool: "kb", ID: fmt.Sprintf("gen-%02d", i), RequestID: fmt.Sprintf("gw-%02d", i), Title: pick(1 + rng.IntN(3)), Content: pick(3 + rng.IntN(25))}
		for _, s := range []*service{pgs, lite} {
			invoke(t, s, "write", in)
		}
	}
	mutate := func(q string) string {
		r := []rune(q)
		i := rng.IntN(len(r))
		switch rng.IntN(4) {
		case 0:
			r = slices.Delete(r, i, i+1)
		case 1:
			if i+1 < len(r) {
				r[i], r[i+1] = r[i+1], r[i]
			}
		case 2:
			r[i] = rune('a' + rng.IntN(26))
		}
		return string(r)
	}
	for range 250 {
		queries = append(queries, mutate(pick(1+rng.IntN(3))))
	}
	for _, q := range queries {
		if strings.TrimSpace(q) == "" {
			continue
		}
		if a, b := run(pgs, q), run(lite, q); !slices.Equal(a, b) {
			t.Errorf("query %q: postgres %v, sqlite %v", q, a, b)
		}
	}
}
