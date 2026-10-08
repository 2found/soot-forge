# Shortlinks (`shortlink_setup`, `shortlink_mint`, `shortlink_revoke`, `shortlink_list`)

A per-name URL shortener living entirely in the bound Cloudflare account:
one Worker on `workers.dev` + one D1 database `<worker>-links`. **No custom
hostname required** — the service is reachable at
`https://<worker>.<workers_subdomain>.workers.dev/<code>`.

## Flow

1. `shortlink_setup {worker}` — idempotent provisioning: creates the
   `<worker>-links` D1 database + `links` table and deploys the redirect
   worker with `env.LINKS` bound. Run once per service name.
2. `shortlink_mint {worker, url}` or `{worker, ref}` — mint a link.
   `code` optional (auto-generates an 8-char-safe alphabet code otherwise);
   `ttlSec` optional (link expires after N seconds). With `ref`, the
   artifact is shared into R2 first (24h presign default) and the shortlink
   points at that URL.
3. `shortlink_revoke {worker, code}` — 404s the code.
4. `shortlink_list {worker}` — newest 100 `{code, url, expires_at}` rows.

## Rules

- Short URLs are public by definition; minted `url` targets must be https.
- Expired links answer `410`; unknown codes `404`.
- Reusing a taken `code` fails — omit `code` to auto-generate.
- `setup`/`mint` are write ops: on runner exit 2 (uncertain), call
  `shortlink_list` to inspect before retrying.
