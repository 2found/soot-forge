# Changelog

Release notes for Soot Forge pack releases. The version is `package.json`'s;
`catalog.json` `version` is the catalog schema version.

## 0.11.0

**Requires a Soot whose host reads `channel.platforms[].ui` and settings
pages (Soot as the CS engine, p3).** Nest no longer has Telegram, Discord or
website chat setup built in: it renders what these packs declare.

### Added

- **`chat-channels`** declares `channel.platforms` `telegram` (`tg`) and
  `discord` (`dc`), each with its setup `ui`:
  - label, icon and a guide that links BotFather / the Discord Developer Portal;
  - one secret `bot_token` field with help text;
  - the platform's own error copy (`platform_token_rejected`,
    `telegram_webhook_active`, `telegram_poll_conflict`,
    `discord_intents_disallowed`, `discord_sharding_required`).
- **`website-chat`** ships a `settings` page (`live-chat-settings`, server
  group, operator) on `website_view` / `website_action`, replacing Nest's
  built-in Live chat screen. It creates sites; edits the name, greeting,
  quick replies, allowed origins, theme, position and answering Soot; saves
  with a stable request id and the current revision; publishes, pauses and
  resumes; and shows the embed snippet. A draft being edited survives a change
  made from chat. Logo and Sheets settings are kept as they are and changed
  from chat.
- **`website-chat`** ships a browser-mode widget (`widget/`, channel-adapter
  §11.17). The product hosts `web-chat.js` and the shared chat frame, and the
  visitor talks to the Soot as a `web` binding's sender through the vendored
  SDK 0.6.0 `./channel/browser`. A signed-in visitor is proven by a
  product-signed assertion; no app key or secret is in the page. One guest
  fixture replayed through the old and new sessions shows the same behaviour
  (`tests/widget-parity.test.mjs`). The host's `/public/widget` stays as it is.
- **`lohi-cs`**: Lohi's customer care pack, layered on `team-cs` (copied
  forward from `2agent/cs/deploy/packs/lohi-cs`, which stays for the old deploy).
  - The reader's own data is read from `/agent/support/lookup/me/*` with the
    host-signed principal (`SOOT_PRINCIPAL_TOKEN` → `X-Soot-Principal`), never
    a user id or conversation id; an anonymous conversation gets
    `principal_required` and nothing is asked. Lookup gains `unlocks`.
  - Write routes keep their bodies and add the header. The key and the token
    reach curl only through its config on stdin.
  - `lohi_recover_topup` and `lohi_fix_chapter` stay `approval: "operator"`
    with a dry-run preflight card.
  - Its router skill is `lohi-triage` (it was `cs-triage`, which `team-cs`
    owns); the catalog tests refuse a skill name shared with `team-cs` or
    `live-chat`.
  - A `lohi-support` collection seed (`knowledge/lohi-support/`), with how-tos
    and policy and no prices, and 8 eval cases (one per tool, a price from
    `features`, the anonymous refusal).
- **`cs-console`** ships the **Khách hàng** `rail` page (member access) for a
  care team's lead Soot. Each row is one verified person (asserted or paired)
  of a tenant, with their timeline across bindings, a status projected from
  `control`, their user bank (read-only) and live product facts. Take over and
  hand back from the page. It stores only tags, notes and identity links, in
  `storage` tables keyed by `<tenant>:<sub>` (`principal` columns). Links are
  made only from a product-signed proof (`aud: "soot-identity-link"`); there
  is no name or email matching. Conversations are read with operator-issued
  member keys, so the host's grants decide what the page sees. Needs a host
  that serves `principal` on team reads and
  `GET /v1/conversations/{id}/principal`.
- A localized `label`, `description` (vi, en) and `keywords` on every pack.
- `scripts/catalog.mjs` checks `channel.platforms` the way the host does
  (id, mode, `request_prefix`, and the `ui` label, icon, guide, fields and
  errors).

### Changed

- `website-chat` drops its `live-chat` tool area; the settings page replaces it.

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
