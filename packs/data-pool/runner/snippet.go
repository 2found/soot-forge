package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// snippetBytes bounds the text a search hit carries.
const snippetBytes = 768

type snippetWord struct {
	start, end int
	norm       string
}

// snippet is the part of a document a search hit shows: the window that holds
// the most of the query's words, each weighted by how rare it is in the
// document, so "the" counts for little and "memoryMb" for much. A long
// section put its answer past the first 768 bytes, and the agent reading only
// the opening said the page did not have it. A window that would start near
// the top, or a query that matches no word, keeps the opening.
func snippet(content, query string) string {
	if len(content) <= snippetBytes {
		return content
	}
	opening := cut(content, 0, snippetBytes)
	terms := map[string]bool{}
	for _, t := range strings.FieldsFunc(normalize(query), notWordRune) {
		if utf8.RuneCountInString(t) >= 2 {
			terms[t] = true
		}
	}
	words := splitWords(content)
	count := map[string]int{}
	type hit struct {
		start, end int
		term       string
	}
	var hits []hit
	for _, w := range words {
		if term := matchTerm(w.norm, terms); term != "" {
			count[term]++
			hits = append(hits, hit{w.start, w.end, term})
		}
	}
	if len(hits) == 0 {
		return content[:opening]
	}
	// Slide a window that opens at each hit's line, or a little before the hit
	// on a long line; both edges only move forward, so a common word costs one
	// pass, not one per occurrence.
	best, bestScore, bestOpen := 0, 0.0, 0.0
	inside := map[string]int{}
	score, left, right, floor := 0.0, 0, 0, 0
	for _, h := range hits {
		start := opensAt(content, h.start)
		start = max(start, floor) // keep both edges moving forward
		floor = start
		for ; right < len(hits) && hits[right].end <= start+snippetBytes; right++ {
			if inside[hits[right].term]++; inside[hits[right].term] == 1 {
				score += 1 / float64(count[hits[right].term])
			}
		}
		for ; left < right && hits[left].start < start; left++ {
			if inside[hits[left].term]--; inside[hits[left].term] == 0 {
				score -= 1 / float64(count[hits[left].term])
			}
		}
		// Of windows holding the same words, the one that opens on the rarest
		// is the one about them, not the text that happens to precede them.
		open := 1 / float64(count[h.term])
		if score > bestScore+1e-9 || score > bestScore-1e-9 && open > bestOpen {
			best, bestScore, bestOpen = start, score, open
		}
	}
	if best < snippetBytes/2 {
		return content[:opening]
	}
	end := cut(content, best, best+snippetBytes)
	text := "…" + strings.TrimSpace(content[best:end])
	if end < len(content) {
		text += "…"
	}
	return text
}

// opensAt is where a window showing the word at pos begins: its line when the
// line starts close before it, else the word boundary a short lead before it.
func opensAt(content string, pos int) int {
	lead := snippetBytes / 4
	if line := strings.LastIndexByte(content[:pos], '\n') + 1; pos-line <= lead {
		return line
	}
	start := pos - lead
	for start < pos && !utf8.RuneStart(content[start]) {
		start++
	}
	if space := strings.IndexAny(content[start:pos], " \t"); space >= 0 {
		start += space + 1
	}
	return start
}

func matchTerm(word string, terms map[string]bool) string {
	if terms[word] {
		return word
	}
	for t := range terms {
		if utf8.RuneCountInString(t) >= 4 && strings.HasPrefix(word, t) {
			return t
		}
	}
	return ""
}

func splitWords(content string) []snippetWord {
	var words []snippetWord
	start := -1
	for i, r := range content {
		if notWordRune(r) {
			if start >= 0 {
				words = append(words, snippetWord{start, i, normalize(content[start:i])})
				start = -1
			}
		} else if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		words = append(words, snippetWord{start, len(content), normalize(content[start:])})
	}
	return words
}

func notWordRune(r rune) bool {
	return !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.Is(unicode.Mn, r)
}

// cut is the largest end within limit that falls on a character boundary.
func cut(content string, start, limit int) int {
	end := min(len(content), limit)
	for end < len(content) && end > start && !utf8.RuneStart(content[end]) {
		end--
	}
	return end
}
