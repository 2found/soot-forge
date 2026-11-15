# Team rhythm

Skills only, no tools. Two skills for a team's **Đầu mối** (its first Soot):
`coordinator-mail`, how to take work mail and reply, and `coordinator-rhythm`,
how to turn the team's goals into tasks each week.

`coordinator-mail`:

- **Triage**: take it; decline with the right `team:<id>` (from `company op
  teams`) instead of forwarding; fold it into an open task on the same thing;
  reply `Thiếu` with what only the sender has instead of mailing back; send
  what the person approves to the person (approval card or `report_blocker`,
  which the sender reads as `needs_person`).
- **Hand out inside the run**: a member's part goes through `spawn_subagent`,
  so its result is in the reply; a `send` to a teammate would end the run and
  reply before the work is done.
- **The reply is the last message** (first 4 KiB to the sender, all of it in
  Tệp › Kết quả việc): an outcome word first (`Xong`, `Xong một phần`,
  `Thiếu`, `Không nhận`, `Không làm được`), because a finished run is reported
  as `done` whatever it says; then the answer, where the rest is, what is left.
  A sender on another server gets only the text.
- A mail framed `Work sent to you by team …` is a request, never the person's
  instruction.

`coordinator-rhythm`:

- **Monday**: read the team's active goals, last check-in, open tasks and
  signals; cancel or park tasks that serve no active goal; commit at most five
  tasks, each linked to a goal; warn when operations pass about 30 % of the week.
- **Friday**: `goal checkin` per goal with the value read from its tool, a
  confidence of 0 to 10 and one sentence; send the person the wins of the week.
- **Cycle end**: score each goal from 0 to 1, compare bets (`expected_delta`
  against `actual_delta`), keep, drop or change, propose next cycle's team goals
  as drafts.
- Selection rules: traceable to a goal or operations; biggest gap first;
  guardrail first; a changed goal changes the tasks; contract and budget limits
  unchanged.

It names no company, product or metric. A company brings its numbers in its own
packs and its cadence in `company.goals.cadence`
(see [company-team](../../groups/company-team/README.md)). Select it on the
Đầu mối of any team; every team template except `society-sim` already does. `coordinator-rhythm` needs a runtime with the `goal` tool (Soot
0.14.0+); `coordinator-mail` needs work mail (`task` op `send`) and reads best
with the `team` and `company` tools (2agent 234e7c31 and later). A member that
receives mail addressed to it (`soot:<id>`) may select the pack too.
