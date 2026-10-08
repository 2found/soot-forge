# Read Artifact (`artifacts_read`)

Use `artifacts_read` to retrieve metadata and content for an immutable artifact reference previously produced by Soot or another authorized pack.

## Input

Pass a JSON object with the required `ref`:

```json
{"ref": "art_0123456789abcdef0123456789abcdef"}
```

- `ref`: Exact artifact identifier matching `^art_[0-9a-f]{32}$`. Arbitrary paths, relative traversals, or scope modifiers are rejected.

## Output

Returns a JSON object containing the artifact descriptor and either inline data or a host path:

```json
{
  "kind": "artifact",
  "artifact": {
    "ref": "art_0123456789abcdef0123456789abcdef",
    "mimeType": "image/png",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "bytes": 12345,
    "name": "example.png"
  },
  "data_b64": "..."
}
```

- When bytes are at or below the inline threshold (default 256 KiB), `data_b64` is returned.
- When bytes exceed the inline threshold, `path` is returned containing the verified object path on the host filesystem.
- The SHA-256 digest is re-verified before returning. Tampered or corrupted artifacts fail with an error.
