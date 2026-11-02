# Audio-pro / subscription quota triage

Read this skill before answering "why did audio-pro stop", "how many TTS
minutes do I have left", "what plan am I on". Reply in the customer's
language (usually Vietnamese).

## Data you can check (read-only)

Call the `lohi_lookup` tool — scoped to the signed-in reader by the host's
signed principal; never pass a userId:

- `lohi_lookup {"kind":"subscription"}` — active plan id/name, status,
  period end, and TTS + audio-pro quota counters (used, monthly limit).
- `lohi_lookup {"kind":"profile"}` — account tier and wallet balance for
  context (e.g. renewal failed → check `wallet` / `orders` too).

## Reading the result

- `used` ≥ `limit` → quota exhausted: honest answer is "your monthly
  audio-pro/TTS quota is used up; it resets at period end" — quote the
  reset date from `period end` if present. Never promise extra quota.
- `used` < `limit` but the feature fails → quota is not the cause; run
  `tts-triage` on the failing chapter instead (it scans the chapters and
  tells empty text from a bad audio file).
- Two different counters exist: Pro audio LISTENING chapters vs Pro audio
  REQUEST count. Quote each from the lookup, do not merge them.
- No active subscription → explain which plan gates the feature; do NOT
  quote prices from memory — pricing lives in the knowledge pool /
  public pricing page; handoff if the customer disputes amounts.
- Renewal/billing complaints → switch to `topup-triage` (`orders`,
  `topups` show the charge rows).

## Never

- Never grant, extend or "fix" quota — no write path exists for it.
- Never invent plan names, prices or quota numbers; report only what the
  lookup returned.
