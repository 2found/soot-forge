# Lohi's marketing workspace

A local Soot workspace that writes, checks and publishes Lohi's blog with no
marketing hub and no person in the loop. The team is split by **job**, not by
pack: Ops (the `lohi-editor` id, which owns the browser profile and claim key),
Writer, Analyst, Radar and an optional Video Soot share the [marketing pack](../../packs/marketing/README.md)'s own storage. The
[Lohi blog publisher](packs/lohi-blog/README.md), a local pack that ships with
this recipe, puts posts on `blog.lohi2.com`.

**Needs Soot 0.13.14 or later.** The recipe uses schedule `then` chains, optional
credentials (a quiet `skipped`), the workspace `env` field, the `marketing:tools=`
pack selector and schedule catch-up; an older runtime refuses the deployment or
cannot run the `marketing-blog` and `marketing-probe` chains. The marketing pack
(storage version 5) also declares table `description`s, which Soot 0.13.13
refuses in `pack.json`: update Soot first.

**`setup.mjs` requires `--blog-remote <git url>` to publish.** There is no default
blog repository (since 0.11.12); without the flag the workspace is built but the
blog chain does not start. See [Set it up](#set-it-up) below.

## The lean team (by job)

The Soots are grouped into **teams** in [company.lohi.json](company.lohi.json), an overlay on the Forge's [company template](../../groups/company-team/README.md): insight (analyst, radar), marketing (writer, Ops as publisher), financial (finance), cs (support and desk on the CS server, declared and not deployed by setup), build (Claude Code through `bbs team`, a contract) and `op-catalog`, a slot for the `lohi-ops` pack. Chains such as publish, probe and GSC are schedules of marketing, not teams.

| Soot | tier, daily tokens | does | wakes on |
| --- | --- | --- | --- |
| Ops (`lohi-editor`) | flash, 150k | publishes blog by chain, X/Facebook/Reddit by browser, probes sign-ins, reads GSC, TikTok/YouTube numbers, scoreboard and the daily report; files Cần bạn cards | a due post, a failed step, a card to raise |
| Writer (`lohi-writer`) | flash, 100k | only writes: `plan` brief, `draft_save`, `check`, `schedule`; the one record is `posts` (no `content` table) | a free blog slot |
| Analyst (`lohi-analyst`) | lite, 80k | Monday digest from `company-loop_signals` (scoreboard, `cohorts`, `plans`, support, signals), campaigns | Monday 08:30, campaigns 07:00 |
| Radar (`lohi-radar`) | lite, 50k | `radar-read` reads Vietnamese and English web-novel feeds with a tool; the model only triages kept signals; read-only | enough new signals |

| Finance (`lohi-finance`) | lite, 30k | Monday `finance-report`: read-only report of revenue, plans and cohorts from `company-loop_signals`; never acts on money. A separate lite Soot was kept over making the Analyst carry it: it only wakes weekly, so it costs one run a week and keeps the Analyst's mission short | Monday 09:00 |

The five add up to 410k a day against the old Writer 250k + Editor 300k = 550k, and
most days nothing wakes a model at all. Schedules that never wake one:
`marketing-report`, `marketing-gsc`, `marketing-video-stats`, `company-review`,
`company-health`, the blog chain and the probe.

`radar-read` seeds `sources` once (an edit made on the table is never overwritten):
r/noveltranslations, r/ProgressionFantasy, r/webnovels, r/LightNovels, a r/Vietnam
search for "truyện chữ", and Google News feeds for web novels, audio reading apps
and Lohi's competitors. Vietnamese competitor sites publish no public feed (not
reachable when this was built), so they are followed through news search; add a feed
by editing the `sources` table in Nest.

