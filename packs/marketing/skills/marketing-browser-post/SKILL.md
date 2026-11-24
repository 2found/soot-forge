---
name: marketing-browser-post
description: "Publish, find, reply and unpublish on X, a Facebook Page, Reddit and TikTok (video upload) through the Soot-kept browser, from a signed marketing claim: signed-out, captcha and changed-layout checks, exact text, post URL, record or fail. Never posts twice."
---
# Posting through the Soot's browser

Use this for a channel whose publisher is `browser` (X, a Facebook Page,
Reddit, a TikTok account). You drive the `browser-use_control` tool. When the person granted you
a named browser profile for the account (`browser-use_view {}` lists your
`profiles`; the id names the account, such as `brand-x`), pass
`"profile": "<id>"` on every control call for that claim: the sign-in lives
there. A claim may name the profile itself (`profile`, from the channel's
setting): use exactly that one and never another account's, so two TikTok
accounts never share a sign-in. A named profile that is not in your
`profiles` is `marketing_fail {status:"needs_person", reason:"signed_out"}`. Otherwise the host keeps this Soot signed in to one browser profile when
it lists the Soot in `SOOT_BROWSER_PERSISTENT_SOOTS`. The person signs in once,
in Nest's docked browser panel, on the login page you opened. You never sign in, type a password or a 2FA code, solve a
captcha or switch accounts.

A community post from the Marketing desk (Reddit, Hacker News, dev.to) is the
founder's to post: it never has a claim, and you never post it, even when asked
in a chat.

Every action starts from a signed claim from `marketing_claim`. The claim
carries `platform`, `account`, `profile`, `body`, `title`, `link`, `subreddit`, for
a reply `reply_url`, and for a video `assets` (the file to upload).
Type its text exactly: never reword it, add tags or
mention anyone. Act at human pace: one claim at a time, with no rapid
retries. Never like, follow, vote or message.

## The rule that keeps one post one post

The intent is written before you act. So:

- **`verify_first: true`**: an earlier attempt may already be live. Run
  **Find** only. If you find it, `marketing_record`. If you cannot be sure,
  `marketing_fail {status: "uncertain"}`. Never open the composer for that
  claim.
- After you press the post button, never press it again for the same claim.
  If the page does not show the result, run **Find**. If it is not found,
  `fail uncertain`. A person answers from Cần bạn, and an uncertain item is
  never claimed again on its own.
- Call `marketing_record` or `marketing_fail` exactly once per claim.

## Read the page (each snapshot)

Use `snapshot -i -c` (interactive, compact). Classify the page with these checks, in this order:

1. **Signed out:** the URL path has `login`, `signin`, `i/flow/login` or
   `checkpoint`, or the snapshot has a password field or a "Log in"/"Sign in"/
   "Đăng nhập" form instead of the account. Then
   `marketing_fail {status:"needs_person", reason:"signed_out", platform}`.
2. **Captcha or check:** "captcha", "Verify you are human", "I'm not a
   robot", "Xác minh", or an arkose/hcaptcha/recaptcha frame. Then
   `fail needs_person` with `reason:"captcha"`. Never try to solve it.
3. **Composer ready:** the platform's text box and post button below are both
   present.
4. **Otherwise** wait about 3 seconds and snapshot once more. If neither
   check matches in 2 snapshots, `fail needs_person` with
   `reason:"layout_changed"` and a short note of what you saw.

`needs_person` pauses only that channel. Nothing was posted. The other
channels go on. The person hears of it through `due.ask`, the one
`report_blocker` that ends your turn (marketing-dispatch step 4). A sign-out
is also told to Nest on the channel's browser profile (the fail answer's
`profile_report`); the item's Đăng nhập link opens that profile's sign-in, and
the channel resumes by itself once the person records it there. Never sign in
or mark a sign-in yourself.
A changed page or a captcha links to your browser, where the page stays open,
and offers "Chạy lại <platform>" / "Để <platform> dừng".

## Platforms

TikTok is a video channel only: see "Upload a video (TikTok)".

