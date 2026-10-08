# Soot Forge

Discover, install and share things Soots can use.

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

## Catalog and releases

`catalog.json` is the single authored list. External entries pin a full commit,
so a changed branch cannot silently change a reviewed pack. Release packaging
materializes the same pinned content and publishes one archive per catalog
entry, including linked packs, plus SHA-256 checksums and the projected catalog.
An archive does not change the upstream ownership of a linked pack.

The General Soot installs default pack archives from a stable Forge release;
its 2build pack still resolves the latest stable 2build release from upstream.
Keep a Forge release containing `toolbox`, `soot`, `browser-use`, `soot-nest`
and `vibe_cf` available before releasing that Soot default. Publication is a
separate step: a local checkout or an unpublished tag is not a release.

```sh
node --test scripts/*.test.mjs
node scripts/validate.mjs                         # catalog + bundled content
node scripts/validate.mjs --soot /path/to/soot --remote  # all pinned content + official installer
node scripts/build.mjs 0.1.0                     # dist/, no publication
(cd packs/health/runner && go test -race ./...)
(cd packs/vibe_cf/runner && go test -race ./...)
```

The repository builds independently. It needs Node 22+, Python 3 and Git;
Go 1.25+ builds the optional runners. It does not require a sibling checkout.
No contributor scripts run in catalog checks or packaging.

Soot is a 2found product. **Tiny agents. Better together.**
