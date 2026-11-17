---
name: nest-workspace-lifecycle
description: "Build and keep a whole workspace working: lean teams (no workflow inside a team), then the ontology (entities from the packs' tables, which team may read, request, update or decide each, processes as moves of one entity with within, deadline, gates and always an end path), then flows per process (happy path, a broken path, every trigger), run them, read the diagnosis, improve, report plainly. Load it for dựng đội và quy trình, đội có chạy tốt không, vì sao việc không chạy, a loop that runs by itself, or after a team, pack or schedule change. Also the periodic tidy (processes with no flow, entities nobody reads, teams that own nothing, memory facts that do not help) and edits of one part (ontology.patch). Money (a bigger daily_tokens or budget, an improve budget above 500000, a pricier model, a paid tool) and removing a gate are the person's: manage_gated."
---
# Workspace lifecycle: teams, ontology, flows, improve

Load this when the person wants a workspace built from a sentence ("dựng đội bán
hàng và CSKH cho shop"), asks whether it works ("đội có chạy tốt không", "vì sao
việc không chạy"), wants work that repeats without them, or right after a team,
pack or schedule changed.

A workspace works when its **entities move through their process**, not when
its schedules exist or its chat sounds busy. Every claim comes from what a tool
returned (a table, a task, a flow result), never from a plan or memory.

Two layers, never mixed:

- **Between teams** is data in `ontology.json`: what things exist, who may touch
  them, who owns each move, by when, and where a person decides.
- **Inside a team** there is no workflow. How a team works lives in its team
  memory, its members' missions and the adapter it learns. You never write steps
  into a team.

The order below is the order of judgement, not a script: stop at the first
step the person did not ask for, and go back a step when a later one shows
the earlier was wrong.

## 1. Lean teams

A team is: name, description, members, entries, limits. Nothing else.

- Read first (`manage` `read`, `templates.list`). Reuse a template or a team
  that exists; a new Soot only for a kind of judgment or a key role nobody has.
- **Two small teams beat one big one.** Split by who owns a thing and who
  answers for its outcome (one team takes requests, one fulfils), not by step.
- The description says what the team takes and what it does not, in the words
  a sender would use. The members' lines name one owner per kind of work, so a
  Đầu mối never wanders.
- Put "how we do it here" (ask again when the source is missing, never guess a
  price) in team memory or a mission, once, as a fact with its reason. Do not
  number steps, and do not write a contract into the team: `contract` is
  retired and its refusals now come from the ontology.
- Show the person the teams in one message, then create after they agree
  (`group.create`, `group.policy.create|save`, `group.projects`).

## 2. The ontology

`ontology.read` first; you edit what exists, you do not start over. Save with
`ontology.save` (`request_id`, `revision`, the whole `ontology/v1` document).
Think in four parts.

**Entities: what teams hand to each other.** One per pack table with a
lifecycle: `owner` (the team that holds the table), `store {pack, table}`,
`state` (the column), `states`, `terminal`. Never retype the table's fields:
they come from the pack. If no pack holds the table, say so; do not invent a
store.

**Relations: who may do what.** Per team and entity, the least that works:
`read`, `request` (write into the owner's queue), `update`, `decide`. Narrow with
`fields` when a team should not see all of it. A refusal in a run ("contract
refused") means a missing relation or field: add that one, nothing wider.

**Processes: moves of one entity.** Each move is `{from, to, by}`, `by` one
team, with `within` when it must be quick. Set `deadline` for the whole
process. Rules of judgement:

- **Every instance has an end path.** Besides `released` or `done`, add a
  terminal for each way it can stop: `declined`, `no_source`, `failed`, a
  canceled one. List them in `terminal`. A process with only a happy ending
  strands the first request that cannot succeed.
- **Gates are for money and for a person's decision**:
  `{at, with: "person", why}`. A gate records that a move waits for the
  person. You may add one; **you never remove or loosen one**. `ontology.save`
  that drops a `gates` entry is held for the person: send it to
  `manage_gated` only if the person asked for exactly that, and say what the
  gate was protecting.
- `starts` names how an instance begins: `chat`, `app`, `admin`, `schedule`.
  Every real source of work is listed, with the team that receives it. All of
  them put the same row in the same entity: one queue, never a second path for
  the same work.
- A recurring start is a tool-first schedule (`repeat.how.tool` decides whether
  there is work; the model wakes only then). Size the day (fires x wakes x
  tokens) well under `daily_tokens` before you create it.
- A move owned by a team on another runtime stays `by` that team; ownership is
  the ontology's, not the runtime's.

**Edit one part, not the whole file.** `ontology.read` gives `revision`; then
`ontology.patch` with `ops` (up to 64 of `{op: "set"|"remove", path, value}`) and
a `reason` in one plain sentence. Paths: `about`, `teams.<id>`, `entities.<id>`,
`relations[<team>,<entity>]`, `terms[<term>]`, `processes.<id>`,
`processes.<id>.moves[<from>><to>]`, `processes.<id>.gates[<at>]`. A `set` of a
team, entity, process or term **replaces the whole object**: send it complete,
with what you did not mean to change. All ops apply or none. A stale `revision`
comes back as a conflict: read again, look at what changed, then retry once.
`ontology.save` (the whole file) is for a first build; it refuses an empty
document unless `clear: true`, which only the person's words allow. Every
change, yours or the person's, is one line in the workspace history with your
`reason` and a `Hoàn tác` button in Nest (Quy trình, Lịch sử). A part the person
last wrote by hand, and any ontology that belongs to another runtime
(`ontology_owned_by_peer`), is not yours: ask in Cần bạn, or say where to edit.

**Terms and team lines** (`terms`, `teams.<t>.does`, `not`, `ask`): the words the
person uses and what each team takes. Short, from the person's own vocabulary.

Keep it small. Two processes that work beat ten that were never run.

### Hard rules and soft rules

The ontology holds the **hard rules**: who owns, reads, requests, decides,
which move, which gate. Workspace memory holds the **soft rules**: "ask again
when the source is missing", "never guess a price". They never overlap:

- Something that can be refused, or a person must approve, is ontology.
- Advice an agent may weigh is a memory fact with `scope: workspace`, one
  sentence and its reason, tagged to where it applies: `process:<id>`,
  `move:<entity>:<from>><to>`, `entity:<id>`, `team:<id>`. An untagged fact has
  no place on the page and is read by nobody on purpose; tag it.
- A fact that grants access, or restates a move, belongs in the ontology; move
  it and retire the fact.
- Nest shows each soft rule beside the state or move it is tagged to, lighter
  than the hard rules, with who wrote it (a person's is never overwritten) and
  what a run measured.

## 3. A flow per process

A flow is a test of the process as people meet it, not of what a member does
inside a team. `flow.save` with `id: "<process>/<name>"` and `flow` (a
`*.flow.json`: `process`, `world`, `cases` of `steps` and `expect`). Steps drive
from outside: `fire`, `chat`, `mail`, `insert`, `piece`, `fake`, `answer`,
`advance`, `wait`. `insert` writes only a workspace table; a table a pack owns
(the usual case for an entity) is never inserted from outside: start that
process with `chat` or `fire`, the way a person or a schedule would, and let the
team write the row. Step shapes (one verb key each; `send` sits beside `chat`, `option` beside
`answer`):

```json
{"chat": {"soot": "<soot id>", "as": "buyer-1"}, "send": "Em muon dat banh kem 20cm"}
{"fire": "<schedule id>"}
{"mail": {"to": "<soot or team>", "title": "...", "detail": "..."}}
{"insert": {"table": "<workspace table>", "row": {"col": "value"}}}
{"answer": {"title": "contains:..."}, "option": "approve"}
{"advance": "2h"}
```

Expectations judge what is observable: `state` (the entity
reaches a state), `moved` (to a state, by the right team), `table`, `calls`,
`task`, `attention`, `reply`, and `runs` only as a cost cap.

Write, for each process:

1. **The happy path**: one instance goes from start to its good end.
2. **At least one broken path**: no source, a refusal, a person who says no, a
   dead outside api. It must end in the end path you wrote, not hang.
3. **One flow per trigger source** in `starts`: the same instance entering by
   admin, by schedule, by chat and by the app all reach the same state. Do not
   build a second path for the same work.
4. A wait is real: a cap or a time rule goes into the flow as `advance`, so a
   slow step is not read as a dead one.

Money and customer-facing actions run against a `fake` or a stub, never the
real outside. A flow never asserts who inside a team did which step. `flow.list`
before writing, `flow.delete` only a flow you wrote and now replace.

## 4. Run, diagnose, improve

1. `flow.run` `{flow_run: {process | ids | tag, attempts}}`: use `attempts: 3`
   for any step a model decides; one pass is luck. It returns a run id.
2. `flow.result` `{id: "<run>|latest"}`: summary plus a diagnosis per failed
   attempt: **tier** (ontology, team, Soot, budget, pack, world, noise), the
   **lever**, the **team**, the **fix** and a **money** flag. Read the tier
   before the symptom.
   - ontology: yours; add the relation, field or end path, then run again.
   - team: team memory, description, member line: an improve run writes it.
   - Soot: a draft eval waits for the person; take it with `improve.drafts.accept`
     (`id`, `draft`) only when its source is `flow:<id>` and you read it.
   - budget: lower or equal limits are yours; above `daily_tokens` is money.
   - pack: a referral for the pack's owner; say it, do not patch a pack.
   - world: fix the flow or the fake.
   - noise: report the pass rate; change nothing.
3. `improve.run` `{scope: "workspace", request_id, mode}`: `propose` to show the
   person first, `auto` when they said to apply. Leave `improve_budget` alone.
   `improve.status`, `improve.history` to look. `improve.apply` applies what
   is not money and the runtime re-measures; if the pass rate fell, it
   reverts itself. `improve.revert` `{scope, id: "<receipt>"}` is yours too:
   use it when the person says "hoàn tác". Without `scope`, `improve.*` still
   means one Soot with its `id`.
4. After a change run the flows again. Never call a fix good until a flow
   passed after it.

## 4b. The periodic tidy

Run it on a schedule (weekly, as a Lead recurring task) or when the person
asks "dọn workspace". Read first, then say what you found in one list, then fix
what is not money and say what you changed:

- a process with no flow, or no broken-path flow: write it (section 3);
- an entity nobody reads or requests: ask whether it is needed; remove the
  entity only with the person's word;
- a relation the contract log and the watch never used: narrow or remove it;
- a team that owns no entity and answers for no move: propose merging it;
- a Soot that has not run for a long time and no flow picks: propose dropping it;
- memory lint (duplicate, not loaded in 30 days, a step list instead of a fact,
  names missing from the ontology, grants the ontology does not allow, a share
  of the memory block that pushes other facts out): fix the wording, merge
  duplicates, move grants to the ontology.

**Memory is measured, not trusted.** Per fact: recall (was it in the run's
context when it should be), value (the run with and without it) and adherence
(was it followed). Keep what helps. A fact that has not changed a result after
three measurements is proposed for retirement, never silently dropped. A
harmful one is removed and the run is repeated; if the pass rate fell, the
change undoes itself. A fact that was followed every time, measured to help
and reads as a constraint is proposed for the ontology or a mission (promotion):
say so and let the person decide. A flow that declares `memory: {needs: [...]}`
runs a control without those facts: pass with and fail without proves the agent
uses memory; pass in both means the fact is redundant.

Report the health in three numbers, with the process figures beside them (flow
pass rate, instances stuck, cost): facts, **% recalled when relevant**, **%
measured** and **% not yet measured**, and how many harmful ones were removed.

## 5. Money is the person's

These never happen from you, even when the person says "just do it" in a
message that is not the approval card:

- raising `daily_tokens`, a team or host budget, `max_run_tokens` above what
  the Soot's `daily_tokens` can carry;
- `improve_budget` above 500000 weighted tokens (the default is enough; the
  runtime holds more);
- a pricier model tier, a paid tool, a pack grant;
- removing or loosening a `gates` entry in the ontology.

Send each through `manage_gated` with the same input and `request_id`; it waits
in Cần bạn with a preview. Say in one line what it is for, what it costs in
the person's terms, and that it waits for them. Do not also ask in chat, and
never write "đã nâng" before the receipt. A refused change is not retried under a
new id to get past the hold. Lowering a limit, shorter runs, any text, relation,
`within` or memory edit are yours.

## 6. Report to the person

Plain, Vietnamese first, short, from what you read. One line per process, then
the causes and who acts:

```
Đơn hàng: 2/3 flow đạt (3 lần). Trượt: khách hủy giữa chừng, đơn kẹt ở "đã báo giá".
Lỗi ở ontology: thiếu trạng thái kết thúc "đã hủy". Mình đã thêm; chạy lại đạt.
Cần bạn: nâng ngân sách cải thiện lên 800000 (đang chờ ở Cần bạn).
```

- Say what you read and what you could not read. "Chưa có flow nào" is an
  answer, not a reason to stop.
- Say what changed only with a receipt, and give the `Hoàn tác` link when
  there is one. A dry run or a held change is "chờ bạn duyệt", never "đã".
- Say the pass rate and the number of attempts, not "ổn".
- End with what waits for whom. Read each source once; about ten reads cover a
  workspace, then answer. A check ends with an answer, never on `report_blocker`.

## What never to do

- Never put steps, a workflow or a contract inside a team.
- Never remove a gate, or add a process with no end path.
- Never retype a table's fields into the ontology.
- Never `set` one part of the ontology without reading it first: a `set` replaces the whole object.
- Never put a rule that can be refused in memory, or a grant in a fact.
- Never write over a part or a memory fact the person wrote; ask in Cần bạn.
- Never retire a memory fact only because it is unmeasured.
- Never write a flow that asserts which member did which step.
- Never route money around because a step is automated.
- Never say a process works until a flow ran it and its state moved.
