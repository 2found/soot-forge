---
name: lohi-ops-builder
description: "How the Workshop builder runs the curator's catalog jobs on the founder's Mac: jobs run on their own (autorun, radar); the model only settles a request link the catalog has never seen and reads failures."
---

# Run the curator's catalog jobs (Workshop builder, founder's Mac)

The curator asks for crawler work through the operations team's `catalog_jobs`. An operator, or a policy, already
approved every job you can see; you run it, you do not judge it. Almost all of it needs no model: the tools below run
the jobs themselves and you are woken only when one needs a decision.

## What runs without you

- `lohi-ops_catalog_jobs_pull {autorun: true, max_start: 3}` (scheduled every 15 minutes) first reports how the jobs this Mac
  started ended, then starts the approved ones as deterministic sequences of cli commands (argv arrays, no shell, detached,
  a log under the pack state dir):
  - `crawl`: `crawl catalog run`; a bare `refresh` (no chapters): `crawl catalog radar`.
  - `refresh` with chapters: `onboard --chapters A-B --chapters-only --no-announce` (with `--request-id` for a request);
    `repair`: the same with `--overwrite`. The refresh reports the chapters it really added; none added is a quiet done.
  - `onboard` of a new novel: crawl 1-10 if the catalog lacks them, `onboard ... --dry-run`, `crawl catalog copyright`,
    then it stops `blocked_copyright` (nothing is ever published) or runs the real onboard (`--request-id --keep-draft` for a
    request: the api publishes it at release).
- A request that names no link is resolved from the catalog alone: ONE source novel whose accent / case folded title equals the
  request title (or its Chinese title). Two matches, none, or a title under 6 characters is never guessed: the job ends
  `failed` with `no source:` in its detail, the api refunds the donors and tells the readers to send a link. You do nothing.
- `lohi-ops_radar_scan` (every 2 hours) sweeps the novels this Mac keeps current and reports new chapters to the curator's
  policy, which opens the refresh jobs. Its result wakes you only when a sweep failed.
- `lohi-ops_crawl_watch` (every 4 hours): stuck crawls, repeated failures, stalled sources. A finding that needs the catalog or a
  decision goes back to the curator as a normal message, not as a job you create.

## What wakes you

1. `needs_source`: a request gave a link the catalog has never seen, so the novel id is not derivable. The pull result holds
   `source_hint` (the source pack whose host is the link's) and an `instruction`. Open the link's page, find the novel id the way
   the source pack does (cli/data/sources/<source>/config.json and its README), never by a title search. If the catalog has no row
   for it, seed one: `crawl catalog meta --source <s> --novel <n> --vi-title "<title>" --landing-url "<link>"`
   (cli/README.md). Then `lohi-ops_catalog_job_run {job_id, source, novel}`. The tool refuses a source that is not the link's own
   site and a novel the catalog does not hold. Cannot tell which novel it is: do nothing; after 24 hours the job ends `no source`
   and the donors get their LT back.
2. A job that could not start (`refused`, for example `catalog_unreadable`): say the reason in one line. A source the cli lacks, an
   unknown kind or product are already ended `failed` by the tool.
3. A radar sweep that failed: say the reason in one line.

## Rules

- A source with a Cloudflare 403 (see cli/README.md, sto66-com) is `failed`: do not retry it the same day. Never edit
  `source_catalog` by hand to make a job pass; never run a cli command that publishes outside a job.
- `lohi-ops_catalog_job_report` stays for a job you ran by hand outside the tools: `{job_id, state: "done"|"failed"|"blocked_copyright",
  detail, novel_slug, chapters, copyright}`; a done onboard or refresh carries the `novel_slug` and the chapter range really added.
- Chapter counts in a detail, never text.
