# Marketing

The know-how and the tools of a marketing team that researches, writes, reviews,
publishes and learns for one product. It is product-neutral: what the product
is, who it is for and how it sounds come from the team's brief (`team.brief` in
team memory, asked by Kamaji when it builds the team) and from a product's own
skill, never from this pack. Installing it grants nothing.

| skill | for | tools |
| --- | --- | --- |
| `marketing-radar` | the Soot that watches sources | `radar_feeds`, `radar_scan`, `radar_items`, `radar_mark` |
| `marketing-write` | writers | `cms_list`, `cms_read`, `cms_save`, `social_channels`, `social_queue`, `social_list`, `social_update` |
| `marketing-edit` | the editor (a skill: review, voice rules) | — |
| `marketing-publish` | the editor, or a publisher | `cms_publish`, `social_publish`, `social_record` |
| `marketing-measure` | the editor or the lead's review | `content_stats` |

A Soot selects the pack whole (`"packs": ["marketing"]`); `"marketing:read"` gives all skills and only the read-mode tools (`radar_feeds`, `radar_items`, `cms_list`, `cms_read`, `social_channels`, `social_list`, `content_stats`). The roles in the table are separated by each Soot's mission and by the hub token, not by selecting parts of the pack.

The [Marketing team](../../groups/marketing-team/README.md) template puts these
together: Kamaji leads, a radar, a writer and an editor work on tasks, keep
shared records in the team tables `signals` and `content`, and keep the brief,
voice rules and lessons in team memory. Nothing goes live without an editor's
review task.

## The hub

Every tool forwards its call, unchanged, with `soot tool-forward --binding-env
MARKETING_HUB` to a marketing hub service: a CMS for each product's blog, a
social queue with platform adapters, a radar of sources and the publish log.
The contract is public: each tool's name, parameters and read/write mode are in
[`pack.json`](pack.json), and the hub receives exactly those calls. 2found runs
its own hub privately; any service that answers the same `soot/v1` tool calls
works.

`MARKETING_HUB` is an operator credential declared in `pack.json` `needs`: enter it per Soot in Nest (Cài đặt → Kết nối) as
`{"service_url": "https://…/api/hub", "service_token": "…"}`. The token is the
hub's client for this team: the hub decides which sites it writes for, which
channels it queues and whether it may publish, so a writer's token cannot
publish and one team cannot touch another product's posts. Tokens never go
through chat and never ship in a template.

## Publishing

`cms_publish` and `social_publish` are public. Whether a person approves each
one first is the host's approval policy: the pack and the template never relax
it. The hub refuses a call that cannot go out (a moved revision, text that is not
the draft, a channel without credentials, an account that posts only for another
product, TikTok) and posts nothing; the publisher then hands the post to a
person in **Cần bạn**. An uncertain post is never published again.

`content_stats` counts what went out — articles, drafts, social posts by
channel — and never who read it (`visits` is `null`). Reader numbers come from a
product's own data pack when it has one.

Tests: `node --test packs/marketing/tests/*.test.mjs` (no network, no posts).
