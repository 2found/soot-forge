# Lohi's marketing workspace

A local Soot workspace that writes, checks and publishes Lohi's blog with no
marketing hub and no person in the loop. Three Soots (Writer, Editor, Video)
share the [marketing pack](../../packs/marketing/README.md)'s own storage. The
[Lohi blog publisher](packs/lohi-blog/README.md), a local pack that ships with
this recipe, puts posts on `blog.lohi2.com`.

**Needs Soot 0.13.12 or later.** The recipe uses the workspace `env` field, the
`marketing:tools=` pack selector and schedule catch-up; an older runtime refuses
the deployment.

```text
08:00       marketing_plan ──(a blog slot is free, once a day)──▶ Writer: plan {} brief ─▶ draft_save ─▶ check ─▶ schedule
            (also keeps the guard's price facts fresh; zero model calls when no slot is free)
7-22 h      marketing_due {schedule} every 10 m ──(a new need)──▶ Editor: marketing_claim ─▶ lohi-blog_publish ─▶ marketing_record
                                                            └──▶ marketing-browser-post (X, Facebook, Reddit) ─▶ marketing_record
06:00       marketing_gsc_sync  (zero model calls; a revoked sign-in is one host Cần bạn item)
every 2 h   marketing_replies_sync ──(notify)──▶ Editor: marketing-replies ─▶ reply_save ─▶ check ─▶ claim {reply}
05:20       marketing_channels_setup (creates x-lohi, facebook-lohi, reddit-lohi paused; fills unset caps)
06:30       lohi-blog_ready ──(something missing, changed)──▶ Editor: one Cần bạn item
07:00       marketing_campaign_report ──(notify)──▶ Editor: record lead outcomes, token count, 80 % note
on request  Video: marketing-video ─▶ mvf (2build) ─▶ marketing_video_import ─▶ Editor: check ─▶ schedule ─▶ browser upload (X, Facebook)
```

| file | what it is |
| --- | --- |
| `setup.mjs` | builds the workspace from this recipe and generates the claim key |
| `deployment.example.json` | product `Lohi`, the three Soots, the shared Editor/Video workspace, pack grants, the seven schedules, `approvals: {"marketing_claim": "auto"}` |
| `soots/lohi-*.json` | Writer, Editor and Video (`flash`), each with a small daily token budget |
| `soots/*.md` | the Lohi brief (`SOUL.md`) and each role's mission |
| `packs/lohi-blog/` | the Lohi-only blog publisher, a local pack: it is not in the Forge catalog |

The topic comes from the tool, not a Soot: `marketing_plan` reads Lohi's public
catalog (`/novel/discovery/feed`, `genres`, `/novel/novels/search`) and the
Search Console queries, picks a keyword not yet written, and hands the Writer
real novels with their links. `marketing_check` fails a draft whose
`lohi2.com` link answers 404 or 410. No Radar Soot and no facts schedule are
needed.

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

## Set it up

```bash
node examples/lohi-marketing/setup.mjs ~/.soot/lohi-marketing   # packs, Soots, deployment, claim key
cd ~/.soot/lohi-marketing && soot start
```

`setup.mjs` copies the packs and Soots, writes `deployment.json` and generates
the Editor's claim key once (never printed, never overwritten). If the runtime
knows the workspace `env` field, the three host settings (`PRODUCT_API_URL`,
`SOOT_BROWSER_PERSISTENT_SOOTS`, `LOHI_BLOG_REMOTE`) go into the file;
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
5. **Videos (optional):** `soot add 2found/soot-forge/packs/2build` and
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
