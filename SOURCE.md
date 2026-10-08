# Initial pack export

Initial bundled content was exported from 2found/2agent at `3fcfafa2eb6011f6ce1f71500fc25456d803e512`.
`health`, `server-care` and `vibe_cf` move here; the runtime no longer owns their source.
`toolbox`, `soot`, `browser-use` and `soot-nest` are committed-source exports.
The runtime retains its existing copies for internal tooling and pending local edits; General creation consumes Forge releases. Updates to either copy are explicit, never automatic.
The exported generated pack schema uses the same revision.

Forge maintains its own discovery guidance in `soot/skills/domain` and
`soot/skills/configure` after this
export; it points Soots to the public catalog and keeps installation separate
from capability grants.
