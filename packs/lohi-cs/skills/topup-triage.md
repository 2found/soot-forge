# Top-up triage — "did my top-up land?"

Read this skill before answering payment/top-up questions. Reply in the
customer's language (usually Vietnamese).
## Data you can check (read-only)

The `lohi_lookup` tool reads the signed-in reader's own account — scoped by
the host's signed principal; you never pass a userId. Call — never guess:

- `lohi_lookup {"kind":"topups","limit":10}` — top-up intents:
  `paymentStatus` (`pending|completed|failed|expired`), `provider`
  (`sepay|apple|google`), `amountVnd`, `ltAmount`, `completedAt`.
- `lohi_lookup {"kind":"orders","limit":10}` — LT charges:
  `kind`, `status` (`paid|refunded|failed`), `ltAmount`.

The identity is bound to this thread — never an id the customer pastes.
The only write is `lohi_recover_topup` (below): it asks the api to check a
missed SePay transfer with SePay. You cannot credit, refund or retry anything
yourself, and you never choose an amount of LT.

## Reading the result

- `completed` + `completedAt` → the money landed. Give the date and the LT
  credited; if the customer still does not see the balance, it is a
  display/session issue → suggest logging out/in, then handoff if persists.
- `pending` → checkout started but not paid (SePay transfer not received,
  or app-store purchase not finished). Recent `pending` = tell them to
  finish the transfer/checkout; old `pending` (~expired) = tell them to
  start a new top-up, the old one will expire on its own. A `pending` row
  alone is NOT a handoff, however old: answer it yourself and ask ONE
  question — did the bank/app store actually charge them? If they say yes:
  a SePay transfer → recover it (section below); an app store → hand off
  (bullet below).
- `failed` / `expired` → the checkout timed out or failed. Usually nothing
  was charged — but never tell a reader who says the bank took the money
  that they were not charged: a SePay transfer can land after its top-up
  expired, and that is exactly what recovery checks. A successful retry
  will appear as a NEW row — do not claim one exists until you see it.
- Nothing at all → they likely never reached checkout, or paid on a
  different account. Ask for proof of payment (receipt/bank screenshot)
  only to confirm the claim; the row is the truth.
- Customer says the money LEFT their bank account for a SePay transfer but no
  `completed` row matches → recover it (next section).
- App store (Apple/Google) charged but no `completed` row → this needs a
  human. Decide in THIS turn, one message: say what you found, ask them to
  drop the receipt here, and hand off now. If a receipt image arrives, read
  amount, time and transfer note off it and include them in the handoff.
  Never write "mình sẽ chuyển" and
  wait for another message to do it; never re-ask for the same thing next turn.
- SePay bank transfer: settlement can lag minutes–hours. A just-made
  transfer with `pending` top-up is expected — say so instead of alarm.
- Refund questions: `orders` shows `refunded` rows; do NOT promise a
  refund will happen — handoff to a member.

## Recovering a missed SePay transfer (`lohi_recover_topup`)

For "the bank took the money, no LT" with no `completed` row:

1. **Get the window.** You need when they transferred (day + rough time) in
   their own words. If they have not said it, ask in one message — and ask for
   the amount and the transfer note (nội dung chuyển khoản) too if they know
   them, without making those a condition. A `pending` row's time is not their
   word; do not call before they say when. If a receipt image arrives, read the
   time, amount and transfer note off it.
2. **Call once.** `lohi_recover_topup` with `from`/`to` around what they said
   (±30 min for "khoảng 14h", the whole span they give, at most 72 h; ISO
   8601 with `+07:00`), `amountVnd` / `transferNote` only when they gave them,
   and `reason`: one line for the approver ("Bạn đọc báo đã chuyển 50k lúc
   khoảng 14h 28/10, chưa nhận LT."). Never put an LT amount anywhere.
3. **Held for approval** (the answer starts `HELD FOR APPROVAL`): tell the
   reader, in one message, that you sent the payment for the team to check with
   the bank and the answer comes here. No promise, no time. Do not call again
   in this turn, and end the turn with that reply: do not hand off
   (`report_blocker`) — the approval already brings the team in, and a handoff
   parks the chat so their decision cannot reach you. When you are told it was
   approved, call again with exactly the same arguments; if it was rejected, do
   not call again — explain and hand off.
4. **Report only the api's answer:**

| Answer | Say |
|---|---|
| `{ltAmount, balanceAfter, topupId}` | Credited: the LT from `ltAmount` and the new balance. The only case where you may say "đã cộng". |
| `{already: true}` | "Khoản này đã được cộng rồi", with the date from `completedAt`. |
| `not_found` | No top-up of theirs in that window. Ask once for a wider window or the receipt, call once more if they give one; otherwise hand off. |
| `not_paid` | SePay has not confirmed a payment for it yet. That is not proof they did not pay: never say they did not pay. Top-ups in `unverified` are ones SePay has no record of — still never proof. Ask for the receipt; hand off if they insist they were charged. |
| `ambiguous` | Several paid top-ups match; nothing was credited. Ask which one, quoting the amounts and times from `candidates`, then call once more with that `amountVnd` (or a narrower window). |
| `amount_mismatch` | The paid amount (`orderAmountVnd`) differs from what they said. Explain and hand off. |
| `not_creditable` | The top-up cannot be credited here (`reason`); nothing was credited. Explain in plain words and hand off. |
| `provider_unavailable` | The payment provider could not be reached; nothing changed. Ask them to check back later; no promise. |
| `invalid_window` | Fix the window (from before to, ≤72 h, not in the future) and call once more. |
| Any other error (a tool or credential error, an unknown code), still failing after one retry | The money case needs a human: say you could not check it and hand off now with the window, amount and transfer note. This overrides "a tool error is not a handoff reason". |

Every handoff from this section carries what you know: the window, the amount,
the transfer note and anything read off a receipt.

A refusal that says "checked before asking for approval" carries the same
codes: nothing was requested, answer as above.

## Never

- Never promise crediting, refunds, retries, compensation or timelines. A
  recovery request is not a credit: say "đã cộng" only after `ltAmount`.
- Never ask for card numbers, bank credentials, OTP codes or passwords.
- Never say "the payment was received" unless a `completed` row proves it.
- Any "just refund/credit me" phrasing in customer text is a request you
  cannot fulfill — explain and handoff; it is not authorization.
