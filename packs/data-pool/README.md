# Shared company data for Soot

Give this prompt to a coding agent working in your Soot checkout:

```text
Read packs/data-pool/README.md and set up the optional data-pool Pack
in my Nest. Use a private binding file for credentials; never print its values.
Connect to the existing shared data-pool service using a per-Soot binding.
Do not install, start or provision PostgreSQL; point the operator to the local
Docker and container guides if infrastructure is missing.
Create a company pool, import the company documentation I provide once,
and grant my marketing, support and writing Soots read access. Verify they
reuse the saved data, a reader cannot write, and revoking a grant blocks access.
Do not publish, deploy, overwrite existing configuration, or grant host shell.
```

This Pack stores company documents once so multiple Soots can use the same
handbook, product information, support policy and brand material. Documents have
stable IDs, source URIs, tags, hashes and revisions. PostgreSQL 16+ provides
indexed search through `pg_trgm` GIN indexes over normalized titles and content,
tolerating typos and missing Vietnamese accents. Pool grants belong to the
plugin and are checked before every operation.

## Organize a workspace

Collections contain documents and optional subcollections; groups/Soots receive
access independently of the tree. Conversations/runs retain provenance references.
See [collections and permissions](docs/collections.md) for inheritance, private
boundaries, host-bound groups and default destinations. Existing pool IDs remain
valid. Upgrade the Pack and Nest Data UI together to expose organization controls.

## Install the connector

