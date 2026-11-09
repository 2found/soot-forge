# Dispatch: claim, publish, record (no hub)

The blog's own publishing needs no model: the `marketing-blog` schedule runs
`due → claim → the blog pack's publish → record` as tools. It wakes you only when a
step failed (its output is attached): if it carries an `intent_id` and the
post is not live, `marketing_fail {intent_id, status:"failed", reason}`;
otherwise nothing. This skill is for the rest (X, Facebook, Reddit, unpublish).

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
4. Do not file Cần bạn items. The host raises the card for each need (a sign-in,
   a captcha, a late or uncertain post, a reply for a person) by itself from the
   dispatch tick, and runs the person's pick (`marketing_answer`, or
   `marketing_pause {signed_in}` for a sign-in) with no model; the sign-in probe then
   checks the session and raises the card again if the channel is still signed out.
   End the turn with one line.
5. **Only one pick wakes you**: "Đã lên — dán liên kết" on an uncertain post. Its
   prompt names the key: ask for the post's link with one `report_blocker` (no
   options), then `marketing_answer {key, option, url}` with the label exactly.
