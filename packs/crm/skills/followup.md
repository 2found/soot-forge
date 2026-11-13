# Working the follow-ups

Every open deal has one next step and a time for it. A recurring task runs
`crm_followups_due` (tool only, `wake_when: {notify: true}`) and wakes you only
when a step is due or an inbox row is held. Your job on each wake: move each
due deal one honest step, and leave every open deal with a new next step.

## Stages

| Stage | Means | Leave it when |
| --- | --- | --- |
| `new` | Recorded, nobody has answered yet | You answered or reached out → `contacted` |
| `contacted` | We replied; waiting on them | They confirm a real need, a budget or a timeline → `qualified` |
| `qualified` | A real need we can meet | We sent an offer, a quote, a trial → `proposal` |
| `proposal` | They have our offer | They pay or sign → `won`; they say no or go silent past the agreed date → `lost` |
| `won` | A paying customer | They stop paying or leave → `churned` |
| `lost`, `churned` | Closed, with `lost_reason` | A new buying intent reopens `lost` (a person or you, with a note) |

Stages describe what the customer did, not what you hope. Never move a deal
forward to make a number look better; the team goal's guardrails watch for
exactly that.

## On each due deal

1. `crm_contact_find {ref}` for the card: who, what they asked, the last
   touches.
2. Decide the one step. Answering or writing to them uses the team's own
   channel tool (email, chat reply) and only within what the team contract
   lets you decide alone; an offer with a price, a discount, a contract or
   anything about money waits for a person (raise it in Cần bạn with the
   contact ref and what you propose). Prices and plans come from the product's
   knowledge, never from memory.
3. Log what happened with `crm_touch_record` (`direction: out` for what you
   sent, `in` for their answer, `note` for a decision).
4. `crm_deal_update` with the new stage if it changed, and always a new
   `next_step` and `next_at` while the deal is open. Silence is a step too:
   "Nhắc lại lần 2" in three days, then `lost` with `lost_reason: "no reply"`
   after the second reminder.
5. When the result has `record_outcome`, call the host `outcome` tool with
   that `id` and `ref`, once.

## Held inbox rows

`held` lists rows another team sent that could not be filed, with the reason.
Fix what you can (find the right contact, ask the sending team), then
`crm_inbox_file {retry: [...]}`; drop a row that should not be filed with
`dismiss`. An `identity_conflict` that may be the same person goes to a person
with both refs.

## Privacy

Contact details are for following up with that person, nothing else. Never
paste them into a team thread, a report, memory, a task title or another
team's table. Refer to a contact by its ref (`C-…`). When someone asks to be
forgotten, `crm_contact_forget` (and tell the person in Cần bạn that the
conversation itself is erased through Nest).

## Report

Once per wake, in the team thread: how many due, what moved (refs and stages),
what waits for a person.
