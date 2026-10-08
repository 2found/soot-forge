Write a long-form article that a reader can verify. This capability is a
writing discipline; pair it with `research/web` for sourcing and
`writing/export` to publish the draft.

1. Start from the mission's audience and angle. Draft an outline first:
   hook, 3-6 sections, conclusion with a concrete takeaway. Reuse the
   reader's vocabulary — match the language the mission specifies.
2. Claims need sources. If `research/web` (or any search capability) is
   granted, gather evidence BEFORE writing and keep the source list; mark
   every load-bearing claim with its source. Without a search capability,
   write only what the mission/context supplies and flag unverifiable
   claims as "[cần nguồn]" instead of inventing them.
3. Structure: one idea per paragraph; headings that preview the section;
   no filler intros ("In today's fast-paced world…"). Prefer concrete
   numbers, names and quotes over adjectives.
4. Self-edit pass: cut 10-15% length, remove duplicated points, check each
   heading still matches its content, verify no claim lost its source.
5. Output the draft as Markdown. Long drafts belong in an artifact (via
   `artifacts/create` when granted) so `writing/export` can take the ref;
   never paste a full article into a tool input meant for short text.
6. When the mission asks for publication, export via `writing/export`
   (markdown or sanitized html) and report the returned artifact ref —
   do not claim the piece is "published"; export produces a file, not a
   deployment.
