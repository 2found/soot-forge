# Company loop

Runs a product's weekly loop: the scoreboard (insight), opportunities, the founder's
Go, a requirement handed to `bbs:team` (build), topics for marketing, and the review
that checks what really changed. It is product-neutral: the product, its scoreboard
address and its repository are configuration, never code in this pack.

Needs Soot 0.13.14 or later.

| tool | what it does | model |
| --- | --- | --- |
| `scoreboard_sync` | reads every scoreboard source (`SCOREBOARD_URL`, then each `SCOREBOARD_URLS` entry; last 7 full days, frozen contract v1, `X-API-Key`), stores a weekly row per product and appends it to the bbs company baseline. One source failing does not stop the others | none (tool-only) |
| `metrics_record` | a Soot writes a product's numbers for one period into this pack's `metrics` table (no scoreboard address needed); the page shows them with their own labels, units and targets | the Soot that reads the numbers |
| `goals_checkin` | gives every active goal whose `metric.ref` is `<product>:<key>` (`2novel:activated_new`) or `company-loop:<key>` (the goal's product, else the host's) its reading: that product's newest stored period, from its `SCOREBOARD_URLS` scoreboard or from `metrics_record`. Checks in once per goal and period through the workspace `soot goals checkin` (`LOOP_SOOT_CONFIG`, confidence 5: a measurement, not a forecast), skips a goal whose cycle has not started, and reports guardrail refs against their limit without recording them. Chain it after `scoreboard_sync`; `dry_run` reads without writing. Without a reachable `soot` it answers the quiet `skipped` shape | none (wakes the Lead only when a check-in fails) |
| `signals` | a compact packet (at most 3 KiB: metrics, sources, support reasons, optional CS gaps, open opportunities, decisions, launches, `parts`, `moats`, `awareness`) that wakes the Lead. `signals {product}` builds it from that product's board only and narrows opportunities, decisions, handoffs and topics to it (the page's row rules); without `product` it behaves as before. `parts` is `[{p, st, m, pct, own}]` (`st` ok/hong/chua_do, `own` = owning team id or null); the trim keeps `parts` last | wakes the Lead |
| `digest_save` | validates 1-5 opportunities (all or none; the error names the field). Tags: `part` (required: `value\|marketing\|sales\|delivery\|finance`), `awareness` (required for `content`, optional for `product`: `unaware` = nấc 1, `problem` = nấc 2, `choosing` = nấc 3), `moat` (optional: `scale\|network\|counter\|switching\|brand\|cornered\|process\|none`, absent = none), `pain` (required for `product`, 10-200 chars: who suffers from what, from customer evidence). `part` and `moat` carry onto `decisions` rows, `awareness` onto `topics` rows; content opportunities go by themselves and queue a topic, product ones are proposed with one "Cần bạn" card | Lead |
| `decide` | Go, Để sau or Bỏ. A product Go writes `REQ-<id>.md` beside the tickets (`$BABYSIT_HOME/requirements/<repo name>/`, else `~/.babysit/...`; the product working tree is never written, a file a person already put in `docs/requirements/` is used as is), runs `bbs team spawn`, and answers with where the team works, what it needs from the founder and that the release go is given in the team's Orca terminal; it never lands, releases, integrates or seals | operator approval |
| `team_watch` | every 30 minutes (a `draft_ready` handoff too: it moves on by itself once the team exists, and raises one reminder with the command after 2 h if it never starts) finds the parent ticket from the team id (`bbs ticket find --json`, then ticket files) and reads `bbs team snapshot`; a handover waiting for the release go files one Cần bạn ask; a released team records `requirement_shipped` and queues a launch topic | none |
| `parts_set` | `{product, parts: [{part, team?, team_name?, metric?, good?, promise?}]}`: who owns each of the 5 parts and which scoreboard metric watches it (`promise` <= 120 chars: the short public promise, for delivery or brand). 1-5 per call, all or none, upserted by `product\|part`; a missing field keeps its value, `""` clears it. The founder does the same on the page (`page_action part_set`). Without a row a part watches a default metric, only if the board has it: value = the north star, marketing = `signups`, sales = `first_payers` then `revenue_vnd`, delivery = `support_threads_new` (down is good), finance = `revenue_vnd`; no owner reads "chưa giao" | the Soot that sets it |
| `topic_next` | the next queued topic, marked `handed` (given to marketing, nothing written yet; carries `awareness` when the topic has one), for the marketing plan (`chain: true` gives the query only (plus `awareness`), one handed topic at a time, at most one a day) | none |
| `topic_sync` | last chain step after `marketing.plan` (`input_from: previous`): a handed topic whose keyword now has a post becomes `written` with the post id; one still unwritten after the 48 h hold returns to `queued`. Old `taken` rows are treated as `handed`. Passes the plan's output through | none |
| `review` | weekly: fills `actual_delta` once `check_after_days` have passed; a hit is actual at least half of expected. A product change is measured on the scoreboard from its release; a content post from its **publish date** on its **own** signal (Search Console or campaign-link clicks, or attributed sign-ups, carried by `topic_sync` from the marketing plan); with no signal of its own it waits two more weeks, then closes as `chưa đo` and is never scored | none |
| `health_sync` | daily, no model: stores the loop-health view. Takes the marketing pack's `inputs_health` as `input_from: previous`, asks the workspace's `soot` CLI (`schedules list`, `traces list --since 7d`, `attention list`, read-only) for each stage's last run and tokens, counts the founder's decisions and chat instructions. Without a reachable CLI the inputs are still stored and the runtime part says why | none |
| `page_view`, `page_action` | the operator page "Công ty" (full width up to 1120 px, one column on a phone, Vietnamese, Nest tokens only), narrowed to one product (Nest's scope, or the page's own switch with 2+ products) and saying what it leaves out: one next step with the place to act (`nest://` links), Cần bạn, the scorecard (north star with trend and target, tiles), what happens after Go, the decision log with verdicts and hit rate, and a "Vòng lặp" section: per stage (insight, build, marketing, CS) the last run, tokens in 7 days, the starving inputs (GSC 0 dòng, chưa có tín hiệu thị trường, chưa có số TikTok) and the founder's effort. A "Khám 5 bộ phận" section after the scorecard shows each part's owner, metric with trend, status (Ổn / Hỏng / Chưa đo), promise, and an "Đổi" control; opportunity and decision rows show part, nấc and moat chips and one line "Hào đang xây". When a part is `hong` and nothing needs the founder more, it is the next step. The scoreboard's additive `cohorts` and `plans` show as "chưa có" until the product serves them | none |

