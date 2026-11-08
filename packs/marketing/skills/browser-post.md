# Posting through the Soot's browser

Use this for a channel whose publisher is `browser` (X, a Facebook Page,
Reddit). You drive the `browser-use_control` tool. The host keeps this Soot
signed in to one browser profile when it lists the Soot in
`SOOT_BROWSER_PERSISTENT_SOOTS`. The person signs in once, in Nest's docked
browser panel, on the login page you opened. You never sign in, type a password or a 2FA code, solve a
captcha or switch accounts.

Every action starts from a signed claim from `marketing_claim`. The claim
carries `platform`, `account`, `body`, `title`, `link`, `subreddit` and, for
a reply, `reply_url`. Type its text exactly: never reword it, add tags or
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
`report_blocker` that ends your turn (marketing-dispatch step 4). For a
sign-in you open the platform's login page in your own browser and the item
links to it; the person signs in there and picks "Đã đăng nhập <platform>".
A changed page or a captcha links to your browser, where the page stays open,
and offers "Chạy lại <platform>" / "Để <platform> dừng".

## Platforms

| | X | Facebook Page | Reddit |
|---|---|---|---|
| Compose | `https://x.com/compose/post` | the Page URL in `account`, then the "What's on your mind?" / "Bạn đang nghĩ gì?" button | `https://www.reddit.com/r/<subreddit>/submit?type=TEXT` |
| Text box | textbox "Post text" (or the composer's single textbox) | textbox in the "Create post" / "Tạo bài viết" dialog | textbox "Title" gets `title`; the body textbox gets `body` |
| Post button | button "Post" | button "Post" / "Đăng" | button "Post" |
| Link | a `link` goes at the end of the text | a `link` goes at the end of the text | a link post only when the sub's rules allow it; otherwise none |
| Find | `https://x.com/<account>`: the newest posts | the Page's posts | `https://www.reddit.com/user/<account>/submitted/` |
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
4. Press the post button once.
5. Open the find page and look for a post that begins with the claim's first
   60 characters (Reddit: the title). Read its URL.
6. `marketing_record {intent_id, url, platform_id}`, then report the
   `post_published` outcome it returns. If the post is not found, follow the
   one-post rule above.

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
