# Librarian (Thủ thư)

Keeps a product's public knowledge correct and complete. A Soot that answers visitors
looks facts up in the **public pools** of the data pool (`knowledge_search`). When a
fact is missing, the runtime hands the gap to one Soot, the librarian, which researches
it in sources you trust and writes it into the pool with its source and revision. The
next visitor gets the answer; nobody edits a page by hand.

```
visitor ─▶ Soot ──knowledge_search──▶ public pool ◀── data-pool_write ── librarian
              └── knowledge_gap (runtime) ───────────▶ librarian ◀── web_fetch (trusted sources)
                                                          └── ask (Cần bạn), only when stuck
```

| Skill | What it decides |
| --- | --- |
| `librarian` | One gap, one fact: one task per gap key, check the pool, research (`/llms.txt` and docs, then the repository README, docs and CHANGELOG, then the website), ask a person only when sources are missing or disagree, write with a stable id, `source` and `expected_revision`, close the task with the document id. Never private or contact data in a public pool. |
| `librarian-refresh` | On a schedule, re-read the trusted sources kept in the librarian's memory and update only the documents that changed, with the revision it read. Reports what changed. |

The pack has no tools of its own: it uses `data-pool_*` (write), `task`, `ask` and the
`research` pack's `web_fetch` / `web_search`. It names no product.

## Set up

1. **Install** the pack and the packs the Soot uses: `soot pack add librarian`, plus
   `data-pool` and `research`. The Soot template is `soots/librarian/`
   (`soot.json`, `MISSION.md`, `SOUL.md`): copy it into your source, edit the trusted
   sources in `MISSION.md`, and keep the same list in the Soot's `soot` memory
   (`source.<name>`: url, pool, document ids), where the refresh reads it.
2. **A data pool with a public pool.** Create the pool that holds product facts and mark
   it public (`data-pool_manage` `pool_update` `public:true`, or the toggle on the
   data-pool console's Library page). A local pool is enough. Only a pool manager does
   this; **never mark the `data_pool.feedback` pool public**: it holds visitors' notes.
3. **Let the librarian write.** In the data-pool service add the Soot as a writer and
   grant it write on each public pool it keeps. Installing the pack grants nothing.
4. **Name it in `deployment.json`.** Merge [`deployment.fragment.json`](deployment.fragment.json):
   `data_pool.librarian: "librarian"` (the Soot must be a host Soot with conversations
   on, not archived, not public-facing) and the two schedules: `librarian-sweep`
   (daily) closes the open gaps, `librarian-refresh` (weekly) re-checks the sources.
   Without `data_pool.librarian` the runtime offers no `knowledge_gap` tool.
5. **Point the answering Soots at the pools:** `"knowledge"` in their `packs` (every
   public pool) or `"knowledge:pools=a,b"` (at most 4).

Binding secrets (a service token, a `DATA_POOL` credential) are entered on the host, not
in this repository.

## What it writes, and what it does not

One fact per document, with a stable id, a `source` URL and the date it was read. Stable
ids make a correction an update, not a second copy. It does not write: private or contact
data, anything it did not read or hear, product facts into memory or files, or changes to
who may read a pool.

## Evals

[`evals/librarian/`](evals/librarian/README.md): four cases: a gap written with source,
nothing found so it asks, contact data refused, and a repeated gap that adds to its task.

```sh
node --test tests/pack.test.mjs
```
