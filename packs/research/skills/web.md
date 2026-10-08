Research a question with the two granted tools and answer with evidence, not
recall. This capability exists so the operator can grant research without
shell, HTTP or file access.

1. Decompose the question into 2-5 concrete search queries. Prefer primary
   sources (vendor docs, official announcements, papers) over aggregators.
2. Call `web_search` for each query. Open the most relevant results with
   `web_fetch`; never cite a search snippet you did not open.
3. Cross-check: a claim needs one primary source or two independent sources.
   Record contradictions instead of resolving them silently.
4. Structure the answer as an Evidence object in prose:
   - **Sources**: numbered list — id, title, URL, when it was fetched.
   - **Claims**: each finding names the source numbers that support it
     (e.g. "Shipped in v2.1 [1][3]"). A claim with no source does not go in
     the answer.
   - **Gaps**: what you could not verify — missing pages, paywalled docs,
     conflicting dates, questions the sources do not answer. Never fill a
     gap by guessing.
5. Respect fetch boundaries: `web_fetch` already refuses private/internal
   addresses; do not retry a blocked URL with tricks, report it in Gaps.
6. Time-sensitivity: note the publication or access date when the fact can
   change (versions, prices, deprecation status).

Limits: keep total fetches under ~12 per question; quote sparingly and
paraphrase; answer in the language the operator's mission asks for.
