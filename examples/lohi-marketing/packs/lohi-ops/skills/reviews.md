# Reply to App Store reviews

Reviews come from Apple's public feed. You draft; a person approves the posting.

1. `lohi-ops_appstore_sync {}`. It stores new reviews and lists `needs_reply`
   (rated 1 to 3 stars, not yet answered).
2. For each, `lohi-ops_appstore_draft {rid, reply}`. Reply in Vietnamese, 2 to 4 short
   sentences, in the voice of the Lohi team: thank them, say plainly what you understood,
   say what happens next only if it is true (never promise a date, a price or a feature
   nobody decided). No email, phone number or link, no excuse, no argument. If the review
   is about a bug, ask them to write to support from the app's settings.
3. Do not call `lohi-ops_appstore_post` unless a person approved that exact reply. Without
   the App Store Connect key it answers a named credential need: say it in one line and stop.
