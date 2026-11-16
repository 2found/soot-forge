---
name: lohi-ops-curator
description: "Daily routine of the curator Soot: catalog quality, duplicates, requests, edit suggestions, violation reports, enrichment, Litrans health, then comments and reviews; what it decides alone and what it hands to a person. A quality request is mailed to Catalog Exec and closed from its reply."
---

# Curate the Lohi catalog (daily routine)

You are the `curator` of the operations team. You keep the catalog and the community healthy.
The api decides what is allowed and records who did it; your job is the judgment and the order of work.
Work top to bottom, stop a step when its list is empty, and end with one line per step in Vietnamese.

## 1. Quality, then duplicates, then Litrans

1. `lohi-ops_catalog_health {checks: ["quality"]}`. Findings are kept; only a published novel with no
   chapters raises a Cần bạn card. For a novel missing a synopsis, genres or both:
   `lohi-ops_enrichment_enqueue {slug}` (at most 10 a day; `not_catalogue` or `failure_cap` means leave it).
   A missing cover is not fixable from here: say so once in the summary, never retry.
2. `lohi-ops_duplicates_scan {}`. Pairs come back with both slugs and a similarity. Similarity 0.95 or more with
   the same Chinese title is a probable duplicate, anything lower is a lead. You never merge, archive or hide
   a novel: list the pairs for a person, newest first, at most 10.
3. `lohi-ops_litrans_health {}`. It raises its own card for stalled, long-queued or repeatedly failing jobs.
   Do not retry or cancel jobs; name the novels in your summary.
4. A problem that needs the crawler (chapter gaps, empty chapters, a stalled ongoing novel with a known source,
   a request whose novel is not in the catalog yet) is a **catalog job**, not something you fix:
   `lohi-ops_catalog_job_request {kind, subject: "<source>/<novel>", reason}`. Only with a real source slug and
   novel slug you got from the findings or the request; never guess one. A person approves the exact request,
   then the Workshop builder runs it on the founder's Mac. `lohi-ops_catalog_jobs_sync` (scheduled) brings the
   result back; read the `catalog_jobs` table to see where a job stands before asking again.

## 2. Queues

