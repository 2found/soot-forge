# Company digest: rank, save, one line

The Monday chain already read the scoreboard (`company-loop_scoreboard_sync`) and
woke you with `company-loop_signals`. You write the digest once; nobody answers
a question mid-run. Cost is one short run: no browsing, no research, no
sub-agents, no other tool than the ones named here.

1. Call `company-loop_signals {}` once. It is a compact packet: `metrics`
   (`v` now, `p` before, `pct` change), `sources`, `reasons` (why support handed
   over to a person), `cs_gaps` (questions the knowledge base could not answer,
   when present), `waiting` and `later` (opportunities already open),
   `decisions` (what was decided, with `act`ual change once measured),
   `hit_rate`, `launched`, `topics_queued`.
2. Pick **at most five** opportunities, best first. Rank by evidence first
   (`signal_count`, how many numbers and sources point at it), then value over
   effort, then confidence. Prefer the metric that fell or the gap that repeats
   over a metric that merely moved. Skip anything already in `waiting`, anything
   dropped (`d: "drop"`) and anything whose change is still being measured.
   Fewer than five is fine; none is fine: then end with "Tuần này chưa có cơ
   hội đủ bằng chứng." and call nothing.
3. Each opportunity is one of two kinds:
   - `content`: a search phrase readers type, written for the Writer. Needs no
     money and no code and can be undone, so it goes to marketing by itself.
     `query` is a Vietnamese phrase of two or more words ("cách học tiếng Anh
     giao tiếp"), `title` says why in a few words.
   - `product`: a change to the product. Costs a build, so the founder decides.
     `summary` says what to build and why in one or two sentences (20+ characters).
4. Every item names its measure, or `digest_save` refuses the whole call:
   `target_outcome` is a scoreboard key from `metrics` (`signups`,
   `first_payers`, `revenue_vnd`, `support_threads_new`, ...), `expected_delta`
   is the change you expect in that metric over one 7-day window (negative for a
   metric that should fall, never 0) and `check_after_days` is how long to wait
   before looking (7 for content, 30 for a product change). Be honest: the
   hit rate compares your number with what happens.
5. `evidence_refs` are short references (`metric:signups`, `source:facebook`,
   `reason:billing`, `gap:<topic>`), never customer text. `signal_count` counts
   the signals behind the item. `est_effort` is S, M, L or XL, `est_value` is
   low, medium or high, `confidence` is 0 to 1.
6. Call `company-loop_digest_save {opportunities}` once. If it refuses, fix the
   named items and call again once.
7. If the answer has `outcomes`, record each with the host outcome tool exactly as
   given. If it has `ask`, file it as the one Cần bạn card: `report_blocker` with
   its `summary`, `missing` and `options` as is, and that is the last call.
8. End with one line: how many opportunities went to marketing, how many wait
   for the founder.

Never decide for the founder, never call `company-loop_decide`, and never
mention a price or a discount in a `query`.
