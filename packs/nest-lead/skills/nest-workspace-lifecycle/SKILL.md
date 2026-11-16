---
name: nest-workspace-lifecycle
description: "Build and keep a whole workspace working: lean teams (no workflow inside a team), then the ontology (entities from the packs' tables, which team may read, request, update or decide each, processes as moves of one entity with within, deadline, gates and always an end path), then flows per process (happy path, a broken path, every trigger), run them, read the diagnosis, improve, report plainly. Load it for dựng đội và quy trình, đội có chạy tốt không, vì sao việc không chạy, a loop that runs by itself, or after a team, pack or schedule change. Money (a bigger daily_tokens or budget, an improve budget above 500000, a pricier model, a paid tool) and removing a gate are the person's: manage_gated."
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

**Terms and team lines** (`terms`, `teams.<t>.does`, `not`, `ask`): the words the
person uses and what each team takes. Short, from the person's own vocabulary.

Keep it small. Two processes that work beat ten that were never run.

## 3. A flow per process

A flow is a test of the process as people meet it, not of what a member does
inside a team. `flow.save` with `id: "<process>/<name>"` and `flow` (a
`*.flow.json`: `process`, `world`, `cases` of `steps` and `expect`). Steps drive
from outside: `fire`, `chat`, `mail`, `insert`, `piece`, `fake`, `answer`,
`advance`, `wait`. Expectations judge what is observable: `state` (the entity
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
- Never write a flow that asserts which member did which step.
- Never route money around because a step is automated.
- Never say a process works until a flow ran it and its state moved.
