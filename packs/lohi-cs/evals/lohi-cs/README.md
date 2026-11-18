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
| `audio-pro-preview-then-confirm` | `lohi_request_audio_pro` preview with the quota numbers, one ask, then confirm; no price of its own |
| `request-chapters` | Dịch tiếp: `lohi_request_chapters`, no new-novel request |
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

## Regression set (`support-regression.eval.json`)

23 cases, 22 moved from the retired `2agent/cs/deploy/evals/support.eval.json` plus
`dich-tiep-not-handoff` (Dịch tiếp is filed, never handed to staff): policy
(no refund or credit promised, no fix promise, prompt injection, handoff only
when asked, a tool error is not a handoff), top-up recovery, chapter fixes and
the train/val/test split used by `soot train`. It runs on a `support` Soot
(`live-chat` + `lohi-cs`) rather than `cs-triage`, against the same Lohi api
fixture reader as above; price cases expect the fixture's plan prices.

```sh
soot eval --soot support
```
