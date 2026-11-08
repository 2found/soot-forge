# Lohi's marketing workspace

A local Soot workspace that writes, checks and publishes Lohi's blog with no
marketing hub. Four Soots share the [marketing pack](../../packs/marketing/README.md)'s
own storage. The [Lohi blog publisher](packs/lohi-blog/README.md), a local pack that
ships with this recipe, puts posts on `blog.lohi2.com`.

```text
Radar ─▶ angle ─▶ Writer: marketing_draft_save ─▶ Editor: marketing_check ─▶ marketing_schedule
every 10 m  marketing_due ──(notify)──▶ Editor: marketing_claim ─▶ lohi-blog_publish ─▶ marketing_record
06:00       marketing_gsc_sync  (zero model calls; a revoked sign-in is one host Cần bạn item)
every 10 m  marketing_due ──▶ Editor: marketing_claim ─▶ marketing-browser-post (X, Facebook, Reddit) ─▶ marketing_record
every 2 h   marketing_replies_sync ──(notify)──▶ Editor: marketing-replies ─▶ reply_save ─▶ check ─▶ claim {reply}
05:20       marketing_channels_setup (creates x-lohi, facebook-lohi, reddit-lohi paused; fills unset caps)
05:30       marketing_facts_sync (prices and offers the guard checks against)
on request  Video: marketing-video ─▶ mvf (2build) ─▶ marketing_video_import ─▶ Editor: check ─▶ schedule ─▶ browser upload (X, Facebook)
```

| file | what it is |
| --- | --- |
| `deployment.example.json` | product `Lohi`, the four Soots, the shared Editor/Video workspace, pack grants, the five schedules, `approvals: {"marketing_claim": "auto"}` |
| `soots/lohi-*.json` | Radar (`lite`), Writer, Editor and Video (`flash`), each with a small daily token budget |
| `soots/*.md` | the shared soul and each role's mission |
| `packs/lohi-blog/` | the Lohi-only blog publisher, a local pack: it is not in the Forge catalog |

## Decisions in this recipe

- **No publish approval.** Lohi's founder asked for posts to go out
  without a click. The pack keeps `marketing_claim` behind an operator
  approval. This host alone sets it to `auto`. Every guard still runs inside
  the claim: facts, personal data, platform rules, duplicates, the Editor's
  verdict on that exact content, pause, caps, spacing and quiet hours. A model
  cannot skip them.
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

1. Install the Forge packs `marketing`, `research`, `writing`, `2build` and
   `toolbox` into this folder's `packs/` (`soot add 2found/soot-forge/packs/<id>`). `lohi-blog`
   is already there: it is Lohi's own publisher, kept out of the Forge
   catalog. Grant it with `soot grant lohi-blog`.
2. Store one random claim key for the Editor (for example the output of
   `openssl rand -hex 32`): in Nest, Đội Soot → Editor → the tool connections,
   `MARKETING_CLAIM_KEY`. Both packs declare it `from: operator`, so they read
   that one stored value and claims are signed and checked with the same key;
   an environment variable is not read.
3. Set `LOHI_REPO` to a clone of the kiem-lai repository whose `origin` the
   machine can push to over SSH. The publisher keeps its own clean worktree
   under the pack's state directory and never touches yours.
   `LOHI_BLOG_URL` is optional; it defaults to `https://blog.lohi2.com`.
4. Sign in to Google from Nest for Search Console (`GSC_GOOGLE`). Until the
   first read, the Bài viết page shows "Chưa có số liệu", never 0.
5. Install `browser-use` (`soot add 2found/soot-forge/packs/browser-use`) and the
   browser (**Cài trình duyệt** in Nest, or `soot browser install`).
   - Start the runtime with `SOOT_BROWSER_PERSISTENT_SOOTS=lohi-editor` in its
     environment. With `soot serve`, export the variable first. The
     service passes on only the environment it starts with, and
     `soot service start` starts it from the calling shell. Restart it with
     `soot service stop && SOOT_BROWSER_PERSISTENT_SOOTS=lohi-editor soot service start`.
     The start at login does not carry the variable yet: after a Mac
     restart, run that line again.
   - Without the variable, each Editor conversation has its own browser and
     sign-ins do not carry over.
6. Check the accounts in the `marketing-channels` schedule: the X handle, the
   Facebook Page URL and the Reddit user. Run the schedule once from Nest to
   create the channels. The Editor opens each login page in its own browser,
   and Cần bạn shows one item, "Đăng nhập X, Facebook, Reddit cho Lohi". For
   each platform:
   1. Bấm **Mở trình duyệt**.
   2. Đăng nhập trong khung bên phải.
   3. Bấm **Đã đăng nhập <X|Facebook|Reddit>**.

   The Editor checks that account and the channel shows "đã đăng nhập, chờ
   Bật". Nothing posts until you choose **Bật** for the channel on the Hàng
   đợi page (`resume`). You never give Soot a password.
7. For videos, run `python3 packs/2build/marketing-video/tools/mvf.py doctor`
   until it prints READY (ffmpeg, Node, HyperFrames 0.8.153, voice and the
   Micro Fish workspace). Grant `marketing` and `browser-use` the workspace
   (`soot grant marketing`, `soot grant browser-use`), then ask Video
   "Làm video từ bài <tên bài>".

To stop publishing, choose **Tạm dừng mọi kênh** on the Hàng đợi page, or call
`marketing_pause {paused: true}`. Writing and checking go on. To take a post
down, choose **Gỡ bài** on the Bài viết page. Removal goes through the same
claim and leaves one commit on the blog's history; on X, Facebook and Reddit
the Editor deletes the post in its browser. To stop one platform, pause its
channel.
