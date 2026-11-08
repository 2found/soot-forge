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
| `decide` | Go, Để sau or Bỏ. A product Go writes `docs/requirements/REQ-<id>.md` in `PRODUCT_REPO` and runs `bbs team spawn`; it never lands, releases, integrates or seals | operator approval |
| `team_watch` | every 30 minutes finds the parent ticket from the team id (`bbs ticket find --json`, then ticket files) and reads `bbs team snapshot`; a handover waiting for the release go files one Cần bạn ask; a released team records `requirement_shipped` and queues a launch topic | none |
| `topic_next` | the next queued topic, for the marketing plan (`chain: true` gives the query only, at most one a day) | none |
| `review` | weekly: fills `actual_delta` once `check_after_days` have passed; a hit is actual at least half of expected | none |
| `page_view`, `page_action` | the operator page "Công ty" (480 px, Vietnamese): one next-step bar, opportunities, handoffs, the decision log and hit rate | none |

Storage: `scoreboard`, `opportunities`, `decisions` (the CL4.3 fields), `handoffs`, `topics`, `state`.
Outcomes: `opportunity_found`, `requirement_shipped`.

| setting | kind | meaning |
| --- | --- | --- |
| `PRODUCT_ADMIN_KEY` | credential, optional | scoreboard key (role `agent_mod`); sent only as `X-API-Key` to `SCOREBOARD_URL` (https or this machine) |
| `SCOREBOARD_URL` | env | the product's scoreboard endpoint |
| `CS_RUNTIME_URL`, `CS_RUNTIME_TOKEN` | env, credential, optional | support knowledge gaps and the feedback desk (`GET /v1/sessions?source=event`, desk Soot notes: counts by kind plus up to 5 scrubbed samples each, ≤ 1 KiB) for the digest |
| `SUPPORT_QUEUE_URL` | env, optional | where a person answers waiting readers; named in the daily Cần bạn card (`waiting_human` ≥ 5, once per count bucket 5/10/20/50, closed with `resolves_need` below 5) |
| `RELEASE_TAGS` | env, optional | git tag patterns of a release in `PRODUCT_REPO` (comma separated, default `v*,*-v*`); the week's count goes to the company baseline as `--releases`, the shipping cadence §7 holds the loop to |
| `PRODUCT_REPO` | env, no default | absolute path of the product checkout that receives requirement files |
| `BBS_BIN` | env, optional | the `bbs` binary (default: PATH, then `~/.local/bin/bbs`) |

Every optional input answers the quiet `skipped` shape when missing. A refused key is one
plain line naming the key's role. With `bbs` absent a Go is `draft_ready` and shows the
command. The pack grants nothing by itself: the Lead Soot selects it with
`company-loop:tools=...` and the Writer only needs `topic_next`.

Tests: `node --test packs/company-loop/tests/*.test.mjs`. See the
[Lohi recipe](../../examples/lohi-marketing/README.md#the-company-loop-insight-build-marketing-support-insight)
for the schedules.
