// soot-writing is the writing pack executable. `export` turns a draft
// (artifact ref or inline text) into a stored Markdown or sanitized HTML
// artifact in the operator-bound artifact store. Standalone tool: it
// re-implements the artifacts store layout (contrib/packs/artifacts
// contract) instead of importing another pack.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	xhtml "golang.org/x/net/html"

	"github.com/2found/soot-forge/packs/writing/runner/contract"
)

// ---- envelope -----------------------------------------------------------

const maxEnvelopeBytes = 128 * 1024

func readCall(in io.Reader) (contract.ToolCall, error) {
	var call contract.ToolCall
	raw, err := io.ReadAll(io.LimitReader(in, maxEnvelopeBytes+1))
	if err != nil || len(raw) > maxEnvelopeBytes || json.Unmarshal(raw, &call) != nil {
		return call, fmt.Errorf("invalid or oversized tool envelope")
	}
	if call.APIVersion != contract.APIVersion || call.Hook != contract.ToolCallHook || call.Soot == "" {
		return call, fmt.Errorf("invalid tool context")
	}
	return call, nil
}

// ---- artifact store (contract: contrib/packs/artifacts) -----------------

var (
	refPattern = regexp.MustCompile(`^art_[0-9a-f]{32}$`)
	shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type artifactMeta struct {
	ID         string `json:"id"`
	MimeType   string `json:"mimeType"`
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	CreatedAt  string `json:"createdAt"`
	Name       string `json:"name,omitempty"`
	Provenance struct {
		Operation string `json:"operation"`
		Soot      string `json:"soot"`
	} `json:"provenance"`
}

// writeFileAtomic writes content to path via tmp+fsync+rename, 0600.
func writeFileAtomic(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0600); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

func storeWrite(root string, content []byte, mimeType, name, op, soot string) (artifactMeta, error) {
	if root == "" || !filepath.IsAbs(root) {
		return artifactMeta{}, fmt.Errorf("artifact store binding missing or not absolute")
	}
	unlock, err := lockArtifactStore(root)
	if err != nil {
		return artifactMeta{}, err
	}
	defer unlock()
	sum := sha256.Sum256(content)
	sumHex := hex.EncodeToString(sum[:])
	objDir := filepath.Join(root, "objects", sumHex[:2])
	if err := os.MkdirAll(objDir, 0700); err != nil {
		return artifactMeta{}, err
	}
	if _, err := os.Stat(filepath.Join(objDir, sumHex)); os.IsNotExist(err) {
		if err := writeFileAtomic(filepath.Join(objDir, sumHex), content); err != nil {
			return artifactMeta{}, err
		}
	} else if err != nil {
		return artifactMeta{}, err
	} else {
		cached, err := readBoundedFile(filepath.Join(objDir, sumHex), int64(len(content)))
		if err != nil || !bytes.Equal(cached, content) {
			return artifactMeta{}, fmt.Errorf("existing artifact object failed verification")
		}
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return artifactMeta{}, err
	}
	m := artifactMeta{ID: "art_" + hex.EncodeToString(raw[:]), MimeType: mimeType,
		SHA256: sumHex, Bytes: int64(len(content)), CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Name: sanitizeName(name)}
	m.Provenance.Operation = op
	m.Provenance.Soot = soot
	if err := os.MkdirAll(filepath.Join(root, "meta"), 0700); err != nil {
		return artifactMeta{}, err
	}
	meta, err := json.Marshal(m)
	if err != nil {
		return artifactMeta{}, err
	}
	if err := writeFileAtomic(filepath.Join(root, "meta", m.ID+".json"), meta); err != nil {
		return artifactMeta{}, fmt.Errorf("%w: %v", errUncertain, err)
	}
	return m, nil
}

func storeRead(root, ref string) (artifactMeta, []byte, error) {
	if !refPattern.MatchString(ref) {
		return artifactMeta{}, nil, fmt.Errorf("invalid artifact ref")
	}
	metaBytes, err := readBoundedFile(filepath.Join(root, "meta", ref+".json"), 64<<10)
	if err != nil {
		return artifactMeta{}, nil, fmt.Errorf("artifact not found")
	}
	var m artifactMeta
	if err := json.Unmarshal(metaBytes, &m); err != nil || m.ID != ref || !shaPattern.MatchString(m.SHA256) || m.Bytes < 0 || m.Bytes > 16<<20 {
		return artifactMeta{}, nil, fmt.Errorf("corrupt artifact meta")
	}
	content, err := readBoundedFile(filepath.Join(root, "objects", m.SHA256[:2], m.SHA256), m.Bytes)
	if err != nil {
		return artifactMeta{}, nil, fmt.Errorf("artifact object missing")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != m.SHA256 || int64(len(content)) != m.Bytes {
		return artifactMeta{}, nil, fmt.Errorf("artifact checksum mismatch")
	}
	return m, content, nil
}

func readBoundedFile(path string, maximum int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("expected regular artifact file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maximum+1))
	if err == nil && int64(len(data)) > maximum {
		return nil, fmt.Errorf("artifact exceeds byte limit")
	}
	return data, err
}

var nameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func sanitizeName(name string) string {
	name = nameUnsafe.ReplaceAllString(filepath.Base(name), "-")
	name = strings.Trim(name, ".-")
	if len(name) > 96 {
		name = name[:96]
	}
	return name
}

// ---- draft -> output ----------------------------------------------------

type exportInput struct {
	Format       string `json:"format"`
	SourceFormat string `json:"source_format"`
	Ref          string `json:"ref"`
	Text         string `json:"text"`
	Name         string `json:"name"`
}

const maxDraftBytes = 256 * 1024

func exportDraft(root, op, soot string, in exportInput) (artifactMeta, error) {
	if in.Format != "markdown" && in.Format != "html" {
		return artifactMeta{}, fmt.Errorf("format must be markdown or html")
	}
	if (in.Ref == "") == (in.Text == "") {
		return artifactMeta{}, fmt.Errorf("supply exactly one of ref or text")
	}
	src := in.SourceFormat
	if src == "" {
		src = in.Format
	}
	var draft []byte
	var srcName string
	if in.Ref != "" {
		m, content, err := storeRead(root, in.Ref)
		if err != nil {
			return artifactMeta{}, err
		}
		if len(content) > maxDraftBytes {
			return artifactMeta{}, fmt.Errorf("draft exceeds %d bytes", maxDraftBytes)
		}
		draft, srcName = content, m.Name
	} else {
		if len(in.Text) > maxDraftBytes {
			return artifactMeta{}, fmt.Errorf("text exceeds %d bytes", maxDraftBytes)
		}
		draft = []byte(in.Text)
	}
	if !utf8.Valid(draft) {
		return artifactMeta{}, fmt.Errorf("draft is not valid UTF-8")
	}
	var out []byte
	var mimeType, ext string
	switch {
	case in.Format == "markdown" && src == "markdown":
		out, mimeType, ext = draft, "text/markdown", ".md"
	case in.Format == "markdown":
		return artifactMeta{}, fmt.Errorf("markdown output requires a markdown source draft")
	case in.Format == "html" && src == "markdown":
		out = renderMarkdownHTML(string(draft))
		mimeType, ext = "text/html", ".html"
	case in.Format == "html" && src == "html":
		var err error
		out, err = sanitizeHTML(draft)
		if err != nil {
			return artifactMeta{}, err
		}
		mimeType, ext = "text/html", ".html"
	case in.Format == "html" && src == "text":
		out = []byte("<p>" + stdhtml.EscapeString(string(draft)) + "</p>")
		mimeType, ext = "text/html", ".html"
	default:
		return artifactMeta{}, fmt.Errorf("unsupported source_format %q", src)
	}
	name := in.Name
	if name == "" {
		name = srcName
	}
	if name == "" {
		name = "draft" + ext
	}
	if filepath.Ext(name) == "" {
		name += ext
	}
	return storeWrite(root, out, mimeType, name, op, soot)
}

// ---- markdown -> html (minimal renderer, escaped inline) ----------------

var (
	mdHeading  = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	mdOlItem   = regexp.MustCompile(`^\d+\.\s+(.*)$`)
	mdUlItem   = regexp.MustCompile(`^[-*]\s+(.*)$`)
	mdLink     = regexp.MustCompile(`\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)`)
	mdBold     = regexp.MustCompile(`\*\*([^*]+)\*\*|__([^_]+)__`)
	mdItalic   = regexp.MustCompile(`\*([^*]+)\*|_([^_]+)_`)
	mdCodeSpan = regexp.MustCompile("`([^`]+)`")
	mdFence    = regexp.MustCompile("^```")
	mdQuote    = regexp.MustCompile(`^>\s?(.*)$`)
	mdSafeURL  = regexp.MustCompile(`^https?://`)
)

// isLocalURL accepts root-relative paths only; "//host/…" is a
// protocol-relative external URL and stays unsafe.
func isLocalURL(v string) bool {
	return strings.HasPrefix(v, "/") && !strings.HasPrefix(v, "//")
}

func mdInline(s string) string {
	esc := strings.ReplaceAll(stdhtml.EscapeString(s), "\x00", "")
	// Code spans and links are replaced first, then parked behind opaque
	// placeholders so emphasis passes cannot rewrite URLs or code content
	// (an underscore inside a href or code span must never match mdItalic).
	var parked []string
	park := func(html string) string {
		parked = append(parked, html)
		return "\x00" + strconv.Itoa(len(parked)-1) + "\x00"
	}
	esc = mdCodeSpan.ReplaceAllStringFunc(esc, func(m string) string {
		return park("<code>" + m[1:len(m)-1] + "</code>")
	})
	esc = mdLink.ReplaceAllStringFunc(esc, func(m string) string {
		parts := mdLink.FindStringSubmatch(m)
		href := stdhtml.UnescapeString(parts[2])
		if !mdSafeURL.MatchString(href) {
			return parts[1] // link text stays inline; unsafe target dropped
		}
		return park(`<a href="` + stdhtml.EscapeString(href) + `">` + parts[1] + `</a>`)
	})
	esc = mdBold.ReplaceAllStringFunc(esc, func(m string) string {
		inner := strings.Trim(m, "*_")
		return "<strong>" + inner + "</strong>"
	})
	esc = mdItalic.ReplaceAllStringFunc(esc, func(m string) string {
		inner := strings.Trim(m, "*_")
		return "<em>" + inner + "</em>"
	})
	for i, html := range parked {
		esc = strings.ReplaceAll(esc, "\x00"+strconv.Itoa(i)+"\x00", html)
	}
	return esc
}

func renderMarkdownHTML(src string) []byte {
	var b strings.Builder
	b.WriteString("<article>\n")
	var inList, inCode, inQuote bool
	var listKind string
	closeLists := func() {
		if inList {
			b.WriteString("</" + listKind + ">\n")
			inList = false
		}
	}
	closeQuote := func() {
		if inQuote {
			b.WriteString("</blockquote>\n")
			inQuote = false
		}
	}
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimRight(line, " \t")
		if mdFence.MatchString(trimmed) {
			if inCode {
				b.WriteString("</code></pre>\n")
			} else {
				closeLists()
				closeQuote()
				b.WriteString("<pre><code>")
			}
			inCode = !inCode
			continue
		}
		if inCode {
			b.WriteString(stdhtml.EscapeString(line) + "\n")
			continue
		}
		if strings.TrimSpace(trimmed) == "" {
			closeLists()
			closeQuote()
			continue
		}
		if m := mdHeading.FindStringSubmatch(trimmed); m != nil {
			closeLists()
			closeQuote()
			level := strconv.Itoa(len(m[1]))
			b.WriteString("<h" + level + ">" + mdInline(m[2]) + "</h" + level + ">\n")
			continue
		}
		if m := mdQuote.FindStringSubmatch(trimmed); m != nil {
			closeLists()
			if !inQuote {
				b.WriteString("<blockquote>\n")
				inQuote = true
			}
			b.WriteString("<p>" + mdInline(m[1]) + "</p>\n")
			continue
		}
		if m := mdUlItem.FindStringSubmatch(trimmed); m != nil {
			closeQuote()
			if !inList || listKind != "ul" {
				closeLists()
				b.WriteString("<ul>\n")
				inList, listKind = true, "ul"
			}
			b.WriteString("<li>" + mdInline(m[1]) + "</li>\n")
			continue
		}
		if m := mdOlItem.FindStringSubmatch(trimmed); m != nil {
			closeQuote()
			if !inList || listKind != "ol" {
				closeLists()
				b.WriteString("<ol>\n")
				inList, listKind = true, "ol"
			}
			b.WriteString("<li>" + mdInline(m[1]) + "</li>\n")
			continue
		}
		closeLists()
		closeQuote()
		b.WriteString("<p>" + mdInline(trimmed) + "</p>\n")
	}
	if inCode {
		b.WriteString("</code></pre>\n")
	}
	closeLists()
	closeQuote()
	b.WriteString("</article>\n")
	return []byte(b.String())
}

// ---- html sanitize (allowlist re-emit via x/net/html) -------------------

var allowedTags = map[string]bool{
	"a": true, "abbr": true, "article": true, "b": true, "blockquote": true,
	"br": true, "code": true, "div": true, "em": true, "figcaption": true,
	"figure": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true,
	"h6": true, "hr": true, "i": true, "img": true, "li": true, "ol": true,
	"p": true, "pre": true, "section": true, "span": true, "strong": true,
	"sub": true, "sup": true, "table": true, "tbody": true, "td": true,
	"tfoot": true, "th": true, "thead": true, "tr": true, "u": true, "ul": true,
}
var dropWithContents = map[string]bool{
	"script": true, "style": true, "iframe": true, "object": true,
	"embed": true, "template": true, "noscript": true, "svg": true,
	"math": true, "form": true, "textarea": true, "select": true,
	"button": true, "input": true, "title": true,
}

func allowedAttr(tag, key string) bool {
	if strings.HasPrefix(key, "on") || key == "style" {
		return false
	}
	switch key {
	case "href":
		return tag == "a"
	case "src", "alt":
		return tag == "img"
	case "title":
		return true
	}
	return false
}

func sanitizeHTML(src []byte) ([]byte, error) {
	doc, err := xhtml.Parse(bytes.NewReader(src))
	if err != nil {
		return nil, fmt.Errorf("invalid html draft")
	}
	var b strings.Builder
	var walk func(*xhtml.Node)
	walk = func(n *xhtml.Node) {
		switch n.Type {
		case xhtml.TextNode:
			b.WriteString(stdhtml.EscapeString(n.Data))
		case xhtml.ElementNode:
			tag := strings.ToLower(n.Data)
			if dropWithContents[tag] {
				return
			}
			if !allowedTags[tag] {
				for c := n.FirstChild; c != nil; c = c.NextSibling {
					walk(c)
				}
				return
			}
			b.WriteString("<" + tag)
			for _, a := range n.Attr {
				key := strings.ToLower(a.Key)
				if !allowedAttr(tag, key) {
					continue
				}
				if (key == "href" || key == "src") && !mdSafeURL.MatchString(a.Val) && !isLocalURL(a.Val) && !strings.HasPrefix(a.Val, "#") {
					continue
				}
				b.WriteString(" " + key + `="` + stdhtml.EscapeString(a.Val) + `"`)
			}
			b.WriteString(">")
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c)
			}
			switch tag {
			case "br", "hr", "img":
			default:
				b.WriteString("</" + tag + ">")
			}
		default:
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				walk(c)
			}
		}
	}
	walk(doc)
	out := b.String()
	if strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("sanitized html is empty")
	}
	return []byte(out), nil
}