| | X | Facebook Page | Reddit |
|---|---|---|---|
| Compose | `https://x.com/compose/post` | the Page URL in `account`, then the "What's on your mind?" / "Bạn đang nghĩ gì?" button | `https://www.reddit.com/r/<subreddit>/submit?type=TEXT` |
| Text box | textbox "Post text" (or the composer's single textbox) | textbox in the "Create post" / "Tạo bài viết" dialog | textbox "Title" gets `title`; the body textbox gets `body` |
| Post button | button "Post" | button "Post" / "Đăng" | button "Post" |
| Link | a `link` goes at the end of the text | a `link` goes at the end of the text | a link post only when the sub's rules allow it; otherwise none |
| Find | `https://x.com/<account>`: the newest posts | the Page's posts (TikTok: `https://www.tiktok.com/@<handle>`) | `https://www.reddit.com/user/<account>/submitted/` |
| Post URL | `/<account>/status/<id>` | the post's permalink (`/posts/` or `permalink`) | `/r/<sub>/comments/<id>/…` |

On Facebook, post only as the Page and only on its own timeline. Never post
to a group. On Reddit, read the sub's rules in the sidebar before the first
post of the week; a rule against the post is `fail failed` with the rule.

## Publish

1. `marketing_claim {id, action:"publish"}`. A `refused` answer is final for
   this turn.
2. Navigate to the compose URL, then snapshot and classify.
3. Click into the text box and type the claim text exactly (`fill` or
   `keyboard inserttext`). Snapshot and check that the box holds that text.
   **A video claim** (`kind:"video"`, `assets[0]` = `{path, sha256}`): upload
   it before typing (below), then type the text.
4. Press the post button once. For a video, only after the upload shows its
   preview and the post button is enabled.
5. Open the find page and look for a post that begins with the claim's first
   60 characters (Reddit: the title). Read its URL.
6. `marketing_record {intent_id, url, platform_id}`, then report the
   `post_published` outcome it returns. If the post is not found, follow the
   one-post rule above.

## Upload a video (X, Facebook)

1. In the composer, snapshot and find the media file input (X: the
   "Add photos or video" / `input[type=file]` in the toolbar; Facebook: the
   "Photo/video" / "Ảnh/video" button, then the dialog's file input).
2. `browser-use_control {action:"upload", selector, path: assets[0].path,
   sha256: assets[0].sha256}`. The tool refuses a changed file or a path
   outside the workspace: that is `marketing_fail {status:"failed",
   reason:"upload: <the tool's message>"}`, nothing was posted.
3. Wait for the upload: snapshot every ~5 s, up to 2 minutes, until the video
   preview shows and the post button is enabled. A platform error (too long,
   too large, unsupported) is `fail failed` with its words. No preview after
   2 minutes is `fail needs_person` with `reason:"layout_changed"`.
   `assets[0].ai_label` true: on Facebook switch on the AI-content label in the
   upload dialog before posting; no switch found is `fail needs_person`.
4. Never upload twice for one claim: a second file input after an upload is
   the same claim's composer, not a new post.

## Upload a video (TikTok)

A TikTok claim is `kind:"video"` with `platform:"tiktok"`, the `account`
(`@handle`), often a `profile`, `body` (the caption, hashtags included) and
`assets[0]` = `{path, sha256}`. Drive TikTok Studio's upload page; the account
is whatever the claim's profile is signed in to. Never switch account.

1. Open `https://www.tiktok.com/tiktokstudio/upload` (the page the person
   signed in on). Classify it as above: a login page or a "Log in" / "Đăng
   nhập" form is `fail needs_person` with `reason:"signed_out"`. If the
   signed-in handle shown in the page header is not the claim's `account`,
   that is `fail needs_person` with `reason:"signed_out"` (name the handle you
   saw in the note) and nothing is uploaded.
2. Snapshot, find the file input ("Select video" / "Chọn video",
   `input[type=file]`) and run `browser-use_control {action:"upload",
   selector, path: assets[0].path, sha256: assets[0].sha256}`. A refused or
   changed file is `fail failed` with `reason:"upload: <the tool's message>"`.
3. Wait for the upload: snapshot every ~5 s, up to 3 minutes, until the
   preview shows and the post button is enabled. A platform error (too long,
   too large, unsupported, a copyright or "can't be posted" notice) is
   `fail failed` with its words. No preview after 3 minutes is `fail
   needs_person` with `reason:"layout_changed"`.
4. Click into the caption box and replace its default text (usually the file
   name) with `body`, exactly. Snapshot and check it holds that text.
5. Under "AI-generated content" / "Nội dung do AI tạo": when
   `assets[0].ai_label` is true switch it on; no switch found is `fail
   needs_person` with `reason:"layout_changed"`. Leave every other setting
   (visibility, comments, duet, stitch, music) as it is.
6. Press "Post" / "Đăng" once. If a "Continue to post?" / "Tiếp tục đăng?"
   dialog appears, press "Post now" / "Đăng ngay" once. Never press it twice
   for one claim. TikTok may show a short "uploaded" screen with no link.
7. Find (below): `https://www.tiktok.com/@<handle>`, the newest video whose
   caption begins with the claim's first 60 characters. Its URL is
   `/@<handle>/video/<id>`: `marketing_record {intent_id, url, platform_id:
   <id>}`. A new video can take up to a minute to appear: wait and reload
   twice before calling it not found, then follow the one-post rule above.

## Find (crash recovery)

Open the find page and read the newest 20 posts (scroll once if needed).
Match on the claim's opening text (Reddit: the title) and the claim's day.
Only a clear match is found. Anything else is not found.

## Reply

The claim has `action:"reply"` and `reply_url`. Open `reply_url`, classify the
page, open its reply box, type the claim text exactly, then press "Reply" /
"Trả lời" / "Comment" once. Read the URL of your reply. If the platform gives
none, use the thread URL with the reply's anchor. Then `marketing_record`. A
reply carries no link on X.

## Unpublish

The claim has `action:"unpublish"` and `url`. Open `url` and classify the
page. Open the post's "…" / "More" menu, choose "Delete" / "Xóa", then
confirm. Reload. When the page says the post is gone, call
`marketing_record {intent_id}`. If the delete option is missing, use
`fail needs_person` with `reason:"layout_changed"`.
