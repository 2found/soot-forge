# The marketing team that runs 2found

Since 2026-10-14, 2found's own marketing, sales and support run on a team of
Soots ([facts](https://2found.dev/facts/soot.md)). This example is the
marketing part of that team as a Soot source you can copy: four Soots that
research, write, review and publish every day and come to a person only for
what a person must do. It is agents as a service you run
yourself — the service is the work, and it runs where you put it: Nest on your
computer, or a Soot runtime on your server (both in preview).

```text
08:00 schedule ─▶ Editor ──▶ Radar      reads HN, Reddit, dev.to, feeds → brief-YYYY-MM-DD
                    │    ──▶ Writer     article + social posts            → article-…, post-…
                    │    review, fix, publish: blog (CMS), social ──▶ Poster (your browser)
                    └─▶ Cần bạn (needs you): only "post this video by hand" or "decide this"
15:00 schedule ─▶ Radar      afternoon scan, merged into today's brief
```

To get a team like this without a repository, ask Kamaji in Nest: it builds
one from the [Marketing team template](../../groups/marketing-team/README.md),
whose members use the product-neutral [marketing pack](../../packs/marketing/README.md)
and a marketing hub. This example stays for a team you keep in git, with your
own procedure pack.

It follows the workflow 2found runs on its own runtime, with 2found's own feed
reader and CMS hub swapped for Forge packs. What it learned in production is in
the design notes at the end.

## Who does what

| Soot | What it does | When it runs |
| --- | --- | --- |
| `acme-editor` | Leads the cycle: asks the radar for the brief, picks at most one angle, assigns the writer, reviews every piece, publishes articles through your CMS and hands social posts to the poster, then reports in a few lines | Morning schedule (08:00 UTC until you change the timezone) |
| `acme-radar` | Reads Hacker News, Reddit, dev.to, your feeds and one web search; writes the day's brief into the shared pool | When the editor asks, and its own afternoon scan (15:00 UTC) |
| `acme-writer` | Writes the article and social posts for the editor's angle, checking every product claim against your site with `knowledge_search` | When the editor asks |
| `acme-poster` | Posts reviewed social posts from the browser already logged in on its computer and writes each post's URL back | When the editor asks |

2found's team also has a support Soot that answers visitors in the website chat
and a desk that sorts their leads and feedback. They are not part of this
example; the editor reads the desk's daily note (`voc-…`) only if one exists.

## What is in it

`soot-source/` is a Soot **source**: a slice of configuration a repository
owns and deploys on its own (`soot spawn --source <id> <dir>` starts an empty
one; `soot bundle` checks it). How a group works together and how a data pool
is shared are on [trysoot.com](https://trysoot.com/docs/orchestration/index.md)
and [Data Pool](https://trysoot.com/docs/data-pool/index.md). It holds:

| file | what it is |
| --- | --- |
| `soot/source.json` | the four Soots, the `acme-marketing` group, two schedules, the products knowledge pool |
| `soot/soots/acme-*/mission.md` | **your company**: audience, sources, channels, languages, daily limit |
| `soot/soots/acme-*/SOUL.md` | each role's character |
| `soot/packs/acme-marketing/` | **the procedure**, as skills: shared workspace, radar, writing, review and publishing, posting |

The split is deliberate. Procedure lives in the pack's skills, written once.
Your company lives in the missions. Product facts live in neither: they come
from your website's `llms.txt` through `knowledge_search`, so the team never
claims something your site does not say.

## Set it up

Steps 3 and 4 use the `soot` CLI, which is not publicly downloadable today: it
needs access to Soot's private repository, and the Nest desktop app does not
install it. With Nest alone, build the same team by hand from these files:
install the Forge packs under **Pack**, create the four Soots with these
missions and souls, then the group and the two schedules (see
[orchestration](https://trysoot.com/docs/orchestration/index.md)), and paste
the five skills into the editor's and teammates' instructions or a pack of
your own.

1. **Copy and rename.** Copy `soot-source/` into your repository. Replace the
   prefix `acme` everywhere (file names and contents) with your own short id:
   Soot, group, pool and schedule ids are shared by the whole runtime.
2. **Point it at your company.** Edit the lines marked `Edit these lines` in
   the four missions, the `knowledge.sources` URL in `source.json` (a page
   listing your product pages; see [llms.txt](https://llmstxt.org)), and the
   schedules' `timezone`.
3. **Install the packs** the Soots borrow (`host_packs`) in your host (Nest or a
   server runtime):

   ```sh
   soot add 2found/soot-forge/packs/research
   soot add 2found/soot-forge/packs/data-pool   # then connect it: packs/data-pool/README.md
   soot add 2found/soot-forge/packs/website     # only to publish through a CMS with its contract
   soot add 2found/soot-forge/packs/browser-use # only where you are logged into your accounts
   ```
4. **Deploy:** `soot bundle --refresh ./soot-source`, then
   `soot source deploy ./soot-source` for Nest on this computer. For a
   2server runtime, `2srv init soot-source acme --runtime <app> -o
   ./soot-source/deploy.yaml` once, then `2srv deploy -f
   ./soot-source/deploy.yaml --apply`.
5. **In Nest**, on each Soot's profile, turn on **Kho dữ liệu chung** (shared
   data) and the switches under **Quyền dùng trên máy này** (what it asks to
   use on this computer). Create the pool `acme-marketing` with write access
   for the four Soots. If you publish through a CMS, paste its credential
   (`WEBSITE_CMS`) under **Kết nối công cụ**.
6. **Try one cycle** before trusting the schedule: open the schedule
   *Morning marketing cycle*, press **Chạy ngay** (run now) and read the
   editor's report.

Nothing can be posted before step 5 gives the Soots their tools and
credentials, and the editor posts only what passed its review. Run step 6
before the next scheduled cycle. Without a CMS credential or a logged-in
browser, everything it would post arrives in **Cần bạn** (needs you) on Nest's
Home with the exact text instead.

## What still needs a person

Soots take the recurring jobs; people keep the decisions. A person:

- **Sets it up and grants access** ([Set it up](#set-it-up)). A Soot uses only
  the tools you grant.
- **Decides what the team may not.** The editor publishes on its own. It stops
  and asks only when a piece would announce a price, date, partnership or
  legal/security claim your pages do not state, answers or criticises a named
  person or company, or depends on a claim it cannot check and cannot leave
  out. A single decision comes as one card with one-click answers and a safe
  default (hold the piece) taken after a set time, 24 hours in the skill's
  example, so silence never stalls the team.
- **Does what the team cannot reach.** A post it cannot make (a video to film,
  a channel with no connection) comes as one card per cycle in **Cần bạn**
  (needs you) with the text to paste.

If you would rather approve every post, set your host's approval policy for
`website_cms_save` and `browser-use_control` to `operator`. The skills do not
change: the gate is the host's.

## Design notes from running it

- **The pool is the workspace.** Teammates hand on document ids, never pasted
  drafts. Every run starts from what the last one left (`status:draft`
  leftovers are reviewed first), and a person can open any piece in Nest.
- **Schedules only say which cycle to run.** The procedure lives in the
  mission and skills. When the schedule text repeated it, the two drifted
  apart and the team followed whichever it read last.
- **Few tool calls, spent on the output.** A scan that "triages everything"
  ran out of calls before writing the brief. The radar skill says "three sharp
  items today beat a perfect list and no brief", and the brief comes before
  bookkeeping.
- **Prefix every shared id.** Pools, like Soots, are shared by the runtime. A
  second team's `marketing` pool would read the first team's briefs.
- **Silence beats filler.** A daily limit and "nothing worth writing → say so
  and stop" keep the blog from filling up with weak posts.

## Verification

`soot bundle --refresh soot-source` validates the source (4 Soots, 1 pack,
1 group, 2 schedules). The workflow is the one 2found runs daily on its own
runtime. This generic copy has not yet been run end to end with the Forge
`research`, `website` and `browser-use` packs. Run step 6 on your host and read
the report before you rely on the schedule.
