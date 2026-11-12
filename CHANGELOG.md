# Changelog

Release notes for Soot Forge pack releases. The version is `package.json`'s;
`catalog.json` `version` is the catalog schema version.

## 0.14.3 — 2026-11-12

Baseline: v0.14.2. Pairs with Soot 0.16.2+ and Lohi api 1.36.0+ (new request types and agent roles). No storage changes.

- **lohi-cs: more chapters and translation quality.** New tool `lohi_request_chapters` files a `chapters` request (the reader wants more chapters of a novel already on Lohi, optional `fromChapter`) or a `quality` request (a translation-quality complaint, description required) for the chatting reader. Idempotent per conversation, type, novel and start chapter; readers asking for the same novel join one request. The triage and novel-request skills route "dịch tiếp" / "thêm chương" here instead of `report_blocker`.
- **marketing: per-Soot Lohi key.** Campaign tools read the new optional credential `PRODUCT_AGENT_KEY` (a key with role `agent_marketing`) and fall back to the deprecated shared `PRODUCT_ADMIN_KEY`, so a deployment that sets only the old key keeps working. A missing key now asks for `PRODUCT_AGENT_KEY`.

## 0.14.2 — 2026-11-12

Baseline: v0.14.1. Pairs with Soot 0.16.2+. No storage changes (company-loop `storage.version` stays 7).