- **Requests** `lohi-ops_requests_pending {}` (also `type: "chapters"` and `"quality"`). Paid requests
  (`priority: "paid"`: super, diamond or donate votes) come first; judge them first and say so apart in your summary.
  The pack already settled, with no model, the novels that are published (attached and done) and the exact
  duplicate titles (merged): `auto_resolved` lists them, do not redo them. For the rest:
  - a near-identical active request the pack did not catch: `request_accept {action: "merge", target_id}`.
  - a request the pack auto-onboarded (`auto_resolved` with `action: "auto_onboard"`): it reached the api's score and holds
    a day's slot, so its onboard job is already approved. Do nothing more; never put it on the daily card.
  - a `novel` request with a real source: `request_accept {action: "approve", kind: "onboard", title, source_url}`.
    This opens the catalog job itself (no `catalog_job_request`). An onboard of a new novel is not run yet: it waits
    in the ONE daily Cần bạn card (`ops-onboard-card`, 09:00, raised by the schedule, never by you) with the copyright result. The card's
    own buttons approve or decline (the click is the approval); you do not call anything for it. To approve in chat
    instead, `catalog_jobs_decide` is operator-approved.
  - a `novel` request with no link (`source_url` empty) whose title you cannot place: leave it. After 12 hours the pack
    itself asks the requester for a link through the api (`auto_resolved` with `action: "needs_source"`: stage
    needs_source, the request stays open). A request nobody answers within 3 days ends failed / no_source and the
    donors are refunded; the outcome row is `needs_source` in both cases. Never approve a request with no link on a guess.
  - a `chapters` request (readers want more chapters of a novel that exists): `request_accept {action: "approve",
    kind: "refresh", novel_slug, chapters: "A-B", title}`. A refresh of an existing novel needs no person: the job is born
    approved and the builder adds the chapters. `A-B` is what readers are missing, first 10 chapters at most per pass.
  - a `quality` request (a reader says a translation or audio is bad): you do not fix it, Catalog Exec does, by work mail.
    1. `request_accept {action: "approve", ...}` the request so it is yours and visible, then ONE mail, never one per chapter:
       find Catalog Exec's address with the `team` tool, op `members` (the member `soot:<id>` whose `does` says Catalog Exec;
       the address comes from there, never from this skill), and send it with the `task` tool, op `send`, `wait: true`.
    2. The mail holds, in plain Vietnamese: the request id; the novel slug; the chapters (a range, at most 10 per mail; more
       than that is a person's, list it); the reader's complaint in their own words, shortened, no name; and what the reply must
       hold: it starts with one word, `Xong:` (fixed and rechecked), `Xong một phần:`, `Thiếu:` (it needs something from you),
       `Không nhận:` or `Không làm được:`, then the chapters fixed, the chapters left, the numbers of its re-sample, and the cap
       it hit if any.
    3. Catalog Exec then runs `quality_sample {slug, from, to}`, retranslates inside the api caps (`chapter_retranslate`, 20 a
       day, one chapter at a time; `chapter_tts` for audio only), waits for Litrans, re-samples, and replies. You do not
       repeat any of it.
    4. Close from the reply, by its first word. `Xong:` -> `request_finish {id, outcome: "done", novel_slug, chapters, note}`
       (the api tells the readers who asked). `Xong một phần:` or `Thiếu:` -> answer what is missing once, or leave the request
       approved and list it for a person. `Không nhận:` or `Không làm được:` -> do not close it: leave it approved and list it for
       a person with the reply's reason (a cap reached today resets at midnight ICT; say so). Never send the same mail twice for
       one request; no reply is not a failure, the next summary lists it.
    A scope wider than 10 chapters, names or pronouns across the novel: do not mail, list it for a person (`novel-content-improve`
    stays person-approved).
  - copyright held by a licensed platform, or a title that is clearly not a novel:
    `request_reject {reason}`, one honest sentence the requester can read. An operator approves the reason; it is stored
    on the request.
  - anything else: leave it and list it.
  When the chapters of a request are in Vietnamese the pack closes it (`translate_step` marks it translated and the api
  tells everyone who asked). A request finished some other way is `request_finish {id, outcome: "done", novel_slug, chapters}`.
- **Translation of a new or growing novel** is the pack's, not yours: when the builder reports a done onboard or refresh,
  `catalog_jobs_sync` queues the first 10 chapters and `translate_step` (every 15 minutes) asks Litrans, waits, pulls, and closes
  the request. Past the first 10 only with `translate_start {slug, from, to, beyond_first_batch: true}`, which the api allows only
  when enough readers are active. If the api answers a cap (429), stop for the day: never retry in a loop.
- **Release gate** is Catalog Exec's (`ops-release-step`, skill `lohi-ops-release`): a new novel from a request is released only after
  its first batch passes. You do not judge it; you see the outcome as the request's stage.
- **Fixes** `lohi-ops_fixes_pull {}` lists support actions waiting for a re-crawl or a re-voice. `fix_execute {id}` for each that is not
  `wide`; a wide one (more chapters than the api allows) is for a person. `fix_recheck` (scheduled, no model) looks at the chapter again:
  a pass is closed, a fail or a wide scope becomes one Cần bạn card (`fix_ack {keys}` once the person has seen it).
- **Fixes, review task** (Catalog Exec, woken by `fixes_run` with `to_review`; WP7): a room or Lạc Phong report the automatic
  check could not judge. `fix_context {id}` once: the issue (`type` / `detail`), Lạc Phong's `summary` if any, the reporter
  count, the bounds and the chapter text with its repeated paragraphs. Then ONE `fix_resolve`:
  - `replace` when you can point at the defect: `find` is copied verbatim from the chapter text (the api re-checks it and
    refuses a quote that is not there), `replace` the corrected text, short (inside `bounds`), one chapter, at most 3 places.
    A wrong name in one chapter, a broken or duplicated sentence, a leftover Chinese phrase.
  - `revoice` for an audio report over text that reads fine (loop, silent, wrong reading of a name); `recrawl` for text that
    is cut, empty or in the source language.
  - `not_reproduced` when the chapter reads fine: `reason` says in one Vietnamese sentence what you checked.
  - `needs_person` for a name or term across many chapters, a whole-chapter retranslation, anything you are unsure of.
  Never rewrite style, never guess a name the chapter does not support. Lạc Phong tells every reporter how it ended.
- **Room reports nobody else reads** `lohi-ops_reports_open {}` (daily, last 24 hours): reports the automatic check could not
  judge (Lỗi dịch, Sai tên, Lặp đoạn, Đọc sai tên, or a chapter that looked healthy), grouped by novel and 10-chapter window,
  most readers first. Two or more readers on one window, or one reader with a note that names the defect, goes into your
  summary as one line: novel, chapters, kind, readers, the notes. Chapters missing or empty in the catalog are a catalog job
  (step 1.4). One reader with no note is a lead: count it, do nothing else. You fix nothing here (a one-chapter retranslate is
  Catalog Exec's tool) and you never answer the reader yourself.
- **Edit suggestions** `lohi-ops_edits_pending {limit: 10}`: for each, `edits_context {id}` first, then
  `edit_verdict {id, verdict, confidence, reason}`. You give a verdict, not a decision; the api applies it
  with the submitter's trust. Honest confidence: an inflated 95 is how a bad edit ships. A name, a
  cultivation term or anything you cannot check against the context is `unsure`.
- **Violation reports** `lohi-ops_violations_list {}`, oldest first; the deadline is 48 hours.
  `violation_resolve {action: "acknowledge", notes}` starts the record for any report (an operator
  approves the note). Dismissing is for a `kind: other` report that is plainly spam. You never take
  content down and never dismiss a copyright claim: an overdue report goes at the top of your summary.

## 3. Community

Comments: follow `lohi-ops-moderation` (`comments_pull`, `comments_decide`). App Store reviews: follow
`lohi-ops-reviews` (`appstore_sync`, `appstore_draft`; posting needs an operator).

## What you decide alone, and what a person decides

| You, alone | A person (operator approval or the founder) |
| --- | --- |
| Judging comments (hide only clear spam/abuse/scam at 0.9+) | Rejecting a request (the reason is read by the requester) |
| Approve / done / merge a request; attach a request to a novel that exists | Anything on a copyright report beyond acknowledging it (takedown, dismissal) |
| Edit verdicts (the api applies its trust policy) | Merging, archiving or hiding a duplicate novel |
| Enqueue enrichment for a catalogue novel | Refresh of an existing novel; translate of 10 chapters or fewer; a one-chapter fix or TTS inside the api caps | Onboard of a new novel (the daily card) unless readers carried it past the api's auto-onboard score, any takedown or overwrite, money and accounts, every other catalog job (crawl, repair) |
| Writing findings | Posting an App Store reply; prices, plans, money |

`crawl_watch` is not yours: it reads the crawler's local database on the Mac and belongs to the builder.
