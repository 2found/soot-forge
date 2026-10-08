# Cloudflare Workers (`worker_deploy`, `worker_list`, `worker_delete`)

Deploy a single-file ES-module Worker and get a public `workers.dev` URL —
the quickest way to publish a small web app or endpoint.

## When to use

- "Host this little page/API publicly" → `worker_deploy`.
- Check what's deployed → `worker_list`. Remove an app → `worker_delete`.

## Operations

- `worker_deploy {name, script}` — `name` is the workers.dev subdomain label
  (`[a-z0-9][a-z0-9-]{0,61}[a-z0-9]` — starts/ends alphanumeric). `script` is the ES-module source; it must export a
  `fetch` handler:

  ```js
  export default { async fetch() { return new Response("hello") } }
  ```

  Returns `receipt.remoteIds.url` (`https://<name>.<subdomain>.workers.dev`)
  when the binding carries `workers_subdomain` AND the subdomain-enable call
  succeeds — otherwise `url` is empty and the script is deployed but not
  publicly routed; call `worker_list` and re-deploy if you need the URL. Deploy is idempotent:
  same name overwrites.
- `worker_delete {name}` — removes the script and its route.
- `worker_list {}` — returns deployed worker names.

## Rules

- One file only — no bundler, no npm deps, no bindings (KV/env vars) in MVP.
- The URL is public immediately after deploy; treat `script` as public.
- Keep handlers stateless; persist via `d1_exec` endpoints if needed (the
  worker would need its own fetch-back wiring — out of scope for this pack).
- Runner exit 1 = decided refusal, exit 2 = deploy may already have
  reached Cloudflare — call `worker_list` before redeploying.
