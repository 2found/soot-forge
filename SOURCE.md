# Initial pack export

Initial bundled content was exported from 2found/2agent at `3fcfafa2eb6011f6ce1f71500fc25456d803e512`.
`health`, `server-care` and `vibe_cf` move here; the runtime no longer owns their source.
`toolbox`, `soot`, `browser-use` and `soot-nest` are committed-source exports.
At the initial export the runtime retained copies for internal tooling; the remaining contrib migration below retires those copies after moving host consumers to explicit snapshots. General creation consumes Forge releases; updates are explicit, never automatic.
The exported generated pack schema uses the same revision.

Forge maintains its own discovery guidance in `soot/skills/domain` and
`soot/skills/configure` after this
export; it points Soots to the public catalog and keeps installation separate
from capability grants.

## Remaining contrib packs

`f0edc4439521eeeb4972bad032bd8b702952431e` is the source revision for artifacts, casework, data-pool, email, live-chat, live-chat-sheets, nest-no-code, research, website and writing. Only tracked pack files were exported; ignored binaries, data, local bindings and fixtures were not read or copied. All fourteen tracked pack trees are removed from Soot contrib after consumer migration. Existing Forge toolbox/soot/browser-use/soot-nest sources remain canonical.

The artifacts/casework/email/writing runners include the public soot/v1 wire contract from that revision in their own modules. Casework includes its standalone record storage/domain with the public event type. Node owner tools carry a JS export of the SDK wire codec and its contract tests; there is no private npm or sibling dependency. The former Soot contrib host consumers are removed; Soot retains only internal compatibility test fixtures.

The generated pack schema was refreshed from the exported Soot SDK at the migration revision to include current interface access metadata.

## Router care

`router-care` was exported from `2found/2agent` at `5e5d79ceec019a3d1e68dd9eabe2a63024300c73`,
from `contrib/9router/pack/`. Forge owns the reusable skill and manifest.
The skill’s operator-policy reference points to the historical consuming integration
at the export revision. The example Docker worker, deployment, installer and
historical evidence have since been removed from current Soot contrib. A current
consumer must supply its own worker and host deployment policy.

The current Router care rewrite separates `release-care` guidance from the
explicitly selected `status` capability. The typed read tool carries the public
soot/v1 codec exported from Forge’s Live chat Sheets SDK snapshot, accepts only
empty input and reads only the host-approved status-file binding. The retired consumer used `caretaker_status`; new definitions select the pack’s
`router-care_status` tool. No privileged worker, host state or schedule moves into Forge.

## Contrib cleanup

Soot no longer bundles `contrib/9router`, `contrib/adapters`,
`contrib/conversation` or `contrib/integrations`. The Browser use adapter and
Live chat Sheets pack client remain here. The former standalone Live chat gateway
and 9router deployment worker are not Forge pack implementations; hosts supply
those independently. Public runtime/SDK contracts remain in Soot.
