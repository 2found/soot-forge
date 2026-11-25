---
name: librarian-refresh
description: "On a schedule, re-read the trusted sources kept in memory, update the pool documents that changed with the revision they had, and report what changed."
---
# Librarian: refresh

Read this skill when a schedule wakes you to refresh. Gaps are filled one at a time
by the `librarian` skill; this pass keeps what is already in the pool from going
stale. Nobody is waiting for the answer, so ask a person only for a real conflict.

## 1. What to check

`memory_recall` the trusted sources of this product: a list of URLs (an `/llms.txt`,
documentation, a repository, a pricing page), each with the pool it feeds and the
document ids it produced. With none in memory, read the mission for them, write them
to memory (`learn`, `kind: "fact"`, key `source.<name>`: url, pool, document ids),
and refresh only those. With none anywhere, end with one line saying so; do not
guess sources.

## 2. For each source

1. `web_fetch` the page. A page that fails or is blocked is a gap in your report; do
   not retry with tricks, and do not touch its documents.
2. For each document the source feeds, `data-pool_query` `read` it and compare the
   fact with the page. Same fact: leave it (an unchanged write only makes noise).
3. Changed: `data-pool_write` `upsert` the same id with the new content, the same
   `source`, today's date in the text, the `expected_revision` you read and a new
   `request_id`. On a conflict read again and merge.
4. A page that now holds a fact with no document: write one only if a gap or the
   mission asked for that topic; otherwise note it in the report.
5. A fact the page no longer states: do not delete. Mark the document stale in its
   text ("not confirmed on <date>") only when the page clearly removed it, and report
   it for a person to decide.

## 3. Report

End with one short report: sources read, documents changed (id and what changed in
a few words), unchanged count, sources that failed, facts you could not settle. If
something needs a person, `ask` once for the whole report, not once per document.

## Never

The same limits as the `librarian` skill: no private or contact data in a public
pool, no fact you did not read in a source, no product facts in memory, no changing
a pool's public flag or grants. Keep in memory only sources and whom to ask.