// ---- entry --------------------------------------------------------------

func run(in io.Reader, out io.Writer, args []string) error {
	if len(args) != 1 || args[0] != "export" {
		return fmt.Errorf("usage: soot-writing export")
	}
	call, err := readCall(in)
	if err != nil {
		return err
	}
	if call.Operation != "writing_export" {
		return fmt.Errorf("operation mismatch")
	}
	var input exportInput
	if len(bytes.TrimSpace(call.Input)) == 0 || bytes.TrimSpace(call.Input)[0] != '{' {
		return fmt.Errorf("missing input")
	}
	dec := json.NewDecoder(bytes.NewReader(call.Input))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&input); err != nil {
		return fmt.Errorf("invalid input")
	}
	m, err := exportDraft(os.Getenv("ARTIFACT_STORE"), call.Operation, call.Soot, input)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(map[string]any{
		"kind": "artifact",
		"artifact": map[string]any{
			"ref": m.ID, "mimeType": m.MimeType, "sha256": m.SHA256,
			"bytes": m.Bytes, "name": m.Name,
		},
	})
}

// errUncertain marks a failure raised after a write may have reached the
// store — the runner exits 2 so the host journals the effect uncertain and
// keeps the resource fenced for inspection.
var errUncertain = errors.New("uncertain effect")

func main() {
	if err := run(os.Stdin, os.Stdout, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, errUncertain) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}
