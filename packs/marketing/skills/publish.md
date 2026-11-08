# Publishing

You take reviewed work live through the hub. Publish only what passed an
editor's review on a task (yours or a teammate's). Whether a person approves
each publish first is the host's approval policy, not your choice: when a
publish waits in **Cần bạn**, report it as waiting and do not call it again.

## How a publish call works

- `cms_publish`: `site`, `slug`, `revision` and `title` copied from `cms_read`
  of the reviewed revision. The answer has the public URL.
- `social_publish`: `id`, `expected_revision`, `channel`, `text` and `link`
  copied from `social_list` exactly.
- The hub refuses a call that cannot go out (a stale revision, text that
  differs from the draft, a channel it is not connected to, an account that
  posts only for another site, TikTok) and says why: nothing was posted. Fix the
  draft and call once more, or hand it off below. Call `social_channels` when
  unsure what is connected and which sites each account posts for.
- Calling again with the same values is the same request; it never posts twice.

## When to stop and ask

Do not publish an item, and ask in the hand-off below, when:
- it would announce a price, a release date, a partnership, or a legal or
  security claim that no source states;
- it answers or criticises a named person or company;
- you cannot tell whether it is true and leaving it out would gut the post.

## Going live

- **Article first.** Publish the article before any social post that links to
  it, then `social_update` those drafts with its URL as `link` (their revision
  changes) and publish them in the same turn.
- **Connected channel** → posted; record the URL.
- **Approved for the browser poster** (`social_channels` says a Soot on the
  operator's computer posts it) → the hub did not post it yet. Do not publish it
  again or hand it off; report it as waiting for that Soot. A later
  `social_list` shows it `published`, `failed` or `uncertain`.
- **Not connected, TikTok, or an account for another site** → a person posts
  it. As the last call of your turn, after your report, call `report_blocker`
  once for all of this turn's hand-offs: `summary` "Cần đăng tay: <kênh> <id>…",
  `missing` one block per post (id, channel, the caption exactly, for TikTok the
  script, and "trả lời link bài đã đăng vào cuộc trò chuyện này"), `completed`
  your report. The person reads only Nest, so `missing` carries the text itself.
  When they reply with a URL, `social_record` it.
- Items held under "When to stop and ask" go into the same `report_blocker`
  call ("Cần quyết: …") with the exact sentence in doubt and the question. With
  one decision, give two to four `options` (your pick `recommended`) and an
  `if_unanswered` that keeps the item as a draft, never publishing or deleting.
- **Refused** (`failed`) → read the reason, fix with `social_update`, publish
  again.
- **Uncertain** → never publish again. `social_list` looks for a late post on
  the account; still uncertain means a person checks the account, then
  `social_record` its URL or `social_update status:draft`.

## Close the loop

Update each item's row in the `content` table (`live` with `url`, or `held`) and
the task: `done` when everything went live or waits for the browser poster;
`blocked` with what is needed when a hand-off or decision is open. End with a
short report: what went live (URLs), what waits for the poster or a person,
what you held back and why.

## Without a hub: claim, publish, record

The queue publishes on its own pace: a tool-only schedule runs
`marketing_due` and wakes you only when something is due or a person is
needed.

1. For each id in `publish`: `marketing_claim {id, action: "publish"}`; for
   each id in `reply`: `action: "reply"`. The claim re-runs the guard, checks
   pause, caps, spacing, quiet hours, staleness and the editor's verdict on
   this exact content, and writes the intent before anything goes out. A
   `refused` answer is final for this turn; its reason is already on the post.
2. Give the signed claim to the channel's publisher: its pack's `publish`
   tool (the blog), or the `marketing-browser-post` skill for a `browser`
   channel (X, a Facebook Page, Reddit). With `verify_first: true`, only look
   (`find`) and record what it finds; never post again.
3. `published` → `marketing_record {intent_id, url, platform_id}` and report
   the `post_published` outcome it returns. `failed` →
   `marketing_fail {intent_id, status: "failed", reason}`; a sign-in, captcha
   or layout problem → `status: "needs_person"` with `reason` `signed_out`,
   `captcha` or `layout_changed` (only that channel pauses); not knowing
   whether it went out → `status: "uncertain"`. Never call the publisher twice
   for one claim.
4. `unpublish` ids follow the same steps with `action: "unpublish"`.
5. `late` items are never posted on their own: they are in `needs` as "Bài lỡ
   giờ".
6. Items in `needs` that are not `raised` go to a person. `report_blocker`
   stops your turn, so first call `marketing_raised {keys}` with all their
   keys (the schedule then does not wake for them again), then, as the last
   call, one `report_blocker` for all of them.
   - **Sign-ins first** (needs with `login_url`, raised or not: the item
     names every platform still signed out). Open each `login_url` in your
     browser (`browser-use_control {action:"tab_new", url}`, one tab per
     platform, skipping one already open) so the page is ready in Nest's
     browser panel. Then one `report_blocker` with `summary`, `missing` and
     `options` copied exactly from `due.sign_in` (the title, one plain line
     per platform, the `nest://browser/<soot>` link, and one "Đã đăng nhập
     <platform>" option each). Add nothing: no tool names, keys, codes or
     "resume".
   - **When the person picks "Đã đăng nhập <platform>"**: select that
     platform's tab and open its home page (x.com/home, facebook.com,
     reddit.com). If the account shows and no login form, call
     `marketing_pause {channel, paused: true, signed_in: true}`: that channel
     stays paused ("đã đăng nhập, chờ Bật") and nothing posts until the person
     chooses **Bật** on Hàng đợi. Still a login form → say so in one line.
     Never post in this turn. Then call `marketing_due` again and file its
     `sign_in` the same way for the platforms still signed out (none left →
     no item).
   - **Other items**, after the sign-ins: `summary` names each, `missing` one
     line per item with the platform and what the person does: look at a
     changed page, answer "Không chắc đã đăng chưa" (live → paste the link;
     not live → post again; or drop it), or post a late item now, reschedule
     or drop it. The person's answers are Hàng đợi page actions (`resume`,
     `confirm_posted`, `confirm_not_posted`, `post_now`, `restore`, `drop`).

`marketing_pause {paused: true}` stops every channel at once; writing and
checking go on.
