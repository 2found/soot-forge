# Soot Forge

Soot's pack catalog and community packs. Public naming follows
[Soot branding](https://github.com/2found/2agent/blob/main/BRANDING.md): **Soot Forge**.
The public discovery page lives at `trysoot.com/forge`, in the Soot website.

For finding or installing a pack, follow [USAGE.md](USAGE.md). Read catalog
metadata first; never infer permissions from a catalog entry or installation.

- `catalog.json` is the hand-authored pack catalog. `groups.json` is the separate group-template catalog; never put identities or group entries in pack v1. Bundled packs live in `packs/`;
  external entries pin a full Git commit and a repository-relative folder.
- Preserve `soot/v1`. A pack is `pack.json` `{api_version, id, name?, description?, skills[], tools[], needs?, interface?}`; it owns skills and tools and declares
  `needs`, never credentials, Soot identity, schedules or grants. `capabilities` and `use` are validation errors. Installing never executes scripts.
- Every executable tool states `run.mode` (`read`, `write` or `repair`); a write tool is never `read`, and no tool sets `run.env` (inherited names go in `needs.env`). Each `{{cred:NAME}}` is declared in `needs.credentials` with `title`, `description` and `from` (`operator`, `workspace`, `data_pool` or `env:VAR`), and each declared one is used. An interface `view_tool` is a read tool. `checkPackModel` in `scripts/catalog.mjs` enforces it. A packs dir holds at most 32 packs.
- No sibling checkout dependencies, secrets, checked-in binaries or runtime data.
  Runners decode the public soot/v1 envelope without private runtime dependencies.
- Run `node --test scripts/*.test.mjs`, `node scripts/validate.mjs`, and the Go
  race tests in each changed runner. Full validation uses `--soot <binary> --remote`.
- Approved version changes update package.json and both lockfile mirrors; push
  main for one check/tag/build/publish pipeline ([RELEASE.md](RELEASE.md)). Catalog version is the schema
  version. Unchanged versions check only; published tags/assets never move.
- Release archives contain one pack root, with deterministic bytes and SHA-256.
  Release/push/deploy requires an explicit user instruction.

UI uses `@tofound/ui` and Soot semantic tokens; public website source ownership
is governed by that repository's `web/AGENTS.md`.
