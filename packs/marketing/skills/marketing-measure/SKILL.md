---
name: marketing-measure
description: "Read what the team shipped and what it led to, and keep the lessons in team memory."
---
# Measuring

You read what the team shipped and what it led to, and turn it into lessons the
next cycle uses.

## What you can count

- `content_stats {days}` (all of this team's sites, or one `site`): articles
  that went live with their URLs, drafts in progress, and social posts
  published by channel. It counts what went out, not who read it: `visits` is
  always `null`. Never report a reach, view or click number the hub did not
  give you.
- Reader numbers come only from a tool the team was given for its product (for
  example a product data pack). Without one, say that reader numbers are not
  connected.
- With a hub, the `content` and `signals` tables count the pipeline (without one, `marketing_items` and `marketing_report` do): `query` with
  `group_by status` for drafts in review, held items, signals unused.

## A review

1. Compare what went out with the goal in `team.brief` and with last period's
   numbers in team memory.
2. Name what worked and what did not, each with the rows or URLs behind it.
3. `learn` at most three lessons in team memory, one fact each (what to repeat
   or stop, and the evidence). Update an earlier lesson instead of adding a
   near-copy. Save this period's counts as one fact so the next review compares
   against it.
4. Report in a few lines: shipped, waiting, the lessons, and the one change you
   propose for the next period. A change to the budget, the schedule or the
   team is the person's decision: propose it, do not make it.

## Without a hub

`marketing_seo_brief` gives the published posts' 14-day Search Console
numbers and the queries worth a post. A post with `null` numbers has not been
read yet: say "no data yet", never 0. Search Console data comes from the
daily `marketing_gsc_sync` schedule; a `needs_person` answer means the Google
sign-in must be renewed in Nest.

## On the Marketing desk: Tuần này và tuần sau

Hôm nay's learning block (`page_view {view: "today"}`, `learn`) is built from
the same inputs: Search Console rows (`gsc_sync`), campaign clicks
(`campaign_report`) and the plan's next topic. Read it before a review:
`top` are the week's best posts by clicks, `queries` the searches worth a post
(`covered: false` means no item answers it yet), `next` what the plan writes
next. `inputs` names what is missing, at most two, most useful first:

| code | means | what you do |
|---|---|---|
| `gsc_not_connected` | nobody signed Google in for Search Console | nothing by yourself; the desk offers the founder "Nhờ Biên tập nối" |
| `gsc_sign_in` | the sign-in expired or was revoked | Nest already shows "Đăng nhập Google lại" in Cần bạn; point to it, do not raise another |
| `gsc_stale` | no successful read for 3 days | check that the daily `gsc_sync` schedule runs; say so in the review |
| `no_signals` | neither Search Console nor campaign clicks have numbers | say "chưa có số liệu người đọc", never 0 |
| `video_links` | posted TikTok videos have no link yet | the founder pastes them on the desk; mention the count once |

When the desk asks "Nối Search Console cho các trang blog của bàn Marketing
(gsc_sync), rồi cho tôi biết cần làm gì." (request id `ask-gsc-connect`), call
`gsc_sync {site, days: 3}` once for each product's Search Console property
(`sc-domain:<domain>` of its site). Then answer in one or two plain lines:
read (how many rows), skipped because Google was never signed in (the founder
signs in once with the account that owns the property; end the line with
`nest://settings/setup?key=GSC_GOOGLE`, which Nest turns into the Đăng nhập
Google button, never a path written in words), `needs_person` (the sign-in card is in Cần bạn) or
`no_access` (that Google account cannot read the property: add it as a user in
Search Console). Keep the daily `gsc_sync` schedule; one read does not keep the
numbers fresh.

## Campaigns

A campaign (`marketing_campaign_save {name, goal{metric,target}, channels,
starts, ends, token_budget}`, or the Chiến dịch page) has one UTM short link
per channel, made through the product api with the operator's
`PRODUCT_AGENT_KEY`. Saving it again fills a link that failed.

When `marketing_campaign_report` wakes you (a daily schedule):

1. Record each item of `outcomes` with the host `outcome` tool exactly as
   given (`{id: "lead", count, ref}`): it is the new attributed signups since
   the last read, given once. Never record a lead the report did not give.
2. For each id in `tokens_due`, read the outcomes report since the campaign's
   `starts` and sum the cost shares of this team's Soots; call
   `marketing_campaign_report {id, tokens_used}`. Record any `outcomes` it
   returns too.
3. Each `tell` item goes to the person as is, once. Nothing stops at 80 %:
   spending more or stopping the campaign is the person's decision.
4. A campaign whose read failed (`ok: false`) keeps the numbers Soot has;
   say "chưa đọc được", never 0.

