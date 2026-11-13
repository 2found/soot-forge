# crm — a micro-CRM for Soot teams

The people a company is trying to help buy, the ways they agreed to be
reached, one deal per product with a stage and a next step, and a timeline of
every touch. Support and the desk record leads, a sales Soot works the
follow-ups that come due, insight reads the pipeline as numbers.

It is a passive record, like `casework`: event → Soot → CRM tool. Saving a
contact sends nothing and starts no run. Work happens because a deal's next
step comes due and a tool-only recurring task wakes a Soot.

## Why a pack, and not memory, files, workspace tables or the data pool

| Need | Memory | Files | Workspace `data` | Data pool | `crm` |
| --- | --- | --- | --- | --- | --- |
| "Every open deal for lohi with a step due today" | no (recall, not query) | no | yes, if every Soot agrees on a schema | no (documents) | `followups_due` |
| One person across chat, email, Telegram, product account | per principal only | no | no identity rules | no | exact identity keys, one owner each |
| Consent decides what is stored | no | no | no | no | enforced by the tool |
| Erasure of a signed-in person | yes | no | no principal column | no | `principal` on every table |
| Same stages and rules for every Soot | prompt | prompt | prompt | prompt | enforced by `deal_update` |

Memory stays for what a Soot learned about a person (`user` bank); the data
pool stays for shared documents; Knowledge stays for product facts and prices.
The CRM never copies a price, a plan or an account's payment state: that is
the product's data, read through the product's own tools.

## Tables (`pack:crm`)

| Table | Holds |
| --- | --- |
| `contacts` | `ref` (`C-…`), name, org, note, `consent` (`yes`/`no`/`unknown`), owner, tags, merged refs |
| `identities` | `key` (unique, normalized `kind:value`), contact; kinds `email`, `phone`, `telegram`, `discord`, `zalo`, `facebook`, `x`, `github`, `linkedin` (need consent) and `account`, `website` (recognize only) |
| `deals` | one per contact and product (`key` = `C-…@product`): stage, next step and when, value, currency, source, owner, won/closed time, lost reason |
| `touches` | append-only timeline: `in`, `out`, `note`, `stage` (with the new stage) |
| `inbox` | insert-only queue for other teams and runtimes: `{request_id, kind, product, payload, from_team, state: "new"}` |

Stages: `new` → `contacted` → `qualified` → `proposal` → `won` | `lost`, and
`won` → `churned`. An open deal always has a next step; `lost` and `churned`
need a reason; a won deal does not go back to an open stage.

## Tools

| Tool | Mode | Does |
| --- | --- | --- |
| `contact_find` | read | by ref, exact identity, the conversation's signed-in person, or a fuzzy accent-insensitive query |
| `contact_save` | write | create/update; joins only on an exact identity or the signed-in person |
| `lead_record` | write | contact + deal `new` due now + inbound touch, in one call |
| `touch_record` | write | one timeline entry; never sends anything |
| `deal_update` | write | stage, next step, value, source, owner; returns `record_outcome` on qualified/won |
| `followups_due` | read | due deals and held inbox rows; `notify` for `wake_when` |
| `pipeline_report` | read | counts per stage, flow, win rate, by source; no contact details |
| `inbox_file` | write | files inbox rows with the same checks, holds the rest |
| `contact_merge` | write | a person-decided merge |
| `contact_forget` | write | erases one contact's rows |

Outcomes: `lead_qualified`, `deal_won` (record them with the host `outcome`
tool from the `record_outcome` a stage change returns).

Every write is idempotent on `request_id` (or is a plain set). Each page of the
store is at most 500 rows, so this is a CRM for hundreds to a few thousand
open deals; `pipeline_report` says `truncated` when a part hit the cap.

## Who selects it

Only Soots that need to see people: the desk that files leads, the sales Soot
that follows up, the Lead. **Never a public Soot** (a website or widget Soot
reads untrusted text; it reaches the desk through `record_feedback`, and the
public safety profile refuses pack tools anyway). An analyst that needs
numbers reads the `pipeline` contract item instead of selecting the pack.

## One CRM, many runtimes

Pack storage belongs to the runtime that runs the tool, so two runtimes that
both select `crm` hold two CRMs that never meet. Do not do that. Pick **one
home runtime** (the always-on server) where the owning team selects the pack;
every other runtime reaches it through that team's contract:

- reads: a provided table `pipeline` (deal fields only, contacts as refs);
- writes: the insert-only queue `crm_inbox`, filed by `inbox_file` on the home
  runtime;
- people details never leave the home runtime.

Owning team on the home runtime (`groups.sales.contract`):

```json
{
  "version": "team-contract/v1",
  "provides": {
    "tables": [{ "name": "pipeline", "pack": "crm", "table": "deals", "tenant": "all",
                 "fields": ["contact", "product", "stage", "stage_at", "value", "currency", "source", "won_at", "closed_at", "lost_reason"] }],
    "queues": [{ "name": "crm_inbox", "kind": "table", "pack": "crm", "table": "inbox",
                 "fields": ["request_id", "kind", "product", "payload", "from_team", "state"] }]
  }
}
```

A team on another runtime declares the home runtime in `remotes`, the sales
team as `{"remote": {"runtime": "server", "group": "sales"}}`, and in its own
contract `consumes: [{"team": "sales", "item": "pipeline"}]` and/or
`requests: [{"team": "sales", "queue": "crm_inbox"}]`. It writes a row with
the `data` tool (`state: "new"`, a unique `request_id` of at most 56
characters). An unreachable home runtime answers `contract_remote_unavailable`;
nothing falls back to a local copy.

When one runtime is no longer enough (several always-on servers writing
contacts all day), the next step is a CRM service on PostgreSQL that every
runtime binds to, the way `data-pool` works, behind the same tool names. Not
before.

## Recurring tasks (home runtime)

```json
{ "title": "CRM: nhận việc từ đội khác", "assignee": "team:sales", "repeat": {
    "every": "15m", "tool": { "pack": "crm", "name": "inbox_file" }, "wake_when": { "notify": true },
    "text": "Some CRM inbox rows were held or a stage change needs an outcome: follow crm-followup." } }
{ "title": "CRM: việc theo khách đến hạn", "assignee": "team:sales", "repeat": {
    "cron": "0 9,14 * * 1-5", "timezone": "Asia/Ho_Chi_Minh",
    "tool": { "pack": "crm", "name": "followups_due" }, "wake_when": { "notify": true },
    "text": "Follow-ups are due: follow crm-followup." } }
```

Both are tool-only: a quiet run costs no model call.

## Privacy

- A way to reach someone is stored only with `consent: "yes"`; `consent: "no"`
  removes the ones on file.
- `contacts`, `identities`, `deals` and `touches` carry a `principal` column
  when a contact is linked to a signed-in person (host-derived, never model
  input), so Nest's person erasure and `retention.days` remove them.
- `contact_forget` erases one contact on request. Inbox rows that were never
  filed are not linked to a contact; dismiss them.
- The pipeline contract item has no contact details.

## Tests

`node --test packs/crm/tests/*.test.mjs` (an in-memory store with the route
semantics, plus one run of the executable against a local storage route).
