# Marketing

The know-how and the tools of a marketing team that researches, writes, reviews,
publishes and learns for one product. It is product-neutral: what the product
is, who it is for and how it sounds come from the team's brief (`team.brief` in
team memory, asked by the lead Soot when it builds the team) and from a product's own
skill, never from this pack. Installing it grants nothing.

Needs Soot 0.13.14 or later (storage version 4 declares table `description`s; Soot 0.13.13 refuses them).

**Needs Soot ≥ the next core release** (the one after 0.25.x that ships the approval query source and `nest://needs/approve/<id>`): the Marketing desk declares `data.queries.approvals {source: "approval"}`, which an older runtime refuses with the whole pack (strict decoding).

| skill | for | tools |
| --- | --- | --- |
| `marketing-radar` | the Soot that watches sources (hub teams) | `radar_feeds`, `radar_scan`, `radar_items`, `radar_mark` |
| (plan) | a hubless team's topic and brief: a tool, not a Soot | `plan` (`{wake:true,…}` from a schedule wakes the Writer only when a blog slot is free; `{}` returns the brief of real novels and links) |
| `marketing-write` | writers | `item_save` on the desk; `cms_list`, `cms_read`, `cms_save`, `social_channels`, `social_queue`, `social_list`, `social_update` otherwise |
| `marketing-edit` | the editor (review, voice rules, the desk's asks, Micro Fish pre-test, newsletter send) | `item_save {pretest}`; with other packs `micro-fish_tally`, `email_send` |
| `marketing-publish` | the editor, or a publisher | `publish_bundle`, `release_due`, `library_scan` on the desk; `cms_publish`, `social_publish`, `social_record` otherwise |
| `marketing-measure` | the editor or the lead's review | `content_stats`, `gsc_sync`, `seo_brief`, the desk's `today.learn` |

A Soot selects the pack whole (`"packs": ["marketing"]`); `"marketing:read"` gives all skills and only the read-mode tools (`radar_feeds`, `radar_items`, `cms_list`, `cms_read`, `social_channels`, `social_list`, `content_stats`). The roles in the table are separated by each Soot's mission and by the hub token, not by selecting parts of the pack.

The [growth](../../groups/growth/group.source.json) team template (Biên tập and
Người viết, for any product in `products.json`; Biên tập is its lead) is the
current way to run these; the older [Marketing
team](../../groups/marketing-team/README.md) template, deprecated, put them
together like this: a lead Soot leads, a radar, a writer and an editor work on tasks, keep
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

## The Marketing desk

The `desk` piece (`slot: "rail"`, order 400, label **Marketing**) is the
founder's one screen for the team's work: **Hôm nay** (why a post has not gone
out, most urgent first; what is being made; today's slots; what just went
out), **Nội dung** (every item by stage: idea, making, approval, scheduled,
live), **Kênh đăng** (who posts where, a matrix of products by channel, each
cell a sheet with the fix, the pace and what waits), **Thư viện** (the marketing
folder: posts, video series and campaigns, radars, `videos.csv`) and **Số liệu**
(the week per product and channel). A product switch narrows every tab. The
page is built on the kit (`_kit/piece.css`, `--kit-*` tokens, light and dark)
from `page/src/` into the classic script `page/app.js` by
`node packs/marketing/page/tests/build.mjs` (`--check` fails when it is stale).
Anything not measured reads "—" with a reason, never 0.

Reads are `page_view {view: summary|today|content|item|channels|channel|library|numbers}`;
`with_summary: true` returns the header's summary in the same answer, so a
refresh reads the hub once. The hub admits each client a fixed number of calls
a minute; a refused call (429) reads as `rate_limited` ("hết lượt đọc trong
phút này"), not as a hub that is down.
writes are `page_action` desk ops from a press, each under its own request id:
`stop`, `pause`/`resume` (`scope: all|channel`), `rules`, `confirm` (an
uncertain post, a video's TikTok link, a hand-off's link, a newsletter sent),
`mark` (a radar row's Onboard?), `create`, `scan` (re-index the folder),
`setup`, `reply_done`, `export` (phase 2, below) and `subscribers` (the pasted
newsletter list, written to `<product>/newsletter/subscribers.csv`; it answers
only a count). None of them publishes. **Tạo nội
dung** writes the item, then asks the serving Soot in the founder's own thread
(`soot.ask`, request id `ask-<ref>`) to hand it to the Writer or the Builder.

**Which Soot serves it.** The host serves a pack piece once per runtime: the
candidates are the Soots that select this pack, were granted `page_view`, are
not archived and that the viewer reaches; the deployment's Lead serves when it
is a candidate, otherwise the first candidate by id (pieces contract §2). Give
`page_view`, `page_action` and `publish_bundle` to `marketing-editor` and not
to the Lead, so the Editor serves the desk, runs its calls and receives its
asks.

**The library.** `MARKETING_ROOT` (optional operator credential) is the full
path of the marketing folder: `products.json` (`[{id, name, mark?, site?,
hub_site?, video_channels?, accounts?}]`), `content/<product>/<day>-<slug>/`
(what `item_save` writes) and `channels/<channel>/` (`campaigns/<slug>/` with
`campaign.json` and its numbered stage folders, `radar/<yyyy-mm-dd>.md`,
`metrics/videos.csv`). A channel no product names shows under "Kênh khác".
Tools never leave the folder (symlinks and `..` are refused). Without it the
library tab says how to set it and the rest of the desk works from the hub.
`products.json` entries may also carry `blog` (`hub`, `{dir}` or `none`),
`blog_dir`, `targets` (`[{id, kind: reddit|hn|devto|other, sub?, name?,
rules?}]`), `changelog` (a path in the folder), `langs` and `newsletter`.

**One approval per bundle.** `publish_bundle` (`approval: operator`,
`preflight: true`) asks the founder once for one source and everything made
from it. Its preflight refuses a revision or a text that moved since the
Writer saved, so no card shows a stale post. The desk never approves: its
**Duyệt…** opens Nest's own card (`nest://needs/approve/<id>`), and it reads the
cards through the piece's approval query (operator only), which it passes back
to every `page_view` so the desk and **Cần bạn** agree. After Duyệt the tool
only records the approved set. The tool-only schedule publishes it:

```json
{"id": "release", "name": "Đăng bài đến giờ", "every": "5m",
 "text": "release_due raised posts that need the founder: raise one report_blocker listing them.",
 "tool": {"pack": "marketing", "name": "release_due", "input": {}}, "wake_when": {"notify": true}}
```

and, to keep the library in step, `{"every": "30m", "tool": {"pack":
"marketing", "name": "library_scan", "input": {"hub": false}}}`. `release_due`
re-checks each post's revision and words before the hub call (a change holds
it), writes an intent first and looks a lost answer up instead of sending
again, and holds a slot missed by more than 6 hours. X and Facebook go out at
about their slot, when the browser poster takes them.

**Known exposure: "Luôn cho phép".** Nest's approval card offers "Luôn cho
phép". Pressing it on a `publish_bundle` card grants the tool `auto` for that
Soot, and every later bundle is recorded with no card; `release_due` then
publishes it. The pack cannot refuse that grant (no core flag for it in this
release). Do not press it unless every future bundle may go out unread, and
revoke it in the Soot's grants if it was pressed.

**Storage version 8** is additive: tables `library` (the folder's index),
`bundles` (approved sets) and `releases` (one row per post and slot, with its
intent); the desk's pause and per-channel pace live in `settings` keys.

Tests: `node --test packs/marketing/tests/*.test.mjs packs/marketing/page/tests/*.test.mjs packs/marketing/campaigns/tests/*.test.mjs`.

## Phase 2: more kinds, pre-test, hubless, setup, learning, replies

- **Kinds.** Tạo nội dung picks one of six kinds: blog, social, video,
  **community** (a post for a subreddit, Hacker News, dev.to or another place;
  `item_save community {target, title, body}`), **newsletter**
  (`item_save newsletter {subject, preheader, body}`; subscribers are pasted on
  the desk into `<product>/newsletter/subscribers.csv` and only counted, never
  shown) and **launch** (a
  blog, an X post and a Show HN from the newest CHANGELOG section, one item,
  one approval; after Duyệt the Show HN part becomes its own community item).
  `publish_bundle` takes `community` and `newsletter` posts. Soot never posts
  a community post: it is the founder's hand-off (copy, open the submit page,
  paste the link; `confirm` checks the link per target, and a Reddit thread
  joins the replies watch). A newsletter is sent by the Editor through the
  `email` pack after the founder approves the words, with Nest asking again
  for the send, or exported (`export` writes `newsletter/out/<slug>.html` and
  `.txt`) and marked sent.
- **Pre-test.** "Thử với người đọc giả lập" on any item asks the Editor to run
  a Micro Fish simulation of that revision (request id
  `pretest-<ref>-<revision>`) and save the verdict with `item_save {pretest:
  {state, verdict: go|fix|stop, n, score, reasons}}`. The verdict is advice;
  it never blocks Duyệt. A team without the `micro-fish` pack sees how to add
  it.
- **Hubless.** Without `MARKETING_HUB` the desk is a full mode, not an error:
  `item_save` writes files, `release_due` writes approved blogs as Markdown
  with front matter into the product's `blog_dir`, and X, Facebook, TikTok,
  community and newsletter parts become hand-offs on Hôm nay. A post for a
  channel the product cannot post to is left out of the approved bundle and
  stays a draft.
- **Setup.** With no product, the desk shows **Bắt đầu marketing**: a 4-step
  sheet that writes the `products.json` entry and a `<product>/brand.md` stub
  (`setup`); once a product exists the same sheet is **Thêm sản phẩm**. The
  Writer reads `products.json` and `brand.md` with the read-only `file_read`
  (inside `MARKETING_ROOT`, no links out, 256 KiB at most) and asks once to
  fill an empty `brand.md`.
- **Learning.** Hôm nay's "Tuần này và tuần sau" shows the week's top posts,
  searches worth a post and the next planned topic, from Search Console,
  campaign clicks and the plan, with the one input that is missing. TikTok
  links are pasted on the desk (no hand-editing of `videos.csv`).
- **Replies.** "Cần trả lời" on Hôm nay lists replies saved by the replies
  schedule that need the founder, plus the drafted safe replies; `reply_done`
  marks one answered and closes its Cần bạn item.
- **Words.** The desk uses plain names: máy chủ đăng bài (the hub), máy đăng
  (the browser poster), Người viết, Biên tập, Người dựng video. Skills and tool
  descriptions keep the internal names.
- **Needs** the Soot runtime that sends `piece.teams` and `piece.packs` in a
  piece's tool context (the core release after 0.25.x) for the Quyền link,
  the pre-test offer and the email send button; with an older runtime those
  read as unknown and the desk still works.

## Reader awareness (nấc 1/2/3)

A topic from the company loop may carry `awareness` (`unaware` = nấc 1, the reader does not know the problem; `problem` = nấc 2, knows it, not how to solve it; `choosing` = nấc 3, picking whom to buy from). `plan` keeps it with the handed topic, returns it in the Writer's brief, and the Writer saves it on the post with `draft_save {awareness}` (storage version 7: nullable `posts.awareness`). `inputs_health` (`posts.awareness`) and the daily `report` show the 14-day mix by level; untagged posts count as `chua_gan`, never guessed. One line of note appears when one nấc is above 70% of the tagged posts, or a nấc has no post while at least 5 were tagged.

## Publishing without a hub

With no `MARKETING_HUB` bound (it is optional), the pack keeps its own work in
its storage (`pack:marketing`, version 1: posts, checks, queue, publish_log,
metrics, facts, channels, settings and the tables later phases fill). The
Marketing desk shows these posts as its items (Nội dung, with the `P-…` ref).
With a marketing folder, the desk runs in hubless mode (see Phase 2). The earlier **Bài viết**, **Hàng đợi** and **Kênh đăng bài** pieces
are replaced by the desk; `page_view {page: posts|queue}` and their
`page_action` ops still answer for an older client. **Chiến dịch**
(`campaigns`, `slot: "project.tab"`, `tab: {id: "marketing"}`) stays, from its
own bundle `campaigns/`, and shows the next step of each campaign and "Mở
Thiết lập" when `PRODUCT_AGENT_KEY` (an `agent_marketing` key; the deprecated
shared `PRODUCT_ADMIN_KEY` still works as a fallback) is missing.

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
  autonomous publishing sets `grants.approvals: {"marketing_claim": "auto"}`; the
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

The **Chiến dịch** piece (`campaigns`, also on the Marketing tab) and
`campaign_save` make a campaign: a goal (`signups`, `first_topups`, `clicks`
or `published` with a target), channels, dates, a token budget and one short
link per channel made by the product api (`POST /admin/links`, `{code, url}`),
tagged `utm_source=<channel>`, `utm_medium=blog|social`, `utm_campaign=<id>`.
The api's address is the `PRODUCT_API_URL` env the host grants; its key is the
optional operator credential `PRODUCT_AGENT_KEY` (an `agent_marketing` key; the deprecated shared `PRODUCT_ADMIN_KEY` still works as a fallback), sent only to that address.
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

## Radar, comments and restarts

- `radar_read` filters in the tool: `keywords` (accent-folded) and `lang: "vi"` keep only on-topic Vietnamese items (the rest are stored as dismissed, never read twice); it wakes the triage Soot at most once per `wake_gap_hours` (default 20), counted from the last wake the Soot answered (`signals_mark`; `signals_list` is read-only and answers nothing; a wake the host refused, e.g. for a token budget, counts nothing and the batch may wake again 6 h later), with at most 15 of the best new signals (`max_items`; `signals_list` shows no more than 15 new at a time) and dismisses the surplus with a note. A source answering 429 rests 24 h; three failures in a row switch it off (`disabled_at`); both are named in `skipped`. `retire: [keys]` switches a source off by hand. The `sources` table gained `fails`, `retry_after`, `disabled_at`.
- `plan` (wake call) adds to each `topic_posts` entry of a published post its `url`, `published_at` and, when Search Console or a campaign link measured it, `clicks` and `signups` (absent means not measured, never 0); the company loop's review scores a content post on these.
- Restart safety: a `write` tool cut by a service restart leaves its resource "result unknown" until a person settles it. `due`, `plan`, `channels_probe` and similar keep only their own bookkeeping rows and are safe to run again, but the runtime gives `read` tools a read-only storage grant, so they stay `write` and declare `"rerun": "safe"` in `run` (runtime 0.13.21+): a restart-cut call settles itself instead of waiting in Nest. `claim`, `record`, `fail`, `pause` and the publish tools are real effects and stay writes.
