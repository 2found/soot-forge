# Nest lead evals

Dry-run behaviour locks for the Kamaji (`nest-lead`, `nest-manage`). Each case
sends one message from the acceptance scenarios (S1–S4, S7, S8, S10–S13, W1–W5, T5–T6) and
gates the *decision*: which tool is called, which is not, and what the reply must
not claim. Evals read tool names only, never arguments or results.

```sh
soot eval --tag nest-lead            # whole suite
soot eval --tag s4                   # one scenario
soot eval --tag needs-runtime        # cases for operations that need the new runtime
```

The suite has no `soot`, so it runs on the runtime's default Soot: run it in a
Nest workspace whose default Soot is the Kamaji and holds the `nest-lead` pack.
Dry run is the default (`effects: dry_run`): `manage` and `manage_gated` answer
with a preview or a refusal, never a receipt, so every case also forbids
"đã tạo", "đã đổi", "đã áp dụng" and similar.

Fixture the cases assume (a workspace used only for evals):

- Soots `cskh` and `but-lohi`;
- a tool `social_post` set to run alone (`auto`) for S7 loosen, and to ask first
  for S7 tighten;
- `cskh` has `daily_tokens` of 200000 (S12), and a client id `shop-example`
  exists but is off (S8);
- for the `channels` cases (T1, D1, T4), a Telegram binding with a member named
  Minh paired. The connect cases need no binding: they gate the hand-off to
  `nest://settings/channels` and that a pasted token is never repeated.
- for the `team-template` cases (T5, T6), Soot Forge reachable (or a host
  template whose description fits a marketing team) so `templates.list` has one.

- for the `workspace` cases (W1–W5), a team `ban-hang` with `but-lohi` as a
  member; W5 reads better with an `orders` table at the workspace level, but a
  missing one still gates that the count comes from `data`.

Cases tagged `needs-runtime` use `client.*`, `soot.improve`, `updates.*`,
`usage.read`, `budget.save`, `channel.*` or `access.*`, which ship in the Soot runtime
released **before** this pack; on an older runtime they end with the model saying
it cannot do that yet. S10's lost reply cannot be simulated from a case, so the case locks the
wording and the read-first rule; the held effect itself is a runtime test.

## What dry run cannot show

`manage` has no host refusal in dry run, so the cases tagged `gated` (S4 delete,
S7 loosen, S8 go public, S12 raise) gate only that the lead acts through the
tool and never claims the change is in effect. That the call reaches
`manage_gated` and waits in Cần bạn is checked at phase integration against the
real runtime, as are the contents of reads (`usage.read`, `updates.status`).
A model may also quote a forbidden phrase while denying it ("chưa thể nói là
đã tạo"); a lone failure on that gate is a flake, so rerun before editing the skill.
