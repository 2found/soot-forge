# Changelog

Release notes for Soot Forge pack releases. The version is `package.json`'s;
`catalog.json` `version` is the catalog schema version.

## 0.11.10

Baseline: v0.11.9 (51a5b3f). Needs Soot 0.13.12 or later for the Lohi recipe (workspace `env`, the `pack:tools=` selector, schedule catch-up).

### Added

- **`marketing_plan`, a daily content plan with no model call.** A tool-only schedule call (`{wake:true, channel, facts_url, catalog, depth}`) wakes the Writer only when a blog slot is free (and refreshes the guard's price facts, so the separate facts schedule is gone). It stays quiet with a named code (`paused_all`, `draft_open`, `queued`, `refused_streak`, `no_slot`, `planned_today`) and wakes at most once a day. The woken Writer calls `marketing_plan {}` for the brief: topic, keyword, angle, source (a Search Console query first, else genre x three angles, skipping written keywords), real novels (title, author, chapters, status, words, summary, url), internal links and what to avoid.
- **Real-catalog briefs.** The plan reads Lohi's public catalog endpoints (discovery feed, genres, search), so a post links novels that exist.
- **Dead-link check.** `check` gains the rule `links`: a lohi2.com or blog link that answers 404/410 fails (`dead_link`); a network error passes as "not checked".
- **Lohi blog publisher.** It clones `LOHI_BLOG_REMOTE` into its own state directory (no `LOHI_REPO` needed; `LOHI_REPO` stays an override), gains a `catalog` read tool, and a `ready` tool with a 06:30 `blog-ready` schedule that names every missing prerequisite in one Cần bạn item, quiet until the list changes.
- **Recipe `setup.mjs`.** `examples/lohi-marketing/setup.mjs <dir> [--port] [--no-video]` builds the workspace and generates `MARKETING_CLAIM_KEY` once (mode 0600, never printed, never overwritten); it writes `env` into `deployment.json` when the runtime's schema lists it. The README lists only what a person does.
- **Writer gets only the tools it writes with**: `marketing:tools=...` in `lohi-writer.json` (needs Soot 0.13.12), cutting its per-turn tool schemas.

### Changed

- **Wake hygiene.** `marketing_due` records `woke:<need>` attention rows and wakes the Editor only for a need not already raised or woken; signing in clears the episode. The dispatch schedule is `*/10 7-22 * * *` Asia/Ho_Chi_Minh.
- **`draft_save` of identical content is idempotent** instead of returning a refused duplicate.
- **Recipe slimmed to three Soots and seven schedules**: the Radar Soot and the facts schedule are removed; the Writer is `["marketing"]` only with a 200k run / 250k daily token budget.
- **Marketing page vocabulary and fixes.** One set of states (Nháp, Đã kiểm tra, Chờ đăng, Đã đăng, Bị từ chối); "Đã kiểm tra" is its own tab and no longer counts as waiting; switches read "Bật là đang đăng, tắt là dừng"; post detail shows the body, "Xếp lịch" and "Gỡ khỏi hàng đợi"; link summaries no longer render `lohi2.com//...`. The Editor answers in plain Vietnamese with a four-line "today" summary.
- `facts_sync` takes its URL from a setting (`facts_url`); without one it says to write without prices.

## 0.11.9

### Added

- **Campaigns and the Chiến dịch page.** The marketing pack's new **Chiến dịch**
  page and `marketing_campaign_save` make a campaign: a goal (`signups`,
  `first_topups`, `clicks` or `published`, with a target), channels, dates
  and a token budget. `marketing_draft_save {campaign}` keeps a post on the
  campaign's channels.
- **UTM short links.** Saving a campaign asks the product api
  (`POST /admin/links`) for one short link per channel, tagged
  `utm_source=<channel>`, `utm_medium=blog|social`, `utm_campaign=<id>`; a
  social or video post on the campaign gets its channel's link. The api's
  address is the host-granted `PRODUCT_API_URL` env; its key is the optional
  operator credential `PRODUCT_ADMIN_KEY`, sent only to that address. Without
  either, the campaign saves without links and the page says what is missing;
  saving again makes them.
- **Campaign report and lead outcomes.** `marketing_campaign_report` (a daily
  tool-only schedule) reads `GET /admin/analysis/campaigns/:id`, keeps the
  snapshot and returns each new attributed signup once as a `lead` outcome
  (`ref: utm:<id>:<day>`). At 80 % of the token budget it returns one note for
  the person and never stops the campaign. When the api cannot be read the page
  keeps the Soot-side numbers and shows **Thử lại**; clicks and signups show
  "—", never 0.
- `examples/lohi-marketing`: a sixth schedule (07:00 campaign report) and the
  `agent_mod` key setup for campaigns.

### Changed

- **The `marketing-team` template asks about publish approval.** The new
  `publish_approval` input defaults to `required`: every `marketing_claim`
  waits for your approval. Only `none` sets the host's policy to
  `{"marketing_claim": "auto"}`; the guard still runs in every claim. The
  template drops the marketing hub: the editor binds `MARKETING_CLAIM_KEY` and,
  optionally, `PRODUCT_ADMIN_KEY`.

Requires Soot 0.13.10 or later (unchanged).

## 0.11.8

### Added

- **One video path for marketing videos.** The `marketing-video` skill drives
  2build's `marketing-video` (`mvf`) for a product video: script, hook,
  Micro Fish pretest and per-platform files. The new `marketing_video_import`
  tool reads the mvf campaign folder under the host-bound `FILE_ROOT`. It
  accepts both the mvf ≥ 1.122 layout (`08-delivery/<script>/<canvas>`) and
  the v1.119 one (`<script>/<hook>/<canvas>`), and refuses parent, hidden or
  symlinked parts. For each channel (X, Facebook) it records the video
  (sha256, size, duration), the captions and a poster, then writes one
  `kind:"video"` draft that passes the same guard, caps and signed claim.
  TikTok stays a handoff.
- **A video that is not ready stays a draft with its reason.** An mvf render
  error, a missing or draft export, or a failed file QA gives **Lỗi dựng**.
  A hook with no Micro Fish round, or one under the bar (setting
  `video_pretest_bar`, default 35 % watch-through), gives **Câu mở đầu yếu**.
  Both hold at check and at claim; nothing is queued. A video that also breaks
  a hard rule (facts, personal data, duplicate) is refused.
- **Hàng đợi shows a queued video** with its poster, captions and the hook
  table (score and **chọn**). **Xem video** opens the workspace file, and
  **Kéo khỏi hàng đợi** pulls the video. A video row has the same Chưa rõ,
  Bài lỡ giờ, sign-in hold, retry and Đổi giờ controls as other rows. Bài viết
  shows the hold badge.
- **`browser-use` `upload`**:
  `control {action:"upload", selector, path, sha256}` uploads a
  workspace-relative media file (mp4, mov, m4v, jpg, jpeg, png, webp; at most
  512 MiB) under `FILE_ROOT`. Absolute, traversing, hidden and symlinked paths
  are refused, and the file must match the claim's sha256. The
  `marketing-browser-post` skill uploads a video claim's file before it types
  and posts only after the preview shows. It turns on Facebook's AI label when
  mvf asks for it.
- `examples/lohi-marketing`: a Video Soot (`lohi-video`) renders with mvf in
  a workspace it shares with the Editor.

### Changed

- **`video-editor` has one skill** (`video_editor_video`, replacing plan, edit
  and hyperframes). It routes marketing videos to mvf. The HyperFrames
  operator pin is now 0.8.153, matching mvf.

Requires Soot 0.13.10 or later (unchanged).

## 0.11.7

### Added

- **`marketing` publishes and replies on social channels through Nest's
  browser.** X, a Facebook Page and a Reddit profile are `browser` channels:
  the `marketing-dispatch` skill claims each due post, reply or unpublish and
  the `marketing-browser-post` skill posts the exact checked text in the
  Soot-kept browser, then records the post URL or fails it. A post is never
  sent twice; a post that may have gone out is `uncertain` and is looked up
  before any retry.
- **Sign-in and other person-needed states are Cần bạn items.** A signed-out
  channel files one sign-in item (opening each login page in its own tab);
  captcha and a changed page layout pause that channel and file an item with
  "Chạy lại" as the recommended option. `marketing_raised` and
  `marketing_answer` track and resolve the item; the next comes after an
  answer.
- **Replies.** `marketing-replies` reads replies and comments
  (`marketing_replies_sync`), classifies each (safe, complaint, money,
  account, flagged, spam), answers only safe ones through the guard and a
  claim (`marketing_reply_save`), and raises the rest as Cần bạn items, most
  urgent first.
- **Per-channel caps and spacing** for X, Facebook and Reddit (posts and
  replies per day), and **Tạm dừng đăng** switches (all channels or one) in
  Hàng đợi; `marketing_channels_setup` configures the social channels.
- **Unpublish on social channels**, from Bài viết or Hàng đợi, through the
  same claim and browser path; a removed blog post notes that its page now
  returns to the blog home.
- **`browser-use` persistent profile.** A Soot the host lists in
  `SOOT_BROWSER_PERSISTENT_SOOTS` (an inherited `needs.env` name) keeps one
  signed-in browser profile across all its conversations, so the person signs
  in once. Unlisted Soots keep one profile per conversation. Export it in the
  shell that runs `soot service start`.

### Changed

- Hàng đợi and Bài viết read like the prototype: channels ordered Blog, X,
  Facebook, Reddit; social rows show the post text and "có liên kết"; failed
  rows waiting to retry are muted; guard refusals name the price source and
  the time it was read.
- `examples/lohi-marketing`: the Editor dispatches social claims; the Writer
  is `lohi-writer`.

Requires Soot 0.13.10 or later (unchanged).

## 0.11.6

### Added

- **`marketing` publishes without a hub.** With no `MARKETING_HUB` bound, the
  pack keeps posts, checks, its queue and the publish log in its own storage
  (`pack:marketing`) and shows them on two operator rail pages of the
  **Marketing** flow: **Bài viết** and **Hàng đợi**. Every post passes a
  guard (served facts, personal data, channel rules, duplicates) and a signed,
  once-only claim (`marketing_claim`, operator approval by default) before a
  publisher posts it. `gsc_sync` reads Search Console numbers with the
  operator's Google sign-in (`GSC_GOOGLE`, declared with
  `needs.credentials.*.oauth`). The hub tools are unchanged.
  **Requires Soot 0.13.10 or later**, which decodes the `oauth` field; an older
  Soot refuses the pack.
