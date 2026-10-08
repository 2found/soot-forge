# Remove Artifact (`artifacts_remove`)

Retract a stored artifact and/or a shared export. The store is the operator-bound
`ARTIFACT_STORE`; shared local URLs live under `ARTIFACT_EXPORT`. This does not
call Cloudflare — R2 shares are `vibe_cf/r2_unshare`.

## Input

At least one of `ref` or `exportId`:

```json
{"ref": "art_0123456789abcdef0123456789abcdef"}
{"exportId": "exp_0123456789abcdef0123456789abcdef"}
{"ref": "art_…", "exportId": "exp_…"}
```

- `ref`: delete `meta/<ref>.json`. The content-addressed object is removed only
  when no remaining meta points at the same SHA-256. Exports whose
  `expiry.json` recorded this `ref` are deleted too (needs `ARTIFACT_EXPORT`).
- `exportId`: delete `<export>/exports/<exportId>/` immediately. Requires
  `ARTIFACT_EXPORT`.

Unknown ids fail; they are not treated as success.

## Output

```json
{
  "kind": "removed",
  "removed": ["exp_…", "art_…"],
  "artifact": "art_…",
  "exportId": "exp_…"
}
```