`company-health` (06:45) runs `marketing_inputs_health` into `company-loop_health_sync`,
which fills the **Vòng lặp** section of the Công ty page: each stage's last run,
tokens in 7 days, which inputs starve ("GSC 0 dòng", "chưa có tín hiệu thị trường",
"chưa có số TikTok") and the founder's effort. It reads the runtime through the `soot`
CLI (`LOOP_SOOT_CONFIG` is this workspace's `deployment.json`, written by `setup.mjs`).

TikTok and YouTube numbers (`marketing-video-stats`, 07:30) come from `yt-dlp` into
`metrics`, without a login. Install it once (`brew install yt-dlp`); until then the
Vòng lặp says "chưa có số TikTok" and nothing fails. Tests use a stub binary.

**Slot for `lohi-ops`.** If `examples/lohi-marketing/packs/lohi-ops/` exists when
`setup.mjs` runs, it is copied like `lohi-blog` (without tests) and its optional
`deployment.fragment.json` is merged: `pack_grants`, `soot_packs` (`{"lohi-editor": ["lohi-ops:tools=..."]}`
replacing that pack's ref on the Soot), `schedules` (an existing id is kept unless it is listed in
`replace_schedules`). Absent, nothing changes.

```text
08:00       marketing_plan ──(a blog slot is free, once a day)──▶ Writer: plan {} brief ─▶ draft_save ─▶ check ─▶ schedule
            (also keeps the guard's price facts fresh; zero model calls when no slot is free)
7-22 h      marketing_due {schedule} every 10 m ──(a new need)──▶ Editor: marketing_claim ─▶ lohi-blog_publish ─▶ marketing_record
                                                            └──▶ marketing-browser-post (X, Facebook, Reddit) ─▶ marketing_record
06:00       marketing_gsc_sync  (zero model calls; a revoked sign-in is one host Cần bạn item)
every 2 h   marketing_replies_sync ──(notify)──▶ Editor: marketing-replies ─▶ reply_save ─▶ check ─▶ claim {reply}
05:20       marketing_channels_setup (creates x-lohi, facebook-lohi, reddit-lohi paused; fills unset caps)
06:30       lohi-blog_ready ──(something missing, changed)──▶ Editor: one Cần bạn item
07:00       marketing_campaign_report ──(notify)──▶ Analyst: record lead outcomes, token count, 80 % note
on request  Video: marketing-video ─▶ mvf (2build) ─▶ marketing_video_import ─▶ Editor: check ─▶ schedule ─▶ browser upload (X, Facebook)
```

| file | what it is |
| --- | --- |
| `setup.mjs` | builds the workspace from this recipe and generates the claim key |
| `deployment.example.json` | product `Lohi`, the Soots, the shared Editor/Video workspace, pack grants, the seven schedules, `approvals: {"marketing_claim": "auto"}` |
| `soots/lohi-*.json` | Ops, Writer, Analyst, Radar and Video, each with a small daily token budget |
| `soots/*.md` | the Lohi brief (`SOUL.md`) and each role's mission |
| `packs/company-loop` (Forge) | scoreboard, watch and review to Ops, digest and health to the Analyst (never `decide`), `topic_next` to the Writer; five schedules `company-scoreboard`, `company-digest`, `company-watch`, `company-review`, `company-health` |
| `packs/lohi-blog/` | the Lohi-only blog publisher, a local pack: it is not in the Forge catalog |

The topic comes from the tool, not a Soot: `marketing_plan` reads Lohi's public
catalog (`/novel/discovery/feed`, `genres`, `/novel/novels/search`) and the
Search Console queries, picks a keyword not yet written, and hands the Writer
real novels with their links. `marketing_check` fails a draft whose
`lohi2.com` link answers 404 or 410. No facts schedule is needed.

## Decisions in this recipe

- **No publish approval.** Lohi's founder asked for posts to go out
  without a click. The pack keeps `marketing_claim` behind an operator
  approval. This host alone sets it to `auto`. Every guard still runs inside
  the claim: facts, personal data, platform rules, duplicates, the Editor's
  verdict on that exact content, pause, caps, spacing and quiet hours. A model
  cannot skip them. (The Forge `marketing-team` template asks the same
  question as `publish_approval` and defaults to `required`; this recipe is
  its `none`.)
- **Campaigns.** The Chiến dịch page (or `marketing_campaign_save`) makes a
  campaign with a goal, channels, dates and a token budget, and one
  `api.lohi2.com/r/<code>` link per channel tagged `utm_source=<channel>`,
  `utm_campaign=<id>`. Lohi's web keeps the first UTM a reader arrives with
  and stores it on signup, so the api's report per campaign gives clicks,
  signups and first top-ups per channel. The 07:00 read turns new signups into
  `lead` outcomes; the Editor (the Đầu mối) says when 80 % of the token budget
  is used and never stops a campaign itself.
- **Channels.** `blog-lohi`: one post a day, at least 20 hours apart. The
  social channels:

  | channel | posts | spacing | replies |
  | --- | --- | --- | --- |
  | `x-lohi` | 4 a day | 3 h | 10 a day, 10 min apart |
  | `facebook-lohi` (the Page only) | 2 a day | 6 h | 10 a day |
  | `reddit-lohi` | 1 a day | 24 h | 5 a day, 30 min apart |

  Nothing goes out between 23:00 and 07:00 Asia/Ho_Chi_Minh.
  - The `marketing-channels` schedule creates the social channels **paused**
    until the founder signs in. It only fills values that are not set yet,
    so it never unpauses a channel or overwrites an edit.
  - An item 6 hours past its time is never posted on its own: it becomes
    "Bài lỡ giờ" in Cần bạn.
- **The Editor is the Publisher.** It drives `browser-use` in one browser
  profile kept across all its conversations, because the host lists it in
  `SOOT_BROWSER_PERSISTENT_SOOTS`. Every other Soot keeps a browser per
  conversation. The founder signs in once per platform in Nest's docked
  browser panel; Soot never signs in, never solves a captcha and never posts
  the same claim twice.
  - A signed-out session, a captcha or a changed page pauses only that
    channel. Each is one Cần bạn item naming the platform.
  - A crash between posting and recording is looked up before anything
    else. If the post cannot be found, it becomes "Không chắc đã đăng chưa"
    and waits for the founder.
- **One video path.** The Video Soot turns a published post into one short
  video with the 2build `marketing-video` skill (`mvf`, HyperFrames 0.8.153)
  and `marketing_video_import`. The mvf owner steps are not waits:
  - The Soot answers the brief itself.
  - The Micro Fish pretest and the publish guard stand in for script approval.
  - The founder previews the poster, captions and hook scores in Hàng đợi and
    can pull the video.

  A render failure or a hook under the pretest bar stays a draft with the
  reason. The Editor uploads X and Facebook videos through `browser-use`;
  TikTok files stay for the founder to post. Video and Editor share one
  workspace folder (`tool_hosts`), so the Editor uploads the file the Video
  Soot rendered, checked against its signed sha256.
- **Replies.** Every 2 hours Soot reads Reddit threads it watches (RSS) and,
  in the browser, X and Facebook notifications. It answers only friendly,
  safe replies, through the same check, claim and reply caps.
  - Money questions, complaints and anything flagged are never answered;
    each becomes one Cần bạn item.
  - A reader's account problem gets only "Bạn nhắn Hỗ trợ trong app Lohi
    nhé" and a Cần bạn item labelled "Chuyển Hỗ trợ Lohi".
  - Reader handles are dropped after 30 days.
- **Lean budgets.** No Soot runs on `pro`. Schedules run tools without a model
  and wake the Editor only when a post is due or a person is needed.

## The company loop (insight, build, marketing, support, insight)

The [company-loop pack](../../packs/company-loop/README.md) closes the circle around the
blog. The Editor is its Lead; the pack is product-neutral and Lohi is only config here
(`SCOREBOARD_URL`, `PRODUCT_REPO`, the Lohi brief).

```text
06:15 daily   company_scoreboard_sync  (no model) ─▶ stores the week, appends it to the bbs company baseline
Mon 08:30     scoreboard_sync{for_digest} ─▶ signals (packet ≤ 3 KiB) ──(notify)──▶ Editor: skill company-digest ─▶ digest_save
                 content opportunity ─▶ decided by Soot ─▶ topic queued ─▶ topic_next ─▶ marketing_plan ─▶ Writer ─▶ blog (no tap)
                 product opportunity ─▶ one "Cần bạn" card ─▶ page "Công ty": Go / Để sau / Bỏ        (tap 1)
Go            requirement file REQ-OP-xxxx.md in PRODUCT_REPO + `bbs team spawn` (never land, release, integrate or seal)
every 30 min  company_team_watch (no model) ─▶ team delivered ─▶ founder reviews and gives bbs:team's release go   (tap 2)
              released ─▶ outcome requirement_shipped + a "launch" topic ─▶ marketing writes about it
Mon 08:00     company_review (no model) ─▶ fills the real change against the baseline; hit = actual at least half of expected
```

The founder taps twice per product change (Go on the opportunity, and bbs:team's own
release go) and never for a content opportunity. Marketing receives topics through the
chain `company-loop.topic_next` then `marketing.plan` (`input_from: previous`): the
chain merges the topic into the plan call, and `marketing.plan` keeps it until a post about
it exists, so the Writer's own plan call sees the same topic. No marketing tool was added.

Set the product checkout when you set up the workspace (no default, never the real tree
in a test):

```bash
node examples/lohi-marketing/setup.mjs ~/.soot/lohi-marketing --blog-remote <git url> --product-repo /path/to/kiem-lai
```

Credentials: `PRODUCT_ADMIN_KEY` (an `agent_mod` key, shared with marketing) is entered in
Nest; `CS_RUNTIME_URL` and `CS_RUNTIME_TOKEN` are optional (support gaps join the digest when
set). Without the key every loop tool answers a quiet `skipped`. If `bbs` is not on the
machine a Go still writes the requirement and the page shows the exact command to run.


To move an existing workspace onto teams (groups, per-team budgets, cross-team read grants), follow [ADOPT.md](ADOPT.md). That path is experimental and internal.

## Set it up

```bash
# live workspace (the real blog repo; you choose it, there is no default):
node examples/lohi-marketing/setup.mjs ~/.soot/lohi-marketing --blog-remote git@github.com:reallongnguyen/novel-reader.git
# any test or scratch workspace: a local bare repo, never the real one
git init --bare /tmp/scratch-blog.git
node examples/lohi-marketing/setup.mjs /tmp/scratch-ws --blog-remote /tmp/scratch-blog.git
cd ~/.soot/lohi-marketing && soot start
```

`setup.mjs` copies the packs and Soots, writes `deployment.json` and generates
the Editor's claim key once (never printed, never overwritten). If the runtime
knows the workspace `env` field, the host settings (`PRODUCT_API_URL`,
`SOOT_BROWSER_PERSISTENT_SOOTS`, and `LOHI_BLOG_REMOTE` from `--blog-remote`)
go into the file (plus `LOOP_SOOT_CONFIG`, the workspace's own `deployment.json`; set `YT_DLP_BIN` only when `yt-dlp` is not on PATH). **`LOHI_BLOG_REMOTE` has no default**: without `--blog-remote`
the blog chain does not start and `blog-ready` raises one Cần bạn card
("Chưa chọn kho đăng blog"), so a test workspace can never push to the real
blog repo. Run setup again with the live address, since it rewrites the file;
otherwise it prints the line to start the runtime with. Install the browser
once (**Cài trình duyệt** in Nest, or `soot browser install`).

What only a person can do, each one Cần bạn card or one command:

1. **Sign in to X, Facebook and Reddit.** The Editor opens each login page in
   its own browser and Cần bạn shows "Đăng nhập X, Facebook, Reddit cho Lohi".
   For each platform: bấm **Mở trình duyệt**, đăng nhập trong khung bên phải,
   bấm **Đã đăng nhập <X|Facebook|Reddit>**. Then choose **Bật** for the
   channel on the Hàng đợi page. You never give Soot a password. The blog
   needs none of this.
2. **Sign in to Google** from Nest for Search Console (`GSC_GOOGLE`). Optional:
   without it the plan chooses topics from the catalog, and Bài viết shows
   "Chưa có số liệu", never 0.
3. **Let the machine reach the blog repository.** An SSH key that can push to
   the kiem-lai repo, `git`, `go`, `2server` and a signed-in `gcloud`. The
   publisher clones the repo itself (no `LOHI_REPO`). The `blog-ready` check
   at 06:30 lists what is missing in one Cần bạn card and stays quiet until
   that list changes.
4. **Campaigns (optional):** an API key with role `agent_mod` from Lohi's
   admin UI, stored in Nest as `PRODUCT_ADMIN_KEY`.
5. **Videos (optional):** `soot add 2found/soot-forge/packs/2build`, run
   setup again (it adds the Video Soot once the pack is there), and
   `python3 packs/2build/marketing-video/tools/mvf.py doctor` until READY, then
   `soot grant marketing` and `soot grant browser-use`.

Check the accounts in the `marketing-channels` schedule (the X handle, the
Facebook Page URL, the Reddit user) before the first run.

What to do next is on the page itself: **Bài viết › Cần bạn** lists every post that waits for you, and
**Hàng đợi** starts with one sentence and one button (or "Không cần làm gì, Soot đang tự chạy"). A channel that is
signed out shows **Đăng nhập <kênh>**, which opens the Editor's browser pane.

To stop publishing, turn off **Đăng mọi kênh** on the Hàng đợi page (a switch is on while it is publishing), or call
`marketing_pause {paused: true}`. Writing and checking go on. To take a post
down, choose **Gỡ bài** on the Bài viết page (a queued post: **Gỡ khỏi hàng đợi**). Removal goes through the same
claim and leaves one commit on the blog's history; on X, Facebook and Reddit
the Editor deletes the post in its browser. To stop one platform, pause its
channel.

## Friction round 2: what runs without a model

- `marketing-blog` (every 10 minutes) is a tool chain: `due {channel}` -> `claim` -> `lohi-blog.publish` -> `record`. It wakes the Editor only when a step fails.
- `marketing-dispatch` skips the blog channel (`skip`), so the Editor's turn is for X, Facebook and Reddit.
- `marketing-plan` queues a `ready` draft older than one hour itself, and wakes the Writer for a blog slot or for social drafts of a published post (one per signed-in, unpaused channel; none while all are paused).
- `marketing-probe` (chain around `browser-use.control`) checks whether a paused channel is really signed in and unpauses one the founder confirmed. Its page markers are heuristics, untested against a live login.
- `marketing-report` (21:00): at most six plain lines, the top three posts and what the plan does next.
- The next topic is ranked by Search Console clicks, else campaign leads; a genre written twice to no effect is tried last.
- Search Console and campaign credentials are optional: without them their tools answer a quiet `skipped`. Campaign actions on the page answer `needs_credential` with a link to Thiết lập; reschedule, pull, restore, pause and `set_limits` need no key.
- `setup.mjs` finds `.2server/connection.yaml` (LOHI_REPO, a parent checkout, then `~/.2server`) and writes `LOHI_CONNECTION` into the host env. The Editor and Writer carry only the marketing tools they use (`marketing:tools=...`).
