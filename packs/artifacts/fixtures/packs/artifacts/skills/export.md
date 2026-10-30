# Export Artifact (`artifacts_export`)

Use `artifacts_export` to copy an artifact from the store to an operator-bound export directory with an expiration TTL and expiry sidecar file.

## Input

Pass a JSON object with the artifact reference and optional TTL:

```json
{
  "ref": "art_0123456789abcdef0123456789abcdef",
  "ttlSec": 3600
}
```

- `ref` (required): Exact artifact identifier matching `^art_[0-9a-f]{32}$`.
- `ttlSec` (optional): Time-to-live in seconds (1 to 86400, default 3600).

## Output

Returns a JSON object with export identity, target path, and expiration timestamp:

```json
{
  "kind": "export",
  "exportId": "exp_0123456789abcdef0123456789abcdef",
  "path": "/var/artifacts/exports/exp_0123456789abcdef0123456789abcdef/report.pdf",
  "expiresAt": "2026-10-06T15:04:05Z",
  "artifact": {
    "ref": "art_0123456789abcdef0123456789abcdef",
    "mimeType": "application/pdf",
    "sha256": "...",
    "bytes": 1024,
    "name": "report.pdf"
  }
}
```

- The file is placed at `<export_dir>/exports/<exportId>/<sanitizedName>`.
- An `expiry.json` sidecar is created alongside the exported file (`{"expiresAt": "RFC3339"}`).
- Subsequent calls opportunistically sweep and delete expired export directories (bounded at 128 entries).
