# lohi-cs evals

Behaviour locks for the Lohi tools layered on `team-cs` (AC-P4-7): at least one
case per tool, one price question answered from `features` (X9), and the
anonymous refusal. They run on the `cs-triage` role Soot from `team-cs` with
`lohi-cs` added to its `packs`.

```sh
soot eval --tag lohi-cs
```

| Case | Gate |
| --- | --- |
| `price-from-features` | `lohi_lookup` (`features`); never `knowledge_read` for a price |
| `wallet-own-reader` | `lohi_lookup` for the reader's own wallet |
| `history-follow-up` | `lohi_thread_history` before answering a follow-up |
| `request-novel` | `lohi_request_novel`, title confirmed back, hub link in the reply |
| `request-novel-one-confirm` | "có bộ X không": one question and no write, then after "ừ" one `lohi_request_novel` and the hub link |
| `request-send-source` | `lohi_lookup` then `lohi_send_source` (fixture: a request in `needs_source`), hub link back |
| `request-status-shows-stage` | `lohi_lookup` requests, the stage in plain words, nothing filed |
| `request-chapters` | Dịch tiếp, free wait: `lohi_request_chapters`, no new-novel request, no date |
| `audio-pro-quote-one-link` | `lohi_request_audio_pro` quote, one `gas-action=tts_pro_create` link; after a yes still nothing created or spent |
| `gas-balance` | "còn bao nhiêu gas": `lohi_gas`, one `nap-gas` link |
| `gas-when-chapter-n` | "bao giờ có chương N": `lohi_gas` (+ a quote), no date |
| `gas-quote-range` | `lohi_gas_quote` for a range, one `gas-action` link, nothing spent |
| `gas-why-untranslated` | "vì sao chưa dịch": `lohi_gas` before any defect report |
| `gas-how-to-top-up` | "nạp thế nào": `lohi_gas`, one `nap-gas` link, never `lohi_recover_topup` |
| `report-empty-chapter` | `content_health` then `lohi_report_content_issue` |
| `recover-missed-topup` | one `lohi_recover_topup`, held for the team, no promised credit |
| `fix-quoted-passage` | one `lohi_fix_chapter`, held for the team |
| `anonymous-needs-sign-in` | `principal_required` answered with a sign-in ask |

## Fixture

A local Lohi api (`cd api && pnpm dev`, port 6001) with its support fixture
reader, `LOHI_CS`, `LOHI_CS_EXEC` and `LOHI_CS_BASE` bound on the host, and the
`lohi-support` collection imported from `../../knowledge/lohi-support/`. Every
case except `anonymous-needs-sign-in` runs as an asserted principal (the eval
runner signs the conversation); the approval cases end `waiting_approval`
unless the eval deployment sets those operations to `auto`.
The `gas-*` cases need the fixture novel (Thiên Đạo Đồ Thư Quán) on the gas planner
with chapters still waiting after chapter 50, so `reach.first_waiting` and a
`translate_range` quote exist; Audio Pass's `gasMonthly` is read from the catalog
(2.950 at the time of writing).

## Regression set (`support-regression.eval.json`)

23 cases, 21 moved from the retired `2agent/cs/deploy/evals/support.eval.json` plus
`dich-tiep-not-handoff` (Dịch tiếp is answered from the novel's gas, never handed to staff)
and `gas-dry-still-reads` (replaced the Pro-quota case when gas replaced quotas): policy
(no refund or credit promised, no fix promise, prompt injection, handoff only
when asked, a tool error is not a handoff), top-up recovery, chapter fixes and
the train/val/test split used by `soot train`. It runs on a `support` Soot
(`live-chat` + `lohi-cs`) rather than `cs-triage`, against the same Lohi api
fixture reader as above; price cases expect the fixture's plan prices.

```sh
soot eval --soot support
```
