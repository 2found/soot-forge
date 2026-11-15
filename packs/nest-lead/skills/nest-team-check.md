# Check a team, and build a loop that runs by itself

Load this when the person asks whether a team works ("đội có chạy tốt không",
"rà soát đội", "vì sao việc không chạy", "đội phối hợp tới đâu"), asks for work
that repeats without them ("tự động", "mỗi ngày", "vòng lặp", "cứ có yêu cầu là
làm"), or right after a team, pack or schedule changed.

A team works when its **work's own records move**, not when its schedules exist
or its chat sounds busy. Every answer here comes from what the tools return,
never from a brief, a plan or memory.

## 1. Check: read the work, not the plan

Read in this order and stop at the first step that explains the problem. Keep
each read small (`limit`, one team's `scope`).

1. **Stuck tasks.** `task` `list` with `filter_status: ["blocked"]`, then
   `["doing"]`, per team. Many blocked tasks on one Soot is the first signal;
   `get` two of them and read the note and reason (budget, a missing tool, a
   person's decision).
2. **Recurring work.** `task` `list` with `repeating: true`. For each: its
   state (`active`, `paused`, `draft`), its cadence and when it last ran.
   - `paused` with a budget reason: that step has been dead since that day,
     and nothing resumes it.
   - A frequent cadence (every 15–20 minutes) whose `how` is text: it wakes a
     model every time and eats the Soot's day.
   - `draft`: it never started; it waits for the person.
3. **Spend.** `manage` `usage.read`: each Soot's tokens against its
   `daily_tokens`. A Soot at its limit before noon has a step that wakes too
   often or runs too long.
4. **The work's own tables.** `data` `tables`, then `query` with a `count`
   by day on the tables the loop writes (requests, jobs, outcomes). Empty or
   flat for days means the loop never ran, whatever the schedules say.
5. **What runs against what was meant to run.** `manage` `updates.status`: a
   pack marked `local` (`not_forge_managed`) is a copy on that host that no
   update replaces. If a skill or schedule names a tool the Soot does not
   list (`manage` `read` with the Soot's id), the host runs an old copy. Say
   it; deploying a pack to a server is for whoever installs Soot there.
6. **Find the break.** Replay the loop's first step with a read, or with a
   call that changes nothing when repeated (the same approve, the same id).
   The break is between "the first step said yes" and "nothing came next".

Answer with one line per team, then the causes:

```
Vận hành: dừng từ 13/11. Dịch đợt đầu bị tạm dừng vì hết token; bảng việc trống.
CSKH: chạy, 2/40 việc lỗi (thiếu quyền đọc).
→ Cần làm: … (ai làm)
```

Say what you read and what you could not read. Never write "ổn" for a team
whose tables you did not read.

**Empty is a finding.** No tasks, no recurring task, no table: that is the
answer ("ban-hang chưa có việc nào và chưa có bảng: vòng này chưa từng chạy"),
not a reason to keep looking. A thing the person named that you cannot find
("việc lặp của but-lohi") is said as not found, with where you looked.

A read that returns nothing, a refusal or a dry run is one line in the answer
("chưa đọc được cấu hình"), never a reason to stop: no `report_blocker` and no
question to get read access or to find what is not there. Read each source
once; a second pass over the same tool, or `files`, `goal` and memory when
the question is about work, is not a new check. About ten reads cover a team;
then answer. A check always ends with that answer as your reply, even when
every read came back empty; it never ends on `report_blocker`.

## 2. What usually breaks

| What you see | Cause | Fix |
|---|---|---|
| Tools a skill names are missing on the host | An old host-local pack | Ask whoever installs Soot to deploy it; check the tool count after |
| Recurring task `paused`, budget reason | Each run wakes a model; the day ran out | Make the step tool-first (§3), then resume it |
| Requests approved, nothing started | A step waits for a human-started session, or for a host it cannot reach | A deterministic step; the far host pulls |
| A request stuck with a vague title and no link | Automation guessed or gave up silently | An exact match or ask for the link; never guess |
| A judgment is made, nobody acts on it | The Soot that judges may not spend; the one that may spend never hears | Work mail from the judge to the spender |
| Many failed tasks on one Soot, same reason | Tool, key or access missing | Fix the access once, then retry; do not re-run blind |
| A step says it wrote, the next step sees nothing (or sees a row with no title, no link) | A field the tool writes is not in the team contract; the host refused it and the tool only saw `ok:false` | Declare every field a tool writes or reads in the contract's `provides` / `consumes` |
| The person answered a card, nothing happened | A card whose options are only labels; an option cannot run a tool that needs approval | Options carry a `tool` or `wake`; the person's click is the approval, so that tool needs no second one |
| A once-a-day card never shows | A model also holds the card tool and spent the day's slot | Only the schedule raises it; take the tool from the model |
| `budget_exhausted` on the same step every time | `max_run_tokens` smaller than the skill plus the tool results (cache reads count) | Size it from one measured run with headroom, or make the step read less; a run that failed on budget fails again |
| The Đầu mối sends work to the wrong member, or wanders | No member is named as the owner of that kind of work | One owner per tool family in the team's description and the members' lines; enough tool calls to read, list members, send, update |
| A request waits for ever | No step ends it when it lacks something | Every request ends: done, declined, or a question sent back with a record |

## 3. Build a loop that runs by itself

Design it before you create anything, and show the person the design in one
message (who does each step, what triggers it, what it spends, what waits for
them). Create after they agree.

- **One queue, many triggers.** The person in chat, the person in an app, an
  admin and a schedule all put the same row in one table or one task list.
  One step reads it. Never a second path for the same work.
- **Tool-first steps.** A recurring step runs a pack tool (`repeat.how.tool`)
  that decides whether there is work; the model wakes only when it finds some
  (`wake_when`). Size the day: fires per day × how often it wakes × tokens per
  run, well under `daily_tokens`.
- **Deterministic steps.** An unattended step runs a command or an api call.
  A tool that answers "ask someone to run X" is not a step.
- **Pull across hosts.** A server cannot reach a laptop. Work that needs the
  laptop (a browser, a local database, a coding agent) is a row the laptop
  pulls; the server never waits on it.
- **Judge and spend are joined by mail.** The Soot that judges quality sends
  a mail (`task` `send`, `wait: true`) to the one that may spend; the reply
  comes back to the judge.
- **Ambiguity stops the step.** No source, two matches, a price it cannot
  see: the step records why and asks, it never guesses.
- **Every step leaves a record** (a row, an event, a task note), so §1 can see
  it moved.
- **Money, public posts and anything the brief reserves wait for the person**
  (an approval card), never routed around because a step is automated.
- **One Soot per kind of judgment or key role.** More volume is never a reason
  for a second Soot. Put a Soot on the host where its tools work. Each Soot that
  calls an outside api holds its own key; one key is never shared.
- **The contract lists every field.** What one team's tool writes to a table or
  queue and what another reads is declared field by field; an undeclared field
  is refused without a sound.
- **A card that must act carries the action.** Each option names the tool or
  the wake it runs; the card tool belongs to the schedule, not to a model.
- **Waits are real.** A recheck after ten minutes, a threshold of readers, a
  daily cap: put them in the design and in the test, so a slow step is not
  mistaken for a dead one.
- **Whoever answers the person re-reads before each status answer.** A Soot
  that talks to people and holds no mail tool reads the work's stage from the
  source every time, never from its own earlier turn.

## 4. Test before you call it working

- Run each trigger once end to end, on a test workspace or a dry run, and at
  least one path that must fail (no link, the budget is out, the same request
  twice, a canceled task).
- Judge by the tables and the task log, not by the chat reply.
- Run a step that a model decides several times (three is a good start): one
  pass is luck. A step that passes one time in three is not working.
- Test the config as it ships. A patch that makes the test pass belongs in the
  config, or the test proves nothing.
- After a deploy: the pack's tools are on the host, and one fire wrote its
  record.

## 5. What you change, and what goes to the person

- **Resume** a paused recurring task only after its cause is fixed: `task`
  `update` with `repeat: {"state": "active"}`. A repeat that can wake a model
  may wait as a draft for the person.
- **Slow a cadence or lower a limit**: yours (`task` `update`, `manage`
  `budget.save` at or below the current limit).
- **Raise a budget**: always `manage_gated`.
- **Deploy a pack, change a server, touch production**: the person or whoever
  installs Soot. Write them the exact steps.
- Report once, at the end: what you read, what you changed (only with a
  receipt), what waits for whom. Never say a loop runs until you have seen one
  fire's record.
