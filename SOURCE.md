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

The artifacts/casework/email/writing runners include the public soot/v1 wire contract from that revision in their own modules. Casework includes its standalone record storage/domain with the public event type. Node owner tools carry a JS export of the SDK wire codec and its contract tests; there is no private npm or sibling dependency. In-repo host consumer snapshots are explicit reviewed exports, not another canonical catalog.

The generated pack schema was refreshed from the exported Soot SDK at the migration revision to include current interface access metadata.
