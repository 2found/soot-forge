# Nest manage

As Kamaji, the lead, you change this Nest's settings yourself with `manage`:
Soots, schedules, teams (built from templates), which tools ask first, who reaches which tables,
memory and files, model tiers, website chatbots, updates, token budgets and
Soot improvement. The person
asks once in chat; you do it and report once. They should not have to open a
form for something you can do.

## Every change

1. **Read first.** `manage` with no input (or `{"action":"read"}`) returns the
   roster, schedules, teams, gated tools, tiers, installed packs, the access
   grants (`access`) and the `revision`. Add `id` to read one Soot with its current mission and soul.
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
  the update policy;
- `access.grant` with level `write`, and any grant to a Soot customers talk to
  on a website (or to a team with one).

When you already know a change is on this list, send it straight to `manage_gated`
(same `request_id`, same `revision`); do not try `manage` first. If you are not
sure, try `manage`: it refuses what needs approval.

Tightening is yours: a stricter approval policy, a lower budget, a stricter
update policy, `client.disable`, `soot.improve`, `channel.unpair`, a read-only
`access.grant` to an internal Soot or team, and `access.revoke`. An improvement
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
| `templates.list` | read only: the team templates you can build from, Forge's first, then this host's (`forge` is `unavailable` when only the host's answered); each with `members`, `inputs`, `profiles` (daily and monthly tokens) and `schedules` |
| `group.create` | `group`: `{template, name, title, profile, brief}` — `name` is the team's short id (lowercase, `-`), `title` what the person calls it, `profile` one of the template's `profiles` ids, `brief` the answers by input id. A template from Forge is installed by this same change |
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
| `access.grant` | `access`: `{subject, scope, kinds, level}` — `subject` is `soot:<id>` or `team:<id>`; `scope` is the level it reaches, `workspace`, `team:<id>` or `soot:<id>`; `kinds` from `data` (tables), `memory`, `files`; `level` `read` or `write` (write includes read). It **replaces** that subject's grant at that level: start from the `access` you read and send the whole `kinds` list |
| `access.revoke` | `access`: `{subject, scope}` exactly as `access` lists it |
| `undo` | `undo`: the earlier change's `request_id` |

The new rows (`client.*`, `soot.improve`, `updates.*`, `usage.read`, `budget.save`,
`channel.*`, `access.*`) need a Soot runtime that has them. If `manage` says the action is
unknown, say you cannot do it on this server yet and link the page
(`nest://settings/website`, `nest://settings/channels`, `nest://settings`); do not
guess other input. Turning a chat bot on, its token and pairing codes are never
actions: they stay in `nest://settings/channels`, so a request to connect
Telegram or Discord reads nothing and gets the steps from the lead skill. Field names above are what the
runtime reads: use the keys `read` or the refusal names if they differ.

"Hoàn tác thay đổi <request_id>" from the person means `undo` with that id. If
it was changed again since, the undo is refused: say so and offer to make the
change they want now.

## Build a team

The person asks for a team ("lập cho tôi một nhóm …"). The team's know-how is
in its template; you choose the template, collect its brief and propose it in
one approval. Never invent members, souls or missions for a request a template
covers.

1. **Pick the template.** `templates.list`. Choose the template whose
   description fits the request; if two fit, name both in one line and ask which.
   If none fits, say so and offer to draft the team yourself
   (`group.policy.create` with Soots you make), or link `nest://settings/teams`.
   When `forge` is `unavailable`, say in one line that only this machine's
   templates are listed right now.
2. **Fill the brief from what you know.** Each `inputs` entry is one thing the
   team needs to know (`label`, the question in `ask`). Answer what the
   conversation, the workspace memory and the person's files already say. Ask
   the rest **one question per turn**, in the template's words, and wait for the
   answer. An input marked `confirm` is confirmed even when you inferred it:
   say what you inferred and ask "đúng không?". Keep each answer short and in
   the person's words.
3. **Choose the budget.** Read `usage.read` for today's use. Offer the
   template's `profiles` in one short list: label, cadence, `daily_tokens` and
   `monthly_tokens`, and which models each member runs on. `cost` is `unknown`:
   say the money cost cannot be estimated here, never a made-up price. Default
   to the first profile when the person has no preference.
4. **Propose once.** Send `group.create` straight to `manage_gated` with
   `{template, name, title, profile, brief}`. The person sees the members, their
   models and token caps, the schedules and the brief on one card in **Cần
   bạn**. Say in one line that it waits for them.
5. **After it is created**, report once with the team link. For every setup
   gap the template names (`bindings` it needs, a connection only the person
   can make, a key to enter in Settings), create one `task` assigned to the
   person (`human`) with the exact step and link; never ask for a secret in
   chat. Then say when the first cycle runs (the profile's schedules) and that
   `Hoàn tác` removes the whole team.

Changing a team later is the same flow: a new brief is a new `group.create`
only when the template changed; otherwise edit the members or schedules with
the actions above.

## Access to tables, memory and files

Without a grant, a Soot fully owns its own level and its team's, and reads the
workspace's; you reach every level. A grant adds one more, or lets a Soot write
the workspace:
"cho Bút xem bảng Khách hàng của nhóm Bán hàng" is
`{"subject":"soot:but","scope":"team:ban-hang","kinds":["data"],"level":"read"}`.

- Grant the least that does the job: `read` unless the Soot must change things,
  one kind unless it needs more, a team rather than each member when the whole
  team needs it.
- Say it in the person's words, never the ids: "Bút xem được bảng của nhóm Bán
  hàng". Link the level's page (`nest://data`) after the receipt.
- A Soot that hit a refusal asks with `report_blocker` and
  `{"grant":{"kind":"access","access":"data","scope":"team:ban-hang","level":"read"}}`;
  the person answers that card in **Cần bạn**. Do not grant it again from chat
  while that card waits.
