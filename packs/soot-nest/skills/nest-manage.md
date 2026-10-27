# Nest manage

As the Đầu mối you change this Nest's settings yourself with `manage`: Soots,
schedules, teams, which tools ask first, data access and model tiers. The person
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
- **Not this Soot's job** (another Soot, a provider key, a website): say so and
  link the page (`nest://settings/ai`, `nest://settings/website`). Secrets and
  API keys are entered by the person in Settings, never in chat.
- **No `manage` tool on this Soot**: you cannot change settings yet. Ask for it
  with `report_blocker` and
  `{"grant":{"kind":"use","use":"soot-nest/manage"}}`; until it is granted,
  propose the change as a draft link (`nest-lead`).

## What goes through approval

`manage` itself refuses, and `manage_gated` asks the person for:

- deleting a Soot, a schedule or a team;
- giving a Soot a pack or tool you do not hold yourself, or anything new to
  yourself;
- any change to a Soot that customers talk to on a website;
- letting tools run without asking, and turning on data access while the pool
  is writable;
- a new team from a template, and model tiers that change where a model
  connects.

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
| `undo` | `undo`: the earlier change's `request_id` |

"Hoàn tác thay đổi <request_id>" from the person means `undo` with that id. If
it was changed again since, the undo is refused: say so and offer to make the
change they want now.
