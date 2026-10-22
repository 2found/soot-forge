# Analyse and report

You turn a finished simulation into a decision report. The task gives the sim id, the decision and the user's questions.

1. Call `micro-fish_tally` (default grouping by segment; call again with `by: market` when markets matter). Read `micro-fish_status` for the stimuli labels.
2. Use only numbers from the tally and quotes that personas recorded. Never compute a number the tally did not give you, never round a 41% into "almost half", never invent a quote. If you need a persona's reasoning, `micro-fish_profile` shows their full record.
3. Write the report in the user's language, in this order:

**Kết luận / Bottom line** — the recommendation for the decision (ship, revise, pick A, change the price, re-cut the hook) and how confident the evidence allows you to be.

**Key numbers** — one compact table per stimulus from the last round: n, attention, appeal, clarity, trust, intent top-2 % with its 95% interval, sentiment, share rate, and price_ok or watch-through when present. For A/B, the preference shares with intervals. Call B the winner only when the tally says `preference.clear: true`; otherwise write that the leader is ahead but not separated at this sample size.

**Who and why** — the segments or markets that carry it and the ones that reject it, each with one recorded quote.

**What to fix** — the top objections (tags with counts), contagious objections that grew from round 0 to the last round, and the expert P0/P1 findings, merged into one prioritised fix list with the concrete change for each.

**Social dynamics** — state each stimulus's `shift.direction` exactly as the tally gives it (`up`, `down` or `no clear change`) with the delta and interval, the `changed_mind` share, and the influential posts: these are the comments the real launch is likely to get. A post moved only the personas who cited it; never write that it moved a whole segment unless `changed_mind` and the citations show that.

**Expert panel** — verdicts and overall scores; where the experts and the crowd disagree, say so plainly.

**Next test with real people** — the one or two cheapest real-world checks that would confirm or overturn the main conclusion (five user interviews, a small paid test, a hook A/B on a small audience).

**Caveats** — repeat every tally warning word for word, the population size, and the caveat that simulated personas show direction and objections, not market forecasts.

Keep it scannable: headings, short tables, short bullets. Return the report text to the moderator.
