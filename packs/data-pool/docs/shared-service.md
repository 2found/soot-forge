# Share one data pool between local and VM Soots

One VM hosts the authoritative data-pool service and policy database. It uses an
existing platform Meilisearch; it never installs one. Local and VM Soot hosts
install the optional Pack and receive only their own service bindings. They
share documents, grants, revisions, receipts and revocations through the API.

## Operator setup

Build the standalone executable (Go 1.25+) on the target architecture:

```sh
cd packs/data-pool/runner
go build -o /private/bin/soot-data-pool .
```

Prepare a mode-0600 `/private/backend.json` outside Git:

```json
{
  "endpoint": "https://search.example.com",
  "api_key": "<private Meilisearch key restricted to Soot indexes>",
  "namespace": "company",
  "state_dir": "/var/lib/company-data-pool",
  "soots": ["data-manager", "marketing-local", "marketing-vm", "support"],
  "managers": ["data-manager"]
}
```

If the separately installed backend is on this same host, the endpoint may be
`http://127.0.0.1:7700`. Other backend addresses require HTTPS. The namespace and
backend address are durable identities; do not change them on existing state.
The service must own its state directory. One service process opens a given
policy database; a second process with the same directory fails closed.

Render configuration and client tokens without printing them or making network
calls. `--output-dir` must not exist; it is created with mode 0700, files 0600:

```sh
python3 packs/data-pool/operator/configure-service.py \
  --backend-config /private/backend.json \
  --service-url https://company-data.example.com \
  --configurator data-manager \
  --output-dir /private/company-data
```

Managers get read/write/manage operation scopes; others get read/status only.
Supply `--writer curator` for a bound curator to receive write operation scope.
For a delegated pool manager, use `--pool-manager SOOT_ID` to issue manage
operation scope without making it a namespace administrator; it still needs
an explicit manage grant to its pool. These scopes do not grant pool access. Move each `bindings/SOOT_ID.json` securely
to its respective host. Keep `service.json` and the backend key on the VM. The
service stores SHA-256 token hashes; tokens are randomly generated, per Soot.

`--configurator` must name a namespace manager. It additionally creates
`bindings/data-manager.ui.json` with a distinct token scoped to `view/action`
only. Load that file into `MANAGER_DATA_POOL_UI` on the operator's Soot host and
bind `DATA_POOL_UI` to those two operations. Explicitly select
`data-pool/configure`. The service requires the human interface marker as well
as the token scope and manager identity. Adding the marker to ordinary agent
operations does not grant human access or change their recorded actor. Keep
this UI token separate from the agent token; never send it to Nest's webview.
Nest calls the runtime interface API, which resolves the host credential.

Start the service yourself, with the private config path:

```sh
/private/bin/soot-data-pool serve --config /private/company-data/service.json
```

By default it listens at `127.0.0.1:8091`; an operator-managed HTTPS reverse proxy
on the same host forwards `/v1/tool` to that address. Set its upstream timeout
above 20 seconds, disable caching and automatic POST retries, and exclude
Authorization headers/request bodies from logs. It must be reachable from the
local and VM Soot hosts using the same HTTPS service URL. For a quick local test,
render with `--service-url http://127.0.0.1:8091`.

Alternatively use the executable's own TLS listener, with operator-managed
certificate renewal:

```sh
python3 packs/data-pool/operator/configure-service.py \
  --backend-config /private/backend.json \
  --service-url https://company-data.example.com:8091 \
  --listen 0.0.0.0:8091 \
  --tls-cert /private/tls/fullchain.pem --tls-key /private/tls/privkey.pem \
  --output-dir /private/company-data-tls
```

Cleartext listening outside loopback is rejected. Certificates/keys must be
readable only as required by the service account. Restart after certificate or
client configuration changes. For continuous operation use your normal process
manager, for example this operator-authored systemd unit:

```ini
[Unit]
Description=Company data pool
After=network-online.target
Wants=network-online.target

[Service]
User=company-data
Group=company-data
ExecStart=/private/bin/soot-data-pool serve --config /private/company-data/service.json
Restart=on-failure
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Create that account and give it access to the private config and state directory.
Use paths appropriate to your host. This is an installation guide; no Soot tool
creates accounts, starts systemd, provisions a VM or executes a deployment.
`GET /healthz` reports service liveness only. Verify end-to-end through Soot next.

## Connect each Soot host

Follow [Pack installation](../README.md#install-the-connector).
On each host, load only the binding issued to that Soot, without echoing it:

```sh
export MARKETING_DATA_POOL="$(cat /private/marketing-local.json)"
```

In that Soot host's deployment, merge this credential binding:

```json
{
  "credentials": {
    "marketing-local": {
      "DATA_POOL": {
        "env": "MARKETING_DATA_POOL",
        "operations": ["data-pool_pools", "data-pool_query", "data-pool_status"]
      }
    }
  }
}
```

Select `data-pool/read` in the `marketing-local` definition or Nest settings.
On the VM use the `marketing-vm` binding and definition. For `data-manager`,
select read/write/manage and bind its own token to the additional write/manage
operations. Keep credentials scoped even if both Soots run in one Nest.

```sh
soot check --show --secrets
soot serve --watch
soot run --soot data-manager "Create company pool acme; grant marketing-local and marketing-vm read access."
soot run --soot data-manager "Import the company handbook I provide into acme once."
```

From either marketing host:

```sh
soot run --soot marketing-local "Search acme for company policy and cite source and revision."
```

Use `marketing-vm` on its host. A revoked grant blocks subsequent reads on both
hosts when they use the same identity. Distinct identities require distinct
revocations. Tokens bind exact identity and allowed operations; a token cannot
impersonate another Soot. Pool grants remain an additional independent check.
This is Soot identity isolation, not per-user isolation within a shared Soot.

## State, recovery and rotation

Back up the central policy directory and a consistent Meilisearch snapshot
while the service is stopped and all Soot writes are quiesced. Back up private
config separately. Do not restore only an index or only grants. Mutation
request IDs and uncertain-effect fences survive restart; timeouts are not proof
of failure. Inspect `data-pool_status` using the original request ID, never
blindly retry with a new ID. HTTP transport never automatically retries writes.

To rotate/remove a service token, update `clients` in the private service config
and restart, then update the owning host's binding. A client entry contains
`soot`, `token_sha256` and allowed `operations` (pools/query/status/write/manage, or separate human view/action scopes).
Multiple distinct tokens may deliberately bind one Soot identity. Removing
capabilities or a pool grant is separate from invalidating its service token.

To move an existing direct-mode pool, stop all direct-mode callers, copy the
entire policy directory to the central service host and retain the exact
namespace and canonical backend endpoint. Point every client at the service;
never run direct mode beside it against the same namespace. If the backend
endpoint identity must change too, that is a separate migration, currently not
automated; do not edit the policy database to bypass its identity check.
