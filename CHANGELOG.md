# Changelog

Release notes for Soot Forge pack releases. The version is `package.json`'s;
`catalog.json` `version` is the catalog schema version.

## 0.10.0

**Requires a Soot with pack pages and programs (pages-storage).** The updated
`data-pool-console` and `browser-use` manifests use `label`, `keywords`,
`interface.pages`, `programs` and `interface.tool_area.capabilities`. An older
Soot's strict decoder refuses them as unknown fields. Update Soot first, or stay
on Forge 0.9.x.

### Added

- **`team-cs`**: a customer care team starter on `live-chat`.
  - Two role Soot sources, `cs-triage` and `cs-escalation`, both with
    `interaction.handoff: "members"`.
  - Four generic skills: `cs-triage`, `handoff-policy`, `tone`, `person-memory`.
    Price, plan, quota and account facts come from the product tool, never from
    the collection.
  - A README covering install, the binding, the adapter secret and a
    first-message test.
  - 8 eval cases.
  - The pack names no product and ships no tools.
- **Pack manifest fields** checked by `scripts/catalog.mjs`, with the schema in
  `schemas/pack.json`:
  - localized `label` (≤ 48) and `description` (≤ 280), and `keywords`;
  - `interface.pages[]` and `interface.tool_areas[]`;
  - `tool_area.capabilities`;
  - `programs[]`.

  A pack is refused for any of these: a page whose `view_tool` is missing
  (`tool_missing`), is not a read tool (`view_not_read`) or does not take stdin
  context (`stdin_not_context`); a duplicate page id (`duplicate_id`); an
  unknown placement (`unknown_placement`); a bundle without `index.html`
  (`bundle_missing`) or over 5 MiB (`bundle_too_large`); `settings_group` on a
  page not placed in settings; or a program whose `check_op` is not a read tool,
  or whose `install_op` is missing or not a write/repair tool.

### Changed

- **`data-pool-console`** is now the **Kho tài liệu** page (en: *Library*,
  `interface.pages` id `kho-tai-lieu`, placement `data`, access `operator`). It
  replaces the tool area.
  - The `page/` bundle is a static classic script that never fetches. It talks
    only through the soot-pages bridge v1.
  - Collections: list, create, delete.
  - Documents: paged list, search, add text, import a URL, read in chunks, edit
    and delete. Each edit and delete carries a revision/generation guard.
  - A conflict keeps the draft: view the latest, copy yours, or save over the
    latest.
  - A lost answer is resent with the same `request_id`, so a save happens once,
    or it is checked by status.
  - Read access is shown read-only.
  - Activity is bounded.
  - Drafts store only request metadata.
  - The `view`/`action` tools keep the legacy `{kind, input}` body, so Nest's
    link sheets and knowledge picker (`pools`, `query`) are unchanged.
- **`browser-use`** declares the browser as a program:
  - `programs[chromium]`, about 170 MB;
  - `chromium_check` (read) runs `soot browser status --json`;
  - `chromium_install` (write) runs `soot browser install --json`;
  - the tool area declares `capabilities` (`input: full`, `stream: websocket`,
    `pacing: frames`).

## 0.9.0

- `live-chat` widget question card.
