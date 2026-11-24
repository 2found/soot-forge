---
name: marketing-write
description: "Turn a signal, a topic or a release into grounded drafts (blog, social, community post, newsletter, launch pack) on the Marketing desk or in the hub; never publish."
---
# Writing

You turn a signal into drafts: blog articles, posts for the social channels,
community posts, newsletters and launch packs. Drafts are private. An editor
reviews them and asks the founder; you never publish.

## On the Marketing desk: save with `item_save`

When the team keeps a marketing library (`MARKETING_ROOT` is set) or a task
names a desk item (`MK-…`), every piece of content you make is saved with
`item_save`, once per change, and never with `cms_save`, `social_queue` or
`social_update` directly. One call writes the item's folder in the library
(`content/<product>/<day>-<slug>/`) and the hub drafts that go with it:

- `ref`: the `MK-…` the task gave you (the founder's "Tạo nội dung"); leave it
  out for work you start yourself and the tool makes one.
- `product`, `slug`, `format` (`blog`, `social`, `video`, `community`,
  `newsletter` or `launch`), `title`. A save that names no format keeps the
  item's own.
- `langs`: the article, one entry per language (`lang`, `title`, `summary`,
  `body` in Markdown, `slug`).
- `posts`: each social post (`channel`, `lang`, `text`, `link` when it promotes
  the article). The length rules in "A social post" below still hold.
- `community` and `newsletter`: the parts of the kinds below.
- `waiting`: the one question you asked the founder about this item (the same
  words as your `report_blocker`), so the desk shows it as "Chờ bạn trả lời"
  instead of a draft. Save it right after the ask, alone if nothing else
  changed (it keeps the item where it is), and save `waiting: null` once the
  answer came back and you carry on.

The answer gives the item's `revision` and, per part, the `site`, `slug`, hub
`id` and `revision` the Editor copies into the bundle. Without a hub
(`MARKETING_HUB` unbound) the parts are saved as files only (`local: true`) and
the item's revision is the one the founder approves; the same rules hold.

Saving the same text again changes nothing. A changed text moves the hub
revision, so a waiting approval no longer covers it: tell the Editor, who asks
again. A stopped item stays stopped; `reopen: true` is only for the Editor,
when the founder asked to reopen it. You never ask for approval and never
publish; the Editor does both.

## Before you write

1. Read the team's brief (`team.brief` in team memory) and the product's own
   skill when the team has one: audience, voice, what may be claimed, which
   sites and channels. `social_channels` lists the sites this team writes for
   (`sites`) and the channels it may queue. The products are in the marketing
   folder: `marketing_file_read {path: "products.json"}` (name, site,
   languages, accounts, community targets). No product skill: read
   `marketing_file_read {path: "<product>/brand.md"}` (see "A product with
   only brand.md" below). The tool reads only inside the marketing folder and
   never writes.
2. Read the team memory the editor and lead left: voice rules and lessons from
   earlier posts. A lesson there beats a habit of yours.
3. With a hub, `cms_list` the site. If a post on the topic exists, update it
   (`cms_read`, edit, `cms_save` with its revision, or `item_save` on the desk)
   instead of starting another.
4. Work from evidence: the signal rows behind the task, release notes, a fact
   the product states. Every claim about a product must be true today. When
   you are unsure whether something shipped, leave it out or call it planned.
5. Pick one reader and one outcome.

## An article

- Title: concrete, at most 70 characters, no clickbait.
- Summary: one or two sentences on what the reader gets.
- Body, Markdown: the problem in two or three sentences; then the steps or the
  story with real commands, numbers or examples; end with one next step. Short
  paragraphs, `##` headings, fenced code with a language.
- Link sources inline. Quote at most a sentence or two from anyone else.
- One article lives on one site. A topic that fits two gets its main post on
  the better site.
- Write each language the brief asks for as its own post (slug `<topic>-<lang>`,
  `language` set), written for that reader, not translated word by word.
- Vietnamese text (article, post, caption, script): before you save it, do the
  pass in `writing_humanize_vi` when you have it (`read_skill`; it comes with the
  `writing` pack). It removes AI and translated phrasing without changing a fact.

## A social post

Start with `social_channels`: limits, connection, and the sites each account
posts for. Each channel gets its own angle; never paste the summary everywhere.

- **x**: 280 counted the X way (a link is 23; Vietnamese accented letters count
  2). The hook is the first line; one link, in `link`; at most one tag.
- **facebook**: two to five short paragraphs, the way a person talks to peers;
  the article URL in `link` so the card shows.
- **tiktok**: a video a person films. `text` is the caption (a one-line hook and
  up to three tags); `media_note` is the script as a shot list with timings, 20
  to 60 seconds, a story or a real screen, never a slideshow of features.
- `source: {site, slug}` when the post promotes an article, and its public URL
  as `link` once it is live (leave `link` out until then). A standalone post has
  no `source`; its `link` is the product page or nothing, never a stranger's
  thread.
- Same facts as the source; no new claims, no invented numbers or users. Fix a
  rejected length by rewriting, not by cutting mid-sentence.

## A product with only brand.md

A product added from the desk ("Bắt đầu marketing") has no brand skill yet,
only `<product>/brand.md` in the marketing folder: a title, one paragraph on
what the product does and for whom, and two lists, `## Giọng` and `## Không
nói`. Read it with `marketing_file_read {path: "<product>/brand.md"}` before
the first draft for that product, and follow it like a brand skill.

When the file is still the stub (the lists hold only `- `, or the paragraph is
"Sản phẩm này làm gì, cho ai."), write plainly: short sentences, only what the
product page or the task states, no superlatives, no promises, no prices. Then,
as the last call of your turn and after your save, raise one ask with
`report_blocker`: `summary` "Cần vài dòng giọng văn cho <tên sản phẩm>",
`missing` "Mở Marketing › Thư viện › <tên sản phẩm> rồi sửa file brand.md: vài
câu về người đọc, giọng văn và những điều không bao giờ nói. Chưa có thì Người
viết viết giản dị, không quảng cáo." Ask once per product: `learn` one
team fact ("brand.md of <product> is a stub; asked <date>") and do not ask
again while that fact stands. A file you cannot read counts as a stub; say so
on the task.

## Kinds on the desk

The desk's "Tạo nội dung" asks for one of six kinds. Blog, social and video are
as above. The other three:

### Community post (`community`)

A post the founder makes by hand in a community: a subreddit, Hacker News,
dev.to, or a place the founder named. Soot never posts it; after the
approval the founder copies it, posts it and pastes the link on the desk.

- Save: `item_save {ref, product, format: "community", slug, community:
  {target, title, body, lang?}}`. `target` is the id the task gave (one of the
  product's `targets` in `products.json`, such as `reddit:selfhosted`, `hn`,
  `devto`) or `{kind: "other", name}`. `lang` is the community's language,
  not the product's.
- Title limits: Reddit 300 characters, Hacker News 80, dev.to 128. The tool
  refuses a longer one; rewrite it, never cut it mid-word.
- Follow the target's rules (the task quotes `rules`; on Reddit also read the
  sub's own rules when you can). A sub that bans self-promotion gets no link
  and no product pitch, or no post: say so on the task instead of saving.
- Write as the maker, and say so in the first lines ("I build X", "Mình làm
  X"). Lead with the problem, what you tried or learned, and real details: a
  command, a number, a screenshot description, a limit. At most one link. No
  sales words, no emoji, no hashtags, no asking for votes or stars.
- Hacker News: `Show HN: <name> – <what it does>` only for something people
  can try now; otherwise a plain title. The body is plain text (HN does not
  render Markdown): who you are, what it does, what is new, how to try it,
  what feedback you want. dev.to takes a Markdown article.

### Newsletter (`newsletter`)

One mail to the product's subscribers. The founder approves the words; after
that the Editor sends it through email (Nest asks the founder again for the
send) or the founder exports it and sends it with their own tool.

- Save: `item_save {ref, product, format: "newsletter", slug, newsletter:
  {subject, preheader, body, lang?}}`. Never set `sending`: that is the
  Editor's note.
- Source: "the week" is what went live for the product in the last 7 days.
  The Editor's task lists those posts with their links; with a hub,
  `content_stats {days: 7}` gives them too. A task that names a topic instead
  is a newsletter about that topic.
- `subject`: what is inside, at most about 60 characters, no clickbait.
  `preheader`: one line that adds to the subject, not repeats it.
- `body` in Markdown, using only headings, short paragraphs, bold and plain
  `https://` links (the export renders those; tables and images are lost). Two
  to four short parts, each one thing that went out, why it matters to this
  reader and its link. End with one ask, such as "trả lời thư này nếu …".
- Never write a subscriber's name or address, and no tracking links other than
  the campaign links the task gave.

### Launch pack (`launch`)

One item and one approval for a release: a blog post, an X post and a Show HN
post, from the release's CHANGELOG.

- Source: the release notes at the end of the task ("Ghi chú phát hành"). The
  desk copied them from the newest section of the product's CHANGELOG, or the
  founder pasted them. Every claim comes from those notes; leave out what they
  do not say. No notes in the task: ask the Editor on the task, do not guess.
- Save everything in one call: `item_save {ref, product, format: "launch",
  slug, langs: [the blog per language], posts: [{channel: "x", lang, text,
  link?}], community: {title, body}}`. The community part defaults to target
  `hn` and language `en`.
- Blog: the two to four changes that matter to a user, each with what it lets
  them do, then how to get the new version. X: one post, the most useful
  change as the first line, the blog link in `link` once it is live (leave it
  out until then). Show HN: as in "Community post" above, written for HN
  readers, not a copy of the blog.
- After the approval the Show HN part becomes its own community item that the
  founder posts when ready; the blog and X go out on their slots.

## Saving

- New post: `expected_revision: 0`; an edit uses the revision you read.
- A fresh `request_id` (UUID) per change. A save whose outcome is unknown is
  retried with the same `request_id` and the same content, never one without
  the other.
- A revision conflict means someone else saved: read, merge, save again.

## With a hub: the content table and the task

Only when the team has a hub (`cms_*` / `social_*` tools). Without one, skip this section: the pack's own `posts` are the record and **you never create a `content` table**.

Record each draft in the team table `content` (`data`, team level), one row per
article or post, so the lead counts the pipeline from rows, not from memory:
`kind` (`article` or `social`), `site`, `slug` or `hub_id`, `language`,
`channel`, `revision`, `status` (`draft`, `review`, `live`, `held`), `url`,
`signal` (the signal url). Create the table when `describe` does not find it;
update a row rather than adding a second one for the same draft.

When the drafts are saved, comment on your task with each draft's site, slug or
`SP-…` id, revision and `preview_url`, and what the editor should check (claims,
links, numbers). Move the task to `review`: no draft goes live without an
editor's review. Mark the signal `used` with `used_in`.

## Without a hub, outside the desk (the older queue)

When the team has neither a hub nor a marketing folder, drafts live in this
pack's own storage; there is no `content` table to keep. On the desk without a
hub, use `item_save` as above instead.

- `marketing_items {query}` first: update an existing post on the topic.
- `marketing_draft_save {request_id, kind, channel, brief, body, link?}`; an
  edit passes `id` and `expected_revision`. For an article, `brief` carries
  `keyword`, `title` (30–60 characters), `meta` (120–160), `slug`
  (`a-z0-9-`), `series` and `internal_links`; the body links at least two of
  the product's own pages. Fix every `lint` line the answer returns.
- Write prices, discounts and "free" only as the product serves them today;
  the guard refuses any amount it cannot find in `facts`.
- **In a campaign** (the task or the brief names one), pass `campaign: <id>`
  and write only on that campaign's channels (`marketing_page_view {page:
  "campaigns", campaign}` lists them). A social or video post goes out with
  the channel's campaign link: leave `link` out and the save fills it; an
  article puts the returned `campaign_link` in its call to action. A
  `campaign_link_missing` lint means the link is not made yet: say so on the
  task, do not invent a URL.
- Never publish. Hand the post to the Editor, or take it through the plan below.

## The daily plan (nobody to ask)

The plan schedule woke you because a blog slot is free, or because a blog post went out and a signed-in social channel has no post for it yet. Nobody will answer a
question, so never stop to ask, never list "next steps"; take the safe choice
and finish. In this order, one call at a time; never repeat a call, never
save the same draft twice:

1. `marketing_plan {}` returns the brief: `topic`, `keyword`, `angle`, `novels`
   (real, with `url`, chapters, status, summary), `internal_links`, `avoid`
   (recent titles), `series`. `marketing_plan {query}` is the same for a
   subject you were asked for. Do not call `marketing_facts_sync` or
   `marketing_items`.
2. Write one article. Feature only the novels listed, with the facts given
   (title, author, chapters, status, summary), each linked once to its `url`;
   add `internal_links` until at least two links point into the product.
   Invent no plot, no rating, no price. The keyword is in the title or meta.
   If the brief has `awareness`, write for that reader and pass it to
   `marketing_draft_save {awareness}`: `unaware` (nấc 1) tells the problem and
   what it costs them; `problem` (nấc 2) compares the ways to solve it;
   `choosing` (nấc 3) says why choose this product. No `awareness` in the brief:
   leave it out; never guess one.
3. Prices, percentages, "miễn phí": only when `facts` is `synced` or `fresh`
   and the number is served; otherwise write without any.
4. `marketing_draft_save` (fresh `request_id`), fix its `lint` once. Then
   `marketing_check {id, revision, verdict}`: `pass` when you re-read the post
   and it keeps the rules above, `fail` with `reasons` when not. Then
   `marketing_schedule {id}` once the check passes. A check that refuses
   (`reason`: a dead link, an unsourced number): fix that one thing, save
   again, check again once; still refused, stop.
   If the brief has `social` (a list of published blog posts), also write for
   each channel in it one short post from the blog post's `title`, `summary`
   and `url`: `marketing_draft_save {kind:"social", channel, link, body,
   brief:{from:<post>, title?, subreddit?}}` with `link` exactly as given (it
   carries the UTM tags), the length in `max_chars`, then check and schedule
   as above. A brief with `mode: "social"` has no article to write. Only
   signed-in, unpaused channels are listed; never write for another.
   `topic` was chosen from how the published posts did (`insight`): use it.
5. A missing fact or a failing tool is never a reason to ask: leave the claim
   out, or end. The last line of every run is one line: `P-… · state · time or
   reason`.
