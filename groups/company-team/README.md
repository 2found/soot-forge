# Company team: a company of teams

`company.source.json` is the 2found.dev flow as a template. A company is not a list
of roles: it is **teams**, and each team is an interface.

| team | group | Soots | gives out (tables others may read) |
| --- | --- | --- | --- |
| insight (also the thin company lead) | [insight](../insight/group.source.json) | analyst (numbers per product, signals packet, digest, decisions, review, weekly money review) | `opportunities`, `topics`, `scoreboard`, `handoffs`, queue `handoff_events` |
| growth | [growth](../growth/group.source.json) | editor, writer (the writer watches the radar, then writes) | `posts`, `metrics`, `signals` |
| support | external (the [support team](../support-team/README.md), on the CS server) or [support](../support/group.source.json) | answerer, desk (the desk files what the answerer records: a public-facing Soot never holds the write tools) | `voc` |
| operations | [operations](../operations/group.source.json) | operator, curator (catalogs, content quality, community moderation) | whatever the jobs' packs own |
| finance (optional) | [finance](../finance/group.source.json) | controller (read-only), for a company that wants a separate controller | the weekly report |
| workshop | external: the founder's Mac ([workshop](../workshop/group.source.json)) | builder, poster | reads `insight.handoffs`, writes `insight.handoff_events` |

The workshop runs where a browser and a coding agent are (the founder's computer). The server
cannot reach it, so it **pulls**: the founder's Go on the server leaves a `handoffs` row in
state `approved`; `builds_pull` on the Mac reads it (`soot data query`), starts the build and
inserts `started`, `progress`, `handover`, `shipped` or `failed` events into the insight team's
`handoff_events` queue; `handoff_events_apply` folds them back. Its edges are the contracts
`build-request` (read) and `handoff-events` (write). Without a `remotes` entry for `founder-mac`
the compiler leaves the team out and says so in its notes.

Each team declares what it **takes in**, what it **gives out**, what it **decides alone**
and **with the founder**, its **daily token budget** and **when it escalates**. A team
starts with one or two Soots; a tool-only chain (publish, probe, GSC, scoreboard, radar
read, video stats) is a schedule of the team that owns the outcome, not a team. Insight
sets goals, runs the weekly review and proposes the budget split; the founder decides.
The lean budgets total 410k tokens a day (insight 130k, growth 250k, finance 30k, optional)
against the old Writer 250k + Editor 300k, plus 80k for operations and 100k for the workshop
(on its own computer).

## Customize per company

Everything is data. An **overlay** (see [company.lohi.json](../../examples/lohi-marketing/company.lohi.json))
says `remove`, `rename`, patches a team (`teams`: Soot ids, budget) or `add`s one, and adds or
removes **contracts**. A contract is `{owner, reader, table, pack, mode, fields}`: which
team's table another team reads (or which request queue it writes), with the field names.
`scripts/company.mjs` composes the result and checks it: contracts name a table the owner
gives out, with fields the pack really has; an optional contract goes with a removed team
and a required one refuses the company; budgets stay under the ceiling and equal the
group's lean profile. `scripts/company.test.mjs` builds Lohi and a second company
(three teams, a different op team, no financial) from this one template.
Another product brings its own scoreboard adapter in the same shape (`SCOREBOARD_URL`,
contract v1, optional `cohorts` and `plans`) and its own packs.

## Goals and the weekly rhythm

`company.source.json` carries `goals`, which compiles into the runtime company's
`company.goals`: `cycle_weeks` 6, at most 3 goals per product and per team,
`ops_warn_ratio` 0.3, goals and waking repeats approved by the person, and
three `cadence` recurring tasks the runtime gives the Đầu mối of every team with
an active team goal (Asia/Ho_Chi_Minh):

| id | cron | what the Đầu mối does |
| --- | --- | --- |
| `weekly-commit` | `0 8 * * 1` | Monday: read goals, last check-in, open tasks and signals; commit at most 5 tasks, each linked to a goal |
| `weekly-checkin` | `0 16 * * 5` | Friday: `goal checkin` (value, confidence 0-10, one sentence) and the wins of the week |
| `cycle-review` | `0 17 * * 5` | Every Friday after the check-in; it acts only when a goal of the team ends within 7 days (a cron cannot count a 6-week cycle, and the quiet weeks cost one line) |

The texts name the `coordinator-rhythm` skill ([team-rhythm](../../packs/team-rhythm/README.md)).
An overlay `goals` object replaces single keys (a `cadence` list replaces the
whole list). The compiled block needs a runtime with company goals (Soot 0.14.0+);
Soot 0.13.29 refuses it as an unknown field.

## From template to runtime company

Status: experimental, internal. It is not offered as a public catalog item.

The `team-*` group templates are `soot/group-template/v3`: each carries a `contract`
(provides, decides, escalates, budget) and tool-chain schedules that run as a named member.
The edges between teams (`consumes`, `requests`) live only in this company template,
because a group on its own would be refused for an edge to a team that is not there.

`scripts/company.mjs` is a thin compiler from `soot-forge/company-template/v1` to
`soot/company-template/v1`. It has no checks of its own: it shapes the file, then calls
`soot company check --json` and prints the runtime's diagnostics. Find the binary with
`LOOP_SOOT_BIN` (else `soot` on PATH).

```bash
node scripts/company.mjs compile --mode adopt --overlay examples/lohi-marketing/company.lohi.json \
  --remotes examples/lohi-marketing/remotes.lohi.json --out lohi.company.json
node scripts/company.mjs check   --mode adopt --overlay ... --config <workspace>/deployment.json
```

- `create`: each team is pinned to a built group archive (`--groups <dir>`).
- `adopt`: the teams are the Soot ids of an existing workspace; `soot company adopt` moves it.
  With `--config`, a team the overlay gives no budget gets the sum of its members'
  `execution.daily_tokens` (what adopt derives, never more); with no member cap its
  `budget_80` escalation is left out and named in notes.
- Overlay `remove` and `rename` go to the runtime unchanged, so it refuses a removal that a
  required edge depends on (`company_edge_required`) or that removes the lead.
- A team with an entry in `--remotes` becomes a remote team (cs, `https://soot.lohi2.com`,
  no roster). Build runs outside Soot (Claude Code with `bbs team`) and is left out of the
  compiled company; the compiler notes it.

Runbook for a live workspace: [ADOPT.md](../../examples/lohi-marketing/ADOPT.md).
