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
| `request-novel` | `lohi_request_novel`, title confirmed back |
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
