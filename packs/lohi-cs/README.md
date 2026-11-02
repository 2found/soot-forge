# Lohi CS

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
`find_novel`, `content_health`, `name_check`, `features`, `novel_chapters` and
`chapter_tts` are public. Write routes keep their bodies and add the header.
Neither the key nor the token is ever put on a command line or printed.

## Approvals

`lohi_recover_topup` credits LT and `lohi_fix_chapter` changes a chapter: both
are `approval: "operator"` with a dry-run `preflight` that renders the approval
card. `lohi_request_novel` and `lohi_report_content_issue` credit and change
nothing and run without approval (the api re-checks and staff approve a
report).

## Credentials

Named only, bound on the host: `LOHI_CS` (read key), `LOHI_CS_EXEC` (the key of
the two approval-held routes) and `LOHI_CS_BASE` (api base URL). No key or
token is in this pack. Prices, plans and quotas come only from
`lohi_lookup` `features` (X9), never from a skill or the collection.

## Knowledge

`knowledge/lohi-support/*.md` is the seed of the `lohi-support` Kho tài liệu
collection: sign-in, missed top-ups, chapter and audio reports, novel requests.
Import the folder into a collection in Nest (Kho tài liệu) and grant it to both
role Soots. The pages hold how-tos and policy only, never a price.

## Tests

```sh
node --test tests/*.test.mjs   # the runner against a fake api (needs curl, jq)
soot eval --tag lohi-cs        # evals/lohi-cs, see its README
```

The runner is POSIX sh with curl and jq. The source of this pack was
`2agent/cs/deploy/packs/lohi-cs`, which stays as it is for the old `cs` deploy.
