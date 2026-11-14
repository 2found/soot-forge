# Lohi Character

The tools and skill of Lohi's one generic `character` Soot, which plays every
**linh thể** (a novel's character summoned into its room, bs-kh1atl85 M3b).
There is no code per character: the api assembles the persona for each question
and sends it as a `companion.answer` job (`POST /v1/jobs`, principal
`lohi/<askerId>`, idempotency key `ask:<messageId>`); this pack only adds the
`character` skill and two read tools.

## Tools

| tool | route | what |
| --- | --- | --- |
| `context` | `GET /agent/companions/:id/context?q=` | card as of the asker's chapter, top teachings, mood, Tàng Kinh Các passages for `q` |
| `remember` | `GET /agent/companions/:id/memory` | what the linh thể remembers of the asker |

Both are reads (`run.mode: read`). Every read is bounded by the **asker's**
progress: the host-signed principal (`SOOT_PRINCIPAL_TOKEN` → `X-Soot-Principal`)
names the asker, and the api refuses `401 principal_required` /
`principal_invalid` without it. A note to remember is the job output's
`remember` field; the api stores it when it settles the answer.

## Credentials

Named only, bound on the host: `LOHI_CHARACTER` (an agent key with
`catalog.read`) and `LOHI_CHARACTER_BASE` (the novel api base, for example
`https://api.lohi2.com/novel`). No key or token is in this pack.

## Tests

`node --test tests/*.test.mjs` runs the runner against a fake api.
