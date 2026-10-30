# Create Artifact (`artifacts_create`)

Use `artifacts_create` to store new content into the content-addressed artifact store and receive an immutable `art_<32hex>` reference.

## Input

Pass a JSON object with `mimeType` and content:

```json
{
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "data_b64": "JVBERi0xLjQK..."
}
```

- `mimeType` (required): Must belong to the allowlist (`text/*`, `application/json`, `application/pdf`, `application/octet-stream`, `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `audio/mpeg`, `audio/wav`, `audio/mp4`, `video/mp4`, `video/webm`). Content is sniffed from raw bytes; mismatched or faked MIME types are rejected.
- `name` (optional): Basename only (e.g. `report.pdf`). Slashes, backslashes, control characters, and traversal paths (`..`) are stripped or rejected.
- `data_b64` (optional): Base64-encoded file content (up to 16 MiB).
- `file` (optional): Relative filename within an operator-configured staging directory. Only available when the operator configures `--stage`.

Exactly one of `data_b64` or `file` must be provided. Do not provide both.

## Output

Returns a JSON object with the created artifact metadata:

```json
{
  "kind": "artifact",
  "artifact": {
    "ref": "art_0123456789abcdef0123456789abcdef",
    "mimeType": "application/pdf",
    "sha256": "...",
    "bytes": 1024,
    "name": "report.pdf"
  }
}
```

The returned `ref` can be passed to downstream tools (e.g., email attachments, writing export, or customer chat media references).