- **company-loop: one project per product.** New env `PRODUCT_REPOS` (`product=<project>` lines, comma- or newline-separated); a product without a line falls back to `PRODUCT_REPO`, so a deployment that sets only `PRODUCT_REPO` behaves as before. A project is an absolute path or a bbs workspace name (`<workspace>` or `<workspace>/<repo dir>`). A project the machine cannot resolve stops at "Chưa có kho mã" with the reason and offers Chạy lại or Giao người làm. Products in different repos build in parallel.
- **company-loop: hand a task to a person.** At Go, a product with a project shows "Go: Soot dựng" and "Go: giao người làm" (the person first for L/XL). "Giao người làm" is also offered on draft-ready, no-repo, approved (waiting for a workshop) and blocked handoffs; a person's task has "Để Soot dựng". A person's task is never pulled by `builds_pull`, and workshop events do not overwrite it.
- Known gap: the "Cần bạn" card of a handoff given to a person stays until it is marked seen (a page action's `settle` is not applied by the runtime yet). The weekly release count still reads only `PRODUCT_REPO`.

## 0.14.1 — 2026-11-12

Baseline: v0.14.0. Pairs with Soot 0.16.2+ (an older Soot ignores the new files). No storage changes.

- **nest-lead ships the Lead's prompts.** `packs/nest-lead/lead/SOUL.md` and `lead/MISSION.md` are the soul and mission a Nest gives the Lead it creates for a workspace from before the Lead. They were compiled into Soot until 0.16.1; Soot 0.16.2 copies them from the installed pack instead, so the Lead's words change with a Forge release. The text is unchanged.

## 0.14.0 — 2026-11-11

Baseline: v0.13.0. Pairs with Soot 0.16.0+ (`data.read` and `data.insert` runtime scopes, the `SOOT_PRODUCT` run product). **Storage of `company-loop` goes 6 → 7** (only adds tables and columns).

- **company-loop: several products, two runtimes.** Every product-bound tool (`scoreboard_sync`, `review`, `opportunities_card`, `team_watch`, `goals_checkin`, `decide`, `topic_next`, `digest_save`, `signals`, `metrics_record`, `parts_set`, `page_view`) takes an optional `product`, defaulting to `SOOT_PRODUCT`, and works on that product's rows only; with neither it behaves as before. `digest_save` refuses an item of another product; `scoreboard_sync` reads the source mapped to the product.
- **company-loop: the Go splits across runtimes.** A runtime with no `PRODUCT_REPO`/`bbs` records the founder's Go as a `handoffs` row in state `approved` with the requirement, product and target outcome (no repo write, no spawn). New tool-only `builds_pull` (runtime with the repo) reads the approved rows with `soot data query`, writes the requirement, starts `bbs team spawn`, records a local `builds` row and inserts a `started` event; `team_watch` inserts `progress`, `handover`, `shipped` and `failed`; `handoff_events_apply` folds the events into `handoffs` (a `shipped` event records `requirement_shipped` and queues the launch topic once). One runtime holding both halves keeps today's direct path. New tables `handoff_events` and `builds`; `handoffs` gains `requirement`, `target_outcome`, `expected_delta`, `url`. New `needs.env` `INSIGHT_TEAM`; `needs.runtime` adds `data.read`, `data.insert`.
- **lohi-cs: product gate.** Its tools refuse with `not_lohi_conversation` before any network call when `SOOT_PRODUCT` or the ToolCall product is not `LOHI_PRODUCT` (default `lohi`), or when `LOHI_BINDINGS` is set and the event binding is not in it; `report-content` also needs a principal. New `needs.env` `LOHI_PRODUCT`, `LOHI_BINDINGS`.
- **Lean standard teams.** `support` keeps the Answerer and the Feedback desk (the runtime refuses a Soot as its own feedback desk, and a public chat gets no pack tools); `insight` is the analyst alone, with a per-product digest and a weekly read-only money review (schedule `money`); `growth` is editor + writer, the writer carries the radar and `research` and the `radar` schedule moved here (Growth provides `signals`); `operations` is operator + curator (catalogs, content quality, community moderation); `finance` stays installable and is marked optional. New template `workshop` (builder, poster) for a computer with a browser and a coding agent: `company-team` replaces its `build` team with it (contracts `build-request` read, `handoff-events` write).

## 0.13.0 — 2026-11-11

Baseline: v0.12.6 (fe4f58f). Pairs with Soot 0.13.19+ (team `coordinator` and `entries`). No pack content or storage changes.

- **Five standard teams with English ids.** The group catalog now offers `insight` (Analyst, Radar: numbers, weekly digest, goals and budgets; part `value`), `growth` (Editor as Đầu mối, Writer, Researcher: marketing and sales; parts `marketing`, `sales`), `support` (Feedback desk as Đầu mối, Answerer: delivery to the customer; part `delivery`), `operations` (one Operator per job: delivery on the product side) and `finance` (Controller, read-only: part `finance`). Each catalog entry names the parts the team can own (`parts`, Kaufman's five) and the members that take chats (`entries`, the first is the Đầu mối). `company-team` and the Lohi example company are built from these five.
- **The old team templates stay installable, marked deprecated.** `marketing-team` and `team-marketing` → `growth`, `team-insight` → `insight`, `support-team` → `support`, `team-financial` → `finance`, `team-op` → `operations`: each keeps its id, so an installed team keeps updating, and carries `stability: deprecated` and `replaced_by`. A runtime reads only the fields it knows, so older hosts list them as before (with "(deprecated)" in the name).
- **lohi-cs: the support regression set lives here.** 22 cases from the retired 2agent `cs/deploy` (policy, injection, top-up recovery, chapter fixes, train/val/test tags) join the pack as `evals/lohi-cs/support-regression.eval.json`.

## 0.12.6 — 2026-11-11

Baseline: v0.12.5 (eab2c9c). Storage is unchanged (6).

- **company-loop: `goals_checkin` really wakes its Soot.** A tool-only schedule starts a model run only when its `wake_when` holds (`notify: true` for this schedule) and never when the tool answers `done: true`. `goals_checkin` always answered `done: true, notify: false`, so neither a refused check-in nor (0.12.5) a newly breached guardrail woke anyone; only the card reached a person. A run with something to act on now answers `notify: true` and no `done`; a quiet run is unchanged.

## 0.12.5 — 2026-11-11

Baseline: v0.12.4 (79f67cb). Pairs with Soot 0.15.6+ (a pack tool runs `soot goals` with its per-call token and no settings directory; on 0.15.5 server runtimes `goals_checkin` still answered `goals_unreadable`). Storage is unchanged (6).

- **company-loop: a breached guardrail reaches a person.** `goals_checkin` already measured each goal's guardrails against their limit but only listed them, with no wake and no card, so a breach was seen by nobody (on soot.2found.dev, `2novel:subscriptions_canceling` read 4 against a limit of 2). It now raises one card per goal, guardrail ref and scoreboard period (`company:guardrail:<goal>:<ref>:<from>..<to>`, an id the runtime files once), wakes the Đầu mối once for that period (remembered in `state`), and settles the card group once the number is back inside its limit. `dry_run` raises, wakes and stores nothing.
- **company-loop: `goals_unreadable` says why.** When `soot goals list` fails, the quiet skip now carries `reason: "soot_failed"` and `detail`, the CLI's error line (at most 200 characters; the CLI never prints the token). Before, a host-side failure such as the 0.15.5 `$HOME is not defined` gave an empty answer.

## 0.12.4 — 2026-11-11

Baseline: v0.12.3 (d0e0e07). **Requires Soot 0.15.5+**: the pack declares `needs.runtime`, a field older runtimes refuse as an unknown field; an older host reports company-loop `blocked` and keeps 0.12.3.

- **company-loop: `goals_checkin` calls its own runtime with a per-call token, not the operator token.** The pack declares `needs.runtime: ["goals.read", "goals.checkin"]`; once the host grants it (`soot grant company-loop`, Nest **Cấp quyền**), the runtime gives each call `SOOT_RUNTIME_URL` and `SOOT_RUNTIME_TOKEN`, valid only for goal list/get and goal check-in, as that Soot, until the call ends. The tool passes them to `soot goals` and no longer passes `--config`, so it no longer depends on `connections.json` (on a server runtime the child could not authenticate and answered `goals_unreadable`; on a laptop it borrowed the operator token). With no token (runtime without the grant) it keeps the quiet `skipped` / `goals_unreadable` answer and does not run `soot`. `LOOP_SOOT_CONFIG` stays for `health_sync`. Storage is unchanged (6).

## 0.12.3 — 2026-11-10

Baseline: v0.12.2 (e1c7853). Pairs with Soot 0.14.0+ (`soot goals` CLI).

- **company-loop: new tool `goals_checkin`.** A goal's `metric.ref` (`2novel:activated_new`, `company-loop:first_payers`) used to resolve nowhere: the pack read scoreboards and goals never saw them. The tool reads the active goals through the `soot` CLI, finds each ref's product in the stored scoreboards (`SCOREBOARD_URLS` + `SCOREBOARD_KEYS`) or recorded metrics (`metrics_record`), and checks in once per goal and period. Another product gets its numbers into a goal with configuration only. Guardrail refs are reported, not recorded. Storage is unchanged (6).
- **company-loop: the waiting card counts readers who are still waiting.** When the support scoreboard serves `support.readers_waiting` (the reader spoke last), the card and the source selection use it instead of `by_state.waiting_human`, which also counts threads a person already answered.
- **lohi-cs: a failed call names its cause.** `soot-lohi-api` used to answer an empty failure when curl could not connect or the api returned a non-JSON page. It now answers `{code: "transport_<n>", retryable: true}` or `{code: "http_<status>"}` (retryable for 5xx, 408, 429); a JSON refusal is passed through unchanged.
- **browser-use: a profile held by another process is named.** Browser daemons now idle out after 30 minutes. A live `SingletonLock` owner outside this runtime is refused as `browser_profile_in_use`, with the owner's PID and a close command, instead of Chrome's exit 21. Ships soot-browser 0.2.4.

## 0.12.2 — 2026-11-10

Baseline: v0.12.1 (b69d36d). Pairs with Soot 0.14.0+.

- **writing: new skill `writing_humanize_vi`.** The Vietnamese edition of blader/humanizer (MIT, license beside the skill): it rewrites AI-sounding or translated Vietnamese (staged contrasts, "việc/sự" nominalization, "được… bởi" passives, calqued idioms, inflated words, sales register) so it reads like a Vietnamese writer, without changing a fact, name or number. Skills are read on demand, so a Soot pays for it only when it reads it.
- **writing and marketing point to it.** `writing_article`, `writing_copy`, `marketing-write` and `marketing-edit` run that pass on Vietnamese text when the Soot has the `writing` pack (`"writing:read"` grants the skills without the export tool).

## 0.12.1 — 2026-11-10

Baseline: v0.12.0 (b5e5906). Pairs with Soot 0.14.0.

- **company-loop:** raises `storage.version` to 6 for the `goal` columns added in 0.12.0. Hosts refused 0.12.0 with `storage_incompatible` and kept 0.11.26; they now update by themselves.
- **Checks:** a new test compares every bundled pack's storage with the previous release tag and fails when a table or column changes without a higher `storage.version`, or when one is dropped or retyped. The catalog CI job now checks out full history so the tag is there.

## 0.12.0 — 2026-11-10

Baseline: v0.11.26 (7d80538). Pairs with Soot 0.14.0, which adds company goals and recurring tasks; an older runtime ignores the skills' goal steps and refuses `company.goals`. company-loop storage stays 5: the new `goal` columns are nullable and additive.

### Added

- **Goals in the Lead's skill (nest-lead).** The Lead drafts direction and cycle goals from the person's words as proposals (baseline read from the scoreboard, target with its reasoning, never an invented number), handles a changed or dropped goal (cancels its tasks, asks the Đầu mối to re-propose, proposes structure changes for the person), approves team goals only when `approve_team_goals` is `lead`, makes repeating jobs as recurring tasks, and never edits soul, mission or contract to change behaviour.
- **`team-rhythm` pack, skill `coordinator-rhythm`.** A generic Đầu mối rhythm: Monday commitments (at most 5 tasks, each linked to a goal; five selection rules), Friday check-in with the wins of the week, cycle review with a score, bets compared by `actual_delta`, and next cycle's team goals proposed as drafts. Selected by the Đầu mối of `team-insight`, `team-marketing` and `team-op`.
- **`company.goals` in the company template.** `cycle_weeks` 6, caps, `ops_warn_ratio` 0.3, person approvals, and three cadence recurring tasks (`weekly-commit` Mon 08:00, `weekly-checkin` Fri 16:00, `cycle-review` Fri 17:00, acts only in a cycle's last week), titles in Vietnamese and English, Asia/Ho_Chi_Minh. `scripts/company.mjs` compiles it into the company block; an overlay `goals` replaces single keys.
- **company-loop: a bet points at its goal.** `digest_save` items take an optional `goal` (string id); the opportunity and every decision keep it, `review` leaves it alone, `signals` repeats it as `g` on a decision, the page shows it. A non-string or malformed `goal` is refused naming the field. `signals` never fetches goals.

## 0.11.26 — 2026-11-10

Baseline: v0.11.25 (4361c70). Pairs with Soot 0.13.29; no storage change.

### Fixed

- **company-loop `signals {product}` no longer carries the host's support data into another product's packet.** `CS_RUNTIME_URL` is the host product's support runtime, so its knowledge gaps and customer feedback appear only in the host's packet (or with no product). Found live: a Lohi support note reached 2Novel's digest.
- **A part owned by a team on another server keeps its owner in the digest.** `signals` parts now name `team_name` when the part has no local team id (`own` was null).

## 0.11.25 — 2026-11-10

Baseline: v0.11.24 (fc55db9). Pairs with Soot 0.13.29; needs no runtime change. company-loop storage 4 → 5 (adds the `parts` table; additive), marketing storage 6 → 7 (adds `posts.awareness`; additive). Old rows read as empty.

### Added

- **Five parts per product (company-loop).** Every product has five parts — Tạo giá trị, Marketing, Bán hàng, Giao giá trị, Tài chính (Kaufman, *The Personal MBA*) — each with an owner team and a metric. New tool `parts_set` and page action `part_set` (button **Đổi**). The Công ty page shows **Khám 5 bộ phận**: a part is **Hỏng** when its metric moved the wrong way by at least 10 % and at least 3 units against the previous week; **Chưa đo** when no source has the metric; **Chưa giao** when no team owns it. A target is shown but never makes a part broken by itself. The default metrics are the north star or `active_users`, `signups`, `first_payers` then `revenue_vnd`, `support_threads_new`, and `revenue_vnd`. A broken part becomes the page's next step (`part_hong`).
- **Three labels on every opportunity.** `digest_save` items need `part`, need `awareness` (`unaware|problem|choosing`) for content, need `pain` (10–200 characters, who suffers from what) for a product item, and take an optional `moat` (`scale|network|counter|switching|brand|cornered|process|none`, Helmer's *7 Powers*). A founder Go records the moat; the page lists **Hào đang xây**. `topic_next` returns the topic's `awareness` for the marketing chain.
- **A digest per product.** `signals {product}` builds the packet for one product only, with its parts, the Go count per moat and the awareness mix of the last 8 weeks. Unlabelled rows count as the host product's.
- **Per-product scoreboard keys.** New optional credential `SCOREBOARD_KEYS` (`product=key`, comma-separated) for `SCOREBOARD_URLS` sources. A key is only ever sent to its own product's URL; `setup.bad_keys` counts the entries it could not read, never their values.
- **Awareness mix (marketing).** `plan` and `draft_save` take `awareness`; `inputs_health` reports the mix of the last 14 days; the report adds a note when one level is above 70 % or a level has no posts while at least 5 posts were tagged.
- **Company templates cover the five parts (nest-lead).** Each `nest-company` template names the owner team of every part without adding a team; Bán hàng goes to the Marketing team.

### Changed — upgrade note

- **A `SCOREBOARD_URLS` source no longer receives `PRODUCT_ADMIN_KEY`.** That key now goes only to the legacy `SCOREBOARD_URL`. A deployment whose mapped products used the shared key must add `product=<key>` entries to `SCOREBOARD_KEYS`; until then, those sources get no key and report "key refused". This stops one product's admin key from reaching another product's URL.
- The `signals` packet drops the moat and awareness tallies before any decision history when it nears its 3 KiB cap; the parts are compacted last.

## 0.11.24 — 2026-11-10

Baseline: v0.11.23 (0221bef). Pairs with Soot 0.13.28 (one Lead outside every team, team Đầu mối, Nest Lịch chạy board); an older runtime keeps every existing behavior (skills read correctly and team cycles still run).

### Changed

- **One Lead, outside every team.** `nest-lead` now speaks as the **Lead**, the person's own assistant in Nest (always named "Lead", formerly Kamaji). It belongs to no team: a team's work goes to the team as a task (`assignee_kind: team`), which the team's **Đầu mối** (its first entry) takes. The Lead no longer answers a team chat or honours `@Tên` inside a team, and on a current runtime team cycles go to the Đầu mối; "Run a team cycle" stays for an older runtime that still sends a team schedule to the Lead, so a cycle text that names it keeps working; it changes a team's Đầu mối with `group.policy.save` (entries reordered). `nest-manage` passes `coordinator` to `group.create` for a template with `asks_coordinator` (one question, "Ai làm Đầu mối của nhóm?"). The morning brief notes its run only reads. A bot is never the Lead's: asked to reach it on Telegram, it offers a bot for a team. With an older runtime the skills still read correctly and team cycles still run.
- **Team templates know their Đầu mối.** Every root `""` template (`marketing-team`, `support-team`, `server-watch`, `team-*`) drops "led by Kamaji" and gives each member a short paragraph for when it is the team's Đầu mối: take the team's messages, schedules and bots, hand work out as tasks, keep status true, report once in the team thread, never hand work to the Lead. The built `groups.json` carries `root`, so Nest and `soot group create` know which templates ask.
- **Copy.** `soot` `soot-domain` explains the Lead and the Đầu mối; `nest-lead`, `soot-nest`, `live-chat`, the catalog and template READMEs no longer say Kamaji.
- **lohi-ops App Store drafts are one Cần bạn card (M7-F1).** New tool `appstore_drafts` (09:40 schedule `ops-reviews-approve`, no model) raises one card for every drafted reply (read by state, so old replied reviews never hide one), superseded as the count changes and settled when none are left; **Đăng** wakes the Soot to post each one, every post still waiting for its approver. `ops-catalog-health` and `ops-crawl-watch` no longer ask the model for `report_blocker` (M7-F4): the tool's card is already the one item for the person.

### Added

- **The lead sets up a company from a template.** New `nest-lead` skill `nest-company`: four templates as data — Bán hàng online, Nội dung, SaaS and Vòng công ty (company-loop without the build stage). The lead asks at most two questions, proposes products, teams, schedules and read grants in one message, and after consent runs only existing settings actions: `company.product.save`, `group.create` through `manage_gated` (each team waits in Cần bạn), then `group.products`, `schedule.save` and `access.grant` (write grants stay gated). It never sets or raises a budget, and never joins a team or puts a schedule on itself. Evals `company.eval.json` (C1, C2).
- `manage` / `manage_gated` `schedule` documents `cron` (`0 9 * * 1-5` = Thứ 2–6 lúc 09:00) beside `every`/`at`.

### Fixed

- **A refused radar wake does not start the gap (M7-F2).** `marketing` `radar_read` records a wake as pending and starts `wake_gap_hours` only from the wake that was answered (`signals_list`/`signals_mark`). A wake the budget refused is retried after at most 6 h (`PENDING_HOLD`, or `wake_gap_hours` when shorter; `0` holds nothing) instead of waiting a whole gap.
- **Company adopt check with Soot 0.13.26+.** `scripts/company.mjs` in adopt mode with `--config` now gives a team without an explicit budget the sum of its members' `execution.daily_tokens` (the value `soot company adopt` derives, never more), so a `budget_80` escalation has a budget to warn against; when no member has a cap, the `budget_80` escalation is left out and named in notes. Without a deployment the output is unchanged.

## 0.11.23 — 2026-11-10

Baseline: v0.11.22 (97815a6). Pairs with Soot 0.13.27. Browser tools 0.2.3 (`soot-browser`, pinned in 2agent `internal/browserinstall/manifest.json`). company-loop storage version 3 → 4 (additive); the Công ty page reads Nest's new page `context` message (2agent soot-pages §5) and an older Nest keeps working without it.

### Added

- **Named browser profiles.** `browser-use_control` takes an optional `profile`: a named sign-in a person granted the Soot or its team in Nest › Cài đặt › Trình duyệt. The pack declares `SOOT_BROWSER_PROFILES` in `needs.env`; the host sets it on every call to the ids the calling Soot may open and refuses an ungranted `profile` before the tool runs, and the adapter re-checks it on every call (its live view and a person's input included), so a revoke stops at the next call. A conversation that asks for a profile stays in it until `close`; one profile is one browser shared by the conversations using it. `browser-use_view` lists the granted ids in `profiles`. A host that predates profiles sets nothing, and a profile call is refused while every other call works as before. `marketing` `browser-post` posts in the profile named for the account when one is granted.
- **Kamaji creates products.** `nest-lead` `manage` takes `company.product.save` (`company_product: {id, name}`) and `group.products` (`group_products: {group, products}`), so a fresh Nest can be asked to make a product and point a team at it. Deleting a product stays the person's.

### Changed

- **Bots and websites belong to a team.** On Nest 0.13.27+ `nest-lead` sends the person to paste a bot token on the team's Kênh tab (`nest://team/<team>/kenh`) and asks which team answers the bot when none is named, since `nest://settings/channels` is now only an overview; an older Nest keeps `nest://settings/channels`. `soot-nest` `nest-links` lists `nest://team/<team>/kenh|quyen` and `nest://settings/browser` (Nest 0.13.27+).
- **Công ty follows the product.** The page takes Nest's selected product (new bridge message `context`) and has its own switch when there are two or more products; every section narrows (Cần bạn, the scorecard, what happens after Go, decisions, loop health by the product's teams), and the page says what it leaves out ("Không tính 1 cơ hội, 2 quyết định của sản phẩm khác"). Mọi sản phẩm shows one scorecard row per product, never a sum. `decisions`, `handoffs` and `topics` carry `product`; rows from before read as their opportunity's product, else the host's, and are labeled on the next sync, never dropped.
- **Per-product scoreboards.** `SCOREBOARD_URLS` (`product=https://…`, comma or newline) sits beside `SCOREBOARD_URL`, which keeps its keys and state. `NORTH_STAR` picks the headline metric.
- **Numbers without an API.** New tool `metrics_record`: a Soot writes a product's numbers for a period into the pack's `metrics` table, with its own labels, units (`usd`, `percent`, …), direction and target; the page reads them like a scoreboard. Labels and units come from the data, with the Lohi words as defaults for the contract keys.
- **Build is optional.** Without `PRODUCT_REPO`, a product Go records the decision and a task ("Việc đã ghi": Giao việc opens a drafted conversation, Đánh dấu đã xong starts the outcome clock), instead of a dead "Chưa có kho mã".
- **The page, rebuilt for a founder.** Full width (up to 1120 px, one column on a phone), one next step on every state with the place to act (`nest://settings/setup?key=…`, `nest://team/…`, `nest://schedules/…`, `nest://new?text=…`), a north star card with trend and target, decisions with Trúng/Trượt/Chờ đo, technical details folded under "Chi tiết kỹ thuật". Colours, radii and fonts are Nest tokens only.

## 0.11.22 — 2026-11-10

Baseline: v0.11.21 (67f9fbb). Pairs with Soot 0.13.26. Browser tools stay 0.2.2.

### Changed

- **Công ty speaks words, not keys.** An opportunity is measured by "Hỗ trợ mới", not `support_threads_new`; evidence reads "Số: Bạn đọc chờ người" instead of `metric:waiting_human`; effort and value read nhỏ/vừa/lớn and thấp/vừa/cao. The scoreboard line no longer starts with the product id, and an amount keeps "₫" on its line. `page_view` adds `metric_labels`.
- **Vòng lặp says when its numbers were taken** ("Số lúc 06:30 …, 12 giờ trước"), and a team's "Hôm nay" is "đến lúc đó", so a morning snapshot is not read as now. A remote team (served by another runtime) reads as running on its own server instead of "Chưa có lần chạy nào".
- **Marketing › Hàng đợi no longer says "Không cần làm gì" while a channel waits for a login.** With posts going out on one channel and others signed out, the headline names the signed-out channels and offers "Đăng nhập …".
- **Hand-off cards are titled by channel and count** ("Cần đăng tay: 3 bài trên X, Facebook"), never by post ids.
- **lohi-cs tools carry Vietnamese titles**, so an approval or a held call in Cần bạn is titled "Gửi yêu cầu thêm truyện", not the model-facing English description.

## 0.11.21 — 2026-11-09

Baseline: v0.11.20 (8cdb993). Pairs with Soot 0.13.24. Browser tools 0.2.2 (`soot-browser`) are built from this revision.

### Changed

- **Browser use: sharp pages.** The browser tool now captures at 2x density with a larger, higher-quality stream, so text in the live browser stays readable on Retina screens.
- **Marketing: sign-in links name the site.** "Đăng nhập X" carries the site label so Nest opens a sign-in window titled for that site.

## 0.11.20 — 2026-11-09

Baseline: v0.11.19 (a483317). Pairs with Soot 0.13.22.

### Changed

- **Lohi's blog is lohi2.com/blog.** The `lohi-blog` publisher gained a **CMS target** (`LOHI_BLOG_TARGET=cms`): the
  `marketing-blog` chain (`due -> claim -> lohi-blog.publish -> record`) reads the CMS post of the slug, saves it as a draft
  to hub site `lohi` (language `vi`) unless the same content is already there, publishes that revision, verifies the
  public CMS read API and answers `https://lohi2.com/blog/<slug>`. The same slug is an update, never a second post
  (retry, re-issued claim, a crash between save and publish); a refused, missing or malformed `MARKETING_HUB` is one
  plain failure; `unpublish` archives the CMS post; `find` and `ready` follow (`ready` checks the credential, the site
  and the publish right by a `tool.preflight`, and no longer asks for git, Go, 2server or gcloud). The git target stays
  the pack default when the variable is unset. `lohi-blog` declares the optional credential `MARKETING_HUB` and the env
  `LOHI_BLOG_TARGET` (an existing workspace must grant it). The Lohi recipe's `setup.mjs` takes `--blog cms|git` and
  defaults to `cms`; `--blog-remote` only applies with `--blog git`. Writer and Ops guidance names `lohi2.com/blog`,
  not `blog.lohi2.com`.
- **marketing: the draft slug lint is the CMS slug rule** (words of a-z and 0-9 joined by single hyphens, 3-80
  characters), so a post is never refused by the CMS after it was scheduled.

## 0.11.19

Baseline: v0.11.18 (9d202d9). **Needs Soot 0.13.21 or later**: marketing declares `run.rerun`, which an older runtime refuses as an unknown pack field, and the packs raise Cần bạn cards through the chain result's `raise`/`settle`, which an older runtime ignores (no card is filed).

### Added

- **Packs raise cards from tool results, with no model wake.** `scoreboard_sync` (waiting readers), the opportunities card (new `company-cards` schedule), `team_watch` (handover waiting, a Go whose team has not started after 2 h), marketing sign-in, lohi-ops and `lohi-blog_ready` return `raise` (an idempotent card id, title, why, link and options) and `settle` (ids to close) instead of `ask` + `notify`/`wake`; a card closed by the person is never raised again under the same id. The digest no longer files the opportunities card itself.

### Changed

- **company-loop: the build leg is finishable.** A product Go writes `REQ-<id>.md` beside the tickets (`$BABYSIT_HOME/requirements/<repo>/`), never into the founder's working tree (a file already in `docs/requirements/` is used as is), and its answer says what happens next and that the release go is given in the team's Orca terminal. `team_watch` also watches `draft_ready` handoffs: they advance once the team exists and raise one reminder (with the command) after 2 h otherwise. A test walks proposed, Go, spawned or draft_ready, building, delivered and released with a fake `bbs`. New env `BABYSIT_HOME` (declared in `needs.env`; the recipe grants it).
- **company-loop: the content hit rate measures the post.** A content decision is reviewed from the post's publish date on its own Search Console or campaign-link clicks (or attributed sign-ups), carried by `topic_sync` from the marketing plan; without its own signal it closes as `chưa đo` two weeks after the check date, never scored. Topics gained `post_url`, `published_at`, `post_clicks`, `post_signups`.
- **company-loop: reader feedback through the contract.** The digest reads `cs.voc` with the `data` tool on scope `team:cs` and calls `signals {voc: true}`; the desk scrape with `CS_RUNTIME_TOKEN` runs only as the fallback (`voc: false`). The waiting-readers count still comes from the legacy `/admin/support` until R1.
- **marketing: radar filters before the model.** `radar_read` takes `keywords`, `lang`, `max_items` (at most 15), `wake_gap_hours` and `retire`; a source answering 429 rests a day and three failures switch it off (noted in `skipped`). The Lohi recipe reads daily, drops the English subreddits and retires their rows. `plan`'s `topic_posts` carries a published post's `published_at`, `url` and own `clicks`. `sources` gained `fails`, `retry_after`, `disabled_at`.
- **lohi-ops: `ops-comments` keeps harmless comments itself.** Short thanks, praise and emoji among the newest comments (never a reported one, never one with a link, contact or number run) are kept by `comments_pull` (`auto_kept`) and the model wakes only for comments that need a judgment.
- **marketing: restart-safe tools declare it.** `due`, `plan` and `channels_probe` stay `write` (a `read` tool cannot keep their bookkeeping rows) and now declare `run.rerun: "safe"`, so a call a restart cut settles itself (`auto_retry_safe`) instead of locking the resource; the pack schema accepts `rerun` (enum `"safe"`). A test pins which tools are re-runnable.
- **company-loop (storage version 3): a topic is not "done" when it is handed over.** `topic_next` now marks a topic `handed` (it was `taken`); the new chain step `topic_sync` (after `marketing.plan`) marks it `written` with the post id once a post with its keyword exists, and returns it to the queue when the 48 h hold ends with no post. New nullable column `topics.post`. Old `taken` rows read as `handed`. The Công ty page lists each topic's state on its opportunity card and in the next-step bar. `marketing.plan` (wake call) adds `topic_posts` (keyword and id of the newest posts). The Lohi example adds the `topic_sync` step to `marketing-plan` and grants it to the Writer.

## 0.11.18

Baseline: v0.11.17 (7c663b9). **Needs Soot 0.13.19 or later**: the team templates are group-template v3 (team contracts, member tool chains, a team budget) and the company compiler hands its file to `soot company check`, which older runtimes lack. Soot 0.13.19 pairs with Forge 0.11.18; packs that did not change still run on Soot 0.13.14 or later. Commits since v0.11.17: 342d79d (recipe grants RELEASE_TAGS), 36887c7 and de963b2 (lean Soot team, loop health), ed7f31b and 64a90c0 (lohi-ops), defa64b, 77775ff (teams as interfaces), 419ef31, ea025eb, 09a9018 (QA fixes), af75b4a and d3ebfc9 (contract copy, lohi-ops quiet schedules) and this release commit.

### Added

- **Team templates v3.** `team-insight`, `team-marketing`, `team-financial` and `team-op` are experimental, internal group templates with a contract per team (what it gives and takes, by level), member tool chains and a team budget. `groups/company-team` plus `scripts/company.mjs` compile a company template and a per-company overlay into the runtime's `company-template/v1` and hand it to `soot company check|create|adopt`; the runtime owns what a company is. Products, teams and remote runtimes follow the runtime's product model (D6): a team scopes `products`, and a cross-team read is contract-scoped and product-checked.
- **lohi-ops pack (a recipe slot).** Catalog health, crawl watch, comment moderation, App Store reviews, novel SEO and a pricing report for the Lohi recipe, with the `lohi-catalog` Soot and a deployment fragment. A missing `PRODUCT_ADMIN_KEY` or `CLI_CATALOG_DB` keeps schedules quiet and raises one Cần bạn item with the exact next step; catalog health and crawl watch wake on notify.
- **Lohi recipe: ADOPT.md.** The runbook to adopt a live workspace into teams: the runtime must run with `soot serve --watch` to apply the adopted file, and the leftover writer `content` table is documented.

### Changed

- **marketing (storage version 5).** A parked item never wakes the Soot again (per-item wake markers), a GSC reason is named, radar and video statistics are read by tools (`radar_read`, `signals`, `video_stats` via `yt-dlp`), `inputs_health` reports starving inputs, and the private content table is gone.
- **company-loop (storage version 2).** Cohorts and plans, `health_sync` and the Vòng lặp section of the Công ty page, which reads `soot teams health`.
- **Catalog: one 16 MiB manifest cap**, as the runtime.
- **Lohi recipe: lean team by job** (Ops, Writer, Analyst, Radar, Finance), Vietnamese team and contract copy, every compiled team carries a name and description (a team without one cannot be saved from Nest), escalation triggers ride as codes.
- **Recipe grants `RELEASE_TAGS`**, with a test that keeps the recipe granting every env its packs ask for; without it the company-loop 0.11.17 update waited for a person.
- **`setup.mjs` upgrades a Forge-installed pack by its release tag and data shape.** `versionOf` read a field no manifest has, so a live workspace never got the new tools. A local pack's own Soots and approvals join the workspace.

### Compatibility

- Needs Soot 0.13.19 for the team templates and the company commands; an installed workspace keeps working, and an update to marketing (storage 5) and company-loop (storage 2) is applied by `soot updates` or `setup.mjs`. `scripts/company.mjs` stays in this release; it is removed when `company.source.json` is written in the runtime's own format.

## 0.11.17

Baseline: v0.11.16 (ba4d1a3). **Needs Soot 0.13.14 or later**, as 0.11.15; Soot 0.13.18 or later pairs with it (Nest opens `nest://page/...` links from 0.13.18; an older Nest shows them as an unknown link). Commits since v0.11.16: 2299d02, 1879ffb, 6ab1248 (merge 1861b18) and this release commit. Packs changed: `company-loop`, `soot-nest` (skill text only) and the `lohi-marketing` recipe; no new pack and no catalog change.

### Changed

- **company-loop: the proposals ask opens Công ty.** The Cần bạn card "N cơ hội chờ bạn chọn" now ends its text with `nest://page/cong-ty`, so one click opens the Công ty page where Go, Để sau and Bỏ are.
- **company-loop: the weekly baseline counts releases.** `scoreboard_sync` counts the tags of `PRODUCT_REPO` created inside the finished week (ICT) and passes the number to `bbs company scoreboard record` as `--releases`. New optional env `RELEASE_TAGS` (comma separated git tag patterns, default `v*,*-v*`; each pattern must be 1 to 64 characters of letters, digits and `*._/-`); it is added to the pack's allowed env and README. With no `PRODUCT_REPO`, a relative path or a repo git cannot read, the count is left out and the rest of the baseline is recorded as before.
- **company-loop: a missing `PRODUCT_REPO` no longer breaks the bbs record.** When the path no longer exists, `bbs` runs from where the tool runs instead of failing the whole baseline.
- **company-loop: `CS_RUNTIME_TOKEN` description** now also says it reads the feedback desk (text only).
- **soot-nest: the `nest-links` skill documents page links** (`nest://page/<page>` and `nest://page/<soot>/<page>`; Nest 0.13.18+).
- **lohi-marketing recipe: the Video Soot only with the 2build pack.** The Video Soot selects the `2build` pack, which comes from `2found/2build`; without it the whole workspace failed to load. `setup.mjs` now adds the Video Soot only when `packs/2build` is installed in the workspace; `--video` insists and is refused with a message telling to run `soot add 2found/soot-forge/packs/2build` first, `--no-video` leaves it out, and `--video` with `--no-video` is refused. Run setup again after installing the pack to get the Video Soot. The person steps no longer repeat the `--product-repo` hint once it was given.

### Compatibility

- Additive. A live workspace keeps working; update `company-loop` with `setup.mjs` to get the new env and ask text. A workspace made by an earlier setup that has the Video Soot but no `packs/2build` is unchanged until setup runs again (which then drops the Video Soot, as it would have failed to load).

## 0.11.16

Baseline: v0.11.15 (34462c8). **Needs Soot 0.13.14 or later**, as 0.11.15; Soot 0.13.17 or later pairs with it (the chain wake carries the last step's output, and `soot update` can add the `desk` Soot of the Lohi CS deploy). Commits since v0.11.15: d725811 (merge 427acf2) and this release commit. One pack changed, `company-loop`; no new pack and no catalog change.

### Changed

- **company-loop: customer-service pain reaches the weekly digest.** `signals` now also reads what readers asked for or lacked from the CS runtime's feedback desk (`GET /v1/sessions?source=event`, conversations of the `desk` Soot, first message `Loại:` and `Tóm tắt:`, last 14 days, at most 40 notes). The packet gains `cs_feedback`: `n` counts by kind (feature_request, bug, complaint, question, feedback) and `ex` up to five samples per kind, each scrubbed (links, addresses, handles, number runs, long ids and order codes removed, 70 characters), at most 1 KiB; if the whole packet is over 3 KiB the samples go first and the counts stay. It is optional like `cs_gaps`: with no `CS_RUNTIME_URL` or token it is absent, a failure shows as `cs_error`. The `signals` tool timeout goes from 30s to 45s for the extra reads. The digest skill now ranks CS pain as evidence (a high `support.waiting_human`, a hand-over reason, a repeating `feature_request` or `bug`), cites it as `feedback:<kind>` or `metric:waiting_human` and never copies a sample word for word into a title.
- **company-loop: one Cần bạn ask when readers wait for a person.** The daily `scoreboard_sync` reads `support.by_state.waiting_human` from the scoreboard. At 5 or more it answers one ask (`ask`, `notify`, `wake`; key `company:support:waiting`, options "Đã xử lý" and "Để sau") that names where a person answers, once per change of the count bucket (5, 10, 20, 50); it keeps the bucket in the pack store. When fewer than 5 wait it answers `resolves_need: true` so the card closes by itself. Only counts are stored, never a reader. The digest-chain call (`for_digest`) never raises or closes the ask.
- **Env `SUPPORT_QUEUE_URL` (optional).** Where a person answers waiting readers (the Lohi admin support queue); named in the ask, with a plain fallback text when unset or not a valid URL. It is added to the pack's allowed env, to the Lohi recipe's `deployment.example.json` and to `setup.mjs` `HOST_ENV` (`https://lohi2.com/admin/support`). The recipe's `company-scoreboard` wake text now says the sync may have news about waiting readers, not only an unreadable scoreboard.

### Compatibility

- Additive: an installed workspace without `SUPPORT_QUEUE_URL` or the CS runtime keeps working; the ask names the product admin's support page in words. Update `company-loop` on a live workspace with `setup.mjs` to pick up the new env and the schedule text.

## 0.11.15

Baseline: v0.11.14 (c63356e). **Needs Soot 0.13.14 or later** for the new pack and the recipe (marketing storage version 4); Soot 0.13.16 or later is still what counts blog posts (see 0.11.14). Commits since v0.11.14: a2b79ee, 21d2fa3 and 99c94da (merge 6fbec46, branch loop-l1-pack) and this release commit.

### Added

- **New pack `company-loop`.** A product-neutral weekly loop: `scoreboard_sync` reads the product scoreboard (last 7 full days, `X-API-Key`) and stores a weekly row; `signals` builds a packet of at most 3 KiB that wakes the Lead; `digest_save` validates 1-5 opportunities (all or none), where a content opportunity goes by itself and queues a topic and a product one files one "Cần bạn" card; `decide` (Go, Để sau, Bỏ) writes `docs/requirements/REQ-<id>.md` in `PRODUCT_REPO` and runs `bbs team spawn`, never land, release, integrate or seal; `team_watch` (every 30 minutes) finds the bbs:team parent ticket from the team id, files one ask when a handover waits for the release go and, once released, records `requirement_shipped` and queues a launch topic; `topic_next` hands the next queued topic to marketing; `review` fills `actual_delta` after `check_after_days` (a hit is actual at least half of expected). The operator page "Công ty" (480 px, Vietnamese) shows one next-step bar, opportunities, handoffs, the decision log and the hit rate. Outcomes `opportunity_found` and `requirement_shipped`; settings `PRODUCT_ADMIN_KEY` (optional credential), `SCOREBOARD_URL`, `CS_RUNTIME_URL`/`CS_RUNTIME_TOKEN` (optional), `PRODUCT_REPO` (no default), `BBS_BIN`. Every optional input answers the quiet `skipped` shape; a refused key is one plain line. The pack is in the catalog (tags operations, collaboration).
- **Lohi recipe wires the loop.** The Editor gets `company-loop` (all tools but `decide`) and the Writer gets `topic_next`; four schedules `company-scoreboard` (daily 06:15, no model), `company-digest` (Monday 08:30), `company-watch` (every 30 minutes, 07:00-23:30) and `company-review` (Monday 08:00). `setup.mjs` installs the pack, writes `SCOREBOARD_URL` (`https://api.lohi2.com/admin/analysis/scoreboard`) and takes `--product-repo <absolute path>` and `--cs-runtime-url <url>`; without `--product-repo` a Go on a product opportunity reports there is no repository and opens no team. The Editor brief and the person steps in the recipe README say what the Lead does and what only the founder can tap.

### Changed

- **Marketing: a handed topic is kept.** `marketing.plan` keeps a topic handed to the wake call (`query` with `wake`) until a post about it exists or 48 hours pass, so the Writer's own plan call sees the same topic. No marketing tool was added; `packs/marketing/pack.json` is unchanged at 65,136 B.
- **AGENTS.md: the 32-pack limit** is stated for a runtime `packs_dir` and for a Soot's selection; the Forge `packs/` directory is a catalog source and is not bound by it.

### Concern

- `packs/marketing/pack.json` is still 65,136 B of the 65,536 B size limit (400 B left). The next addition to it needs trimming first.

## 0.11.14

Baseline: v0.11.13 (d934140). **Needs Soot 0.13.16 or later for the blog chain to count posts**: the chain's `lohi-blog_publish` step answers an `outcome`, which Soot 0.13.16 records (0.13.15 and earlier run the chain but leave `post_published` at zero); the Lohi recipe also needs 0.13.14 or later, as before (marketing storage version 4). Commits since v0.11.13: 71e6477 and 0e2f5b2 (Nest flows N6, merge c147437), f6d5223, 2af4860 and this release commit.

### Added

- **Marketing: `campaign_verify`.** One read-only request that says whether the saved Lohi admin key works (`ok`, `wrong_key`, `no_role`, `no_key`, `no_api`, `unreachable`) with a Vietnamese message; Nest shows it on the Thiết lập row. It never writes and never returns the key. The Lohi Editor is granted it.

### Changed

- **Lohi blog: an unpublish answers as a chain step.** `lohi-blog_unpublish` now answers `ok` and `intent_id` like publish (`ok` is true for `removed`), so `record` closes a removal in a tool chain. Tests cover claim to publish to record and unpublish to record.
- **Lohi recipe `setup.mjs` keeps a Forge-installed pack.** A pack with its install receipt (`.soot-source.json`) is left alone unless the recipe's copy is newer, and the receipt survives a copy, so `soot updates` no longer says a Forge pack was edited on this host.
- **Marketing page: a stalled draft shows after 30 minutes**, not 24 hours: Writer has stopped midway, and the row says to press Nhờ Writer hoàn thiện.
- **Marketing page: Đăng ngay in quiet hours promises the real time.** The row names the first moment Soot may post (`giờ yên 23:00–07:00`) instead of a minute that has passed.
- **Marketing page: 500-row reads and a narrow table.** Metrics reads in the campaign view and the performance insight are capped at 500 rows (the page cap), and the campaign table fits a 480 px screen.
- Tool descriptions of `cms_save`, `social_queue`, `social_list` and `due` are shorter; behaviour is unchanged.

### Concern

- `packs/marketing/pack.json` is 65,136 B of the 65,536 B size limit (400 B left; the 65,184 B guard held). The next addition to it needs trimming first.

## 0.11.13

Baseline: v0.11.12 (4a629bc). Needs Soot 0.13.14 or later, as 0.11.12 did (marketing storage version 4); nothing in this release needs Soot 0.13.15. Friction round 4: a failed post says why in plain words. Commits since v0.11.12: 74b3a41 (Nest flows N5, merge a3862dd) and this release commit.

### Changed

- **Marketing: failed posts read in words.** The publisher's own code (`git_failed`, `push_rejected`, `build_failed`, `deploy_failed`, `slug_taken`, `claim_*`, a missing `main` branch) no longer reaches the person on a post, in the queue or on a video row; each reads as a sentence. A reason already in Vietnamese is shown as written.
- **Marketing: a retry is promised for when it can go.** After a failed publish the queue time moves to the first slot outside quiet hours, not an hour from now, so the shown "Soot thử lại lúc ..." is true.
- **Marketing: paused channel headline.** A channel the person paused holds its posts; the queue headline names the switch ("Bật <channel>") instead of promising a next post that cannot go.
- **Lohi recipe `setup.mjs` copies exactly the release file set** (the rule of `scripts/archive.mjs`, tests omitted). A workspace copy then equals the Forge archive, so the runtime adopts it by digest instead of asking a person to apply an update.

### Concern

- `packs/marketing/pack.json` is still 65,184 B of the 65,536 B size limit (352 B left; unchanged). The next addition to it needs trimming first.

## 0.11.12

Baseline: v0.11.11 (1f480dd). **Needs Soot 0.13.14 or later**: the marketing pack's storage version 4 declares table `description`s, which Soot 0.13.13 refuses in `pack.json` (update Soot before the pack). The Lohi recipe needs 0.13.14 too.

### Breaking

- **`examples/lohi-marketing/setup.mjs` needs `--blog-remote <git url>`; there is no default blog repository any more.** Without it the workspace is still built, `LOHI_BLOG_REMOTE` is not written, the blog chain does not start and `lohi-blog_ready` raises one Cần bạn card ("Chưa chọn kho đăng blog"). The live workspace passes the real blog address; any test or scratch workspace passes a local bare repo, so it can never push to the real blog. `lohi-blog` also has no built-in default for `LOHI_BLOG_REMOTE`. Run setup again with the address if a workspace was built without it (setup rewrites the file).

### Added

- **Marketing page next steps.** Every post and channel shows what happens next in one plain sentence with the one button that matters, or "Không cần làm gì, Soot đang tự chạy". Bài viết has a Cần bạn tab (`filter` accepts `need` and `ready`), Hàng đợi opens with one headline, a signed-out channel carries "Đăng nhập <kênh>" (opens the platform sign-in page in Nest's browser pane), limits (`cap_per_day`, `spacing_min`, `reply_cap_per_day`) confirm before saving, Chiến dịch rows show their next step and "Mở Thiết lập" when the admin key is missing. `page_view` carries `next`; items carry their queue time.
- Vietnamese table `description`s on every marketing table (storage version 3 to 4, additive; the runtime fills bare descriptions on update, a description a person wrote stays), and a Kênh đăng bài settings page.

### Changed

- Page fixes: dialog above its scrim with focus, scroll to top, a request id per action, plain campaign errors and wording without jargon.
- Test only: the r2 chain test is no longer flaky.

### Concern

- `packs/marketing/pack.json` is 65,184 B of the 65,536 B size limit (352 B left). The next addition to it needs trimming first.

## 0.11.11

Baseline: v0.11.10 (7eab4f1). Needs Soot 0.13.13 or later for the Lohi recipe (schedule `then` chains, optional credentials and the `skipped` state).

### Added

- **Tool-only blog publish chain.** The `marketing-blog` schedule (every 10 minutes, 07-22) runs `due {channel}` -> `claim` -> `lohi-blog.publish` -> `record` with no model; it wakes the Editor only when a step fails (who then calls `marketing_fail`). `due` answers `{id, action}` or `{done:true}`; `claim` refusal adds `done:true`; `record` accepts the publisher's `ok` and `status`. `marketing-dispatch` skips the blog channel.
- **Ready drafts schedule themselves.** `plan` queues a `ready` draft older than one hour; a draft open over 24 hours no longer holds the slot and is reported once.
- **Social engine.** `plan` wakes the Writer for social drafts only when a signed-in, unpaused channel lacks a draft for a blog post published within 7 days; the brief carries per-channel links with UTM, character limits and subreddits. Nothing runs while all channels are paused or signed out.
- **Insight ranking.** Next topic by Search Console clicks, else campaign leads, else plain rotation; a genre written twice with no effect goes last. A `report` tool and a 21:00 `marketing-report` schedule give at most six plain lines.
- **`channels_probe`**, a tool-only sign-in probe (chain around `browser-use.control`) that unpauses a founder-confirmed channel only when it is really signed in and re-raises one that is signed out; backs off 12 h after two tries.
- **Page `set_limits`** edits a channel's `cap_per_day`, `spacing_min` and `reply_cap_per_day`.
- **Recipe `setup.mjs`** finds `.2server/connection.yaml` (LOHI_REPO, a parent checkout, then `~/.2server`) and writes `LOHI_CONNECTION` into the host env.

### Changed

- **Optional credentials.** Search Console and campaign credentials are optional: `gsc_sync` and `campaign_report {}` answer a quiet `{skipped:true, reason_code:'optional_credential', key}`; campaign operations on the page answer `needs_credential` with a link to Thiết lập, while reschedule, pull, restore, pause and `set_limits` need no key.
- **Leaner Editor.** `marketing:tools=...` (21 tools) and `lohi-blog:tools=publish,unpublish,find,ready`: 47 tools / 31,953 B down to 29 tools / 18,792 B; the Writer's `marketing:tools` list is 4,437 B.
- `lohi-blog_ready`, `marketing_due` with no needs and a signed-in probe answer `resolves_need:true`, so the matching Cần bạn item clears itself.

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
