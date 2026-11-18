# Lohi Character

> **Deprecated in Soot Forge (2026-11-18).** This is Lohi's own pack. Its source of truth moved to the kiem-lai repository (`2found/soot/packs/lohi-character/`) and Lohi's server runs that copy as a local pack. This Forge copy stays for installs that still reference it and is no longer updated.

The tools and skill of Lohi's one generic `character` Soot, which plays every
**linh thể** (a novel's character summoned into its room, bs-kh1atl85 M3b).
There is no code per character: the api assembles the persona for each question
and sends it as a `companion.answer` job (`POST /v1/jobs`, principal
`lohi/<askerId>`, idempotency key `ask:<messageId>`); this pack only adds the
`character` skill and five read tools.

## Tools

| tool | route | what |
| --- | --- | --- |
| `context` | `GET /agent/companions/:id/context?q=` | card as of the asker's chapter, top teachings, mood, Tàng Kinh Các passages for `q` |
| `remember` | `GET /agent/companions/:id/memory` | what the linh thể remembers of the asker |
| `character` | `GET /agent/companions/:id/character` | the card as of the asker's chapter (with "lúc này"), mood, and sample dialogue: the character's real lines ≤ that chapter. A fallback: the job prompt already carries both |
| `characters` | `GET /agent/companions/:id/characters?q=` | other characters of the same novel (fuzzy on the name, or the best-loved with no `q`), each with its card as of the asker's chapter; one the asker has not met is never named |
| `wiki` | `GET /agent/companions/:id/wiki?q=` | Book Bible wiki entries of the same novel the asker may see (fuzzy on the entry name) |

All five are reads (`run.mode: read`). Every read is bounded by the **asker's**
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
