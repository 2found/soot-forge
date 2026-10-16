# Soot Forge

Discover, install and share things Soots can use.

Ask your coding agent:

```text
Read https://github.com/2found/soot-forge/blob/main/USAGE.md and its catalog.json. Help me find a pack for my task, explain its source and required capabilities, and install the pack I choose into my Soot workspace. Verify the installation without automatically granting tools.
```

Soot Forge is the community pack catalog for [Soot](https://trysoot.com).
Browse it at [trysoot.com/forge](https://trysoot.com/forge). This repository owns
the packs and source links; the page is implemented in the Soot website.

## Install a pack

Inside a Soot workspace, pass its GitHub folder link to Soot:

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/health
```

Soot records the fetched commit and content digest. For reproducible installs,
replace `main` with a reviewed full commit, or use a versioned release archive
with its SHA-256 from `SHA256SUMS`. `soot add` requires a Soot version supporting
GitHub tree links; earlier versions accept `2found/soot-forge/packs/health`.

Installing adds files to the workspace's pack library. It does not run dependency
scripts, start an adapter or grant a capability. Read the pack README, prepare
its executable if needed, then explicitly select `health/probe` in the Soot
definition and run `soot check --show`. Existing packs are never overwritten.
Recipes referencing another pack require you to install that pack separately.

## Share a pack

Open a pull request with one of these two forms:

| Form | Your PR contains | Source ownership |
| --- | --- | --- |
| Bundled | `packs/<id>/` and a `catalog.json` entry | Pack changes are reviewed here |
| External repository | A `catalog.json` entry with repository, folder and commit | Pack changes stay in your repository |

For example, **2build** keeps its pack in `2found/2build`; Forge links to a
reviewed commit. Consumers can install directly from that GitHub folder link.
See [Contributing](CONTRIBUTING.md) for exact entries, validation and release policy.

## Files, speech and video

| Pack | Work it supports | Optional host service |
| --- | --- | --- |
| [Office](packs/office/README.md) | Read/create/edit Word, Excel, PowerPoint; extract, merge, fill and render PDF | LibreOffice for conversion/layout rendering |
| [OCR](packs/ocr/README.md) | Native PDF text first; page/image recognition when needed | DeepSeek OCR / OCR 2 image-capable endpoint |
| [Image generation](packs/image-gen/README.md) | Local Qwen Image 2.1 Turbo Q4_K_M PNGs with file receipts | Host-owned stable-diffusion.cpp; Metal/CPU and pinned weights |
| [Text to speech](packs/tts/README.md) | Exact narration, authorized OmniVoice voices, measured PCM WAV | Resident OmniVoice model service |
| [Google Workspace](packs/google-workspace/README.md) | Docs, Sheets, Drive: read/edit, files, folders and exports | Scoped Google credentials |
| [Video editor](packs/video-editor/README.md) | Planning, cuts, still motion, audio mixing, timed captions and final-frame QA | FFmpeg; optional pinned HyperFrames/Chromium |

Client dependencies are small and separately prepared. Model weights, Python
environments, browser binaries and caches stay outside the distributed pack
tree. Installing a pack starts none of these services. Read the individual
README and select only the needed capabilities. A complete host example lives
in [examples/media-workspace](examples/media-workspace/README.md).

[examples/marketing-team](examples/marketing-team/README.md) is a whole team as
a Soot source: an editor, a radar, a writer and a browser poster that share a
data pool, run on two schedules and publish on their own, asking a person only
for what a person must do.

See [library choices and verification](docs/media-packs.md) for measured sizes,
actual Soot/provider evidence, limitations and reproducible test commands.

## Catalog and releases

`catalog.json` is the single authored list. External entries pin a full commit,
so a changed branch cannot silently change a reviewed pack. Release packaging
materializes the same pinned content and publishes one archive per catalog
entry, including linked packs, plus SHA-256 checksums and the projected catalog.
An archive does not change the upstream ownership of a linked pack.

Agents discover packs from `catalog.json`: `id`, `name`, `description`, `tags`
and `source` are machine-readable metadata. Each installed pack has its own
`pack.json` describing capabilities, skills and tools. Follow [USAGE.md](USAGE.md)
to turn a catalog entry into an installation command.

The General Soot installs default pack archives from a stable Forge release;
its 2build pack still resolves the latest stable 2build release from upstream.
Keep a Forge release containing `toolbox`, `soot`, `browser-use`, `soot-nest`,
`vibe_cf`, `office`, `ocr` and `image-gen` available before releasing that Soot
default. Source on `main` alone does not make those archives available to a fresh
Nest installation: the installer resolves the latest published stable release.
The selected browser capability also needs the host preparation in
[Browser use](packs/browser-use/README.md): Node.js 24+ and the standalone
`soot-browser` executable on the Soot host's PATH. Pack installation does not
install that executable or its browser dependencies.
Update `package.json` and both version fields in `package-lock.json` to the reviewed stable release version,
then push `main`. A single workflow validates catalog content and runner tests,
creates `v<version>` after those checks, builds the pack archives, and publishes
a complete release with catalog, docs, download instructions and checksums.
Unchanged versions still run checks and skip publication. `catalog.json.version`
is the schema version, not the release version. PRs use the same read-only gate;
no contributor tools run there. Resume an unpublished tag/draft via workflow
dispatch; published tags and assets are immutable.

```sh
node --test scripts/*.test.mjs
node scripts/validate.mjs                         # catalog + bundled content
node scripts/validate.mjs --soot /path/to/soot --remote  # all pinned content + official installer
node scripts/build.mjs 0.1.0                     # dist/, no publication
node scripts/test-packs.mjs                      # trusted source: all Go race + pack Node tests
# Full Python lane: prepare Office's hashed requirements outside packs_dir,
# install FFmpeg/FFprobe and a local Arial/DejaVu font, then:
node scripts/test-packs.mjs --python /absolute/office-runtime/bin/python --report /tmp/pack-tests.json
```

The repository builds independently. It needs Node 22+, Python 3 and Git;
Go 1.25+ builds the optional runners. It does not require a sibling checkout.
No contributor scripts run in catalog checks or packaging.

Runner tests execute pack code and belong to the trusted-source CI lane.
The Python option is explicit; omitted Python and opt-in service tests are not
passes. Real provider/service journeys remain separate from hermetic tests.
See [the catalog-wide review](docs/pack-review.md) for coverage, measured
performance changes and remaining integration prerequisites.

Soot is a 2found product. **Tiny agents. Better together.**

## Migrated community packs

The catalog also includes artifacts, casework, data-pool, email, live-chat, live-chat-sheets, nest-no-code, research, router-care, website and writing. Their source is maintained here. Go runners build from each pack’s `runner/` module; Node owner tools include their public wire codec. Host adapters, SDKs and reviewed application/test snapshots remain in Soot. See [SOURCE.md](SOURCE.md) for provenance.
