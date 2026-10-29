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
