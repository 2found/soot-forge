# Dispatch: claim, publish, record (no hub)

The tool-only dispatch schedule ran `marketing_due` and woke you. Act on its
answer with few calls: never call `marketing_items` (the claim carries the
text) or `update_plan`, never snapshot a page twice when once tells you,
and keep every text you write to one short line.

1. For each id in `publish` (`action:"publish"`), `reply` (`action:"reply"`)
   and `unpublish` (`action:"unpublish"`): `marketing_claim {id, action}`. A
   `refused` answer is final for this turn; its reason is already on the post.
2. Give each claim to its channel's publisher: the blog's pack `publish` tool,
   or, for a `browser` channel (X, Facebook, Reddit), the
   `marketing-browser-post` skill (read it once, only when you hold such a
   claim). With `verify_first: true`, only look and record what you find.
3. `published` → `marketing_record {intent_id, url, platform_id}`. `failed` →
   `marketing_fail {intent_id, status:"failed", reason}`. Sign-in, captcha or
   changed page → `status:"needs_person"`, `reason` `signed_out`, `captcha`
   or `layout_changed`, and stop that channel's other claims this turn (fail
   each the same way without opening the page again). Not sure it went out →
   `status:"uncertain"`. One publisher call per claim, ever.
4. Then the Cần bạn item. `report_blocker` stops your turn, so it is the last
   call. Call `marketing_due` once more if a claim paused a channel.
   - **Sign-in** (`due.sign_in` is present): open each `login_url` of the
     needs in its own tab (`browser-use_control {action:"tab_new", url}`),
     skipping one already open; call `marketing_raised {keys}` with the keys
     of needs not yet `raised`; then `report_blocker` with `summary`,
     `missing` and `options` copied exactly from `due.sign_in`. Add nothing.
   - **Other needs not raised** (changed page, captcha, "Không chắc đã đăng
     chưa", late items, replies Soot never answers): `marketing_raised
     {keys}`, then one `report_blocker`: `summary` names each, `missing` one
     line each with the platform and what the person does. Answers come back
     as Hàng đợi page actions.
   - Sign-in first; the other needs wait for the next turn.
5. **The person picks "Đã đăng nhập <platform>"**: your first call is
   `browser-use_control {action:"navigate", url}` with that platform's check
   page: X `https://x.com/home`, Facebook `https://www.facebook.com/settings`,
   Reddit `https://www.reddit.com/settings`. Do not list tabs and do not take a
   snapshot: the answer's `url` decides. Still that check page → signed in:
   `marketing_pause {channel, paused:true, signed_in:true}` (the channel waits
   for the person's **Bật**; never post now). Any other `url` (a login page,
   the front page) → still signed out. Then `marketing_due` and file its
   `sign_in` exactly as in step 4 without reopening tabs (none → end the turn
   with one line). Three or four calls in all.
