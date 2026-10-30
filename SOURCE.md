# Initial pack export

Initial bundled content was exported from 2found/2agent at `3fcfafa2eb6011f6ce1f71500fc25456d803e512`.
`health`, `server-care` and `vibe_cf` move here; the runtime no longer owns their source.
`toolbox`, `soot`, `browser-use` and `soot-nest` are committed-source exports.
At the initial export the runtime retained copies for internal tooling; the remaining contrib migration below retires those copies after moving host consumers to explicit snapshots. General creation consumes Forge releases; updates are explicit, never automatic.
The exported generated pack schema uses the same revision.

Forge maintains its own discovery guidance in `soot/skills/domain` and
`soot/skills/configure` after this
export; it points Soots to the public catalog and keeps installation separate
from grants.

## Remaining contrib packs

`f0edc4439521eeeb4972bad032bd8b702952431e` is the source revision for artifacts, casework, data-pool, email, live-chat, live-chat-sheets, website-chat, research, website and writing. Only tracked pack files were exported; ignored binaries, data, local bindings and fixtures were not read or copied. All fourteen tracked pack trees are removed from Soot contrib after consumer migration. Existing Forge toolbox/soot/browser-use/soot-nest sources remain canonical.

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
explicitly selected `router-care` pack. The typed read tool carries the public
soot/v1 codec exported from Forge’s Live chat Sheets SDK snapshot, accepts only
empty input and reads only the host-approved status-file binding. Definitions select the pack’s
`router-care_status` tool. No privileged worker, host state or schedule moves into Forge.

## Contrib cleanup

Soot no longer bundles `contrib/9router`, `contrib/adapters`,
`contrib/conversation` or `contrib/integrations`. The Browser use adapter and
Live chat Sheets pack client remain here. The former standalone Live chat gateway
and 9router deployment worker are not Forge pack implementations; hosts supply
those independently. Public runtime/SDK contracts remain in Soot.

## Office and media packs

`office`, `ocr`, `tts`, `google-workspace`, `video-editor` and `image-gen` are original standalone
Forge implementations against the public `soot/v1` tool envelope. They contain
no private Soot runtime imports or sibling checkout dependencies. Their copied
support module is maintained in `scripts/support/runner_common.py`, with
`scripts/sync-media-support.py --check` enforcing identical distributed copies.

The video guidance draws on the local `lohi-tiktok-planner` and
`lohi-tiktok-content-creator` workflows: source fidelity, continuity, measured
speech, production handoff and actual decoded-frame review. It was rewritten
for general use. Personal voice references, Lohi assets, deployment settings
and private integration code were not exported.

Upstream HyperFrames, OmniVoice and DeepSeek OCR remain external dependencies,
not vendored skill or model source. Pins, source links and verification scope
are recorded in [docs/media-packs.md](docs/media-packs.md). Host examples and
test evidence are outside pack roots; release archives contain no credentials,
virtualenvs, node_modules, model weights or generated media.

The unreleased `google-doc` identity was subsequently renamed to
`google-workspace`, with original Sheets/Drive tools using the same standalone
REST/auth/receipt foundation. Historical verification records retain original
IDs and hashes; the new catalog, manifests and consumer examples use Workspace.

`image-gen` uses externally prepared stable-diffusion.cpp and the explicitly
selected Abiray conversion of Qwen Image 2.1 Turbo (`Q4_K_M`). The original
checkpoint, quantized diffusion, Qwen encoder and VAE provenance are pinned in
`packs/image-gen/model.json`. No upstream model or native inference source is
vendored. Qwen's Research License applies to these model weights; Forge's code
license does not replace it. See [verification](docs/office-ocr-image-gen.md).
