---
name: audio-pro
description: "Audio Pro: create it for the reader from their own pass (preview, one confirm, then confirm with the previewed effect), and answer quota and plan questions."
---
# Audio Pro — create it, and read the quota

Read this skill before answering "tạo audio pro chương 21 đến 40", "sao audio pro
dừng", "còn bao nhiêu lượt", "mình đang ở gói nào". Reply in the reader's language
(usually Vietnamese). Audio Pro is one of the three asks on a book (Dịch tiếp, Audio
Pro, Báo lỗi); `novel-request` has the whole model and the hub link.

## Create Audio Pro (`lohi_request_audio_pro`)

The reader's own Audio Pass pays, from its quota. You never pay, quote or compute a
price. The api serves every number.

1. Find the novel: `lohi_lookup find_novel` → `slug` (the novel must already be on Lohi).
   Get the range from the reader ("chương 21 đến 40"); a start alone is fine.
2. Preview: `lohi_request_audio_pro {"step":"preview","novelSlug","fromChapter","toChapter"?}`.
   Nothing is reserved. Read the answer and tell the reader exactly its numbers:
   `range` (from–to, `chapters`), `cost` (turns of their quota), `quota.remaining` and
   `quota.remainingAfter`, `breakdown.voiced` (already has Pro audio, free).
3. If `canSubmit` is false, say the `blocker.label` and stop: `quota_empty` → used up
   until `quota.resetsAt`; `quota_exceeded` → a shorter range (`limits.maxTo`);
   `nothing_to_do` → every chapter already has or is waiting for Pro audio;
   `convert_only` → these chapters cannot get Pro audio yet; `no_chapters` → not
   published yet.
4. Ask ONCE: "Tạo Audio Pro chương 21–40, tốn 20 lượt, bạn còn 40 lượt sau đó. Mình tạo
   nhé?" Only a clear yes goes on (a reader who already gave the exact range and said to
   create it has said yes: still show the preview numbers in the reply).
5. Confirm: `lohi_request_audio_pro {"step":"confirm", "novelSlug","fromChapter",
   "toChapter": range.to, "expect": {"from": range.from, "to": range.to, "cost": cost}}`.
   Copy `expect` from the preview exactly; never compute it. `voiceId` is not needed.
6. Say it is queued, how many chapters (`accepted`), and that the reader is told when it
   is ready; the hub link for the book. Never a time.

Answers:

- `preview_changed` → the numbers moved since the preview: tell the reader the new
  numbers (the answer holds a new `preview`) and ask again. Do not confirm on the old yes.
- `cannot_submit` → read its `blocker` as in step 3.
- `voice_pro_pass_required` (402) → Audio Pro needs an Audio Pass. Say the reader has none
  and read what the pass is and costs from `lohi_lookup features` (`q: "audio pro"`);
  never quote from memory, never offer another way to pay.
- `no_voice_available` → handoff with the novel and range.
- `principal_required` → the reader must sign in to Lohi.

Pro audio for the ranges that Dịch tiếp translates follows the same path: ask after the
chapters exist.

## Quota and plan questions (read-only)

Call `lohi_lookup`, scoped to the signed-in reader by the host; never pass a userId:

- `{"kind":"subscription"}` — active plan, status, period end, TTS and Audio Pro quota
  counters (used, monthly limit).
- `{"kind":"profile"}` — tier and wallet balance for context; a failed renewal → also
  `wallet` / `orders`.

Reading the result:

- `used` ≥ `limit` → the quota is used up and resets at the period end; give that date if
  present. Never promise extra quota.
- `used` < `limit` but the feature fails → quota is not the cause; run `tts-triage` on the
  failing chapter.
- Two counters exist: Pro audio LISTENING chapters and Pro audio REQUEST count. Quote each
  from the lookup, do not merge them.
- No active subscription → say which plan gates it from `lohi_lookup features`; handoff if
  the reader disputes amounts. Billing complaints → `topup-triage`.

## Never

- Never quote a price, quota or cost from memory, the collection or your own sum; only the
  preview and `features` say them.
- Never grant, extend or "fix" quota; there is no tool for it.
- Never confirm without a preview and a yes from this conversation, and never with an
  `expect` you did not copy from the preview.
