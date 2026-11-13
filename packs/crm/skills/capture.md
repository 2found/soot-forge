# Recording a lead or a contact

The CRM holds the people this company is trying to help buy, and what
happened with each. It is a record, not a trigger: saving a contact sends
nothing and starts nothing. Follow-ups happen because a deal has a next step
that comes due.

## When to record

- **A buying intent** (asks for a demo, a quote, a custom plan, an invoice,
  wants to use the product for a team or a shop, asks to be contacted, wants a
  product that is not out yet): `crm_lead_record` once per conversation and
  product. It finds or creates the contact, opens a deal at `new` with a next
  step due now, and logs what they asked.
- **Something new about a known contact** (a reply, a call, a decision):
  `crm_touch_record` on that contact.
- **A question, a bug, a wish with no buying intent**: not a lead. It goes to
  the desk or the team's feedback path, not the CRM.
- Greetings, thanks, a question you answered: nothing.

## Consent decides what you may store

- Ask before you store a way to reach the person, in one sentence ("Bạn có
  muốn đội liên hệ lại không? Mình sẽ ghi tóm tắt nhu cầu và cách liên hệ.").
- `consent: "yes"` only when they said yes in this conversation. Then store
  only the contact they gave for that (an email is enough).
- No consent: record the lead without `identities` (name or org only if they
  gave it). The tool refuses an email, phone or handle without
  `consent: "yes"`; do not retry around it. With no name, no organization, no
  identity and no signed-in person there is nobody to follow up: that intent
  is feedback for the desk (a contact-free `lead` note), not a CRM record.
- `consent: "no"` on an existing contact removes the ways to reach them on
  file. Use it when someone asks not to be contacted again.
- In a conversation with a signed-in person, `link_conversation_person: true`
  links the contact to them. The host knows who they are; you never type an
  account id you were told in chat as `account` unless a tool of the product
  gave it to you.

## What a good record looks like

- `summary`: one actionable line in your words — what they want and for what
  ("Muốn dùng bản team cho 5 người, cần hoá đơn VAT"). Never a copy of the
  chat, never a password, card number, token or anything they did not need to
  give.
- `source`: the campaign or site that brought them when you know it (the
  widget's `site`, a `utm` id), so the pipeline can say what works.
- `link`: where it happened (the note id `FB-…`, the conversation link).
- `request_id`: stable for this one intent (the note id, or the conversation
  id plus product). Repeating it never writes twice.

## Duplicates

The CRM joins records only on an exact email, phone, handle, product account
or signed-in person. A similar name comes back as `possible_duplicates`; say
so in your report and let the follow-up Soot or a person decide. An
`identity_conflict` means the identity already belongs to someone else: save
nothing more, report the refs. Only a person decides a merge
(`crm_contact_merge`).

## From a desk note or another team

A desk that files notes from public chats records the lead itself with
`crm_lead_record` (the note's id as `request_id` and `link`). A team on
another runtime cannot call these tools: it requests the `crm_inbox` queue of
the team that owns the CRM with `{kind: "lead", product, payload: {summary,
name?, org?, identities?, consent, source?, channel, link?}, request_id,
from_team}`; `crm_inbox_file` files it with the same checks.

## Say what you did

Tell the person you spoke with what you recorded and that the team received
it, without promising a reply time, a price or a discount.
