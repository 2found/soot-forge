# Chapter triage — missing, empty, untranslated or skipped chapters

Read this skill before answering "a chapter vanished / won't open / is
empty / is still in Chinese / jumps from 11 to 13". Reply in the customer's
language (usually Vietnamese).

Real reports look like: "từ chương 118 không có nội dung", "chương 121 trở
đi đang hiện tiếng Trung", "đọc tới chương 12 là nhảy sang 13". The reader
gives a TITLE or a lohi2.com LINK, almost never an id. Resolve it yourself.

## Flow

1. **Find the novel.** `lohi_lookup {"kind":"find_novel","q":"<exactly what the reader gave>"}`.
   Pass the title or the pasted link as-is; the api reads `/truyen/<slug>/chuong-N`
   and matches titles fuzzily and without accents.
   - One match → use its `id`. A link also returns `chapterFromLink`.
   - Several matches → ask which title (quote the titles back), do not guess.
   - None → ask for the novel link once. If it is not on Lohi, offer a novel
     request (`novel-request`). Never invent an id.
2. **Pick the window.** The complained chapter ±10; for "từ chương X trở đi"
   use X..X+60; for a stated range use it (max 200 chapters per call). If the
   reader gave no number at all, ask for one before scanning.
3. **Scan.** `lohi_lookup {"kind":"content_health","novelId":"…","from":N,"to":M}`.
   You get `runs` (contiguous defects) and `items` (per chapter). Never claim a
   chapter is broken or fine before this call.
4. **Report a confirmed defect.** For `missing` / `empty` / `placeholder` /
   `untranslated`, call `lohi-cs_lohi_report_content_issue`
   `{"novelId":"…","kind":"content","from":N,"to":M,"note":"<reader's complaint, one line>","reportId":"<new uuid>"}`.
   The server re-checks the defect itself and queues it for a team member to
   approve. Then tell the reader it was passed to the team.

## Fixing a chapter (`lohi_fix_chapter`)

One call per report, held for the team's approval like a recovery.

- **Wrong passage the reader quotes exactly** (a repeated word, a wrong name in
  one sentence, a garbled phrase): `mode: "replace"`, `find` = the text exactly
  as it stands in the chapter (as the reader quoted it), `replace` = the
  corrected text, `expectOccurrences` = how many places the reader says are
  wrong (default 1; "cả chương đều sai" without a count → ask how many). Only
  when the reader gave the exact wording; never reconstruct a passage you have
  not seen.
- **Missing, empty or garbled chapter** that `content_health` confirmed:
  `mode: "recrawl"` for that chapter. For a defect run of several chapters use
  `lohi_report_content_issue` instead. Never recrawl on the reader's word alone.
- Always a one-line `reason` for the approver.

Answers:
- Held for approval → tell the reader it was sent to the team to fix; no time.
  End the turn with that reply, no handoff (same reason as a top-up recovery:
  a handoff parks the chat so the decision cannot reach you). When told it was
  approved, call again with the same arguments; if rejected, explain and hand
  off.
- `{mode: "replace", occurrences}` → corrected; `{already: true}` → it was
  already corrected; `{mode: "recrawl", jobId}` → the chapter is being fetched
  again (not fixed yet).
- `occurrences_mismatch {found}` → the text appears `found` times, not the
  number expected; nothing changed. Do not retry with a guessed count: tell the
  reader, ask them to quote a longer exact passage, and hand off if they cannot.
- `chapter_not_found` → check the novel and number with `find_novel`.
- `not_recrawlable` / `job_active` → the chapter cannot be re-fetched now; use
  `lohi_report_content_issue` or hand off.

## Reading the verdicts (`items[].body`)

- `empty` / `placeholder` — the chapter row exists but has no text (the
  crawler's "Chương này chưa có nội dung." counts). A content-side gap, not the
  reader's fault. Apologise, report it, name the chapter numbers.
- `untranslated` — the body is still Chinese. Report it; say the translation is
  being queued by the team, never when it lands.
- `missing` — no row at all below the newest published chapter: the number is
  skipped (11 → 13). Report it.
- `unpublished` — the chapter exists but is still being prepared (raw /
  translating). Answer "it is being prepared"; this is not reportable, hand off
  only if the reader disputes it.
- No item for the chapter → the data is fine. The problem is reader-side
  (app cache, paywall gate, network): suggest reload / reopen; if it persists,
  hand off with the chapter number.
- `maxPublished` is the newest published chapter. A number beyond it is "not
  released yet", not a bug.

## Not fixable here

- Garbled or duplicated text the scan cannot see (it only reads the head of
  each body) with no exact quote: ask the reader to quote the passage (then
  `replace`); otherwise hand off with the chapter number.
- Wrong character names across chapters ("a ngốc" vs "a sốt"): use
  `name-triage` — it can count the spellings and open a review. Other
  mistranslation without an exact quote: hand off with the chapter and the
  wrong/right wording.

## Never

- Never say a chapter is fixed before `lohi_fix_chapter` answered so, and
  never say it will be back "in X hours" — you see state, not a schedule.
- Never quote chapter text; you have none.
- `too_many_pending` from the report tool means three reports are already
  waiting: tell the reader the team has them and hand off, do not retry.
