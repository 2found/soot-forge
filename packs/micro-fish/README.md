# Micro Fish

A simulated society for anything you need people's reaction to: a post, a video, an article, a product page, a price, a campaign. Every persona is its own Soot with its own conversation and memory. They open a shared feed in rounds, meet the thing under test among ordinary posts, and skip it, finish it, like, share, comment, follow or post, seeing each other's shares and comments. Afterwards each one is interviewed, an expert panel reviews the content, and deterministic statistics turn what was recorded into a report. Node.js 22+ is required. Installing runs no scripts and grants nothing.

Use the [Simulated society template](../../groups/society-sim/README.md) to create the workspace; the driver adds the persona Soots.

## Method

After the multi-agent social simulations MiroFish and OASIS, on the Soot runtime:

1. **Brief** — a JSON file: the goal, the platform, one to four **subjects** (one arm each), the **context** posts they compete with, the **audience**, the interview **questions** and the **expert** lenses. Nothing in it is specific to one kind of content.
2. **Population** — a seeded draw from a persona library after the audience filter. Each selected persona becomes a Soot (`SOUL.md` from the library record, a platform-neutral `MISSION.md`, and only the `timeline`, `act` and `answer` tools).
3. **Feed rounds** — each round the driver wakes the personas whose seeded activity says they open the app. A persona's own run calls `timeline`, decides, and records with `act`. The feed draws unseen posts weighted by likes, shares, comments, follows and recency, so what one persona does changes what the next one sees.
4. **Between subjects** — with several subjects, each persona is assigned one and never sees the others, so nobody compares variants side by side.
5. **Interview** — the feed closes and every persona that met its subject answers the brief's questions from memory, in the same conversation. Someone who scrolled past says so.
6. **Experts** — each lens reads the brief and records P0–P3 findings with fixes. No verdict, no overall score.
7. **Tally and report** — `tally` computes reach, the skip / some / full split, the average `depth` (percent of the post people got through), like, share, comment and follow rates with 95% Wilson intervals, the subject's rank among the context posts, the A/B comparison, interview results, segment breakdowns and warnings. The analyst writes the report from it.

The model never computes a statistic and the driver never judges content. A simulation shows direction, objections and wording problems, never a market forecast. Subjects are text: a video or an image is judged from its description, and the report must say so.

## The brief

```json
{
  "sim": "hook-test-1",
  "goal": "Which opening makes a stranger stay",
  "platform": "TikTok",
  "language": "vi",
  "subjects": [
    {"id": "a", "label": "Cut A", "account": "LoHi Truyện", "file": "a.md"},
    {"id": "b", "label": "Cut B", "account": "LoHi Truyện", "content": "…"}
  ],
  "context": "vi-short-video",
  "audience": {"n": 48, "age": [18, 40], "zone": "Đô Thị", "match": "truyện|phim"},
  "rounds": 4,
  "feed_size": 4,
  "questions": [{"id": "retell", "type": "text", "ask": "…"}],
  "experts": [{"id": "editor", "lens": "Short-video editor: the first three seconds, pacing, on-screen text"}]
}
```

Only `sim`, `goal` and `subjects` are required. `context` is a shipped feed name (`feeds/`) or a list of `{account, content}`; give your own for another platform or market, because the context posts are the scale the subject is read against. `audience` filters by `age`, `sex`, `zone`, `region` and `match`; `cap: true` takes the whole filtered pool when it is smaller than `n`. `audience.library` names a file in `personas/` or an absolute path (see [personas/NOTICE.md](personas/NOTICE.md)). Question types are `scale` (1–5), `yesno`, `tags` and `text`; without `questions` the pack asks retell, clarity, intent, objections and why. `metric` (`full`, `stopped`, `depth`, `like`, `share` or `comment`; default `full`) is what the A/B comparison and the rank in the feed are decided on; use `depth` where few people finish, such as short video. A subject is at most 12,000 characters.

## Driver

```sh
node tools/driver.mjs populate brief.json --workspace ./sim   # add missing persona Soots; when "added" > 0: stop the runtime, `soot migrate adopt`, start it
node tools/driver.mjs run brief.json --workspace ./sim --out ./runs [--parallel 8] [--no-report]
node tools/driver.mjs tally hook-test-1 --workspace ./sim [--by age|zone|sex]
node tools/driver.mjs ask hook-test-1 "Ngô Ngọc Nhi" question.txt --workspace ./sim
node tools/driver.mjs sims --workspace ./sim
```

`run` needs the workspace's runtime serving (`soot serve`). It is resumable: run it again with the same brief and it continues from the recorded round. Persona Soots persist in the workspace and are reused by later simulations; each simulation gives a persona a fresh conversation.

## Tools

| Who | Selection | Tools |
| --- | --- | --- |
| persona Soot | `micro-fish:tools=timeline,act,answer` | open the feed, record behaviour, answer the interview |
| expert | `micro-fish:tools=brief,expert` | read the subjects, record findings |
| analyst | `micro-fish:read` | `tally`, `status`, `profile`, `brief` |

A persona is identified by the host (`call.soot`), never by an input field, so one persona cannot act as another.

## State and limits

Simulations live in `SOOT_PACK_STATE/sims/<sim>.json`, shared by the whole workspace. Records are replaced atomically; parallel persona writes wait on a short per-simulation lock, and a lock older than a minute is treated as abandoned.

Limits: 1000 personas, 4 subjects, 60 context posts, 48 rounds, feeds of up to 8 posts, 8 interview questions, 16 MiB per simulation. Tool results stay inside the host's 32 KiB preview.

## Test

Tests run from a Soot Forge checkout; release archives omit them.

```sh
node --test packs/micro-fish/tests/*.test.mjs
```
