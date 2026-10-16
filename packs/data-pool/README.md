# Shared company data for Soot

Give this prompt to a coding agent working in your Soot checkout:

```text
Read packs/data-pool/README.md and set up the optional data-pool Pack
in my Nest. Use a private binding file for credentials; never print its values.
Connect to the existing shared data-pool service using a per-Soot binding.
Do not install, start or provision Meilisearch; show the operator its local Docker
and VM installation guides if infrastructure is missing.
Create a company pool, import the company documentation I provide once,
and grant my marketing, support and writing Soots read access. Verify they
reuse the saved data, a reader cannot write, and revoking a grant blocks access.
Do not publish, deploy, overwrite existing configuration, or grant host shell.
```

This Pack stores company documents once so multiple Soots can use the same
handbook, product information, support policy and brand material. Documents have
stable IDs, source URIs, tags, hashes and revisions. Meilisearch provides indexed
search that tolerates typos and missing Vietnamese accents. Pool grants belong
to the plugin and are checked before every operation.

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

Direct mode, where the Soot host itself talks to Meilisearch, needs the built
runner. You need Go 1.25+ to build the connector and a Soot workspace. The operator
installs and runs the search infrastructure separately: see the [Meilisearch
Docker and VM guide](docs/meilisearch.md). Meilisearch Community Edition
v1.54.3 is the tested backend. The Pack never installs or starts Meilisearch,
provisions a VM, or installs a service as a consequence of selecting capabilities.
Meilisearch's [release](https://github.com/meilisearch/meilisearch/releases/tag/v1.54.3)
has CE binaries and checksums. Use the CE binary, not the separately licensed
enterprise binary. Local HTTP is accepted only on loopback; remote backends
require HTTPS. Ingestion/search in this version uses no embedding service.

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

Installation grants no capability and starts no backend. `use: []` is
intentional. Once this source is published, Git folder installation uses
`soot add 2found/soot-forge/packs/data-pool --ref <reviewed-commit>`.
That channel does not include a built binary: build explicitly in the installed
`packs.d/data-pool/runner` before selecting capabilities. No installer executes
dependency scripts. The runner builds independently without a sibling checkout.

## Connect local and VM Soots to one shared pool

Recommended: operate one platform Meilisearch on a VM and run the optional
[data-pool service](docs/shared-service.md) beside it. This service
owns the policy database, document metadata, grants and mutation receipts.
Each Soot connects with its own host-bound credential:

```json
{
  "service_url": "https://company-data.example.com",
  "service_token": "<private token bound to this Soot and its operations>"
}
```

