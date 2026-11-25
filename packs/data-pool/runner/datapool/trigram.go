package datapool

import (
	"strings"
	"sync"
	"unicode"
)

// pg_trgm in Go, for the SQLite backend. PostgreSQL serves the fuzzy match with
// a trigram GIN index and `%`; SQLite has no such operator, so the same
// function is registered as an SQL function (trgm_sim, trgm_count) and the
// FTS5 trigram index narrows the rows it is evaluated on (store_sqlite.go).
//
// The definition is pg_trgm's: lower-cased text is split into words of letters
// and digits; each word is padded with two leading and one trailing space; its
// 3-rune windows form the set; similarity is |A∩B| / |A∪B| in float32; `%`
// means similarity >= 0.3. Text reaching here is normalized already (accents
// folded, lower case), the same key the PostgreSQL index is built on.

// trigramThreshold is pg_trgm.similarity_threshold's default, as float32 so the
// comparison is bit-for-bit PostgreSQL's.
const trigramThreshold = float32(0.3)

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// words splits on anything that is not a letter or digit.
func words(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !isWordRune(r) })
}

type trigramSet map[string]struct{}

func trigramsOf(text string) trigramSet {
	set := trigramSet{}
	for _, w := range words(text) {
		r := []rune("  " + w + " ")
		for i := 0; i+3 <= len(r); i++ {
			set[string(r[i:i+3])] = struct{}{}
		}
	}
	return set
}

func (a trigramSet) similarity(b trigramSet) float32 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	small, large := a, b
	if len(small) > len(large) {
		small, large = large, small
	}
	shared := 0
	for t := range small {
		if _, ok := large[t]; ok {
			shared++
		}
	}
	return float32(shared) / float32(len(a)+len(b)-shared)
}

// queries keeps the trigram sets of recent queries: one SQL statement
// evaluates trgm_sim against many rows with the same second argument, and
// searches running at once each keep theirs (a single shared slot would make
// them rebuild the set per row). It is cleared when full.
var queries struct {
	sync.Mutex
	sets map[string]trigramSet
}

const maxCachedQueries = 64

func querySet(text string) trigramSet {
	queries.Lock()
	defer queries.Unlock()
	if set, ok := queries.sets[text]; ok {
		return set
	}
	if queries.sets == nil || len(queries.sets) >= maxCachedQueries {
		queries.sets = map[string]trigramSet{}
	}
	set := trigramsOf(text)
	queries.sets[text] = set
	return set
}

// maxMatchTerms bounds the FTS5 query a search builds; a query has at most 512
// characters, so this only trims the longest ones.
const maxMatchTerms = 256

// matchQuery is the FTS5 trigram query that finds every document that could
// reach the similarity threshold or contain the text: one quoted trigram per
// distinct 3-rune window of each word padded with a single space on each side
// (the indexed text is padded the same way, so word boundaries are indexed).
// PostgreSQL's second leading space is not indexable and carries no word
// content, so it is left out. An empty result means the query has no word.
func matchQuery(text string) string {
	seen := map[string]bool{}
	terms := []string{}
	for _, w := range words(text) {
		r := []rune(" " + w + " ")
		for i := 0; i+3 <= len(r) && len(terms) < maxMatchTerms; i++ {
			if t := string(r[i : i+3]); !seen[t] {
				seen[t] = true
				terms = append(terms, `"`+t+`"`)
			}
		}
	}
	return strings.Join(terms, " OR ")
}
