# Soot Forge

Packs for Soot: the skills and tools a Soot can use, in a public catalog that
grows by pull request.

[Soot](https://trysoot.com) gives recurring work — answering visitors,
watching sources, writing, following up — to a small team of Soots that runs on
schedule and asks you only when a person is needed. Each Soot uses only the
tools you grant it. A pack is how those skills and tools reach it.

This repository holds the packs and the catalog. Browse them at
[trysoot.com/forge](https://trysoot.com/forge); that page is part of the Soot
website and is built from this repository's [`catalog.json`](catalog.json),
which lists every pack with its source, tags and description.

## Find and install a pack

Ask your coding agent:

```text
Read https://github.com/2found/soot-forge/blob/main/USAGE.md and its catalog.json. Help me find a pack for my task, explain its source and needs, and install the pack I choose into my Soot workspace. Verify the installation without automatically granting tools.
```

Or, inside a Soot workspace, pass the pack's GitHub folder link to Soot:

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/health
```

Soot records the fetched commit and content digest. For reproducible installs,
replace `main` with a reviewed full commit, or use a versioned release archive
with its SHA-256 from `SHA256SUMS`. `soot add` requires a Soot version supporting
GitHub tree links; earlier versions accept `2found/soot-forge/packs/health`.

**Installing grants nothing.** It adds files to the workspace's pack library;
it does not run dependency scripts, start an adapter or grant a credential.
Read the pack README, prepare its executable if needed, then explicitly select
the pack (for example `"packs": ["health"]`, or `health:read` for its read
tools only) in the Soot definition and run `soot check --show`. Existing packs
are never overwritten. Install each pack a Soot selects.

## See whole teams

- [**The marketing team that runs 2found**](examples/marketing-team/README.md)
  — an editor, a radar, a writer and a browser poster that share a data pool,
  run on two schedules and publish on their own, asking a person only for what
  a person must do. It is a copy of 2found's own marketing team, with 2found's
  services swapped for Forge packs.
- [**Media workspace**](examples/media-workspace/README.md) — Soot definitions
  and host configuration for the files, speech and video packs below, kept
  outside the distributable packs.

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
README and select only the needed packs. See
[library choices and verification](docs/media-packs.md) for measured sizes,
actual Soot/provider evidence, limitations and reproducible test commands.

Every other pack is listed in [`catalog.json`](catalog.json) and on
[trysoot.com/forge](https://trysoot.com/forge). Many came from Soot and are
now maintained here; [SOURCE.md](SOURCE.md) records each one's provenance. Go
runners build from each pack's `runner/` module; Node owner tools include their
public wire codec. Host adapters, SDKs and reviewed application/test snapshots
remain in Soot.

## Share a pack

Open a pull request with one of these two forms:

| Form | Your PR contains | Source ownership |
| --- | --- | --- |
| Bundled | `packs/<id>/` and a `catalog.json` entry | Pack changes are reviewed here |
| External repository | A `catalog.json` entry with repository, folder and commit | Pack changes stay in your repository |

For example, **2build** keeps its pack in `2found/2build`; Forge links to a
reviewed commit. Consumers can install directly from that GitHub folder link.
See [Contributing](CONTRIBUTING.md) for exact entries, validation and review.
Once merged, a pack installs from `main` right away; the Forge page shows it
after the Soot website refreshes its catalog snapshot.

## Catalog and releases

`catalog.json` is the single authored list. External entries pin a full commit,
so a changed branch cannot silently change a reviewed pack. Agents discover
packs from it: `id`, `name`, `description`, `tags` and `source` are
machine-readable metadata. Each installed pack has its own `pack.json`
describing skills, tools and needs. Follow [USAGE.md](USAGE.md) to turn
a catalog entry into an installation command.

A release materializes the same pinned content as one archive per catalog
entry, including linked packs, plus SHA-256 checksums and the projected
catalog. An archive does not change the upstream ownership of a linked pack.
Releases are cut by raising the version in `package.json` and
`package-lock.json` and pushing `main`; once that version is released, a push
that leaves it alone runs the checks and publishes nothing.
`catalog.json.version` is the schema version, not the release version.
[RELEASE.md](RELEASE.md) is the maintainer checklist and
[Contributing](CONTRIBUTING.md#automated-releases) the release policy.

The General Soot installs default pack archives from a stable Forge release;
its 2build pack still resolves the latest stable 2build release from upstream.
Keep a Forge release containing `toolbox`, `soot`, `browser-use`, `soot-nest`,
`nest-lead`, `vibe_cf`, `office`, `ocr` and `image-gen` available before releasing that Soot
default. Source on `main` alone does not make those archives available to a
fresh Nest installation: the installer resolves the latest published stable
release. The browser pack also needs the host preparation in
[Browser use](packs/browser-use/README.md): Node.js 24+ and the standalone
`soot-browser` executable on the Soot host's PATH. Pack installation does not
install that executable or its browser dependencies.

## Develop and test

```sh
node --test scripts/*.test.mjs
node scripts/validate.mjs                         # catalog + bundled content
node scripts/validate.mjs --soot /path/to/soot --remote  # all pinned content + official installer
node scripts/build.mjs 0.1.0                     # dist/, no publication
node scripts/test-packs.mjs                      # trusted source: all Go race + pack Node tests
# Full Python lane: prepare Office's hashed requirements outside the packs dir,
# install FFmpeg/FFprobe and a local Arial/DejaVu font, then:
node scripts/test-packs.mjs --python /absolute/office-runtime/bin/python --report /tmp/pack-tests.json
```

The repository builds independently. It needs Node 22+, Python 3 and Git;
Go 1.25+ builds the optional runners. It does not require a sibling checkout.
No contributor scripts run in catalog checks or packaging; PRs use the same
read-only gate.

Runner tests execute pack code and belong to the trusted-source CI lane.
The Python option is explicit; omitted Python and opt-in service tests are not
passes. Real provider/service journeys remain separate from hermetic tests.
See [the catalog-wide review](docs/pack-review.md) for coverage, measured
performance changes and remaining integration prerequisites.

Soot and Soot Forge are 2found products. **Tiny agents. Better together.**