The scoreboard may add `cohorts` (`cohort` ISO week, `signups`, `active_w1/w2/w4`, `first_payers`) and `plans` (`tier`, `started`, `active`, `revenue_vnd`); both are optional and anything malformed is dropped.

**Part health** (one pure function, `partHealth` in `tools/lib/parts.mjs`, shared by `signals` and the page): per part, `hong` when its metric moved the bad way by 10% or more **and** by at least 3 units against the previous period (a target is shown, never a reason on its own: a stretch target is not a broken part, and 1 → 0 on a small product is noise); `chua_do` when the metric has no value on the latest board; else `ok`. A part without an owner is also `chua_giao`.

Storage (version 5): `scoreboard`, `opportunities` (+ `part`, `awareness`, `moat`, `pain`, `goal`), `decisions` (the CL4.3 fields, + `part`, `moat`, `goal`), `handoffs`, `topics` (+ `awareness`), `state`, `metrics`, `parts`. All new columns are nullable: a row from before version 5 reads as "chưa gắn" and is never dropped. `decisions`, `handoffs` and `topics` carry `product` since version 4; rows written before it are never dropped: they read as their opportunity's product, else the host product, and are labeled on the next sync or page action.
**Goal ref (optional).** `digest_save` accepts `goal` per item: the id of the company goal the bet is meant to push (1-64 characters of letters, digits and `_ . : -`; anything else is refused naming `goal`). The pack only carries the string: the opportunity and every decision about it keep it, `review` leaves it untouched, `signals` repeats it as `g` on a decision that has one, and the page shows it. The pack never fetches goals; the runtime's `goal` tool owns them. Insight reads `decisions` with their `goal` at a cycle review to compare each goal's bets with `actual_delta`.

Outcomes: `opportunity_found`, `requirement_shipped`.

| setting | kind | meaning |
| --- | --- | --- |
| `PRODUCT_ADMIN_KEY` | credential, optional | scoreboard key (role `agent_mod`); sent only as `X-API-Key` to the single `SCOREBOARD_URL` (https or this machine), never to a `SCOREBOARD_URLS` source |
| `SCOREBOARD_KEYS` | credential, optional | one key per product API: `product=key` entries split by comma or newline. A `SCOREBOARD_URLS` source sends only its own product's entry as `X-API-Key`; a source with no entry sends no key (its 401/403 reads as the plain "key refused" line naming the product). A malformed entry (bad product id, key shorter than 8 characters or with spaces, duplicate) is skipped. Keys are never logged or returned |
| `SCOREBOARD_URL` | env, optional | the host product's scoreboard endpoint; its product is the board's own `product` field. Unchanged from before products |
| `SCOREBOARD_URLS` | env, optional | more products' scoreboards: `product=https://…` entries split by comma or newline (`sach-hay=https://api.example.com/admin/analysis/scoreboard`). Product ids are `[a-z0-9][a-z0-9_-]{0,63}`; the mapping wins over the board's own label; a bad or duplicate entry is skipped and counted. Each source has its own key in `SCOREBOARD_KEYS` (a product's key is never sent to another product's API) |
| `NORTH_STAR` | env, optional | the headline metric: `key` for every product or `product=key,…` per product. Default: a recorded metric flagged `north_star`, else `revenue_vnd`, else the first |
| `CS_RUNTIME_URL`, `CS_RUNTIME_TOKEN` | env, credential, optional | support knowledge gaps (`/v1/settings/knowledge`) and, only as a fallback when the team contract item `cs.voc` is unavailable, the feedback desk (`GET /v1/sessions?source=event`, desk Soot notes: counts by kind plus up to 5 scrubbed samples each, ≤ 1 KiB) for the digest |
| `SUPPORT_QUEUE_URL` | env, optional | where a person answers waiting readers (the waiting-readers count still comes from the legacy `/admin/support` through the scoreboard until R1 retires it; do not remove it before then); named in the daily Cần bạn card (`waiting_human` ≥ 5, once per count bucket 5/10/20/50, closed with `resolves_need` below 5) |
| `RELEASE_TAGS` | env, optional | git tag patterns of a release in `PRODUCT_REPO` (comma separated, default `v*,*-v*`); the week's count goes to the company baseline as `--releases`, the shipping cadence §7 holds the loop to |
| `LOOP_SOOT_BIN`, `LOOP_SOOT_CONFIG` | env, optional | the `soot` binary (default: PATH, then `~/.local/bin/soot`) and the absolute path of this workspace's `deployment.json`; only for `health_sync` |
| `PRODUCT_REPO` | env, optional, no default | absolute path of the product checkout the build team works in (it is not written by a Go). Without it there is no build stage: a product Go records the decision and a task (see below) |
| `BABYSIT_HOME` | env, optional | the ticket home where requirement files are written (default `~/.babysit`) |
| `BBS_BIN` | env, optional | the `bbs` binary (default: PATH, then `~/.local/bin/bbs`) |

