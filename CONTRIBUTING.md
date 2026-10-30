# Share a pack through a pull request

Fork `2found/soot-forge`, make your changes and open a GitHub pull request.
Choose a stable lowercase pack ID. The ID must match `pack.json`; changing it
creates a different pack. Metadata must describe the skills and tools the pack actually
contains, dependencies the user must prepare, and the credentials it declares in `needs`.

## 1. Bundle the pack here

Place `pack.json`, skills, tools and a README in `packs/my-pack/`, then add:

```json
{
  "id": "my-pack",
  "name": "My pack",
  "description": "A concrete description of what the pack does.",
  "tags": ["research"],
  "source": { "kind": "bundled", "path": "packs/my-pack" }
}
```

Use the [Soot pack authoring guide](https://github.com/2found/2agent/blob/main/docs/authoring-packs.md).
`pack.json` uses `soot/v1`: `skills`, `tools`, optional `needs` and `interface`; `capabilities` and `use` are rejected. Paths stay inside the pack. No symlinks, secrets,
vendored dependencies, compiled binaries or runtime state. Tools are installed
as source; explain how to prepare their executable on the user's platform.
Packs own skills/tools, not the Soot's soul, mission, schedules or host grants.
Every executable tool states `run.mode` (`read`, `write` or `repair`); a tool named like a change is not `read`. No `run.env`: inherited names go in `needs.env`.
Every `{{cred:NAME}}` is declared in `needs.credentials` (`title`, `description`, `from`: `operator`, `workspace`, `data_pool` or `env:VAR`) and every declared credential is used. An interface `view_tool` is a read tool.

## 2. Link an external GitHub repository

Keep your source where it already lives. Add metadata and a **full 40-character
commit SHA** (not `main`, a tag or `HEAD`):

```json
{
  "id": "my-pack",
  "name": "My pack",
  "description": "A concrete description of what the pack does.",
  "tags": ["research"],
  "source": {
    "kind": "github",
    "repository": "your-name/your-repository",
    "path": "packs/my-pack",
    "ref": "REPLACE_WITH_A_FULL_REVIEWED_COMMIT_SHA",
    "version": "1.2.3"
  }
}
```

The folder must be publicly fetchable and contain `pack.json` declaring the
same ID. You must have permission to redistribute its source in Forge release
archives; document its license in the pack. Updating the pack is another PR
changing the pinned commit and `version`. `version` is the stable SemVer of the
release the commit belongs to; the repository must have a tag `v<version>` at
exactly that commit, which CI checks. The 2build entry in `catalog.json` is a real example.
The installer uses `https://github.com/owner/repo/tree/<commit>/packs/my-pack`.

## Review and checks

Run `node --test scripts/*.test.mjs` and `node scripts/validate.mjs` locally.
For the full check, use `node scripts/validate.mjs --soot /path/to/soot --remote`.
CI fetches linked source at the reviewed SHA and validates its tree against
the exported public pack schema. The optional local --soot check additionally
uses the official Soot installer against a temporary library. It never executes a pack's
tools or dependency scripts and has read-only repository permissions.

PR checks reject duplicate IDs, duplicate skill or tool names, unknown metadata fields, moving external refs,
unsafe folder paths, symlinks, oversized trees, missing skills and mismatched
manifest IDs. Authoring validation uses the exported generated Soot schema, not another
handwritten schema. The official installer remains the semantic authority.

Before accepting a PR, review the source, attribution/license, dependencies,
effects and credential requirements. Inclusion is discovery, not a security
certification or permission grant. The user remains responsible for selecting
packs and granting `needs`.

## Maintainer release

Push a stable `vX.Y.Z` tag only after validation. The release workflow builds
deterministic source archives for every catalog entry, records `SHA256SUMS` and
uploads them to the matching GitHub release. Soot verifies GitHub's SHA-256
asset digest at creation. Preserve the default pack IDs required by General;
release Forge before a Soot binary whose defaults reference it.

The website consumes a generated catalog snapshot from this file. Refresh it
with the Soot website's `sync:forge` command after catalog changes; its build
does not read another checkout or make remote requests.

## Automated releases

The release version lives in `package.json` and `package-lock.json`. Update both
and push main; the release workflow calls catalog/runner checks once, tags only
a verified new version, builds deterministic archives and publishes docs and
download metadata in that same run. Keep the catalog schema version separate.
