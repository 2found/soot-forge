# Human data-pool interface

The optional `configure` capability selects fixed `view` and `action` executables.
Presentation metadata uses `kind: data-pool`, `access: operator`. Both operations
require host-derived `interaction: true`, a namespace-manager identity and a
separate `DATA_POOL_UI` binding. Ordinary model operations ignore a human marker.
The shared gateway derives identity from its operation-scoped token.

Nest uses the existing conversation interface transport; it never connects to
Meilisearch or opens the policy database. Inputs and responses contain no backend
key, service token, state directory or host environment. No installation,
backend startup, implicit grant or model run occurs on opening the interface.

`view` input is `{ "kind": "overview|pools|query|activity|status", "input": {} }`:

- `overview`: empty input; namespace, opaque service identity, bound Soots,
  host managers and safe limits. A generic `{}` availability probe also works.
- `pools/query/status`: the existing corresponding agent operation input.
- `activity`: `{ "pool": "company", "limit": 20, "after": "sequence" }`.
  Newest first, at most 20 rows. `next` is an exclusive sequence cursor;
  `retention` and `oldest_sequence` describe the retained window. This probe
  does not log itself. Metadata absent from old state stays absent.

`action` input is `{ "kind": "write|manage", "input": {} }`, using the existing
write/manage fields. Human writes additionally require `generation` and
`expected_revision` (zero for a new document). Human management requires
`generation` and `expected_policy_revision`, except `pool_create`. These guards
are checked while holding the namespace policy lock through publication. The
saved request fingerprint covers the guards as well as the data. Always retain
the original request ID; reconcile using `view` / `status`, without replaying a
POST automatically.

A successful mutation returns its durable receipt. `pending` and `uncertain`
are not success. A validation/permission rejection returns
`{ "status": "error", "code": "rejected", "message": "..." }`; a stale revision
uses `code: conflict`. A known durable pending/uncertain receipt stays visible
after an error following submission. A transport failure provides no outcome:
keep the original request and check its receipt before any further mutation.

Pool details expose `policy_revision`, effective `grants`, `host_managers` and
`bound_soots`. Namespace administrators cannot be revoked through pool grants.

Admission: `storage.soots` is fixed at install, so a host Soot created later is
admitted at runtime. `action` kind `manage` with `{ "action": "admit", "soot":
"<id>", "level": "read|write", "host": "<@host client name>", "request_id": … }`
(host may be omitted when the service has one machine credential) or
`{ "action": "dismiss", "soot", "request_id" }`. Only a host manager may call
them; they need no generation or policy revision, take effect on the next
request without a restart, and tie the Soot to that one machine credential.
`overview` lists `admitted_soots` (id → level) beside `bound_soots`, which now
includes them. A config-bound Soot cannot be dismissed. A machine credential
calling for a Soot it may not act as gets 400 `invalid_input` saying the Soot is
not admitted, so the model reports a `data_pool` blocker instead of guessing.
Document metadata includes optional `{ "writer": { "kind": "human|soot",
"soot": "bound-identity" } }`. Activity contains actor, timestamp, status,
document ID/revision references and permission targets; no query text, content
or credentials. It records access, not downstream content usage. Pool deletion
removes its activity; the durable deletion receipt survives for host managers.
