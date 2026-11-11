# Company digest: rank, save, one line

The Monday chain already read the scoreboard (`company-loop_scoreboard_sync`) and
woke you with `company-loop_signals`. You write the digest once; nobody answers
a question mid-run. Cost is one short run: no browsing, no research, no
sub-agents, no other tool than the ones named here.

0. **Which product.** When your run has a product (the task or schedule names
   it), the tools already work on it: call `company-loop_signals` and
   `company-loop_digest_save` with no `product`, and every item is that product's.
   When it has none and the company has several products, name one product per
   digest (`signals {product}`, `digest_save {product}`) and never mix products
   in one save.
1. Read what readers asked for: `data {op: "query", scope: "team:cs", table: "voc", limit: 60}`
   (the support team's contract item `cs.voc`: `kind`, `summary`, `created`, already
   free of personal detail). Count the rows of the last 14 days by `kind` and note
   the themes that repeat; that is your reader feedback. If the call is refused,
   fails or the team is unreachable, you have no voc: say so in one clause and use
   the packet's `cs_feedback` instead. If it answers with zero rows that is a real
   answer ("no feedback"), not a failure.
   Then call `company-loop_signals {voc: true}` once (`{voc: false}` when voc was
   unavailable: the tool then reads the older feedback desk itself). It is a compact packet: `metrics`
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
   The packet also has `parts`: the 5 parts of the business (`p` value,
   marketing, sales, delivery, finance), each with `st` (`ok`, `hong` = its
   metric `m` moved the bad way by 10% or more or is off its target, `chua_do` =
   no number), `pct` and `own` (the owning team, `null` = chưa giao). `moats`
   counts past Go decisions by moat; `awareness` counts the content topics of
   the last 8 weeks by nấc.
2. Pick **at most five** opportunities, best first. **Customers first:** what
   customers said or did (voc rows, `reasons`, `cs_gaps`, `support.waiting_human`)
   ranks above what competitors or the market do. Then a part that is `hong`
   or `own: null` is evidence: prefer the opportunity that fixes that part and
   say it in `part`. Then rank by evidence
   (`signal_count`, how many numbers and sources point at it), then value over
   effort, then confidence. Prefer the metric that fell or the gap that repeats
   over a metric that merely moved. Customer-service pain counts as evidence:
   a high `support.waiting_human`, a `reason`, a kind in the voc rows (or `cs_feedback.n`) that
   repeats (several `feature_request` or `bug` notes about the same thing) each become an opportunity, usually `product`, aimed at
   `support_threads_new` or `support_handoffs` (negative `expected_delta`), or at
   `content` when a help article would answer the question. Cite them as
   `feedback:<kind>` or `metric:waiting_human`; never copy a sample word for
   word into a title (samples are summaries, not quotes). Skip anything already in `waiting`, anything
   dropped (`d: "drop"`) and anything whose change is still being measured.
   Fewer than five is fine; none is fine: then end with "Tuần này chưa có cơ
   hội đủ bằng chứng." and call nothing.
3. Every item carries tags, or `digest_save` refuses the whole call and names the field:
   - `part` (always): `value`, `marketing`, `sales`, `delivery` or `finance`, the
     part this change fixes or grows.
   - `awareness` (always for `content`): which nấc the post speaks to. `unaware`
     = nấc 1, the reader does not know they have the problem; `problem` = nấc 2,
     knows it, not how to solve it; `choosing` = nấc 3, picking whom to buy from.
     Keep a mix over the weeks: if `awareness` shows one nấc taking most topics,
     write for another.
   - `pain` (always for `product`, 10 to 200 characters): who suffers from what,
     taken from customer evidence ("người mới đọc: không biết chương nào để bắt đầu").
     No pain from a customer, no product item.
   - `goal` (optional): the id of the goal this bet pushes, copied from the
     goal list or the "Mục tiêu và việc" block of this run. Leave it out when no
     goal fits; never invent an id.
   - `moat` (optional): set it only when the change builds one: `scale`, `network`,
     `counter`, `switching` (only the good kind: it makes the customer's life
     easier, never a lock-in), `brand` (a short promise kept every day), `cornered`
     or `process`. `none` is fine and honest; most items have none.
   Each opportunity is one of two kinds:
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
   hit rate compares your number with what happens. For a `content` item the
   review does not use the weekly total: it counts the post's own clicks (Search
   Console or its campaign link) from its publish day, or sign-ups its campaign
   link brought, so set `expected_delta` as that number for one post (for example
   30 clicks), not as a change of the whole metric. A post with no measured click
   count is reported "chưa đo", never scored.
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
