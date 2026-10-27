# Releasing Soot Forge

Two kinds of change reach users from `main`. Pick the profile before you push.

| Change | Profile |
| --- | --- |
| README, docs or examples, with the `package.json` version unchanged | [Docs-only push](#docs-only-push) |
| A new pack archive release for Soot installers (`version` in `package.json` and `package-lock.json` raised) | [Package release](#package-release) |

`catalog.json.version` is the catalog schema version, not the release version;
changing it alone publishes nothing. A catalog entry or pack source change with
the version unchanged also publishes nothing and follows the docs-only steps,
plus the pack checks in [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs-only push

Nothing is published. GitHub serves the new files at once, and `soot add` links
to `main` resolve to the new commit. Release archives stay as they are,
including the docs archive (`soot-forge-docs_<version>.tar.gz`, which bundles
`README.md`, `USAGE.md` and `AGENTS.md`): it keeps the old text until the next
package release.

1. **Check that the current version is already released.** After
   `git fetch origin`, `git diff origin/main -- package.json package-lock.json`
   shows no `version` change, and the tag for the current version exists with
   a published (not draft) release:

   ```sh
   v=v$(node -p "require('./package.json').version")
   git ls-remote --tags origin "$v"         # prints the tag; no output = no tag
   gh release view "$v" --repo 2found/soot-forge --json isDraft  # "isDraft": false
   ```

   No tag: a push to `main` would tag and publish this version, so treat the
   push as a [package release](#package-release). A tag with no release
   ("release not found") or a draft release: the push publishes nothing, but
   finish that release first by [resuming it](#resume-an-unfinished-release).
2. **Verify locally:**

   ```sh
   npm ci --ignore-scripts
   npm test                              # node --test scripts/*.test.mjs
   node scripts/validate.mjs --remote    # catalog, bundled and pinned external content, as CI runs it
   ```

   Then check every link in the changed Markdown files resolves: relative links
   and `#anchors` point at files and headings that exist, and external URLs
   answer 2xx/3xx.
3. **Push `main`.** The `Release packs` workflow runs the catalog and runner
   checks (`check.yml`) and reports "already released / no version change" in its
   plan step: no tag, no archives, no GitHub release.
4. **Confirm:** the workflow run is green and the changed files render on
   <https://github.com/2found/soot-forge>.

The Forge page on [trysoot.com/forge](https://trysoot.com/forge) reads a catalog
snapshot in the Soot website. A catalog change shows there only after that
site refreshes its snapshot and deploys; a README-only change needs nothing
there.

**Rollback:** `git revert <commit>` and push `main`. The revert is itself a
docs-only push.

## Package release

Follow [Contributing § Automated releases](CONTRIBUTING.md#automated-releases):
raise the version in `package.json` and both version fields in
`package-lock.json` to the reviewed stable version (`X.Y.Z`; the workflow
rejects prerelease suffixes), then push `main`; the same workflow validates,
tags, builds and publishes. Release Forge before a Soot build whose default
packs reference it. Published tags and assets are immutable, so a bad release
is fixed by a newer version, never by moving a tag.

### Resume an unfinished release

If a run stopped after tagging, or left a draft, run the `Release packs`
workflow by hand with the existing tag; it resumes on the same commit without
moving the tag:

```sh
gh workflow run release.yml --repo 2found/soot-forge -f tag=vX.Y.Z   # the existing tag
```
