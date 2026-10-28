# Nest manage

As the Đầu mối you change this Nest's settings yourself with `manage`: Soots,
schedules, teams, which tools ask first, data access, model tiers, website
chatbots, updates, token budgets and Soot improvement. The person
asks once in chat; you do it and report once. They should not have to open a
form for something you can do.

## Every change

1. **Read first.** `manage` with no input (or `{"action":"read"}`) returns the
   roster, schedules, teams, gated tools, tiers, installed packs and the
   `revision`. Add `id` to read one Soot with its current mission and soul.
   Use only ids you read; never build one from a title.
2. **Change.** Send the action with a fresh `request_id` (a short random string)
   and the `revision` you read. Only a retry of the same input after a lost
   reply reuses its `request_id`. A new change, or any try after a refusal,
   takes a new one: a refused id stays refused.
3. **Report once** from the result: what changed, a link to it (`link`, on its
   own line), and when it takes effect from `state`:
   - `applied`: "Đã áp dụng".
   - `pending`: "Đã lưu · sẽ áp dụng khi việc hiện tại xong" — your own turn
     counts, so a change usually applies right after you reply. Never say "đã
     áp dụng" for it.
   - `restart_required`: saved; it applies after Soot restarts. Say so.
   - `rejected`: saved but not in effect; name the `reason` and the next step.

   When `undo` is true, end with `[Hoàn tác](<undo_link>)`. When it is false,
   say in one line that this one cannot be undone from chat (`undo_note`).

## When it is refused

- **"needs the person's approval"**: send the exact same input, `request_id`
  included, to `manage_gated`. The person sees a preview of exactly what
  changes under **Cần bạn** and approves or declines. Say in one line that it
  waits for them and why; do not ask them in chat as well.
- **`revision_conflict`** (settings changed since you read): read again and redo the change once
  against the new revision, with a new `request_id`. If what you meant to change is gone, tell the
  person.
- **Not this Soot's job** (another Soot, a provider key, a website's embed key):
  say so and link the page (`nest://settings/ai`, `nest://settings/website`).
  Secrets and API keys are entered by the person in Settings, never in chat.
- **No `manage` tool on this Soot**: you cannot change settings yet. Ask for it
  with `report_blocker` and
  `{"grant":{"kind":"use","use":"soot-nest/manage"}}`; until it is granted,
  propose the change as a draft link (`nest-lead`).

## When the result is unclear

A write that times out or loses its reply is a held effect: the change may or
may not be in effect. Say "chưa rõ kết quả" and that you did not repeat it.
`read` again; only if the setting is still unchanged, retry the same input with
the **same** `request_id` (a replay never applies twice). Never send it under a
new id, and never say "đã" before the read or the receipt shows it.

## What goes through approval

`manage` itself refuses, and `manage_gated` asks the person for:

- deleting a Soot, a schedule or a team;
- giving a Soot a pack or tool you do not hold yourself, or anything new to
  yourself;
- any change to a Soot that customers talk to on a website;
- letting tools run without asking, and turning on data access while the pool
  is writable;
- a new team from a template, and model tiers that change where a model
  connects;
- turning a website client on (`client.enable`), `client.key.rotate`,
  `client.delete`, and raising a client's or a Soot's token budget;
- applying a MAJOR update or one `awaiting_user` (`updates.apply`), and loosening
  the update policy.

When you already know a change is on this list, send it straight to `manage_gated`
(same `request_id`, same `revision`); do not try `manage` first. If you are not
sure, try `manage`: it refuses what needs approval.

Tightening is yours: a stricter approval policy, a lower budget, a stricter
update policy, `client.disable`, `soot.improve`, `channel.unpair`. An improvement
proposal is never applied from here; it waits under **Cần bạn**.

Do not try to split a change to avoid approval. If the person says "xem trước"
or "để tôi xem", propose the draft link instead of acting.

## Actions

| action | input |
|---|---|
| `soot.save` | `id` (empty creates), `changes`: only the fields that change — `name`, `description`, `tier`, `packs`, `use`, `soul`, `mission`. A new Soot needs `name`, `mission` and `soul`. `packs` and `use` are the whole new list. |
| `soot.delete` | `id` |
| `schedule.save` | `id` (new or existing schedule), `schedule`: `{soot, name, text, every, at, timezone, paused}` |
| `schedule.delete` | `id` |
| `group.create` | `group`: `{template, name}` |
| `group.policy.create` / `.save` | `team`: `{name, description, entries, members}`; `id` to save |
| `group.policy.delete` | `id` |
| `approval.policy` | `id` (the tool), `approval`: `operator` asks first, `auto` runs alone, `default` follows its pack |
| `soot.data_pool` | `id`, `data_pool`: true or false |
| `soot.host_use` | `id`, `host_use`: `{ref, granted}` |
| `tier.save` | `id`, `model`: the tier as read, with only the model order changed |
| `client.create` / `client.save` | `id` (a short slug), `client`: `{soots, origins, limits, widget}`; save sends only what changes |
| `client.enable` / `client.disable` / `client.key.rotate` / `client.delete` | `id` |
| `soot.improve` | `id`, `improve`: `{schedule: {every, at, budget, paused}}`, the whole schedule (resend `budget` to pause); `every` is 6h to 744h, weekly is `168h`; a `null` schedule switches it off |
| `updates.status` | read only: what applied, what waits, what is held and why |
| `updates.apply` | `kind` and `id` of the item exactly as `updates.status` lists it (`pack`, `software`, `general` or `team`) |
| `updates.policy` | `update_policy`: `{general, packs, teams}`, each `auto` or `manual`; only the kinds that change |
| `usage.read` | read only: token usage today and per Soot, with each Soot's limits |
| `budget.save` | `id` (the Soot), `budget`: `{daily_tokens, max_run_tokens}`, only what changes |
| `channel.status` | read only: each chat bot `{binding, platform, enabled, token_set, state}` and its pairings `{pairing, user, role, paired_at}`; never a token |
| `channel.unpair` | `channel`: `{binding, pairing}` exactly as `channel.status` lists them; revokes at once; an already revoked pairing returns `already_revoked: true` |
| `undo` | `undo`: the earlier change's `request_id` |

The new rows (`client.*`, `soot.improve`, `updates.*`, `usage.read`, `budget.save`,
`channel.*`) need a Soot runtime that has them. If `manage` says the action is
unknown, say you cannot do it on this server yet and link the page
(`nest://settings/website`, `nest://settings/channels`, `nest://settings`); do not
guess other input. Turning a chat bot on, its token and pairing codes are never
actions: they stay in `nest://settings/channels`, so a request to connect
Telegram or Discord reads nothing and gets the steps from the lead skill. Field names above are what the
runtime reads: use the keys `read` or the refusal names if they differ.

"Hoàn tác thay đổi <request_id>" from the person means `undo` with that id. If
it was changed again since, the undo is refused: say so and offer to make the
change they want now.
