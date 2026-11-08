# Marketing

The know-how and the tools of a marketing team that researches, writes, reviews,
publishes and learns for one product. It is product-neutral: what the product
is, who it is for and how it sounds come from the team's brief (`team.brief` in
team memory, asked by the lead Soot when it builds the team) and from a product's own
skill, never from this pack. Installing it grants nothing.

Needs Soot 0.13.14 or later (storage version 4 declares table `description`s; Soot 0.13.13 refuses them).

| skill | for | tools |
| --- | --- | --- |
| `marketing-radar` | the Soot that watches sources (hub teams) | `radar_feeds`, `radar_scan`, `radar_items`, `radar_mark` |
| (plan) | a hubless team's topic and brief: a tool, not a Soot | `plan` (`{wake:true,…}` from a schedule wakes the Writer only when a blog slot is free; `{}` returns the brief of real novels and links) |
| `marketing-write` | writers | `cms_list`, `cms_read`, `cms_save`, `social_channels`, `social_queue`, `social_list`, `social_update` |
| `marketing-edit` | the editor (a skill: review, voice rules) | — |
| `marketing-publish` | the editor, or a publisher | `cms_publish`, `social_publish`, `social_record` |
| `marketing-measure` | the editor or the lead's review | `content_stats` |

A Soot selects the pack whole (`"packs": ["marketing"]`); `"marketing:read"` gives all skills and only the read-mode tools (`radar_feeds`, `radar_items`, `cms_list`, `cms_read`, `social_channels`, `social_list`, `content_stats`). The roles in the table are separated by each Soot's mission and by the hub token, not by selecting parts of the pack.

The [Marketing team](../../groups/marketing-team/README.md) template puts these
together: a lead Soot leads, a radar, a writer and an editor work on tasks, keep
shared records in the team tables `signals` and `content`, and keep the brief,
voice rules and lessons in team memory. Nothing goes live without an editor's
review task.

## The hub

Every tool forwards its call, unchanged, with `soot tool-forward --binding-env
MARKETING_HUB` to a marketing hub service: a CMS for each product's blog, a
social queue with platform adapters, a radar of sources and the publish log.
The contract is public: each tool's name, parameters and read/write mode are in
[`pack.json`](pack.json), and the hub receives exactly those calls. 2found runs
its own hub privately; any service that answers the same `soot/v1` tool calls
works.

`MARKETING_HUB` is an operator credential declared in `pack.json` `needs`: enter it per Soot in Nest (Cài đặt → Kết nối) as
`{"service_url": "https://…/api/hub", "service_token": "…"}`. The token is the
hub's client for this team: the hub decides which sites it writes for, which
channels it queues and whether it may publish, so a writer's token cannot
publish and one team cannot touch another product's posts. Tokens never go
through chat and never ship in a template.

## Publishing

`cms_publish` and `social_publish` are public. Whether a person approves each
one first is the host's approval policy: the pack and the template never relax
it. The hub refuses a call that cannot go out (a moved revision, text that is not
the draft, a channel without credentials, an account that posts only for another
product, TikTok) and posts nothing; the publisher then hands the post to a
person in **Cần bạn**. An uncertain post is never published again.

`content_stats` counts what went out — articles, drafts, social posts by
channel — and never who read it (`visits` is `null`). Reader numbers come from a
product's own data pack when it has one.

Tests: `node --test packs/marketing/tests/*.test.mjs` (no network, no posts).

## Publishing without a hub

