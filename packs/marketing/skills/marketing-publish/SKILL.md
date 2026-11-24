---
name: marketing-publish
description: "Take reviewed work live: one approval per desk bundle (with or without a hub), hand-offs for what the founder posts, and never repeat an uncertain post."
---
# Publishing

You take reviewed work live: through the hub, or on the Marketing desk through
one approved bundle per item. Publish only what passed an editor's review on a task (yours or a teammate's). Whether a person approves
each publish first is the host's approval policy, not your choice: when a
publish waits in **Cần bạn**, report it as waiting and do not call it again.

## On the Marketing desk: one approval per bundle

When the team keeps a marketing library (`MARKETING_ROOT` is set) or the work
is a desk item (`MK-…`), the founder approves each source and everything made
from it once, and the pack publishes it. Do not call `cms_publish` or
`social_publish` yourself for a desk item.

1. When the Writer's `item_save` is reviewed, call `publish_bundle` once for
   the item: `ref`, `product`, and `posts`, one entry per part, copied exactly
   from `item_save`'s answer, `cms_read` or `social_list` (`page_view {view:
   "item", ref}` shows them too):
   - blog: `{channel: "blog", lang, site, slug, revision, title}`;
   - X, Facebook, TikTok: `{channel, lang, id, revision, text, link}`; a post
     saved with no hub has no `id`: leave it out;
   - community: `{channel: "community", lang, revision, title, body}`;
   - newsletter: `{channel: "newsletter", lang, revision, subject, preheader,
     body}`.
   A part saved only as files (`local: true`) takes the item's `revision`. A
   launch pack is one bundle: its blog, its X post and its community part
   (Show HN). The approval card in **Cần bạn** shows every post and about when
   it goes out. A call refused before the card (a revision or a text that
   moved) is fixed with `item_save`, then called again.
2. While the card waits, do nothing more for the item. A rejection comes back
   with the founder's note: hand it to the Writer, then call `publish_bundle`
   again with the new revisions.
3. After Duyệt the tool only records the approved set. The `release_due`
   schedule publishes each post at its slot with the approved revision, holds
   one whose words changed and never posts a missed slot late. X and Facebook
   go out at about their slot, when the browser poster takes them.
   - **Skipped parts.** A post for a channel the product has no account on, or
     one not connected, is left out of the approved set (`skipped` in the
     answer, `no_account` or `channel_not_connected`) and stays a draft. Say so
     in your reply ("Bài X chưa lên vì kênh chưa nối; bài nằm lại làm nháp").
     Once the channel works, call `publish_bundle` again for the same `ref`
     with only those posts: it is its own approval.
   - **Hand-offs.** Community posts, newsletters, TikTok and, without a hub,
     X and Facebook become the founder's hand-offs after Duyệt. The desk shows
     each on Hôm nay with its steps; the founder posts and pastes the link
     there (`confirm`). Do not raise a `report_blocker` for them and do not
     `social_record` them. When the founder sends you a link in the chat
     instead, record it once with `page_action {op: "confirm", ref, outcome:
     "posted", url, channel, lang}` (a TikTok video takes no `channel`).
   - **Launch pack.** After Duyệt its Show HN part is its own community item
     (`split` in the answer): the founder posts it when ready, while the blog
     and X go out on their slots.
   - **Newsletter.** The founder presses Gửi bản tin… (you send it as the
     `marketing-edit` skill says) or exports it and marks it sent.
4. Keep one schedule for it: `release_due` every 5 minutes, tool-only (no
   model). It wakes you only when its answer has `notify: true`; then raise
   ONE `report_blocker` that lists every post it names, with the reason and
   what the founder can do on the desk. Never retry a post it held.
5. A second tool-only schedule, `library_scan {hub: false}` every 30 minutes,
   keeps the desk's library in step with the folder.

### Without a hub (hubless desk)

When `MARKETING_HUB` is not bound, the desk still works, and so does this flow:

- `item_save` saves every part as files; the bundle carries the item's
  revision and no hub ids.
- A product's blog is `folder` (or `none`) in `products.json`. At its slot
  `release_due` writes each approved blog as Markdown with front matter into
  the product's `blog_dir`; that counts as Đã lên and the founder publishes
  the site. `blog: none` has no blog part. Keep the `release_due` schedule even
  without a hub: it is what writes those files.
- X and Facebook have no poster without a hub: they are hand-offs (above), as
  are TikTok and community posts.
- Nothing is published anywhere else; there is no `cms_publish` or
  `social_publish` without a hub.

The founder can stop an item, pause every channel or one, and change a
channel's pace on the desk. Respect what you read there: a stopped item is not
published, and only you reopen one (`item_save` with `reopen: true`), and only
when the founder asked for it.

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

## Going live (outside the desk)

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
  once for all of this turn's hand-offs: `summary` "Cần đăng tay: <số> bài trên
  <kênh>, <kênh>" (the person reads it as a title: name channels and a count,
  never a post id),
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

With a hub, update each item's row in the `content` table (`live` with `url`, or `held`); without one `marketing_record` is the record. Then update
the task: `done` when everything went live or waits for the browser poster;
`blocked` with what is needed when a hand-off or decision is open. End with a
short report: what went live (URLs), what waits for the poster or a person,
what you held back and why.

## The older queue (no desk, no hub): claim, publish, record

Outside the desk and without a hub, the queue publishes at its own pace: a tool-only schedule runs `marketing_due`
and wakes you only when something is due or a person is needed. Follow the
`marketing-dispatch` skill.

`marketing_pause {paused: true}` stops every channel at once; writing and
checking go on.