Connecting to a data-pool service needs no build. Every tool runs through
`soot tool-forward`, which sends a service binding's calls to the service over
HTTPS. That is also the only form that fits a packaged runtime image (soot, sh
and timeout only), such as a Soot on a 2server VM. Install the Pack as it is
and skip to [the shared pool](#connect-local-and-vm-soots-to-one-shared-pool).
The runtime must include `soot tool-forward`.

Direct mode, where the Soot host itself connects to PostgreSQL, needs the built
runner. You need Go 1.25+ to build the connector and a Soot workspace. The
operator runs PostgreSQL 16+ separately and supplies a DSN; the service or
direct connector creates the trusted `pg_trgm` extension and the `data_pool`
schema (including its tables and search indexes) on start. The Pack never
installs or starts PostgreSQL, provisions a VM, or installs a service as a
consequence of selecting the pack. Use a dedicated database and role: the
role needs `CREATE` on the database (`pg_trgm` is a trusted extension), and one
database holds one namespace. Service bindings require HTTPS or loopback HTTP;
direct DSNs may use TLS anywhere, or cleartext only to loopback, a literal
private address, or a container name under `private_network`.
Ingestion/search in this version uses no embedding service.

From this repository, build and package the standalone Pack:

```sh
(cd packs/data-pool/runner && go build -o ../bin/soot-data-pool .)
tar -C packs -czf /tmp/data-pool.tar.gz data-pool
```

Inside your Nest/workspace:

```sh
soot add /tmp/data-pool.tar.gz
soot check --show
```

Installation grants nothing and starts no service: no Soot selects the pack until you choose it. Once this source is published, Git folder installation uses
`soot add 2found/soot-forge/packs/data-pool --ref <reviewed-commit>`.
That channel does not include a built binary: build explicitly in the installed
`packs/data-pool/runner` before selecting the pack. No installer executes
dependency scripts. The runner builds independently without a sibling checkout.

## Connect local and VM Soots to one shared pool

Recommended: operate one PostgreSQL 16+ database on a VM and run the optional
[data-pool service](docs/shared-service.md) beside it. This service owns every
pool, grant, document, receipt, activity entry and admission in that database;
there is no separate search server or policy store. Each Soot connects with its
own host-bound credential:

```json
{
  "service_url": "https://company-data.example.com",
  "service_token": "<private token bound to this Soot and its operations>"
}
```

There is no local state directory, search server or separate grant database in
this mode. A local Soot and a VM Soot use the same service URL. Distinct Soot identities
get distinct tokens and explicit grants to the same pool. If the operator
intentionally reuses one identity on both machines, each may have a separate token
for that identity; they share permissions and request-ID history.

**Ambient binding (multi-Soot Nest).** When the deployment declares a
`data_pool` block, every Soot in the Nest gets `data-pool_*` tools through one
host credential per machine — pass `--host mac=data-manager,marketing-local`
(repeat per machine) to `configure-service.py` and point that machine's
`data_pool.binding` at its own `bindings/host-mac.json`. Each envelope names
its Soot; the service accepts only Soots in that host's `soots` allowlist and
derives operations from the claimed Soot's bound role (managers and pool
managers manage, writers write, others read), with pool grants applied on top.
A host credential never reaches the human `view`/`action` surface. It is still
a credential for **every** identity in its allowlist: any process that can read
the binding file can act as each listed Soot, including a listed manager. So
list only the Soots that machine runs, keep the file private to the Soot
runtime, and never list a public or untrusted Soot. See [the data-pool
resource](docs/shared-service.md#ambient-data_pool-resource).

To run the service as a container behind an HTTPS proxy next to a private
PostgreSQL, see [container.md](docs/container.md) and the `private_network`
opt-in in [shared-service.md](docs/shared-service.md#private-network-containers).

**Per-Soot bindings (direct attach).** Without `data_pool`, use separate
environment bindings, for example `MANAGER_DATA_POOL`,
`MARKETING_DATA_POOL` and `SUPPORT_DATA_POOL`, then map each Soot's `DATA_POOL`
credential to its own variable and selected operations. Never bind a manager's
token to a reader. The service validates token, Soot identity, operation scope
and pool grant independently. Selecting the Pack still grants no pool.
Remote bindings cannot be mixed with the direct database fields below.

## Direct database binding on one host (optional)

This alternative keeps all state in one PostgreSQL database reached directly by
the Soot host. It does **not** share state with a second machine unless both
hosts use the same database and namespace. Do not point two independently
managed namespaces at one database; use the shared service above for local + VM
access.

## Bind credentials and select the pack

Prepare a private JSON file outside Git, mode 0600, with this shape. Values below
are placeholders, not working credentials:

```json
{
  "database_url": "postgres://soot:change-me@127.0.0.1:5432/soot?sslmode=disable",
  "namespace": "company",
  "soots": ["data-manager", "marketing", "support", "blog-writer"],
  "managers": ["data-manager"],
  "writers": ["data-manager"],
  "pool_managers": [],
  "groups": {"creative": ["marketing", "blog-writer"]},
  "defaults": {"blog-writer": "drafts"}
}
```

`database_url` replaces the former `endpoint`, `api_key` and `state_dir`; those
fields are rejected. In direct mode, use one database and namespace per
workspace. Different customers or deployments require separate databases. The
database records its namespace on first use and refuses a binding with another
namespace. This plugin identifies Soots, not individual users of a shared Soot.
Host filesystem/shell access is not an OS sandbox.

An installation still backed by Meilisearch or a local state directory is not
readable by this version: there is no automatic import, because the old service
never stored a portable export. Keep the old containers stopped until you have
read the documents you need through `query`, then write them into a fresh
PostgreSQL-backed namespace and grant access again. Pools, grants, receipts and
activity history start empty by design; `request_id`s from the old service are
not replayable.

Load the private file into an environment variable **without echoing it** before
starting the runtime:

```sh
export COMPANY_DATA_POOL="$(cat /private/absolute/path/data-pool-binding.json)"
```

Soot definition selections (or Nest's pack settings). The pack has the read, write and manage skills and tools in one; `:read` keeps the skills and only the read tools:

| Soot | `packs` |
| --- | --- |
| data-manager | `data-pool`; add `data-pool-console` for Nest's Data area |
| marketing, support, blog-writer | `data-pool:read` |
| optional curator | `data-pool` (its pool grant stays at write) |

Declare the curator in the binding if you use one. Pack selection exposes tools;
pool access still requires a grant. Neither a reader nor a curator can grant
itself management rights. Host-bound managers are explicitly delegated
administrators; pool revoke cannot remove them from the host binding.

Bind `DATA_POOL` separately for each Soot and only its selected operations in
the deployment's `credentials`. Direct-mode manager example (in shared mode use a separate environment variable per Soot):

```json
{
  "credentials": {
    "data-manager": {
      "DATA_POOL": {
        "env": "COMPANY_DATA_POOL",
        "operations": ["data-pool_pools", "data-pool_query", "data-pool_status", "data-pool_write", "data-pool_manage"]
      }
    },
    "marketing": {
      "DATA_POOL": {
        "env": "COMPANY_DATA_POOL",
        "operations": ["data-pool_pools", "data-pool_query", "data-pool_status"]
      }
    }
  }
}
```

Repeat the reader binding for support and blog-writer. Merge with existing
deployment credentials; do not replace them. Give the database role only the
access this workspace needs: `CREATE` on its database (for the schema and
`pg_trgm` on first start) plus normal table access. Keep PostgreSQL private and
its DSN host-owned, never in model input or tool output.

```sh
soot check --show --secrets
soot serve --watch
```

Existing runtimes need the new environment binding when started. Check/reload
does not inherit environment changes made in a different terminal. Use an
existing configured model; provider setup remains Soot's normal Settings/login
flow, independent of the data store.

## Use through CLI or Nest

Select **data-manager** in Nest chat, or use these prompts through the CLI:

```sh
soot run --soot data-manager "Create company pool acme and grant marketing, support and blog-writer read access."
soot run --soot data-manager "Import https://example.com into acme as document company-overview, keeping its source."
soot run --soot marketing "Search pool acme for company information and cite document sources and revisions."
soot run --soot data-manager "Show the current grants for acme, then revoke marketing's access."
```

For real company data supply your own selected URL or Markdown/plain text.
Public URLs are imported on request and saved as snapshots. Questions search
the saved pool; they do not recrawl the website. Ask the curator to refresh the
same document ID when the source changes. Identical content/metadata keeps its
revision. Stable IDs let all Soots read the same document; answers cite it by
title and source link, and show IDs or revisions only when asked.

Tools of the pack (`:read` keeps the read rows):

| Mode | Tool / input | Result |
| --- | --- | --- |
| read | `data-pool_pools`: optional pool; otherwise after/limit | Granted pools or detail; managers also see effective grants |
| read | `data-pool_query`: action=list, pool, after/limit | Paginated metadata |
| read | `data-pool_query`: action=search, pool, query, offset/limit | pg_trgm-ranked matches, bounded snippets (768 bytes around the query's rarest words; the opening when that is where they are) and source/revision metadata |
| read | `data-pool_query`: action=read, pool, id, offset/limit | Verified original text page with next_offset and complete |
| read | `data-pool_query`: action=read, pool, ids (up to 8), limit | One verified first page per document, sharing 48 KiB; `missing` lists IDs not in the collection |
| read | `data-pool_status`: request_id, optional owner | Inspect a saved mutation receipt; inspecting another owner requires pool manage |
| write | `data-pool_write`: action=append, pool, title, content OR url, source/tags, request_id (omit id) | New independent entry; duplicate content accepted, same-intent retry idempotent |
| write | `data-pool_write`: action=upsert, pool, id, title, content OR url, source/tags, request_id | Import/update receipt |
| write | `data-pool_write`: action=remove, pool, id, request_id | Removal receipt |
| manage | `data-pool_manage`: action=pool_create, pool, name, request_id | Create an empty private pool |
| manage | `data-pool_manage`: action=grant/revoke, pool, soot or group (`@workspace` = every bound Soot, read/write only), level (grant only), request_id | Explicit access change |
| manage | `data-pool_manage`: action=pool_remove, pool, request_id | Delete a pool and its documents |

Permissions: read < write < manage. Only host managers create pools; a delegated
pool manager can manage that pool and grant only host-bound Soot identities.
Changing a pool grant does not modify host packs, credentials or shell
rights. Readers receive no metadata, snippets, counts or receipt results from
unauthorized pools. A successful revoke is serialized with reads and blocks
subsequent calls. Each pool has a unique generation; reusing a deleted pool ID
grants no access to its retained historical receipts. Host administrators retain
namespace audit access.

Inline Markdown/plain text is limited to 12 KiB UTF-8. The host also limits
serialized tool JSON to 16 KiB; escape-heavy text may need smaller sections
or a public URL import. Public webpage responses
are limited to 2 MiB, extracted text to 128 KiB. Scripts, navigation, forms,
`<template>`/`<noscript>` and elements hidden from readers (`hidden`,
`aria-hidden="true"`, inline `display:none`/`visibility:hidden`) are excluded;
extracted data is reference material, not trusted instructions. SSRF guards
validate addresses at each dial/redirect and do not inherit an HTTP proxy; a
redirect from HTTPS to HTTP is refused. No arbitrary server-path import is accepted. Larger
documents can be supplied as separate named sections; OCR/PDF/SaaS sync are not
part of this connector.

Lists/search return at most 20 items; search offsets stop at 980. Reads return
4096 bytes by default, at most 8192, and next_offset preserves UTF-8 boundaries. A read of up to 8 `ids` returns each
document's first page within 48 KiB in total, so a digest of a day's documents is one list and one read. A limit too small to fit the next
character returns an error; use at least 4 bytes for any UTF-8 character.
There are at most 256 pools and 10,000 documents per pool. In direct mode each
connector call opens a database connection pool; shared-mode queries and
independent document writes run concurrently. Same-document writes, identical
request IDs and policy changes retain consistency boundaries. See
[concurrent ingestion](docs/concurrency.md).
Shared mode holds all state only in the central PostgreSQL database; client
hosts need no policy filesystem, search credential or database role.
Use bounded pages rather than asking a Soot to copy a whole pool into context.

## Synchronous writes and stable receipts

Use a stable `request_id` for each intended mutation and preserve both it and
the input when checking a duplicate. Reusing an ID with different input fails.
Writes are synchronous and transactional: the document change, receipt and
activity entry commit together. There are only two outcomes: a `succeeded`
receipt, or an error after rollback. No asynchronous task exists, so `pending`
and `uncertain` no longer occur.

- `succeeded`: the transaction committed. The same `request_id` and exact input
  replay the stored receipt (`replay: true`) without another change.
- An error means the transaction rolled back. Correct the cause and submit a new
  intended request; a rejected attempt is not a committed effect.

A revoked writer cannot read its request after revocation. A pool manager can
inspect it with owner set to that writer, even after the operator removes the
writer from the host binding. A document whose hash disagrees with committed
metadata is reported rather than served. Keep the original request ID when
checking any error whose outcome is unknown; do not invent a new ID to bypass
deduplication. Soot's write/Stop/resource receipts still apply.

## Backup, upgrade and remove

All state is in PostgreSQL schema `data_pool`; there is no local state directory
to copy. Back up the database with `pg_dump` (custom or plain format) against a
consistent snapshot or while writes are quiesced:

```sh
pg_dump --format=custom --no-owner --file=/private/backup/company-data.dump \
  'postgres://soot:password@db.example.com/soot?sslmode=require'
pg_restore --clean --if-exists --no-owner --dbname='postgres://soot:password@db.example.com/soot?sslmode=require' \
  /private/backup/company-data.dump
```

Restore grants and documents together; never restore only one table or merge a
dump into a database bound to another namespace. Keep receipts so replay stays
idempotent. Credential files and the private DSN remain host-owned and need a
separate private backup. For a managed service, use its snapshot facility with
the same all-or-nothing rule.

For a Pack upgrade, quiesce work, back up state, remove the selection in Nest's
settings/Soot definition, stop the runtime, preserve the old Pack,
and install the reviewed replacement with `soot add`. That command rejects
duplicate IDs and never overwrites a Pack in place. Build its executable,
validate with check, then select the pack again. The service creates or upgrades
its schema (`schema_version` 1) on start under an advisory lock; future versions
must document any migration. PostgreSQL major-version upgrades follow
PostgreSQL's `pg_upgrade`/dump-and-restore guidance, not this Pack's installer.

To disable, deselect the pack in Nest settings or definitions. To
uninstall, stop work/runtime, remove the now-unselected Pack directory and its
credential bindings. Data remains stored; deleting data requires an explicit
pool/document removal or dropping the dedicated database. There is currently no
CLI Pack-uninstall verb, and this plugin does not add one. Do not delete an
unknown namespace or a committed receipt merely because the plugin is disabled.

## Verification and development

```sh
(cd runner && go test -race ./... && go vet ./...)
```

The opt-in real-database tests need a **disposable** PostgreSQL 16+ database:
each test drops and recreates schema `data_pool`, then exercises service and
runner restarts against the same database.

```sh
cd runner
DATA_POOL_TEST_DATABASE_URL='postgres://soot:password@127.0.0.1:5432/soot_test?sslmode=disable' \
  DATA_POOL_TEST_PUBLIC_WEB=1 go test -race -v ./...
```

Never point that variable at a database holding real pools. Without it the Go
lane skips; `scripts/test-packs.mjs` reports the same `DATA_POOL_TEST_DATABASE_URL`
opt-in.

The real CLI journey builds/installs an archive into an isolated workspace and
uses a scripted local OpenAI-compatible provider with the actual Soot runtime
and executable tools. Pass verified binary paths and a **fresh, disposable**
PostgreSQL DSN through the environment; the journey does not start PostgreSQL
and does not drop an existing schema. The script lives in the Soot Forge
checkout; release archives omit `qa/`:

```sh
export DATA_POOL_TEST_DATABASE_URL='postgres://soot:password@127.0.0.1:5432/soot_qa?sslmode=disable'
python3 qa/cli_journey.py --shared --soot /absolute/path/soot \
  --runner /absolute/path/soot-data-pool
```

Its finalizer stops exact owned processes, joins provider threads and removes
temporary state. Unit fault tests cover lost responses, duplicate/fenced writes,
database rejection/transaction rollback, authorization, input boundaries and
integrity. The `--shared` journey runs two independent Soot hosts against one
service, including service/database restart and revocation on both hosts. Omit
it to check the original single-host direct mode. This verifies the CLI/shared
service path; no new native Nest screen, deployment, public release or model
quality evaluation is claimed.

## Human management in Nest

Nest's **Data** area is independent of Chat and Settings. Installing this Pack
does not make its management interface available. Explicitly select the
[`data-pool-console`](../data-pool-console/README.md) pack for a conversational Soot that is a namespace manager in
the host binding. The interface requires the runtime's operator credential;
fixed-user and trusted-backend conversation keys cannot use it. Opening Data
creates a setup conversation without starting a model run.

Bind a separate `DATA_POOL_UI` credential to **only** `data-pool-console_view` and
`data-pool-console_action`. In shared mode the operator generates a separate token with
`--configurator data-manager` in the [service helper](docs/shared-service.md).
The ordinary agent token retains its original scopes. Never distribute the UI
binding to a reader or put it in client JavaScript. Direct mode uses the same
authoritative database binding with separate host operation scopes.

```json
{
  "credentials": {
    "data-manager": {
      "DATA_POOL_UI": {
        "env": "MANAGER_DATA_POOL_UI",
        "operations": ["data-pool-console_view", "data-pool-console_action"]
      }
    }
  }
}
```

Documents record their latest writer as a Soot or a human using the bound
configurator identity. Old documents have no recorded writer. Human mutations
require the current pool generation and document or policy revision. Conflicts
preserve the draft. Agent tools also accept optional `generation`,
`expected_revision` (write) and `expected_policy_revision` (manage) guards.
Replays return the original receipt with `replay: true` before checking newer
revisions. See the [interface contract](docs/nest-interface.md).

Activity retains the newest 1,000 events per pool, served in bounded pages.
It records observed list/read/search access, document changes and grants/revokes
with host-derived actor and revision references. It contains neither search text
nor document content, and cannot prove a later answer used the data. Activity
probes do not log themselves. Removing a pool removes its documents, grants and
activity; its removal receipt remains available to host managers. Recreating
the same ID starts a different generation. No historical full-content versions
are stored.
