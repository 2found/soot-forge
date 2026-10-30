# Cloudflare (`vibe_cf`)

Cloudflare mini-stack pack: R2 file sharing (public presigned URLs),
Workers deploys (public `workers.dev` web apps), D1 serverless SQLite, and
bounded DNS inside one bound zone.

## Skills và tools

Pack được chọn nguyên (`"packs": ["vibe_cf"]`); `"vibe_cf:read"` chỉ gồm các skill và tool đọc (`*_list`). Mỗi skill đi cùng nhóm tool của nó:

| Skill | Bạn được gì | Tools |
|---|---|---|
| `cloudflare_r2` | Share file → public URL có hạn | `r2_share`, `r2_upload`, `r2_unshare`, `r2_list` |
| `cloudflare_worker` | Deploy single-file Worker → `*.workers.dev` | `worker_deploy`, `worker_delete`, `worker_list` |
| `cloudflare_d1` | SQLite serverless | `d1_create`, `d1_exec`, `d1_list` |
| `cloudflare_dns` | Bản ghi trong zone đã bind | `dns_create`, `dns_delete`, `dns_list` |
| `cloudflare_shortlink` | Shortener trên workers.dev, không cần hostname | `shortlink_setup`, `shortlink_mint`, `shortlink_revoke`, `shortlink_list` |

## Credentials

Declared in `pack.json` `needs`: `CF_BINDING` (operator credential, entered per Soot in Nest or bound by a deployment `credentials` entry with `operations`) and optional `ARTIFACT_STORE`. `CF_BINDING` JSON:

```json
{
  "api_token": "cf_api_token",           // Workers/D1/DNS REST
  "account_id": "…",                     // required for all REST ops
  "zone_id": "…",                        // dns tools only
  "r2_access_key": "…",                  // R2 S3 creds (presign)
  "r2_secret_key": "…",
  "r2_bucket": "…",
  "workers_subdomain": "myaccount"       // for public URL in receipts
}
```

Model never sees the token — the host injects it.
`r2_share`/`r2_upload` additionally need `ARTIFACT_STORE` to resolve refs.

## Receipts & exit contract

Write ops return `{kind:"receipt", receipt:{actionId, state, remoteIds}}`.
`state` is `succeeded` / `failed` / `unknown`. Runner exit codes follow the
core contract: `1` refused/decided (safe to inspect-and-retry), `2` uncertain
(effect may have reached Cloudflare — check `*_list` before retrying).

## Prepare the source pack

The pack installs without running scripts or granting Cloudflare access. From
the installed pack folder, build the standalone Go executable:

```sh
(cd runner && go test -race ./... && go build -trimpath -o ../bin/vibe-cf .)
```

Then select `vibe_cf` in the Soot definition and supply its credentials.
`vibe_cf` remains unselected in General. Its runner decodes the public `soot/v1` JSON envelope directly and
needs no private runtime source. For the fixture, copy the built binary into
`fixtures/packs/vibe_cf/bin/vibe-cf` locally; binaries are never shared in Git.