With no `MARKETING_HUB` bound (it is optional), the pack keeps its own work in
its storage (`pack:marketing`, version 1: posts, checks, queue, publish_log,
metrics, facts, channels, settings and the tables later phases fill) and
shows it on two operator rail pages that belong to the **Marketing** flow
(`provides: ["flow-marketing"]`): **Bài viết** (posts, the SEO brief lint,
the editor's check, Search Console numbers or "Chưa có số liệu") and **Hàng
đợi** (the queue, pause for every channel or one, what just went out).

Every post and channel on these pages shows **what happens next**, in one
plain sentence, with the one button the founder needs or "Không cần làm gì":

- **Bài viết** has a **Cần bạn** tab (a refused post, a failed or uncertain
  post, a post late by 6 hours or more). A social post shows its words, a
  published post shows its link first, and each row says what Soot does and
  when (`next` in `page_view`: `draft`, `ready`, `scheduled`, `late`,
  `signed_out`, `person_paused`, `paused_all`, `failed_retry`, `uncertain`,
  `published` and the rest; the page turns each code into a sentence).
- **Hàng đợi** opens with one headline (the one blocker, or "Không cần làm gì,
  Soot đang tự chạy. Bài kế tiếp: …"). A signed-out channel carries **Đăng nhập
  X** (opens the Editor's browser pane in Nest), not only a switch. Limits
  (posts per day, spacing, replies per day) are edited per channel with a
  confirmation (`page_action set_limits`).
- **Chiến dịch** shows the next step of each campaign and "Mở Thiết lập" when
  `PRODUCT_ADMIN_KEY` is missing; the page never shows the key's name alone.

```text
draft_save → check (guard + editor verdict) → schedule → due (tool-only schedule)
  → claim (guard again, pause/cap/spacing/quiet hours, intent row, signed claim)
  → publisher publish/find → record (post_published) | fail
```

- **The guard** refuses a post whose prices, percentages or "free" offers are
  not in `facts` read from the product's served source in the last 24 hours
  (`facts_sync`), that holds personal data, breaks the channel's rules or
  repeats a post of the last 90 days; the reason is shown on the post and
  nothing is posted. Pause, cap, spacing and quiet hours only make it wait.
- **The claim** (`marketing_claim`, `approval: operator` by default) is signed
  with `MARKETING_CLAIM_KEY` (HMAC-SHA256 over canonical JSON, 10 minutes) and
  carries the content hash; publishers refuse anything else. A host that wants
  autonomous publishing sets `approvals: {"marketing_claim": "auto"}`; the
  guard still runs.
- **Once only.** The intent row is written before the claim is returned; a
  claim re-issued after a crash says `verify_first` and the publisher looks
  before it acts. An open intent is re-issued only after 30 minutes, longer
  than any publisher run, so a slow deploy is never raced.
- **Search Console.** `gsc_sync {site, days}` reads impressions, clicks and
  position for every published URL with the operator's Google sign-in
  (`GSC_GOOGLE`, a `google_oauth` value written by Nest's sign-in, declared
  with `oauth {provider: "google", scopes: [webmasters.readonly]}`); a missing
  or revoked sign-in exits 1 with the host's `needs_person` line, so the host
  shows one "Đăng nhập Google lại" item in Cần bạn. `seo_brief` feeds the
  radar. The `oauth` field needs Soot 0.13.10 or later: an older runtime
  refuses the pack (strict decoding).

The hub tools above are unchanged and still forward when `MARKETING_HUB` is
bound; the new tools never forward.

## Campaigns

The **Chiến dịch** page (also `provides: ["flow-marketing"]`) and
`campaign_save` make a campaign: a goal (`signups`, `first_topups`, `clicks`
or `published` with a target), channels, dates, a token budget and one short
link per channel made by the product api (`POST /admin/links`, `{code, url}`),
tagged `utm_source=<channel>`, `utm_medium=blog|social`, `utm_campaign=<id>`.
The api's address is the `PRODUCT_API_URL` env the host grants; its key is the
optional operator credential `PRODUCT_ADMIN_KEY`, sent only to that address.
`draft_save {campaign}` keeps a post on the campaign's channels and gives a
social or video post the channel's link.

`campaign_report` (a daily tool-only schedule) reads
`GET /admin/analysis/campaigns/:id?from&to`, stores the snapshot and returns new
attributed signups as `lead` outcomes (`ref: utm:<id>:<day>`), once each. The
Soot passes `tokens_used` (summed from its outcomes' cost shares); at 80 % of
the budget the tool returns one `tell` for the person and never stops the
campaign. When the api cannot be read the page keeps the Soot-side numbers
(published, reach) and says "Chưa đọc được số đăng ký từ <product>" with
**Thử lại**; clicks and signups show "—", never 0.

## Added in friction round 2

`due {channel, skip}` and `claim` answer `{done:true}` when a chain should stop quietly; `record` accepts the publisher's `ok` and `status`. `channels_probe` is the tool-only sign-in probe (start phase returns `{action:"navigate", url}`; a phase with `result` decides). `report` builds the Editor's daily report (six lines or fewer). `plan` also reports `social` work and ranks topics by `insight`. `page_action set_limits` edits a channel's `cap_per_day`, `spacing_min` and `reply_cap_per_day`. Tools that need an optional credential answer `{ok:true, skipped:true, reason_code:'optional_credential', key}` when it is unset; campaign operations answer `needs_credential` (`link: nest://settings/setup`). `ready` and `due` and a signed-in probe set `resolves_need:true`.