- **`cs-console`** belongs to the support flow (`provides: ["flow-ho-tro"]`),
  so Nest lists it under the product's Hỗ trợ tab.
- **`examples/lohi-marketing`**: Lohi's hubless marketing workspace (Radar,
  Writer, Editor) with its local `lohi-blog` publisher pack for
  `blog.lohi2.com`.

### Changed

- `schemas/pack.json` is regenerated by Soot's contractgen (Soot 0.13.10): it
  adds `needs.credentials.*.oauth`.

### Fixed

- **`lohi-blog`** (example pack): a push that loses a race rebases with the
  tool's own git identity, so the retry works on a host whose git has none
  (a Linux server or CI runner).

## 0.11.5

### Added

- **`lohi-cs`** names a reader card (`interface.subject` → `lohi_subject_card`):
  the host shows the signed-in reader (name, email, plan, LT balance, join
  date, latest top-up and the "Mở trên Lohi" link) in Nest's **Người dùng** tab
  and the run envelope. Requires Soot 0.13.7 or later, which decodes
  `interface.subject`; an older Soot refuses the pack.

### Fixed

- **`lohi-cs`** `soot-lohi-api` scopes every command to the run's
  conversation, never one the model supplied.
- `schemas/pack.json` is again generated by Soot's contractgen (Soot 0.13.7)
  instead of edited by hand: `interface.subject` takes the generated shape, and
  two descriptions that Soot's types do not carry are gone.

