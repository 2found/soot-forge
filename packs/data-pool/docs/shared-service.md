# Share one data pool between local and VM Soots

One VM hosts the authoritative data-pool service and a PostgreSQL 16+ database.
All pools, grants, documents, receipts, activity and admissions live in that
database; the service does not run a search server. Local and VM Soot hosts
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
  "database_url": "postgres://soot:password@db.example.com/company?sslmode=require",
  "namespace": "company",
  "soots": ["data-manager", "marketing-local", "marketing-vm", "support"],
  "managers": ["data-manager"],
  "writers": [],
  "pool_managers": [],
  "groups": {},
  "defaults": {}
}
```

Use PostgreSQL 16+ and a dedicated database for one workspace. On start the
service creates the trusted `pg_trgm` extension, schema `data_pool`, its tables,
GIN trigram indexes and the schema version; the database role needs `CREATE` on
the database. The database records the namespace on first use and refuses a
different one, so do not share one database between companies. Direct
`postgres://`/`postgresql://` DSNs are accepted with TLS (`sslmode=require`,
`verify-ca` or `verify-full`) anywhere. Without TLS, the host must be loopback
or a literal private address, except that a container hostname is allowed under
the explicit [`private_network`](#private-network-containers) opt-in. The
namespace and database identity are durable: back up and restore them together.
Use one service process per namespace; two hosts writing separate schemas into
one database are not a supported topology.

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
to its respective host. Keep `service.json` and the private DSN on the VM. The
service stores SHA-256 token hashes; tokens are randomly generated, per Soot.

`--configurator` must name a namespace manager. It additionally creates
`bindings/data-manager.ui.json` with a distinct token scoped to `view/action`
only. Load that file into `MANAGER_DATA_POOL_UI` on the operator's Soot host and
bind `DATA_POOL_UI` to those two operations. Explicitly select
the `data-pool-console` pack. The service requires the human interface marker as well
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

## Ambient `data_pool` resource

A Nest where *every* Soot needs pool tools can attach them ambiently instead of
writing one credential per Soot. Issue one **host credential per machine**,
each listing exactly the Soots that machine runs (additive: per-Soot bindings
are still emitted):

```sh
python3 packs/data-pool/operator/configure-service.py \
  --backend-config /private/backend.json \
  --service-url https://company-data.example.com \
  --host mac=data-manager,marketing-local \
  --host vm=marketing-vm,support \
  --output-dir /private/company-data
```

This writes `bindings/host-mac.json` and `bindings/host-vm.json`, and service
client entries `{"soot":"@host","name":"mac","soots":[…],"token_sha256":…}`.
Copy each file only to its own machine and declare there:

```json
"data_pool": {
  "binding": {"file": "/private/company-data/bindings/host-mac.json"},
  "access": "write"
}
```

`access` is `read` (the default: every Soot gets `data-pool:read`) or `write` (the whole `data-pool` pack). What a host credential
can and cannot do:

- Each envelope names a Soot. A claim outside **that host's** `soots` allowlist
  is denied (403), so the VM's credential cannot act as a Soot listed only on the
  Mac, and vice versa. The service refuses to start if an `@host` entry has no
  `name` or an empty `soots` list.
- Operations follow the claimed identity's bound role: namespace managers and
  `pool_managers` get write+manage, `writers` get write, everyone else
  pools/query/status. Pool grants still apply on top.
- It never derives `view`/`action` and rejects any envelope marked
  `interaction: true`; human configuration needs the separate `--configurator`
  UI token.
- **It is a credential for every identity in its allowlist.** Any process that
  can read the binding file can act as each listed Soot, including a namespace
  manager if one is listed. Keep the file mode 0600 for the Soot runtime's
  account only, list only Soots that machine actually runs, and never put a
  public or untrusted Soot (for example a public chat Soot) in a host allowlist;
  give such a Soot no data-pool credential, or its own per-Soot read binding.
- Revoke one machine by deleting its client entry and restarting; the other
  host keeps working. Distinct hosts may list the same Soot when a Soot
  intentionally runs on both; they then share its permissions and request IDs.

Host and Soot names are validated, and every output file is planned before
writing: a Soot whose ID would collide with a host binding (for example a Soot
named `host-mac` beside `--host mac=…`) is an error, and output is rendered into
a temporary sibling directory then renamed, so a failed run leaves nothing.

A single `pool_create` can seed the audience instead of a follow-up grant:
`scope:"workspace"` grants every bound Soot, `scope:"group"` plus
`subject:"<group>"` grants that bound group, at `level` `read` (the default) or
`write`; `manage` is rejected for a scope. `scope:"own"` (the default) grants
only the creator manage. The scope is written as an ordinary grant, so it shows
in the pool detail's `grants` (`"@workspace": "read"`) or `group_grants`, and
`grant`/`revoke` adjust it. The workspace subject is spelled as a group:

```json
{"action":"revoke","pool":"handbook","group":"@workspace","request_id":"close-handbook"}
```

A workspace grant is likewise limited to `read` or `write`.

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

Cleartext listening outside loopback is rejected unless `private_network` is
set (see below). Certificates/keys must be
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

Create that account and give it access to the private config and database
credential. Use paths appropriate to your host. This is an installation guide;
no Soot tool creates accounts, starts systemd, provisions a VM, installs
PostgreSQL or executes a deployment.
`GET /healthz` reports process liveness only and never touches PostgreSQL.
`GET /readyz` additionally pings the database (2-second bound, result reused for
one second), and returns a generic `{"status":"ready"}` or a 503. `soot-data-pool
healthcheck [URL]` probes `/healthz` (default `http://127.0.0.1:8091/healthz`,
3-second timeout, exit 0/1) for images without curl. Each `/v1/tool` request
writes one JSON line to stderr — time, claimed Soot, client kind (`soot`,
`host:NAME` or `ui`), operation, HTTP status and duration — and never tokens,
bodies, queries, document IDs or content. On SIGTERM the service drains for up
to 20 seconds and closes its database within 5 more, so a 30-second stop grace
(`TimeoutStopSec=30`, compose `stop_grace_period: 30s`) is enough.
Verify end-to-end through Soot next.

## Private network (containers)

For a container on a private Docker network behind a TLS-terminating proxy
(Caddy, for example), set `"private_network": true` at the top level of the
service config, or pass `--private-network` to `configure-service.py`. Without
it, behaviour is unchanged. With it:

- `listen` may be any IP address in cleartext, for example `0.0.0.0:8091`.
  Only the proxy may reach that port: publish it to nothing or to loopback, and
  give Soot hosts only the proxy's HTTPS URL. Tokens cross the private network
  unencrypted between proxy and container.
- `database_url` may name a container host, for example
  `postgres://soot:password@data-pool-postgres:5432/soot?sslmode=disable`.
  Without TLS the hostname is accepted only with this flag; a literal public IP
  is still rejected at startup. URL-import SSRF guards remain independent: they
  resolve every outbound host and refuse non-public addresses. Prefer a
  `sslmode=require` DSN whenever the network is not fully trusted.

Direct-mode bindings (`DATA_POOL` in a Soot host) do not set this flag. See
[container.md](container.md) for the image and a complete deployment.

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

Select `data-pool:read` in the `marketing-local` definition or Nest settings.
On the VM use the `marketing-vm` binding and definition. For `data-manager`,
select `data-pool` and bind its own token to the additional write/manage
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
revocations. A per-Soot token binds exact identity and allowed operations and
cannot impersonate another Soot; a host token can act as each Soot in its own
allowlist and no other. Pool grants remain an additional independent check.
This is Soot identity isolation, not per-user isolation within a shared Soot.

## State, recovery and rotation

Back up the PostgreSQL database with `pg_dump` while the service is stopped or
writes are quiesced. The dump contains pools, grants, documents, receipts,
activity, references and admissions in schema `data_pool`; there is no separate
search index to snapshot. Back up private config and the DSN separately. Do not
restore only grants or only documents. Request-ID receipts are written in the
same transaction as their effect and survive restart; a lost response is not
proof of failure, so inspect `data-pool_status` using the original request ID
instead of retrying with a new one. HTTP transport never automatically retries
writes.

To rotate/remove a service token, update `clients` in the private service config
and restart, then update the owning host's binding. A per-Soot client entry
contains `soot`, `token_sha256` and allowed `operations`
(pools/query/status/write/manage, or separate human view/action scopes). A host
client entry contains `"soot":"@host"`, a unique `name`, its `soots` allowlist
and `token_sha256`, and no `operations`. Multiple distinct tokens may
deliberately bind one Soot identity. Deselecting the pack or removing a pool grant is
separate from invalidating its service token.

To move a direct-mode workspace to the central service, dump the source database
and restore it into the destination database, then point every client at the
service with the same namespace. Never run direct mode beside the service
against the same namespace. If the database identity or namespace must change,
that is a separate migration; do not edit the `data_pool.meta` namespace row to
bypass the namespace check.
