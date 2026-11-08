# Replies and comments

A tool-only schedule runs `marketing_replies_sync` every 2 hours. It reads
watched Reddit threads by RSS and wakes you only when there is something to
do:

- `classify`: saved replies with no class yet;
- `read`: browser channels (X, a Facebook Page) whose notifications were last
  read more than 2 hours ago.

## Read (browser channels)

For each channel in `read`, open its notifications or the comments under the
channel's recent posts with `browser-use_control`. Classify each page first,
as `marketing-browser-post` says: signed out or a captcha means you stop that
channel and raise it. Collect only replies to this account's own posts.

## Classify

Give each reply exactly one class:

| class | when | what happens |
|---|---|---|
| `safe` | thanks, a reading question, a recommendation, a friendly remark | you may answer |
| `complaint` | anger, a bug or quality complaint, a translation complaint | never answered; one Cần bạn item, "Phàn nàn" |
| `money` | payment, top-up, refund, price dispute | never answered; one Cần bạn item, "Tiền" |
| `account` | a reader cannot sign in, lost purchase, account data | only the fixed support pointer (`rules.support_reply`); one Cần bạn item labelled `rules.support_label` (default "Chuyển Hỗ trợ") with the thread link |
| `flagged` | anything you are unsure of, legal, press, a minor, personal data | never answered; one Cần bạn item, "Cần xem" |
| `spam` | spam, bots, scams | ignored |

When in doubt, use `flagged`. Never ask a reader for an email, a phone
number or account details in public.

Save each batch with `marketing_reply_save {channel, items:[…]}`, one call per
channel: `{id, class}` for a synced reply, or `{reply_url, thread_url,
parent_post, author_handle, text, class}` for one read in the browser. A
replay is harmless. The call also marks that channel as read, even with no
items.

## Answer (safe only)

1. Write one short, kind reply in the channel's voice. Use no link on X, no
   offer or price unless it is in the served facts, and no other handle.
2. `marketing_draft_save {kind:"reply", channel, parent:"R-…", body,
   request_id}`. The tool takes the target from the saved reply. It refuses
   a reply that is not `safe`.
3. `marketing_check` (the Editor's verdict), then `marketing_schedule`. The
   reply goes out through `marketing_claim {action:"reply"}` and
   `marketing-browser-post` under the channel's reply cap and spacing, like
   any post.

An `account` reply already has its pointer draft (`drafts` in the answer):
check and schedule it as it is; never change its text.

## Raise the rest

`marketing_due` lists every `complaint`, `money`, `account` and `flagged`
reply in `needs`. For each item not yet `raised`, file one `report_blocker`
with the platform, the reply's text in quotes, the class label and the reply
link. Then call `marketing_raised {keys}`. Never answer these yourself and
never pass a reader's details to another Soot.
