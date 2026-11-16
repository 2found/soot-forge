# lohi-ops

Lohi operations beyond marketing. **This directory is the source of truth** (it was a snapshot of the
Mac's local pack under `runtimes/mac/config/packs/`). One pack, two Soots on two runtimes
([TEAMS.md](../../TEAMS.md)):

- **`curator`** (operations team, server runtime soot.lohi2.com): catalog quality, duplicates, the request /
  edit / violation queues, enrichment, Litrans health, comments, App Store reviews, SEO, pricing. HTTP only.
- **`builder`** (workshop team, the founder's Mac): runs the crawler jobs the curator asks for, and
  `crawl_watch` (reads the cli's local SQLite, so it is **builder-only**: never grant it to a server Soot).

Skills: `lohi-ops-curator` (daily routine, what it decides alone vs asks a person), `lohi-ops-release` (Catalog Exec's release gate, the only skill its wake reads), `lohi-ops-builder`
(catalog jobs), `lohi-ops-moderation`, `lohi-ops-reviews`.

## Tools

| Tool | Mode | Approval | Runs on | Source |
| --- | --- | --- | --- | --- |
| `catalog_health` (stale, gaps, thin, untranslated, **quality**) | write (findings, card) | - | curator | api `GET /admin/analysis/catalog-health` |
| `quality_list` | read | - | curator | same, `check=quality&problems=cover,synopsis,genres,chapters` |
| `duplicates_scan` | write (findings `dup:*`) | - | curator | api `GET /admin/analysis/catalog-duplicates` |
| `litrans_health` | write (findings, card) | - | curator | api `GET /admin/analysis/litrans-health` |
| `reports_open` | read | - | curator | api `GET /novel/agent/content-reports/open` (room reports the check could not act on, grouped by novel and 10-chapter window) |
| `fixes_run` | write (`fix_checks`) | - | Catalog Exec | api `GET /novel/agent/support-actions` then `POST …/:id/execute` for each runnable task, no model; `to_review` wakes the model (WP7) |
| `fix_context` | read | - | Catalog Exec | api `GET /novel/agent/support-actions/:id/context` (issue, summary, reporter count, chapter text; never who reported) |
| `fix_resolve` | write (`fix_checks`) | - | Catalog Exec | api `POST /novel/agent/support-actions/:id/resolve` (replace / revoice / recrawl / not_reproduced / needs_person) |
| `requests_pending` | read | - | curator | api `GET /novel/agent/requests/pending` |
| `request_accept` (approve, done, merge) | write | - | curator | api `POST /novel/agent/requests/:id/{approve,done,merge}` |
| `request_reject` | write | operator | curator | api `POST /novel/agent/requests/:id/reject` |
| `edits_pending`, `edits_context` | read | - | curator | api `/novel/agent/edit-queue`, `/edit-suggestions/:id/context` |
| `edit_verdict` | write | - (a verdict; the api applies its trust policy) | curator | api `POST /novel/agent/edit-suggestions/:id/verdict` |
| `violations_list` | read | - | curator | api `GET /novel/agent/violation-reports` (reporter never shown) |
| `violation_resolve` (acknowledge, dismiss non-copyright) | write | operator | curator | api `POST /novel/agent/violation-reports/:id/resolve` |
| `enrichment_enqueue` | write | - | curator | api `POST /novel/agent/enrichment/novels` |
| `comments_pull`, `comments_decide` | write | - (hides only spam/abuse/scam at confidence >= 0.9) | curator | api `/admin/moderation/replies` |
| `comments_resolve` | write | operator | curator | same |
| `appstore_sync`, `appstore_draft`, `appstore_drafts` | write | - | curator | Apple public feed |
| `appstore_post` | write | operator | curator | App Store Connect (`ASC_API_KEY`) |
| `seo_report`, `pricing_report` | read | - | curator | Search Console; api scoreboard |
| `catalog_job_request` | write (`catalog_jobs`) | operator | curator | pack table |
| `catalog_jobs_sync` | write | - | curator | its own queue table `catalog_job_events`; posts request stages (curator key); the radar policy |
| `catalog_jobs_pull` (`autorun`), `catalog_job_run`, `catalog_job_report` | write | - (the job was approved) | builder | runtime CLI `soot data query/insert`; runs cli plans via `tools/job-runner.mjs` |
| `radar_scan` | write (state, queue events) | - | **builder only** | cli radar + SQLite; reports new chapters as `radar` events |
| `crawl_watch` | write (findings, card) | - | **builder only** | cli SQLite (`CLI_CATALOG_DB`) |

Every list is paginated (cursor or offset in the answer). Findings go to the `findings` table (`check`:
stale, gaps, thin, untranslated, quality, duplicate, litrans).

## Catalog jobs (curator -> builder)

`catalog_jobs` (pack table, operations team): `product`, `kind` (crawl | onboard | refresh | repair),
`subject` (`<source>/<novel>`, a repair adds `#<from>-<to>`), `reason`, `state`
(requested | approved | running | done | failed), `approved_by`, `result`, `at`.

1. The curator calls `catalog_job_request`. It waits for an operator's approval of the exact request; the
   approved call writes the row as `approved` (`approved_by: operator`). `requested` is reserved for a
   policy that lets a card approve instead.
2. The builder (Mac) `catalog_jobs_pull` -> `soot data query --team operations --item catalog_jobs
   --filter '{"state":"approved"}' --json`. With `autorun: true` it also starts what it finds (at most `max_start`), as a
   **plan** (`plan.json`, argv arrays validated against the cli's slug and range shapes, no shell) interpreted by a detached
   `node tools/job-runner.mjs <dir>` with the cli as cwd. It appends the cli output to `log`, then writes `result.json`
   (state, novel_slug, chapters, copyright) and `exit` under `$SOOT_PACK_STATE/catalog-jobs/<id>/`; the next pull reports
   the end from them. The plans (`tools/lib/runner.mjs`):
   - `crawl`: `crawl catalog run`; a refresh with no chapters: `crawl catalog radar`.
   - `refresh` A-B: `onboard --chapters A-B --chapters-only --no-announce [--request-id]`; `repair`: the same plus `--overwrite`.
   - `onboard` of a new novel: [crawl 1-10 if absent] -> `onboard --dry-run` -> `crawl catalog copyright` -> read
     `source_catalog.copyright_issue` -> `blocked_copyright` (never published) or the real run, with `--request-id --keep-draft` for a request.
   `catalog_job_run {job_id}` runs one job the same way; `catalog_job_report` is only for a job somebody ran by hand.
   *Why a plan and not a model:* these are the same commands the `novel-onboard` skill ran, in the same order, so they cost nothing
   to run and cannot drift; the single judgment left is below.

### Which novel is a request about (no blind onboarding)

The cli has no "link -> source and novel" command and no title search; `source_catalog` (SQLite) is the only map it keeps.
`tools/lib/resolve.mjs` therefore decides from that catalog and from nothing else:

| The request has | Resolved how | Otherwise |
| --- | --- | --- |
| a refresh with its prod `novel_slug` | the one `is_prd_sync` row with that slug (several sources: the one holding the wanted chapters) | `failed` `no_source` |
| a link (`source_url`) | the row whose `landing_url` equals it (https, host without `www`, no query or trailing slash) | **`needs_source`**: the link's host names a source pack (`sources/*/config.json base_url`), the model derives the novel id by the link alone and answers `catalog_job_run {job_id, source, novel}`; unanswered for 24 hours it ends `failed` `no source` |
| a title only | exactly ONE row whose accent / case folded title (or Chinese title) equals it, 6 characters or more | `failed` `no_source` |

A vague title (two sources carry it, none does, it is too short) is **never** onboarded: it ends the job `failed` with the detail
`no source: ...`; `catalog_jobs_sync` posts the request stage `failed` with cause `no_source` and one fixed reader line asking for a link
(`NO_SOURCE_NOTE`); the api refunds every donation once and shows that line. A request with no link at all is softer: 12 hours after the pack
first saw it, `requests_pending` calls `POST /novel/agent/requests/:id/ask`, which moves it to `needs_source` and notifies the requester and
supporters — the request stays open. Only a request nobody answers within 3 days ends `failed` / `no_source` and is refunded. A reader who
sends the link gets a normal onboard.

### Auto-ingest of new chapters

All tool-first; no model unless something fails.

1. `radar_scan` (builder Mac, every 2 hours): one detached sweep at a time over `is_prd_sync` novels that are not finished, not
   copyright flagged and not on metruyenchuvn (at most 60 per sweep, continuing from where the last stopped, one `crawl catalog radar` per source).
   On the next call it harvests: a novel flagged `has_new_chapters` whose last chapter grew past what it reported before becomes a `radar:<source>/<novel>`
   event in `catalog_job_events` (state `radar`, `chapters` = last chapter). The Mac cannot insert jobs, only events.
2. `catalog_jobs_sync` (curator) is the policy (`ingestRadar`): for each find, the api's `GET /novel/agent/novels/:slug/litrans/status` must show
   at least 1 active reader (`RADAR.minActiveReaders`); then ONE `refresh` job is inserted `approved` with `approved_by: policy:radar`, subject
   `<source>/<novel>#<last-49>-<last>`, at most 10 per ICT day (`RADAR.dailyJobs`); the rest wait for the next day, an unreachable api keeps the
   find, a novel with an open refresh or without readers is dropped.
3. The builder's autorun runs the refresh (onboard imports only the chapters prod lacks, with `--no-announce`).
4. `catalog_jobs_sync` sees the done event and queues the added chapters in `translations` (first batch of 10 now, the rest in `rest_from` / `rest_to`,
   `announce: true`). `translate_step` translates them inside the api caps (10 per call, 20 per novel and 200 per day; a 429 waits) and chains the rest in batches of 10
   **only** when the api says the novel has the readers past the first batch (`beyond_first_batch_allowed`, 30 active readers in 7 days); otherwise
   the rest is dropped with a note. Each translated batch is announced to the readers through `POST /novel/agent/onboard/novels/:slug/chapters/announce`
   (the same room announcement the cli skipped with `--no-announce`). A stopped translation is one Cần bạn card.

### Quality requests

A reader's quality complaint is mailed by the curator to Catalog Exec (work mail, `task` op `send`, `wait: true`; Catalog Exec's `soot:<id>`
comes from the `team` tool, op `members`, never from the skill). The mail holds the novel, chapters, the complaint and what the reply must hold;
Catalog Exec re-samples (`quality_sample`), retranslates inside the caps (`chapter_retranslate`, 20 a day), rechecks and replies with the outcome word first
(`Xong:`, `Xong một phần:`, `Thiếu:`, `Không nhận:`, `Không làm được:`); the curator closes the request from the reply (`request_finish`). Both are skills over
existing tools: a deterministic helper would only wrap one `quality_sample` call, so none was added.

### Token budget (Catalog Exec loop)

| Schedule | Tool | Wakes the model when | Budget per wake |
| --- | --- | --- | --- |
| `ops-translate-step` | `translate_step` | never (cards) | 0 |
| `ops-release-step` | `release_step` | a sample waits for a verdict, once per 6 h | 12k |
| `ops-fixes` | `fixes_run` | a review task, once per task | 10k |
| `ops-fix-recheck` | `fix_recheck` | never (cards) | 0 |

Builder: `ops-catalog-jobs-pull` wakes on `needs_source` or a job that cannot start; `ops-radar-scan` only on a failed sweep.
Curator: `ops-catalog-jobs-sync` wakes only when a job FAILED (a done job, a radar find or a copyright stop does not).
3. Events (`running`, `done`, `failed`, `blocked_copyright`, with a short detail; done events carry `novel_slug` and `chapters`) are inserted into the queue
   `catalog_job_events` of the operations team. The curator's `catalog_jobs_sync` folds them back into
   `catalog_jobs`; it wakes the curator only when a job failed.

`soot data` (soot ≥ 0.16.0): the builder reads with `soot data query --team operations --item catalog_jobs
--filter '{"state":"approved"}' --json` (answer `{rows, total, next_offset}`) and reports with `soot data insert
--team operations --queue catalog_job_events --row '<json>' --json`. The queue is the operations team's own pack
table, so the curator's `catalog_jobs_sync` reads it in place from a cursor; only the builder needs the runtime
scopes. Both calls live in `runSoot`/`queryItem`/`insertItem` in `tools/lib/jobs.mjs`.

## The request loop

Intake to outcome, tool-first (no model unless judgment is needed):

1. `requests_pending` (types novel, chapters, quality; paid first) attaches published novels and merges exact duplicates itself. A `novel` request
   that reached the api's auto-onboard score and holds one of the day's slots (`auto_onboard`; 20 points, 5 a day, both served by the api) is
   approved and its onboard job opened already `approved` (`approved_by: policy:auto_onboard`), once per request: no daily card, no model.
2. `request_accept {action: approve, kind}` opens the catalog job (`request_id`, title, source_url, novel_slug, chapters). Refresh of an existing
   novel is born `approved`; onboard of a new novel is `requested` until the single daily card (`onboard_card`, raised by the schedule only; its buttons run `catalog_jobs_answer`, which acts on the jobs stored under the card's one-time nonce; `catalog_jobs_decide` is the gated chat path).
3. The builder runs it non-interactively (plans above: onboard dry-run 1-10, copyright check, real run; a match is `blocked_copyright` and nothing is published).
4. `catalog_jobs_sync` queues the first 10 chapters in `translations`; `translate_step` asks Litrans (api caps: 10 per call, 20 per novel and 200 per
   day), pulls, then marks the chapters request translated so requesters are notified. Every request that leaves the queue leaves a row in `request_outcomes`.
   Each step posts the request's `stage` to the api (`POST /novel/agent/requests/:id/stage`): `translating` on a done onboard, `failed` with a
   cause (`blocked_copyright`, `no_source`, `failed`) on a stopped one, which refunds every LT donation once on the api.
4b. Release gate (new novels from a request): instead of closing the request, `translate_step` moves it to `quality`. `release_step` (every 30
   minutes, no model) wakes Catalog Exec when a sample waits; it reads `quality_sample` (≤ 10 chapters: length vs source, leftover Chinese,
   Book Bible names, audio) and posts `quality_verdict`. Pass: the api dispatches pro TTS for the batch, platform-paid inside its daily cap
   (`GET /novel/agent/policy` `releaseAudio`; past it the audio is deferred and `release_step` retries), stage `audio`; once every sampled chapter
   has audio `release_step` marks the request `released` and `done` (the api tells the readers). Fail: one retranslate of the flagged chapters,
   sampled again; a second fail is one Cần bạn card. State lives in the pack's `state` table under `release:<slug>`.
5. Fixes: `fixes_pull` / `fix_execute` (support actions) and `chapter_retranslate` / `chapter_tts` (20 per day each) are re-checked by `fix_recheck`; a fail or a
   wide scope is one Cần bạn card. Names and pronoun batches stay with a person.

Approval policy (in `deployment.fragment.json`): automatic for refresh of an existing novel, translate of 10 chapters or fewer and a one-chapter fix inside the
caps; a person for onboard of a new novel (daily card) unless it reached the api's auto-onboard score, any takedown or overwrite, and money or accounts. `catalog_jobs_decide` is operator-approved.

## Agent roles (least privilege)

A Lohi agent key carries exactly one role ([docs/AGENT-KEYS.md](../../../../docs/AGENT-KEYS.md) in kiem-lai; the api's
`agent-access/policy.ts` is the authority and `GET /novel/agent/skills` serves it). Each tool declares the role it needs
in `tools/lib/roles.mjs`, and a refused call (403) names that role, not "agent_mod".

| Role | Tools |
| --- | --- |
| `agent_analyst` (or `agent_curator`) | `catalog_health`, `quality_list`, `duplicates_scan`, `litrans_health`, `pricing_report` |
| `agent_moderator` | `comments_pull`, `comments_decide`, `comments_resolve`, `violations_list`, `violation_resolve` |
| `agent_curator` | `requests_pending`, `request_accept`, `request_reject`, `edits_pending`, `edits_context`, `edit_verdict`, `enrichment_enqueue` |
| `agent_catalog_exec` | `translate_start`, `translate_step`, `fix_execute`, `fixes_run`, `fix_resolve`, `chapter_retranslate`, `chapter_tts`, `quality_verdict`, `release_step`; `request_finish` (also `agent_curator`) |
| any of exec / curator / analyst | `fixes_pull`, `fix_recheck`, `fix_context`, `quality_sample`, `reports_open` (reads) |
| `agent_curator` | also `catalog_jobs_sync` (request stages, radar policy status reads) |
| no Lohi key | `onboard_card`, `catalog_jobs_answer`, `catalog_jobs_decide`, `fix_ack`, `catalog_jobs_pull`, `catalog_job_run`, `catalog_job_report`, `catalog_job_request`, `radar_scan`, `crawl_watch`, `seo_report`, `appstore_*` |

A Soot gets one key, so the tools granted to one Soot must fit its key's role. The deprecated `agent_mod` key passes
every row except `agent_catalog_exec`'s spend tools.

## Wiring

- Env: `PRODUCT_API_URL` (https://api.lohi2.com), `CLI_CATALOG_DB` (builder: absolute path to
  `cli/data/catalog.db`; Node >= 22.5), `CLI_DIR` (builder: absolute path to the `cli/` checkout), `SOOT_BIN`
  (optional), `APPSTORE_APP_ID` (default 6795186131), `APPSTORE_COUNTRY` (default vn), `GSC_SITE`, `SITE_URL`.
- Runtime scopes (`needs.runtime`): `data.read`, `data.insert`; the host grants them in `grants.packs`.
  Without the grant the job tools answer a quiet `skipped` (`no_runtime`).
- Credentials, all optional (a missing one is a quiet `skipped` on schedules and raises ONE Cần bạn item
  naming the key): `PRODUCT_AGENT_KEY` (the Soot's own Lohi agent key, one role, sent only to `PRODUCT_API_URL` over https;
  falls back to the deprecated shared `PRODUCT_ADMIN_KEY`, an `agent_mod` key, until the keys are rotated),
  `GSC_GOOGLE`, `ASC_API_KEY`.
- [deployment.fragment.json](deployment.fragment.json): `server` (curator: tools list, approvals, schedules) and
  `mac` (builder). Approvals: `appstore_post`, `comments_resolve`, `request_reject`, `violation_resolve`,
  `catalog_job_request`. No secret values are in it.
- Reviewer names are never stored. Comment text is stored only as a 160-character excerpt with an opaque id.

Tests: `node --test "2found/soot/packs/lohi-ops/tests/*.test.mjs"` (mocks only; no network, no real api, no soot).
