# Company digest: rank, save, one line

The Monday chain already read the scoreboard (`company-loop_scoreboard_sync`) and
woke you with `company-loop_signals`. You write the digest once; nobody answers
a question mid-run. Cost is one short run: no browsing, no research, no
sub-agents, no other tool than the ones named here.

1. Call `company-loop_signals {}` once. It is a compact packet: `metrics`
   (`v` now, `p` before, `pct` change), `sources`, `reasons` (why support handed
   over to a person), `support` (threads by state: `waiting_human` is readers
   waiting for a person right now), `cs_gaps` (questions the knowledge base
   could not answer, when present), `cs_feedback` (what readers asked for or
   lacked, when present: `n` counts by kind, `ex` a few short samples per kind),
   `waiting` and `later` (opportunities already open),
   `decisions` (what was decided, with `act`ual change once measured),
   `hit_rate`, `launched`, `topics_queued`, `cohorts` (signup weeks: `su` signups,
   `w1`/`w2`/`w4` still active after 1/2/4 weeks, `fp` first payers) and `plans`
   (`t` tier, `st` started, `ac` active, `rev` revenue). `cohorts` or `plans`
   `null` means the product does not serve it yet: say "chưa có", never guess a
   retention or plan number. A cohort whose `w1` falls week over week is evidence
   like any falling metric.
2. Pick **at most five** opportunities, best first. Rank by evidence first
   (`signal_count`, how many numbers and sources point at it), then value over
   effort, then confidence. Prefer the metric that fell or the gap that repeats
   over a metric that merely moved. Customer-service pain counts as evidence:
   a high `support.waiting_human`, a `reason`, a kind in `cs_feedback.n` that
   repeats (several `feature_request` or `bug` notes about the same thing in
   `ex`) each become an opportunity, usually `product`, aimed at
   `support_threads_new` or `support_handoffs` (negative `expected_delta`), or at
   `content` when a help article would answer the question. Cite them as
   `feedback:<kind>` or `metric:waiting_human`; never copy a sample word for
   word into a title (samples are summaries, not quotes). Skip anything already in `waiting`, anything
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
   given. Do not file a Cần bạn card: the host raises the card for the
   opportunities that wait for the founder by itself, and `report_blocker` would
   only park this run.
8. End with one line: how many opportunities went to marketing, how many wait
   for the founder.

Never decide for the founder, never call `company-loop_decide`, and never
mention a price or a discount in a `query`.