## 0.11.4

### Changed

- **`lohi-cs`** `topup-triage`: a reader who says they just topped up ("vừa
  nạp", "mới nạp 50k", "lúc nãy") has given the window. The skill now calls
  `lohi_recover_topup` at once over the last 3 hours (and today for "hôm
  nay"), with the amount when they gave it, instead of asking when they paid.
  Found replaying Lohi's support history: the agent asked first, and the reader
  had already answered.

## 0.11.3

### Fixed

- **`server-care`** can be selected straight from the Forge. Its `remediate`
  tool was a `repair` operation, which Soot loads only with a host-specific
  `preauthorized` flag and `verify_target`, so `soot check` refused every Soot
  that picked the pack, including the `server-watch` group. It is now a
  `write` operation: `approval: operator` still holds each restart or reload
  until an operator approves that exact request, and it still runs once.

## 0.11.2

### Changed

- **`health`** works right after `soot pack add health`: the probe is a POSIX
  sh script that uses `curl`, so no Go build or toolchain is needed on the
  host (the Go `runner/` is gone). One pack now watches several endpoints: the
  operator sets `HEALTH_TARGETS` (`name=url` pairs, up to 16) and grants it
  (`needs.env`); each endpoint answers on its own line. Addresses still come
  only from operator config, never from the model. A single URL in `run.args`
  keeps working.
- **`server-care`** skill names the real operations (`health_probe`,
  `server-care_remediate`) and records one `alert_triaged` per endpoint alert.

## 0.11.1

### Changed

- **`lohi-cs`** keeps working for conversations from the legacy cs bridge
  during the Lohi dual-write window (CS engine P5.3). A host that still runs
  the bridge grants `LOHI_CS_LEGACY_SCOPE=1` (`needs.env`); a conversation
  without a principal is then scoped by `conversationId`, and the api checks
  the bound support thread (`403 thread_unbound` otherwise). Without the grant
  nothing changes: an anonymous conversation asks nothing about a reader. The
  fallback goes away with the legacy path (R2).

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
- **Outcomes** (Soot 0.13.0 jobs): `team-cs` counts resolved conversations
  with `void_on: binding_activity` (a new message from the person undoes the
  outcome), `server-care` counts triaged alerts, and
  `marketing` counts published posts and leads.
- **`server-watch`** group template: a watcher Soot with a cron schedule that
  hands alerts to `server-care`.
- **`server-care`** `remediate` tool (bounded to 50 s, under the run timeout).
- **`cs-console`**: cursors on every list, with a `truncated` flag when a host
  read is capped; proofs are claimed once in a `proof_claims` table with a
  per-tenant `unique` `jti`, and a replay answers `proof_replayed`. Links
  carry `alias_tenant`.
- **`data-pool-console`** keeps its unsaved draft across a reload through the
  Nest `draft.*` bridge, and declares `provides: ["knowledge"]`.
- **`website-chat`**: `tests/loader-parity.test.mjs` replays the old
  `/public/v1` and the new `/v1/channel` loaders on one fixture.

### Changed

- `website-chat` drops its `live-chat` tool area; the settings page replaces it.
- The 0.11.0 packs need **Soot 0.13.0**: an older Soot refuses the new fields
  (`outcomes[].void_on`, `storage` `unique`, page `provides`) and keeps its
  current packs. Update Soot first.

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
