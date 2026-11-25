package datapool

import (
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// The service's SQL is written once, in PostgreSQL syntax. The SQLite backend
// runs it through sqliteSQL, which changes only what SQLite spells differently:
//
//	data_pool.t          -> t                (one file is one namespace)
//	$1, $2               -> ?1, ?2           (numbered, so repeats stay valid)
//	x::text              -> x
//	= ANY($1)            -> IN (?n, ?n+1, …) (the slice becomes extra arguments)
//	FOR UPDATE / SHARE   -> removed          (a write transaction already owns the file)
//	now()                -> a UTC timestamp in the format the driver parses
//
// Anything else must already be valid in both engines; the shared test suite
// runs on both, so a statement that is not shows up as a failing test.

var (
	anyClause   = regexp.MustCompile(`=\s*ANY\(\$(\d+)\)`)
	placeholder = regexp.MustCompile(`\$(\d+)`)
	forLock     = regexp.MustCompile(`\s+FOR (UPDATE|SHARE)\b`)
	sqliteNow   = `strftime('%Y-%m-%d %H:%M:%f+00:00', 'now')`
	staticSQL   sync.Map // query -> translated query, for statements without ANY
)

func sqliteSQL(query string, args []any) (string, []any) {
	hasAny := strings.Contains(query, "ANY(")
	if !hasAny {
		if cached, ok := staticSQL.Load(query); ok {
			return cached.(string), args
		}
	}
	q := strings.ReplaceAll(query, databaseSchema+".", "")
	q = strings.ReplaceAll(q, "::text", "")
	q = strings.ReplaceAll(q, "now()", sqliteNow)
	q = forLock.ReplaceAllString(q, "")
	if hasAny {
		extra := append([]any(nil), args...)
		q = anyClause.ReplaceAllStringFunc(q, func(match string) string {
			n, _ := strconv.Atoi(anyClause.FindStringSubmatch(match)[1])
			list := reflect.ValueOf(args[n-1])
			extra[n-1] = nil // the slice itself is no longer referenced
			marks := make([]string, 0, list.Len())
			for i := 0; i < list.Len(); i++ {
				extra = append(extra, list.Index(i).Interface())
				marks = append(marks, "$"+strconv.Itoa(len(extra)))
			}
			if len(marks) == 0 {
				return "IN (NULL)"
			}
			return "IN (" + strings.Join(marks, ",") + ")"
		})
		args = extra
	}
	q = placeholder.ReplaceAllString(q, "?$1")
	if !hasAny {
		staticSQL.Store(query, q)
	}
	return q, args
}
