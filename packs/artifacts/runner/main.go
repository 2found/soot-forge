// soot-artifacts is the executable for the artifacts pack (BP-02). It decodes
// the soot/v1 tool envelope from stdin and implements the content-addressed
// filesystem store documented in README.md. The store root arrives only via
// the operator-bound ARTIFACT_STORE credential; model input never reaches
// argv, env or unvalidated paths. The only Soot import is the wire contract.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/2found/soot-forge/packs/artifacts/runner/contract"
)

const (
	// Contract limits. --max-bytes may tighten, never loosen the 16 MiB cap.
	hardMaxBytes     = 16 << 20
	defaultInlineMax = 256 << 10
	maxEnvelope      = 32 << 20
	maxMetaBytes     = 64 << 10
	maxExportSweep   = 128
	defaultTTLSec    = 3600
	maxTTLSec        = 86400
	storeFilePerm    = 0600
	storeDirPerm     = 0700
)

var (
	refPattern    = regexp.MustCompile(`^art_[0-9a-f]{32}$`)
	exportPattern = regexp.MustCompile(`^exp_[0-9a-f]{32}$`)
	shaPattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type options struct {
	storeDir  string
	exportDir string
	stageDir  string
	maxBytes  int64
	inlineMax int64
}

func (o *options) bindStore(getenv func(string) string) error {
	root := getenv("ARTIFACT_STORE")
	if root == "" {
		return errors.New("ARTIFACT_STORE credential binding is not set")
	}
	if !filepath.IsAbs(root) {
		return errors.New("ARTIFACT_STORE must bind an absolute directory path")
	}
	o.storeDir = filepath.Clean(root)
	return nil
}

func (o *options) bindExport(getenv func(string) string) error {
	dir := getenv("ARTIFACT_EXPORT")
	if dir == "" {
		return errors.New("ARTIFACT_EXPORT credential binding is not set")
	}
	if !filepath.IsAbs(dir) {
		return errors.New("ARTIFACT_EXPORT must bind an absolute directory path")
	}
	o.exportDir = filepath.Clean(dir)
	return nil
}

type readInput struct {
	Ref string `json:"ref"`
}

type createInput struct {
	Name     string `json:"name,omitempty"`
	MIMEType string `json:"mimeType"`
	DataB64  string `json:"data_b64,omitempty"`
	File     string `json:"file,omitempty"`
}

type exportInput struct {
	Ref    string `json:"ref"`
	TTLSec int64  `json:"ttlSec,omitempty"`
}

type removeInput struct {
	Ref      string `json:"ref,omitempty"`
	ExportID string `json:"exportId,omitempty"`
}

// artifactMeta is the persisted meta/<id>.json shape from the store contract.
type artifactMeta struct {
	ID         string `json:"id"`
	MIMEType   string `json:"mimeType"`
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	CreatedAt  string `json:"createdAt"`
	Name       string `json:"name,omitempty"`
	Provenance struct {
		Operation string `json:"operation"`
		Soot      string `json:"soot"`
	} `json:"provenance"`
}

// artifactRef is the public ref DTO consumed by other packs and adapters.
type artifactRef struct {
	Ref      string `json:"ref"`
	MIMEType string `json:"mimeType"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Name     string `json:"name,omitempty"`
}

type artifactResult struct {
	Kind     string      `json:"kind"`
	Artifact artifactRef `json:"artifact"`
	Path     string      `json:"path,omitempty"`
	DataB64  string      `json:"data_b64,omitempty"`
}

type exportResult struct {
	Kind      string      `json:"kind"`
	ExportID  string      `json:"exportId"`
	Path      string      `json:"path"`
	ExpiresAt string      `json:"expiresAt"`
	Artifact  artifactRef `json:"artifact"`
}

type removeResult struct {
	Kind     string   `json:"kind"`
	Removed  []string `json:"removed"`
	Artifact string   `json:"artifact,omitempty"`
	ExportID string   `json:"exportId,omitempty"`
}

func decodeCall(in io.Reader) (contract.ToolCall, error) {
	var call contract.ToolCall
	d := json.NewDecoder(io.LimitReader(in, maxEnvelope))
	if err := d.Decode(&call); err != nil {
		return call, fmt.Errorf("invalid tool context: %w", err)
	}
	if call.APIVersion != contract.APIVersion || call.Hook != contract.ToolCallHook || call.Soot == "" {
		return call, errors.New("invalid tool context")
	}
	return call, nil
}

// decodeStrict mirrors the manifest's additionalProperties:false input schema;
// a scope/owner/root key smuggled into model input is rejected, never ignored.
func decodeStrict(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		return errors.New("missing input object")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return fmt.Errorf("invalid input: %w", err)
	}
	return nil
}

func validRef(ref string) bool {
	return refPattern.MatchString(ref)
}

func metaPath(root, ref string) string {
	return filepath.Join(root, "meta", ref+".json")
}

func objectPath(root, sha string) string {
	return filepath.Join(root, "objects", sha[:2], sha)
}

// loadMeta resolves a ref through meta/<ref>.json. Refs are shape-checked
// before joining so meta paths can never escape the bound root.
func loadMeta(root, ref string) (artifactMeta, error) {
	var meta artifactMeta
	if !validRef(ref) {
		return meta, fmt.Errorf("invalid artifact ref %q", ref)
	}
	data, err := os.ReadFile(metaPath(root, ref))
	if err != nil {
		return meta, fmt.Errorf("artifact %s unavailable: %w", ref, err)
	}
	if len(data) > maxMetaBytes {
		return meta, fmt.Errorf("artifact %s metadata exceeds limit", ref)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return meta, fmt.Errorf("artifact %s metadata failed to parse", ref)
	}
	if meta.ID != ref || !shaPattern.MatchString(meta.SHA256) || meta.Bytes < 0 || meta.MIMEType == "" {
		return meta, fmt.Errorf("artifact %s metadata is invalid", ref)
	}
	return meta, nil
}

// verifyObject re-hashes object bytes before any consumer sees them, per the
// contract's re-verify rule.
func verifyObject(path string, meta artifactMeta) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("artifact %s object unavailable: %w", meta.ID, err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return fmt.Errorf("artifact %s object unreadable", meta.ID)
	}
	if n != meta.Bytes || hex.EncodeToString(h.Sum(nil)) != meta.SHA256 {
		return fmt.Errorf("artifact %s failed sha256 verification", meta.ID)
	}
	return nil
}

func refDTO(meta artifactMeta) artifactRef {
	return artifactRef{Ref: meta.ID, MIMEType: meta.MIMEType, SHA256: meta.SHA256, Bytes: meta.Bytes, Name: meta.Name}
}

// writeFileAtomic follows the contract write path: tmp file in the same
// directory, fsync, chmod 0600, atomic rename.
func writeFileAtomic(dir, name string, data []byte) error {
	return writeFromAtomic(dir, name, bytes.NewReader(data))
}

// copyFileAtomic is the same atomic write driven from an open file.
func copyFileAtomic(src, dir, name string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return writeFromAtomic(dir, name, in)
}

func writeFromAtomic(dir, name string, src io.Reader) error {
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, src); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Chmod(storeFilePerm); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		return err
	}
	committed = true
	return nil
}

func newID(prefix string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b[:]), nil
}

// sanitizeName keeps a single basename component; traversal and control
// characters turn into no name at all rather than a rewritten path.
func sanitizeName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || name != filepath.Base(name) || name == "." || name == ".." {
		return ""
	}
	if strings.ContainsAny(name, "\\/") || strings.ContainsRune(name, 0) || !utf8.ValidString(name) || len(name) > 255 {
		return ""
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	return name
}

func declaredAllowed(declared string) bool {
	if strings.HasPrefix(declared, "text/") && len(declared) > len("text/") {
		return true
	}
	switch declared {
	case "application/json", "application/pdf", "application/octet-stream",
		"image/png", "image/jpeg", "image/webp", "image/gif",
		"audio/mpeg", "audio/wav", "audio/mp4",
		"video/mp4", "video/webm":
		return true
	}
	return false
}

// sniffMIME identifies content from magic bytes, never the declared type or
// file extension. Unrecognized text falls back to text/plain; binary falls
// back to application/octet-stream.
func sniffMIME(data []byte) string {
	switch {
	case len(data) >= 5 && bytes.Equal(data[:5], []byte("%PDF-")):
		return "application/pdf"
	case len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(data) >= 3 && bytes.Equal(data[:3], []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE")):
		return "audio/wav"
	case len(data) >= 3 && bytes.Equal(data[:3], []byte("ID3")):
		return "audio/mpeg"
	case len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0:
		return "audio/mpeg"
	case len(data) >= 4 && bytes.Equal(data[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return "video/webm"
	case isMP4Family(data):
		return "video/mp4"
	case utf8.Valid(data):
		return "text/plain"
	default:
		return "application/octet-stream"
	}
}

// isMP4Family accepts ISO base media (ftyp major/compatible brands in the
// header). Brand-level audio/video splits are unreliable, so the sniffer
// reports the whole family as video/mp4 and mimeAccepted covers both.
func isMP4Family(data []byte) bool {
	if len(data) < 12 || !bytes.Equal(data[4:8], []byte("ftyp")) {
		return false
	}
	for _, b := range data[8:12] {
		if b < 0x20 || b > 0x7e {
			return false
		}
	}
	return true
}

// mimeAccepted enforces the allowlist against sniffed content so a relabeled
// payload (lie-by-extension) cannot smuggle an excluded type.
func mimeAccepted(declared, sniffed string, data []byte) bool {
	switch {
	case declared == "application/octet-stream":
		return true
	case strings.HasPrefix(declared, "text/"):
		return sniffed == "text/plain"
	case declared == "application/json":
		return sniffed == "text/plain" && json.Valid(data)
	case declared == "audio/mp4", declared == "video/mp4":
		return sniffed == "video/mp4"
	default:
		return declared == sniffed
	}
}

// stagePath resolves a model-supplied staging path inside the operator's
// --stage allowlist directory only. Without --stage, file input is denied
// outright; model input can never nominate an arbitrary host path.
func (o options) stagePath(name string) (string, error) {
	if o.stageDir == "" {
		return "", errors.New("file input requires an operator-configured staging directory")
	}
	if name == "" || filepath.IsAbs(name) || !filepath.IsLocal(name) {
		return "", errors.New("file input must be a relative path")
	}
	stageAbs, err := filepath.Abs(o.stageDir)
	if err != nil {
		return "", err
	}
	if stageAbs, err = filepath.EvalSymlinks(stageAbs); err != nil {
		return "", fmt.Errorf("staging directory unavailable: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(stageAbs, name))
	if err != nil {
		return "", fmt.Errorf("staged file unavailable: %w", err)
	}
	if resolved != stageAbs && !strings.HasPrefix(resolved, stageAbs+string(filepath.Separator)) {
		return "", errors.New("staged file escapes the staging directory")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("staged file is not a regular file")
	}
	if info.Size() > o.maxBytes {
		return "", fmt.Errorf("file exceeds %d byte limit", o.maxBytes)
	}
	return resolved, nil
}

func cmdRead(o options, call contract.ToolCall, out io.Writer) error {
	var input readInput
	if err := decodeStrict(call.Input, &input); err != nil {
		return err
	}
	meta, err := loadMeta(o.storeDir, input.Ref)
	if err != nil {
		return err
	}
	path := objectPath(o.storeDir, meta.SHA256)
	if err := verifyObject(path, meta); err != nil {
		return err
	}
	result := artifactResult{Kind: "artifact", Artifact: refDTO(meta)}
	if meta.Bytes <= o.inlineMax {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		result.DataB64 = base64.StdEncoding.EncodeToString(data)
	} else {
		result.Path = path
	}
	return emit(out, result)
}

func cmdCreate(o options, call contract.ToolCall, out io.Writer) error {
	var input createInput
	if err := decodeStrict(call.Input, &input); err != nil {
		return err
	}
	mediaType, _, err := mime.ParseMediaType(input.MIMEType)
	if err != nil || !declaredAllowed(mediaType) {
		return fmt.Errorf("mimeType %q is not in the artifacts allowlist", input.MIMEType)
	}
	if (input.DataB64 == "") == (input.File == "") {
		return errors.New("exactly one of data_b64 or file is required")
	}
	var data []byte
	if input.File != "" {
		path, err := o.stagePath(input.File)
		if err != nil {
			return err
		}
		data, err = os.ReadFile(path)
		if err != nil {
			return err
		}
	} else {
		if len(input.DataB64) > base64.StdEncoding.EncodedLen(int(o.maxBytes)+1) {
			return fmt.Errorf("data_b64 exceeds %d byte limit", o.maxBytes)
		}
		data, err = base64.StdEncoding.DecodeString(input.DataB64)
		if err != nil {
			return fmt.Errorf("invalid data_b64: %w", err)
		}
	}
	if int64(len(data)) > o.maxBytes {
		return fmt.Errorf("artifact exceeds %d byte limit", o.maxBytes)
	}
	if !mimeAccepted(mediaType, sniffMIME(data), data) {
		return fmt.Errorf("content does not match allowlisted mimeType %q", mediaType)
	}
	for _, dir := range []string{filepath.Join(o.storeDir, "objects"), filepath.Join(o.storeDir, "meta")} {
		if err := os.MkdirAll(dir, storeDirPerm); err != nil {
			return err
		}
	}
	sha := sha256.Sum256(data)
	shaHex := hex.EncodeToString(sha[:])
	object := objectPath(o.storeDir, shaHex)
	if _, err := os.Stat(object); err != nil {
		if err := os.MkdirAll(filepath.Dir(object), storeDirPerm); err != nil {
			return err
		}
		if err := writeFileAtomic(filepath.Dir(object), shaHex, data); err != nil {
			return err
		}
	}
	name := sanitizeName(input.Name)
	operation := call.Operation
	if operation == "" {
		operation = "artifacts_create"
	}
	// A colliding CSPRNG id is retried rather than allowed to clobber an
	// existing immutable meta record.
	for range 4 {
		id, err := newID("art_")
		if err != nil {
			return err
		}
		if _, err := os.Stat(metaPath(o.storeDir, id)); err == nil {
			continue
		}
		meta := artifactMeta{
			ID: id, MIMEType: mediaType, SHA256: shaHex, Bytes: int64(len(data)),
			CreatedAt: time.Now().UTC().Format(time.RFC3339), Name: name,
		}
		meta.Provenance.Operation = operation
		meta.Provenance.Soot = call.Soot
		encoded, err := json.Marshal(meta)
		if err != nil {
			return err
		}
		if err := writeFileAtomic(filepath.Join(o.storeDir, "meta"), id+".json", encoded); err != nil {
			// The object is already committed; a dangling object without meta
			// is recoverable, but the caller cannot distinguish it from a
			// partial commit — report uncertain.
			return fmt.Errorf("%w: %v", errUncertain, err)
		}
		return emit(out, artifactResult{Kind: "artifact", Artifact: refDTO(meta)})
	}
	return errors.New("could not allocate an artifact id")
}

func cmdExport(o options, call contract.ToolCall, out io.Writer, now time.Time) error {
	var input exportInput
	if err := decodeStrict(call.Input, &input); err != nil {
		return err
	}
	if input.TTLSec < 0 || input.TTLSec > maxTTLSec {
		return fmt.Errorf("ttlSec must be within 0..%d", maxTTLSec)
	}
	if input.TTLSec == 0 {
		input.TTLSec = defaultTTLSec
	}
	meta, err := loadMeta(o.storeDir, input.Ref)
	if err != nil {
		return err
	}
	object := objectPath(o.storeDir, meta.SHA256)
	if err := verifyObject(object, meta); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(o.exportDir, "exports"), storeDirPerm); err != nil {
		return err
	}
	sweepExports(filepath.Join(o.exportDir, "exports"), now)
	exportID, err := newID("exp_")
	if err != nil {
		return err
	}
	dir := filepath.Join(o.exportDir, "exports", exportID)
	if err := os.Mkdir(dir, storeDirPerm); err != nil {
		return err
	}
	name := sanitizeName(meta.Name)
	if name == "" {
		name = "artifact" + exportExtension(meta.MIMEType)
	}
	if err := copyFileAtomic(object, dir, name); err != nil {
		return err
	}
	expiresAt := now.Add(time.Duration(input.TTLSec) * time.Second).UTC().Format(time.RFC3339)
	expiry, err := json.Marshal(map[string]string{"expiresAt": expiresAt, "ref": meta.ID})
	if err != nil {
		return err
	}
	if err := writeFileAtomic(dir, "expiry.json", expiry); err != nil {
		return fmt.Errorf("%w: %v", errUncertain, err)
	}
	return emit(out, exportResult{
		Kind: "export", ExportID: exportID,
		Path: filepath.Join(dir, name), ExpiresAt: expiresAt,
		Artifact: refDTO(meta),
	})
}

func cmdRemove(o options, call contract.ToolCall, out io.Writer) error {
	var input removeInput
	if err := decodeStrict(call.Input, &input); err != nil {
		return err
	}
	if input.Ref == "" && input.ExportID == "" {
		return errors.New("provide ref and/or exportId")
	}
	if input.ExportID != "" && !exportPattern.MatchString(input.ExportID) {
		return fmt.Errorf("invalid export id %q", input.ExportID)
	}
	result := removeResult{Kind: "removed"}
	if input.ExportID != "" {
		if o.exportDir == "" {
			return errors.New("ARTIFACT_EXPORT credential binding is not set")
		}
		dir := filepath.Join(o.exportDir, "exports", input.ExportID)
		if _, err := os.Stat(dir); err != nil {
			return fmt.Errorf("export %s unavailable: %w", input.ExportID, err)
		}
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("%w: %v", errUncertain, err)
		}
		result.ExportID = input.ExportID
		result.Removed = append(result.Removed, input.ExportID)
	}
	if input.Ref != "" {
		meta, err := loadMeta(o.storeDir, input.Ref)
		if err != nil {
			return err
		}
		if err := os.Remove(metaPath(o.storeDir, input.Ref)); err != nil {
			return fmt.Errorf("%w: %v", errUncertain, err)
		}
		if !shaStillReferenced(o.storeDir, meta.SHA256) {
			_ = os.Remove(objectPath(o.storeDir, meta.SHA256))
		}
		if o.exportDir != "" {
			if err := removeExportsForRef(filepath.Join(o.exportDir, "exports"), input.Ref); err != nil {
				return fmt.Errorf("%w: %v", errUncertain, err)
			}
		}
		result.Artifact = input.Ref
		result.Removed = append(result.Removed, input.Ref)
	}
	return emit(out, result)
}

func shaStillReferenced(root, sha string) bool {
	entries, err := os.ReadDir(filepath.Join(root, "meta"))
	if err != nil {
		return true
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, "meta", e.Name()))
		if err != nil {
			return true
		}
		var meta artifactMeta
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		if meta.SHA256 == sha {
			return true
		}
	}
	return false
}

func removeExportsForRef(dir, ref string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var expiry struct {
			Ref string `json:"ref"`
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name(), "expiry.json"))
		if err != nil || json.Unmarshal(data, &expiry) != nil || expiry.Ref != ref {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func exportExtension(mediaType string) string {
	if exts, err := mime.ExtensionsByType(mediaType); err == nil && len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}

// sweepExports deletes expired export directories opportunistically within
// the same invocation, bounded at 128 entries per contract.
func sweepExports(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for i, e := range entries {
		if i >= maxExportSweep {
			break
		}
		if !e.IsDir() {
			continue
		}
		var expiry struct {
			ExpiresAt time.Time `json:"expiresAt"`
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name(), "expiry.json"))
		if err != nil || json.Unmarshal(data, &expiry) != nil || expiry.ExpiresAt.IsZero() {
			continue
		}
		if !expiry.ExpiresAt.After(now) {
			os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

func emit(out io.Writer, v any) error {
	encoded, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, string(encoded))
	return err
}

func run(in io.Reader, out io.Writer, getenv func(string) string, args []string) error {
	if len(args) < 1 {
		return errors.New("usage: soot-artifacts <read|create|export|remove> [flags]")
	}
	cmd := args[0]
	switch cmd {
	case "read", "create", "export", "remove":
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
	fs := flag.NewFlagSet("soot-artifacts "+cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var o options
	fs.Int64Var(&o.maxBytes, "max-bytes", hardMaxBytes, "max artifact bytes; may tighten the 16MiB ceiling, never loosen it")
	fs.Int64Var(&o.inlineMax, "inline-max", defaultInlineMax, "read returns data_b64 at or below this size")
	fs.StringVar(&o.stageDir, "stage", "", "operator-allowlisted staging directory enabling create file input")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if o.maxBytes <= 0 || o.maxBytes > hardMaxBytes {
		return errors.New("--max-bytes must be within 1..16MiB")
	}
	if o.inlineMax < 0 || o.inlineMax > hardMaxBytes {
		return errors.New("--inline-max must be within 0..16MiB")
	}
	if err := o.bindStore(getenv); err != nil {
		return err
	}
	if cmd == "export" {
		if err := o.bindExport(getenv); err != nil {
			return err
		}
	}
	if cmd == "remove" {
		_ = o.bindExport(getenv)
	}
	call, err := decodeCall(in)
	if err != nil {
		return err
	}
	switch cmd {
	case "read":
		return cmdRead(o, call, out)
	case "create":
		return cmdCreate(o, call, out)
	case "remove":
		return cmdRemove(o, call, out)
	default:
		return cmdExport(o, call, out, time.Now())
	}
}

// errUncertain wraps errors raised after a write may have reached the
// store — the runner exits 2 so the host journals the effect uncertain and
// keeps the resource fenced for inspection instead of a blind retry.
var errUncertain = errors.New("uncertain effect")

func main() {
	if err := run(os.Stdin, os.Stdout, os.Getenv, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, errUncertain) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}
