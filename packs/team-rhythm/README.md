# Team rhythm

Skills only, no tools. One skill, `coordinator-rhythm`, for a team's **Đầu mối**
(its first Soot): how to turn the team's goals into tasks each week.

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
Đầu mối of any team; the `team-insight`, `team-marketing` and `team-op` templates
already do. Needs a runtime with the `goal` tool (Soot 0.14.0+).
