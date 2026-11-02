# TTS / audio-pro triage — audio that is silent, 2 seconds long or missing

Read this skill before answering "the audio won't play / plays 2 seconds /
Pro voice is empty / can't hear it". Reply in the customer's language
(usually Vietnamese).

Real reports: "audio Tương Dạ không nghe được từ chương 136", "audio thái hư
chí tôn bị trống nội dung từ chương 1891-2053". A real incident behind them:
Pro audio had been generated while the chapter text was still empty, so it
narrated only "Chương này chưa có nội dung." and ended after two seconds.
First separate TEXT problems from AUDIO problems.

## Flow

1. Resolve the novel and chapter exactly as `chapter-triage` step 1–2
   (`find_novel` on the title or link; a link carries the chapter number).
   Ask whether it is the standard voice or Pro only if the reader did not say.
2. `lohi_lookup {"kind":"content_health","novelId":"…","from":N,"to":M}` over the
   complained chapters (±10, or the stated range). Read `items[].body` AND
   `items[].audio`.
3. For one chapter you can also use `{"kind":"chapter_tts","chapterId":"…"}` for
   the latest job status and `failureCode`.

## Reading `items[].audio`

- `on_empty_text` — audio exists but the chapter text is empty/placeholder.
  This is a TEXT defect first: report `kind:"content"` (see `chapter-triage`).
  Tell the reader the audio will need regenerating once the text is fixed. The
  report tool refuses `kind:"audio"` here (`content_first`) on purpose.
- `placeholder` — the stored audio narrated only the placeholder sentence while
  the text is now fine: stale audio. Report `kind:"audio"`.
- `too_short` — audio far shorter than the chapter text (e.g. 2 seconds for a
  1800-word chapter). Report `kind:"audio"`.
- No `audio` item and no defect → the file looks fine; the problem is
  client-side (player, network, expired link). Suggest reopening / reloading;
  hand off with the chapter number if it persists. The player already falls
  back to the standard voice when a Pro audio is empty.
- `ttsJob.status` `pending` → still being generated ("đang tạo", no ETA).
  `failed` / `undelivered` → name the `failureCode` to the team on handoff; do
  not quote `failureReason` to the reader.
- Chapter has no Pro audio at all: Pro audio is made on request and the team
  works through requests; chapters with more requests are prioritised. Say
  that, never an ETA. Do not promise to make one.

## Reporting

`lohi-cs_lohi_report_content_issue {"novelId","kind":"audio","from","to","note","reportId"}`.
The server re-checks the defect and queues a regeneration for a team member to
approve; tell the reader it was passed on, not that it is fixed.

## Billing questions in the same thread

"Nghe lại có mất linh thạch không?" — re-listening a chapter you already
unlocked is free. If the reader says they were charged again, look at
`lohi_lookup` `wallet` / `orders`, quote the real ledger rows, and hand off for
a correction; you cannot refund.

## Never

- Never trigger, retry or cancel a TTS job yourself — only propose through the
  report tool.
- Subjective voice quality ("đọc sai", "máy móc") and volume mixing are product
  feedback: take it down and hand off.
- Never promise "audio will be ready soon".
