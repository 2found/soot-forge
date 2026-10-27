# Micro Fish

Run a simulated society on the thing you need to decide about: a feature, a product, a price, a video, an ad or a campaign. A population of personas reacts to it alone first, then again after reading what the others posted; an expert panel reviews it independently; deterministic statistics turn the records into a report. Node.js 22+ is required. Installing runs no scripts and grants nothing.

Use the [Simulated society template](../../groups/society-sim/README.md) to create the moderator, population architect, crowd, expert panel and analyst. The pack works with any Soot that is granted its capabilities; the template is the tested shape.

## Method

Inspired by multi-agent social simulations such as MiroFish/OASIS, scaled down to what a Soot team can run in one conversation:

1. **Brief** — the decision, the real stimulus (up to 4 variants for A/B), markets and questions.
2. **Population** — personas with segment, market, income, habits, prior stance, skepticism and influence; at least a quarter are people who would say no.
3. **Round 0** — independent first impressions, no feed, stimulus order randomised per persona.
4. **Social rounds** — each persona sees a seeded feed of posts from its own corner (same segment and market, louder authors and widely cited posts weigh more) and may change its mind, citing the posts that moved it.
5. **Expert panel** — independent reviews with a GO / ITERATE / NO_GO verdict and P0–P3 findings; experts never see the crowd.
6. **Tally and report** — per-round scores, top-2 rates with 95% intervals, opinion shift, A/B preference, segment and market breakdowns, objections, quotes, influential posts and warnings for small samples, uniform crowds and positive skew.
7. **Interview** — ask any persona why, in character, from its recorded history.

Every number comes from `micro-fish_tally`; the model never computes statistics. A simulation shows direction, objections and wording problems, never a market forecast.

## Capabilities

| Capability | Skills | Tools |
| --- | --- | --- |
| `coordinate` | micro-fish-coordinate, micro-fish-product, micro-fish-media | `create`, `stimulus`, `plan_round` |
| `populate` | micro-fish-populate | `add_personas` |
| `crowd` | micro-fish-crowd | `react` |
| `panel` | micro-fish-expert | `expert` |
| `analyze` | micro-fish-analyze | `tally` |
| `records` | — | `status`, `packet`, `profile` |

## State and limits

Simulations live under `SOOT_PACK_STATE/worlds/<scope>/`, where the scope is derived from the root Soot and the conversation: every member of a delegated run shares the world, other conversations cannot see it. Records are replaced atomically; parallel crowd writes wait on a short per-simulation lock, and a lock older than a minute (longer than any tool timeout) is treated as abandoned.

Limits keep every call inside the host's 16 KiB tool input and 32 KiB preview: 200 personas, 4 stimuli of up to 3000 characters, rounds 0–4, feeds of up to 8 posts, 10 personas per `add_personas`, 6 reactions per `react`, 12 personas per `packet`, 4 MiB per simulation.

## Test

Tests and QA scripts run from a Soot Forge checkout; release archives omit them.

```sh
node --test packs/micro-fish/tests/world.test.mjs
```