There is no local `state_dir`, Meilisearch key or separate grant database in this
mode. A local Soot and a VM Soot use the same service URL. Distinct Soot identities
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
Meilisearch, see [container.md](docs/container.md) and the `private_network`
opt-in in [shared-service.md](docs/shared-service.md#private-network-containers).

**Per-Soot bindings (direct attach).** Without `data_pool`, use separate
environment bindings, for example `MANAGER_DATA_POOL`,
`MARKETING_DATA_POOL` and `SUPPORT_DATA_POOL`, then map each Soot's `DATA_POOL`
credential to its own variable and selected operations. Never bind a manager's
token to a reader. The service validates token, Soot identity, operation scope
and pool grant independently. Selecting a Pack capability still grants no pool.
Remote bindings cannot be mixed with the direct-backend fields below.

## Direct backend on one host (optional)

This alternative keeps policy state on one host. It works with either local
or remote Meilisearch, but it does **not** share policy with a second machine.
Do not point two independent policy directories at the same namespace/backend;
use the shared service above for local + VM access.

## Bind credentials and select capabilities

Prepare a private JSON file outside Git, mode 0600, with this shape. Values below
are placeholders, not working credentials:

```json
{
  "endpoint": "http://127.0.0.1:7700",
  "api_key": "<private Meilisearch credential>",
  "namespace": "company",
  "state_dir": "/private/absolute/path/company-data-policy",
  "soots": ["data-manager", "marketing", "support", "blog-writer"],
  "managers": ["data-manager"]
}
```

In direct mode, use one shared namespace/state directory on the same host. Different
customers or deployments require separate namespaces and policy directories.
The state file is bound to its original namespace/backend; pointing it at a
different backend is rejected. This plugin identifies Soots, not individual
users of a shared Soot. Host filesystem/shell access is not an OS sandbox.

Load the private file into an environment variable **without echoing it** before
starting the runtime:

```sh
export COMPANY_DATA_POOL="$(cat /private/absolute/path/data-pool-binding.json)"
```

Soot definition selections (or Nest's existing capability settings):

| Soot | Explicit `use` selectors |
| --- | --- |
| data-manager | `data-pool/read`, `data-pool/write`, `data-pool/manage`; optionally `data-pool/configure` for Nest |
| marketing, support, blog-writer | `data-pool/read` |
| optional curator | `data-pool/read`, `data-pool/write` |

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
deployment credentials; do not replace them. Choose an API key with only the
backend actions needed for this dedicated namespace: documents/search/tasks and
index creation/removal. Key management is never exposed as a model tool. Keep
the backend private; its access credential is held by the host, not the model.

```sh
soot check --show --secrets
soot serve --watch
```

Existing runtimes need the new environment binding when started. Check/reload
does not inherit environment changes made in a different terminal. Use an
existing configured model; provider setup remains Soot's normal Settings/login
flow, independent of the data backend.

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

Tools available to selected capabilities:

| Capability | Tool / input | Result |
| --- | --- | --- |
| read | `data-pool_pools`: optional pool; otherwise after/limit | Granted pools or detail; managers also see effective grants |
| read | `data-pool_query`: action=list, pool, after/limit | Paginated metadata |
| read | `data-pool_query`: action=search, pool, query, offset/limit | Indexed matches, bounded snippets (768 bytes around the query's rarest words; the opening when that is where they are) and source/revision metadata |
| read | `data-pool_query`: action=read, pool, id, offset/limit | Verified original text page with next_offset and complete |
| read | `data-pool_query`: action=read, pool, ids (up to 8), limit | One verified first page per document, sharing 48 KiB; `missing` lists IDs not in the collection |
| read | `data-pool_status`: request_id, optional owner | Reconcile a saved mutation; inspecting another owner requires pool manage |
| write | `data-pool_write`: action=append, pool, title, content OR url, source/tags, request_id (omit id) | New independent entry; duplicate content accepted, same-intent retry idempotent |
| write | `data-pool_write`: action=upsert, pool, id, title, content OR url, source/tags, request_id | Import/update receipt |
| write | `data-pool_write`: action=remove, pool, id, request_id | Removal receipt |
| manage | `data-pool_manage`: action=pool_create, pool, name, request_id | Create an empty private pool |
| manage | `data-pool_manage`: action=grant/revoke, pool, soot or group (`@workspace` = every bound Soot, read/write only), level (grant only), request_id | Explicit access change |
| manage | `data-pool_manage`: action=pool_remove, pool, request_id | Delete a pool and its documents |

Permissions: read < write < manage. Only host managers create pools; a delegated
pool manager can manage that pool and grant only host-bound Soot identities.
Changing a pool grant does not modify host capabilities, credentials or shell
rights. Readers receive no metadata, snippets, counts or task results from
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
There are at most 256 pools and 10,000 documents per pool. Direct-mode operations serialize through a private state lock. Shared-service
queries and independent document writes run concurrently; same-document writes
and policy changes retain consistency boundaries. See [concurrent ingestion](docs/concurrency.md).
Shared mode holds that state only in the central service; client hosts need no
policy filesystem or Meilisearch credential.
Use bounded pages rather than asking a Soot to copy a whole pool into context.

## Pending, uncertain and failed writes

Use a stable `request_id` for each intended mutation and preserve both it and
the input when checking a duplicate. Reusing an ID with different input fails.

- `succeeded`: the backend task completed and local document metadata committed.
- `pending`: accepted by the backend; inspect `data-pool_status` with the saved ID.
- `uncertain`: submission response was lost or malformed. The saved intent fences
  the document/pool; status can prove an imported revision or completed deletion.
  It never resubmits the original mutation.
- `failed`: an observed backend rejection or failed task. Correct the cause
  before explicitly submitting a new intended request.

A revoked writer cannot read its request after revocation. A pool manager can
inspect it with owner set to that writer, even after the operator removes the
writer from the host binding. A document being updated is hidden
if the backend revision/hash disagrees with committed metadata. A timeout is
never proof that no effect happened; don't change request_id to bypass a fence.
If an uncertain effect cannot be proven, the operator must inspect the private
backend and receipt before deciding recovery. Do not delete policy state to
clear an unresolved effect. Soot's write/Stop/resource receipts still apply.

## Backup, upgrade and remove

Quiesce Soot work and stop the owned runtime (direct mode) or the data-pool
service (shared mode) before copying plugin state. Back
up the entire private `state_dir` together with a consistent Meilisearch
snapshot/dump using the [official snapshot reference](https://specs.meilisearch.dev/specifications/text/0258-snapshots-api.html).
Do not copy a live policy database or restore only its grants while retaining
a different document/index revision. Keep unresolved receipts in backups.
Credential files remain host-owned and need a separate private backup.

For a Pack upgrade, quiesce work, back up state, remove selections in Nest's
existing settings/Soot definition, stop the runtime, preserve the old Pack,
and install the reviewed replacement with `soot add`. That command rejects
duplicate IDs and never overwrites a Pack in place. Build its executable,
validate with check, then reselect explicitly. This version's state layout is
v1; future versions must document any migration. Backend upgrades follow
Meilisearch's version-specific migration guidance, not this Pack's installer.

To disable, deselect the capabilities in Nest settings or definitions. To
uninstall, stop work/runtime, remove the now-unselected Pack directory and its
credential bindings. Data remains stored; deleting data requires an explicit
pool/document removal. There is currently no CLI Pack-uninstall verb, and this
plugin does not add one. Do not delete an unknown namespace or an unresolved
receipt merely because the plugin is disabled.

## Verification and development

```sh
(cd runner && go test -race ./... && go vet ./...)
```

The opt-in real-backend tests accept a preverified CE executable and run
disposable local state, including backend/runner restarts:

```sh
cd runner
DATA_POOL_TEST_MEILI=/absolute/path/meilisearch DATA_POOL_TEST_PUBLIC_WEB=1 go test -race -v ./...
```

The real CLI journey builds/installs an archive into an isolated workspace and
uses a scripted local OpenAI-compatible provider with the actual Soot runtime
and executable tools. Pass verified binary paths; it does not install binaries:

```sh
python3 qa/cli_journey.py --shared --soot /absolute/path/soot \
  --runner /absolute/path/soot-data-pool --meili /absolute/path/meilisearch
```

Its finalizer stops exact owned processes, joins provider threads and removes
temporary state. Unit fault tests cover lost responses, duplicate/fenced writes,
backend rejection/task failure, authorization, input boundaries and integrity.
The `--shared` journey runs two independent Soot hosts against one service,
including central/backend restart and revocation on both hosts. Omit it to check
the original single-host direct mode. This verifies the CLI/shared backend path; no new native Nest screen, deployment,
public release or model quality evaluation is claimed.

## Human management in Nest

Nest's **Data** area is independent of Chat and Settings. Installing this Pack
does not make its management interface available. Explicitly select
`data-pool/configure` for a conversational Soot that is a namespace manager in
the host binding. The interface requires the runtime's operator credential;
fixed-user and trusted-backend conversation keys cannot use it. Opening Data
creates a setup conversation without starting a model run.

Bind a separate `DATA_POOL_UI` credential to **only** `data-pool_view` and
`data-pool_action`. In shared mode the operator generates a separate token with
`--configurator data-manager` in the [service helper](docs/shared-service.md).
The ordinary agent token retains its original scopes. Never distribute the UI
binding to a reader or put it in client JavaScript. Direct mode uses the same
authoritative backend/state binding with separate host operation scopes.

```json
{
  "credentials": {
    "data-manager": {
      "DATA_POOL_UI": {
        "env": "MANAGER_DATA_POOL_UI",
        "operations": ["data-pool_view", "data-pool_action"]
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
