# Lohi CS

> **Deprecated in Soot Forge (2026-11-18).** This is Lohi's own pack. Its source of truth moved to the kiem-lai repository (`2found/soot/packs/lohi-cs/`) and Lohi's server runs that copy as a local pack. This Forge copy stays for installs that still reference it and is no longer updated.

Lohi's customer care tools and skills, layered on [`team-cs`](../team-cs/). The
two `team-cs` role Soots (`cs-triage`, `cs-escalation`) add `lohi-cs` to their
`packs`; `team-cs` keeps the path (triage, handoff, tone, memory) and this pack
adds what only Lohi knows: its tools, `lohi-triage` and the Lohi skills. Skill
names never collide with `team-cs` or `live-chat` (checked by
`scripts/catalog.test.mjs`).

## Who the reader is

The reader's own data (profile, wallet, top-ups, orders, subscription, requests,
unlocks, recommendations, thread history) is read from
`/agent/support/lookup/me/*` with the host-signed principal token
(`SOOT_PRINCIPAL_TOKEN` → `X-Soot-Principal`, principal-token contract). The api
scopes each read to the token's `sub` and answers `401 principal_required`,
`401 principal_invalid` or `403 principal_mismatch`. An anonymous conversation
has no token: those reads answer `principal_required` without calling the api.
**Dual-write window only** (CS engine P5.3, removed in R2): a host that still
runs the legacy cs bridge grants `LOHI_CS_LEGACY_SCOPE=1` (`grants.packs.lohi-cs.env`).
A conversation without a principal is then scoped by `conversationId`, which the
api resolves to the bound support thread (`403 thread_unbound` otherwise).
`find_novel`, `content_health`, `name_check`, `features`, `novel_chapters` and
`chapter_tts` are public. Write routes keep their bodies and add the header.
Neither the key nor the token is ever put on a command line or printed.

## Product gate

One runtime may serve several projects (products). A conversation that is not Lohi's is
refused with `{"code":"not_lohi_conversation","detail":"..."}` before any request:
`SOOT_PROJECT` (or the ToolCall's `project`) names another project than
`LOHI_PRODUCT` (default `lohi`), or the conversation's `event.binding` is outside
`LOHI_BINDINGS` (comma list, optional). `lohi_report_content_issue` proves no
reader, so without a principal or the legacy scope it also needs a positive Lohi
signal (the project or a listed binding). Public reads stay open on a
conversation that carries no project at all.

## Approvals

`lohi_recover_topup` credits LT and `lohi_fix_chapter` changes a chapter: both
are `approval: "operator"` with a dry-run `preflight` that renders the approval
card. `lohi_request_novel`, `lohi_request_chapters` (a `chapters` or `quality` request for a novel
already on Lohi), `lohi_send_source` (a source link for a book that waits on one) and
`lohi_report_content_issue` credit and change nothing and run without approval (the api
re-checks and staff approve a report). `lohi_request_audio_pro` is no staff approval
either: the reader's yes in the chat is the approval. It takes two calls, `step: preview`
(reserves nothing) and `step: confirm`, whose `expect {from,to,cost}` is copied from the
preview; the api re-previews and refuses `preview_changed` if the effect moved, and the
reader's own Audio Pass pays (no LT, no price on the wire). The hook `tool.preflight`
(dry run) of that tool is the preview.

## One book, three asks

The pack follows the product's model: a requested novel is one book with one page
(`hub_url`), and the reader asks three things of it: Dịch tiếp
(`lohi_request_chapters`), Audio Pro (`lohi_request_audio_pro`) and Báo lỗi
(`lohi_report_content_issue`), plus a source link (`lohi_send_source`). Requesting a
novel is one confirm and one call (`lohi_request_novel`, answer with `hub_url`).
`lohi_lookup` `requests` lists every book the reader requested or backed with `stage`,
`progress`, `needs_you` and `hub_url`. None of the four is a handoff to staff.

## Credentials

Named only, bound on the host: `LOHI_CS` (read key), `LOHI_CS_EXEC` (the key of
the two approval-held routes) and `LOHI_CS_BASE` (api base URL). No key or
token is in this pack. Prices, plans and gas numbers come only from
`lohi_lookup` `features` (X9), never from a skill or the collection.

## Knowledge

`knowledge/lohi-support/*.md` is the seed of the `lohi-support` pool of the data
pool: sign-in, missed top-ups, chapter and audio reports, novel requests.
Import the folder into a pool in Nest (Kho tài liệu), mark the pool public and
add `knowledge:pools=lohi-support` to both role Soots' packs. The pages hold how-tos and policy only, never a price.

## Tests

```sh
node --test tests/*.test.mjs   # the runner against a fake api (needs curl, jq)
soot eval --tag lohi-cs        # evals/lohi-cs, see its README
```

The runner is POSIX sh with curl and jq. The source of this pack was
`2agent/cs/deploy/packs/lohi-cs`, which stays as it is for the old `cs` deploy.
