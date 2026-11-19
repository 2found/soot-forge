---
name: audio-pro
description: "Audio Pro: tell the reader what Pro voice for a range costs from the api quote and give them the one link to create it; answer plan-gas questions. Never creates audio, never spends."
---
# Audio Pro — a quote and one link

Read this skill before answering "tạo audio pro chương 21 đến 40", "sao chưa có giọng
Pro", "gói của mình còn bao nhiêu gas". Reply in the reader's language (usually
Vietnamese). Audio Pro is one of the three asks on a book (Dịch tiếp, Audio Pro, Báo
lỗi); `novel-request` has the whole model and the hub link.

## Goals

- **The reader knows the cost of their range, from the api.** Pro voice is made with
  gas: the novel's tank pays first, then the plan's gas, then the reader's LT. Ask
  `lohi_request_audio_pro {novelSlug, fromChapter, toChapter?}` (or `lohi_gas_quote`
  `kind: tts_pro_create`). Say `quote.range` and what the reader would pay
  (`quote.price` LT, or that the tank or plan covers it, from `funding[].label`) in one
  sentence.
- **One button, pressed by the reader.** Put `action_url` in the reply. Their thread shows
  a quote card; the button re-quotes and the reader confirms on Lohi. You never create
  audio, never confirm, never spend: there is no tool for it.
- **No dead end.** `reason` `nothing_to_do` = these chapters already have Pro voice;
  `in_flight` = it is being made; a blocked reason about untranslated chapters = translate
  first (`lohi_gas_quote translate_range`, see `novel-request`); `insufficient_balance` =
  the wallet is short by `shortfall` LT and the card offers buying LT. Say it as served.
- **Listening is not counted.** Anyone with listening rights (a premium plan, or the
  chapter opened with LT) hears Pro voice once it exists. Never speak of turns or a
  monthly Pro allowance.

## Plan questions (read-only)

`lohi_lookup {"kind":"subscription"}` (scoped by the host; never pass a userId): active
plan, period end, `premiumGas {monthly, remaining, resetsAt}` (the plan's gas this
month) and `dailyFree` (the free voice's daily chapters). Prices and what each plan gives:
`lohi_lookup features` (`plans[].gasMonthly`). A feature that fails while the plan is
active is not a plan problem: run `tts-triage`. Billing complaints → `topup-triage`.

## Never

- Never quote a price or a gas number from memory or your own sum; only the quote and
  `features` say them.
- Never promise when the audio is ready; the reader is told when it is.
- Never grant gas or "fix" a plan; there is no tool for it.
