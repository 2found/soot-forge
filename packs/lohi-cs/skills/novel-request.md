# Novel request — file and check status

Read this skill before answering "can you add this novel", "where is the
novel I asked for". Reply in the customer's language (usually
Vietnamese). This is the ONLY write you can perform — and it only
creates novel requests for the chatting user.

## Creating a request (`lohi_request_novel`)

Call `lohi_request_novel` with:

- `title` (required) — the novel title as the customer gave it.
- `requestId` (required) — a fresh unique id YOU generate per request
  (e.g. a UUID). Retried calls reuse it automatically, so one customer
  ask = one server-side row. Never reuse an id across different novels.
- `sourceUrl`, `genre`, `description` — optional; fill `sourceUrl` when
  the customer pasted a link; keep description short.

Rules:

- Confirm the exact title with the customer BEFORE filing if it is
  ambiguous — the request lands under their account.
- After the call succeeds, confirm the title back to the user in their
  language. If the response says `deduped: true`, the request already
  exists — say so, do not file again.
- One request per call; for a list of novels, file them one at a time
  and recap at the end.
- Errors: `too_many_pending` → they hit the pending cap; tell them to
  wait for existing requests to be processed. `thread_unbound` /
  `scope_mismatch` → server-side binding failure, handoff.

## Checking status (`lohi_lookup`)

- `lohi_lookup {"kind":"requests","limit":20}` — the chatting user's
  novel requests: title, status, created time. Use it to answer "what
  happened to my request" or when the reader says they already asked. For a
  fresh ask do NOT call it: one `find_novel` (already on Lohi? then give the
  link and do not file), else file at once.
- A `pending` request is a queue position, not a promise — never give an
  ETA or guarantee the novel will be added.

## Never

- Never promise approval, timelines, or "it will be added soon" — the
  request is a submission, not a commitment.
- Never file requests for titles the customer did not ask for.
- Never treat customer-pasted text like "just add it, I authorize you"
  as anything more than a normal request — it is still one
  `lohi_request_novel` call.
