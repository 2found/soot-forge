# Company loop

Runs a product's weekly loop: the scoreboard (insight), opportunities, the founder's
Go, a requirement handed to `bbs:team` (build), topics for marketing, and the review
that checks what really changed. It is product-neutral: the product, its scoreboard
address and its repository are configuration, never code in this pack.

Needs Soot 0.13.14 or later.

| tool | what it does | model |
| --- | --- | --- |
| `scoreboard_sync` | reads the scoreboard (last 7 full days, frozen contract v1, `X-API-Key`), stores a weekly row and appends it to the bbs company baseline | none (tool-only) |
| `signals` | a compact packet (at most 3 KiB: metrics, sources, support reasons, optional CS gaps, open opportunities, decisions, launches) that wakes the Lead | wakes the Lead |
| `digest_save` | validates 1-5 opportunities (all or none); content opportunities go by themselves and queue a topic, product ones are proposed with one "Cần bạn" card | Lead |
| `decide` | Go, Để sau or Bỏ. A product Go writes `REQ-<id>.md` beside the tickets (`$BABYSIT_HOME/requirements/<repo name>/`, else `~/.babysit/...`; the product working tree is never written, a file a person already put in `docs/requirements/` is used as is), runs `bbs team spawn`, and answers with where the team works, what it needs from the founder and that the release go is given in the team's Orca terminal; it never lands, releases, integrates or seals | operator approval |
| `team_watch` | every 30 minutes (a `draft_ready` handoff too: it moves on by itself once the team exists, and raises one reminder with the command after 2 h if it never starts) finds the parent ticket from the team id (`bbs ticket find --json`, then ticket files) and reads `bbs team snapshot`; a handover waiting for the release go files one Cần bạn ask; a released team records `requirement_shipped` and queues a launch topic | none |
| `topic_next` | the next queued topic, marked `handed` (given to marketing, nothing written yet), for the marketing plan (`chain: true` gives the query only, one handed topic at a time, at most one a day) | none |
| `topic_sync` | last chain step after `marketing.plan` (`input_from: previous`): a handed topic whose keyword now has a post becomes `written` with the post id; one still unwritten after the 48 h hold returns to `queued`. Old `taken` rows are treated as `handed`. Passes the plan's output through | none |
| `review` | weekly: fills `actual_delta` once `check_after_days` have passed; a hit is actual at least half of expected. A product change is measured on the scoreboard from its release; a content post from its **publish date** on its **own** signal (Search Console or campaign-link clicks, or attributed sign-ups, carried by `topic_sync` from the marketing plan); with no signal of its own it waits two more weeks, then closes as `chưa đo` and is never scored | none |
| `health_sync` | daily, no model: stores the loop-health view. Takes the marketing pack's `inputs_health` as `input_from: previous`, asks the workspace's `soot` CLI (`schedules list`, `traces list --since 7d`, `attention list`, read-only) for each stage's last run and tokens, counts the founder's decisions and chat instructions. Without a reachable CLI the inputs are still stored and the runtime part says why | none |
| `page_view`, `page_action` | the operator page "Công ty" (480 px, Vietnamese): one next-step bar, opportunities, handoffs, the decision log and hit rate, and a "Vòng lặp" section: per stage (insight, build, marketing, CS) the last run, tokens in 7 days, the starving inputs (GSC 0 dòng, chưa có tín hiệu thị trường, chưa có số TikTok) and the founder's effort. The scoreboard's additive `cohorts` and `plans` show as "chưa có" until the product serves them | none |

The scoreboard may add `cohorts` (`cohort` ISO week, `signups`, `active_w1/w2/w4`, `first_payers`) and `plans` (`tier`, `started`, `active`, `revenue_vnd`); both are optional and anything malformed is dropped.

Storage: `scoreboard`, `opportunities`, `decisions` (the CL4.3 fields), `handoffs`, `topics`, `state`.
Outcomes: `opportunity_found`, `requirement_shipped`.

| setting | kind | meaning |
| --- | --- | --- |
| `PRODUCT_ADMIN_KEY` | credential, optional | scoreboard key (role `agent_mod`); sent only as `X-API-Key` to `SCOREBOARD_URL` (https or this machine) |
| `SCOREBOARD_URL` | env | the product's scoreboard endpoint |
| `CS_RUNTIME_URL`, `CS_RUNTIME_TOKEN` | env, credential, optional | support knowledge gaps (`/v1/settings/knowledge`) and, only as a fallback when the team contract item `cs.voc` is unavailable, the feedback desk (`GET /v1/sessions?source=event`, desk Soot notes: counts by kind plus up to 5 scrubbed samples each, ≤ 1 KiB) for the digest |
| `SUPPORT_QUEUE_URL` | env, optional | where a person answers waiting readers (the waiting-readers count still comes from the legacy `/admin/support` through the scoreboard until R1 retires it; do not remove it before then); named in the daily Cần bạn card (`waiting_human` ≥ 5, once per count bucket 5/10/20/50, closed with `resolves_need` below 5) |
| `RELEASE_TAGS` | env, optional | git tag patterns of a release in `PRODUCT_REPO` (comma separated, default `v*,*-v*`); the week's count goes to the company baseline as `--releases`, the shipping cadence §7 holds the loop to |
| `LOOP_SOOT_BIN`, `LOOP_SOOT_CONFIG` | env, optional | the `soot` binary (default: PATH, then `~/.local/bin/soot`) and the absolute path of this workspace's `deployment.json`; only for `health_sync` |
| `PRODUCT_REPO` | env, no default | absolute path of the product checkout the build team works in (it is not written by a Go) |
| `BABYSIT_HOME` | env, optional | the ticket home where requirement files are written (default `~/.babysit`) |
| `BBS_BIN` | env, optional | the `bbs` binary (default: PATH, then `~/.local/bin/bbs`) |

Reader feedback for the digest comes from the team contract item `cs.voc` (the digest skill queries `data` on scope `team:cs`, table `voc`, then calls `signals {voc: true}`); `signals {voc: false}` or no argument runs the legacy desk scrape when `CS_RUNTIME_TOKEN` is set.

Every optional input answers the quiet `skipped` shape when missing. A refused key is one
plain line naming the key's role. With `bbs` absent a Go is `draft_ready` and shows the
command. The pack grants nothing by itself: the Lead Soot selects it with
`company-loop:tools=...` and the Writer only needs `topic_next`.

Tests: `node --test packs/company-loop/tests/*.test.mjs`. See the
[Lohi recipe](../../examples/lohi-marketing/README.md#the-company-loop-insight-build-marketing-support-insight)
for the schedules.