Reader feedback for the digest comes from the team contract item `cs.voc` (the digest skill queries `data` on scope `team:cs`, table `voc`, then calls `signals {voc: true}`); `signals {voc: false}` or no argument runs the legacy desk scrape when `CS_RUNTIME_TOKEN` is set.

Every optional input answers the quiet `skipped` shape when missing. A refused key is one
plain line naming the key's role. With `bbs` absent a Go is `draft_ready` and shows the
command. The pack grants nothing by itself: the Lead Soot selects it with
`company-loop:tools=...` and the Writer only needs `topic_next`.

## Using it for another company

Nothing here assumes Lohi. A company sets only what it has:

1. **Numbers.** Either a scoreboard per product over HTTP (`SCOREBOARD_URL` for one, `SCOREBOARD_URLS` for more; the frozen v1 contract: `{version: 1, product, range: {from, to}, metrics: {<key>: {label, unit, value, previous}}}`), or no address at all: a Soot that can read the numbers elsewhere (a sheet, a payment dashboard, a data table) calls `metrics_record` once a week. Both can be used together; for the same period the HTTP number wins for a key it has and recorded keys fill the rest.
2. **Labels and units come from the data.** The ten contract keys (`revenue_vnd`, `signups`, …) keep their Vietnamese words as defaults; any other key shows its own `label`, `unit` (`vnd`, `usd`, `eur`, `percent`, `count`, or any short word such as `điểm`), `good` (`up`, or `down` for churn-like numbers) and `target`. `NORTH_STAR` picks the headline.
3. **Build is optional.** Without `PRODUCT_REPO`, a product Go writes the decision log row and a handoff in state `task`: the page shows "Việc đã ghi" with "Giao việc" (a drafted Nest conversation, `nest://new?text=…`) and "Đánh dấu đã xong" (`page_action {op: "task_done", id}`), which starts the outcome clock as a release would. Older `no_repo` rows without a repository read as tasks. With a repository but no `bbs`, the Go is `draft_ready` with the command, as before.
4. **Products.** Nest sends the selected product to the page (`context` bridge message, soot-pages §5); an older Nest sends none and the page shows every product the data names. `page_view` takes `{page, product?, host?, products?}` and answers `scope: {product, host, products[{id, name, waiting}], left_out{opportunities, handoffs, decisions, topics}, unlabeled}` and, for every product with numbers, `boards[]` (one compact row each; numbers of different products are never summed).

`metrics_record` input (one product, one period of at most 31 days, all or nothing):

```json
{ "product": "acme", "period": { "from": "2026-11-02", "to": "2026-11-08" }, "source": "Bảng Stripe tuần",
  "metrics": [
    { "key": "mrr_usd", "value": 9900, "label": "Doanh thu định kỳ", "unit": "usd", "target": 12000, "north_star": true },
    { "key": "churn_pct", "value": 2.9, "previous": 3.0, "label": "Tỉ lệ rời bỏ", "unit": "percent", "good": "down" }
  ] }
```

The `metrics` table: one row per `product`, period and metric (`key` = `product|from..to|metric`; writing again replaces it), with `period_from`, `period_to`, `metric`, `label`, `unit`, `value`, `previous` (absent: the previous period recorded here), `target`, `good`, `north_star`, `source`, `recorded_by` (the Soot), `recorded_at`. Aggregates only, never a person. Grant it to the Soot that reads the numbers: `company-loop:tools=metrics_record`, and schedule that Soot weekly.

A goal's number needs no code in Soot or in this pack: the product serves the key (or a Soot records it), the goal names it as `<product>:<key>`, and `goals_checkin` does the rest. Schedule `scoreboard_sync` with `then: goals_checkin` weekly.

Tests: `node --test packs/company-loop/tests/*.test.mjs`. See the
[Lohi recipe](../../examples/lohi-marketing/README.md#the-company-loop-insight-build-marketing-support-insight)
for the schedules.
