# A short video from a post (marketing-video)

You turn one published post, or one chapter highlight, into one short video
and queue it on X and Facebook. The video itself is made by the 2build
`marketing-video` skill and its `mvf` tool: read that skill and follow its
stages. Do not write your own script, hook or pretest steps; this skill only
says where a team run differs and how the files reach Hàng đợi.

## 1. Start
- Pick the source: `marketing_items {state:"published"}`; its id is `parent`.
  Read the post from its URL. Prices, limits and "free" come only from the
  served sources (the `facts` the Editor checks); never from memory.
- One video at a time. Campaign folder: `marketing/campaigns/<slug>/` in the
  workspace, made with `mvf init <slug> --product <product>`.

## 2. Run mvf without waiting on the founder
mvf names three owner touchpoints. Here:
- **Brief:** answer it yourself from the post and the team brief: platforms
  `x` and `facebook` (add `tiktok` only as a handoff file), language `vi`.
- **Script approval:** after the Micro Fish pretest (`mvf judge scripts`) has
  written `decision.json`, run
  `mvf approve <sid> --verdict delegated --note "publish guard + Micro Fish pretest; founder previews in Hàng đợi"`.
  The publish guard (`marketing_check`, again at `marketing_claim`) judges the
  words that go out. When the deployment keeps `publish_approval: required`,
  the claim's approval in Cần bạn is the founder's word; never wait here.
- **The cut:** the founder previews in Hàng đợi and may pull it. Do not ask.
Loop on `mvf next` until `08-delivery/` has the files. A FAIL you cannot fix
in two tries ends the run (step 3 with `error`).

## 3. Queue
`marketing_video_import {request_id, campaign:"marketing/campaigns/<slug>",
channels:["x-…","facebook-…"], parent}` reads the pretest, the delivered files,
captions, poster and copy, and saves one video draft per channel.
- A render or export failure: pass `error` with mvf's FAIL line. The drafts
  stay drafts with "Lỗi dựng" and the reason.
- A hook under the pretest bar, or no Micro Fish round: the drafts stay drafts
  with "Câu mở đầu yếu". Nothing is queued; do not lower the bar or re-run
  the panel until it agrees.
- Otherwise the Editor runs `marketing_check {id, revision, verdict}` on each
  draft and `marketing_schedule {id}`; caps, spacing and quiet hours apply as
  for any post. The Publisher uploads it (marketing-browser-post).
Re-importing the same campaign after a fix updates the same drafts.

## Report
One line per draft: channel, id, state, and the reason when held.
