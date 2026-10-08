# Cloudflare (`vibe_cf`)

Cloudflare mini-stack pack: R2 file sharing (public presigned URLs),
Workers deploys (public `workers.dev` web apps), D1 serverless SQLite, and
bounded DNS inside one bound zone.

## Capabilities

| `use` | Bạn được gì | Ops |
|---|---|---|
| `vibe_cf/r2` | Share file → public URL có hạn | `r2_share`, `r2_upload`, `r2_unshare`, `r2_list` |
| `vibe_cf/worker` | Deploy single-file Worker → `*.workers.dev` | `worker_deploy`, `worker_delete`, `worker_list` |
| `vibe_cf/d1` | SQLite serverless | `d1_create`, `d1_exec`, `d1_list` |
| `vibe_cf/dns` | Bản ghi trong zone đã bind | `dns_create`, `dns_delete`, `dns_list` |
| `vibe_cf/shortlink` | Shortener trên workers.dev, không cần hostname | `shortlink_setup`, `shortlink_mint`, `shortlink_revoke`, `shortlink_list` |

## Binding (host-side credential)

`CF_BINDING` JSON, supplied via `secret_env` per operation:

```json
{
  "api_token": "cf_api_token",           // Workers/D1/DNS REST
  "account_id": "…",                     // required for all REST ops
  "zone_id": "…",                        // dns capability only
  "r2_access_key": "…",                  // R2 S3 creds (presign)
  "r2_secret_key": "…",
  "r2_bucket": "…",
  "workers_subdomain": "myaccount"       // for public URL in receipts
}
```

Model never sees the token — the host injects it per granted operation.
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

Then select only the needed `vibe_cf/<capability>` in the Soot definition and
bind host credentials to those operations. `vibe_cf` remains unselected in
General. Its runner decodes the public `soot/v1` JSON envelope directly and
needs no private runtime source. For the fixture, copy the built binary into
`fixtures/packs.d/vibe_cf/bin/vibe-cf` locally; binaries are never shared in Git.
