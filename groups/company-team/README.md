# Company team: a company of teams

`company.source.json` is the 2found.dev flow as a template. A company is not a list
of roles: it is **teams**, and each team is an interface.

| team | group | Soots | gives out (tables others may read) |
| --- | --- | --- | --- |
| insight (also the thin company lead) | [team-insight](../team-insight/group.source.json) | analyst, radar | `opportunities`, `topics`, `scoreboard`, `handoffs` |
| marketing | [team-marketing](../team-marketing/group.source.json) | writer, publisher | `posts`, `metrics`, `signals` |
| cs | external (the [support team](../support-team/README.md), on the CS server) | support, desk | `voc` |
| financial | [team-financial](../team-financial/group.source.json) | finance (read-only) | the weekly report |
| build | external: Claude Code through `bbs team` | claude-code | `handoffs` (shipped / release state) |
| op-`<job>` | [team-op](../team-op/group.source.json), once per job | operator | whatever the job's pack owns |

Each team declares what it **takes in**, what it **gives out**, what it **decides alone**
and **with the founder**, its **daily token budget** and **when it escalates**. A team
starts with one or two Soots; a tool-only chain (publish, probe, GSC, scoreboard, radar
read, video stats) is a schedule of the team that owns the outcome, not a team. Insight
sets goals, runs the weekly review and proposes the budget split; the founder decides.
The lean budgets total 410k tokens a day (insight 130k, marketing 250k, financial 30k)
against the old Writer 250k + Editor 300k, plus 80k for each op team.

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

## What the runtime does not have yet (for L6)

A group schedule is a text task for Kamaji: it cannot hold a tool-only chain, and a
member's packs cannot narrow their tools (`validateGroup`: `id` or `id:read` only). There
is no company object that composes groups, no cross-team read grant (a team reads another's
table only through pack storage and a tool env), no per-team budget (budgets are per
member) and no per-team Nest page. This manifest is therefore Forge data plus the
workspace recipe's setup; nothing here asks the runtime for those. File pointers are in
the handoff of this change.
