# Lohi's marketing workspace

A local Soot workspace that writes, checks and publishes Lohi's blog with no
marketing hub. Three Soots share the [marketing pack](../../packs/marketing/README.md)'s
own storage. The [Lohi blog publisher](packs/lohi-blog/README.md), a local pack that
ships with this recipe, puts posts on `blog.lohi2.com`.

```text
Radar ─▶ angle ─▶ Writer: marketing_draft_save ─▶ Editor: marketing_check ─▶ marketing_schedule
every 10 m  marketing_due ──(notify)──▶ Editor: marketing_claim ─▶ lohi-blog_publish ─▶ marketing_record
06:00       marketing_gsc_sync  (zero model calls; a revoked sign-in is one host Cần bạn item)
05:30       marketing_facts_sync (prices and offers the guard checks against)
```

| file | what it is |
| --- | --- |
| `deployment.example.json` | product `Lohi`, the three Soots, pack grants, the three schedules, `approvals: {"marketing_claim": "auto"}` |
| `soots/lohi-*.json` | Radar (`lite`), Writer and Editor (`flash`), each with a small daily token budget |
| `soots/*.md` | the shared soul and each role's mission |
| `packs/lohi-blog/` | the Lohi-only blog publisher, a local pack: it is not in the Forge catalog |

## Decisions in this recipe

- **No publish approval.** Lohi's founder asked for posts to go out
  without a click. The pack keeps `marketing_claim` behind an operator
  approval. This host alone sets it to `auto`. Every guard still runs inside
  the claim: facts, personal data, platform rules, duplicates, the Editor's
  verdict on that exact content, pause, caps, spacing and quiet hours. A model
  cannot skip them.
- **One channel, `blog-lohi`.** One post a day, at least 20 hours apart, never
  between 23:00 and 07:00 Asia/Ho_Chi_Minh. The tools create the channel with
  these defaults the first time it is used.
- **Lean budgets.** No Soot runs on `pro`. Schedules run tools without a model
  and wake the Editor only when a post is due or a person is needed.

## Set it up

1. Install the Forge packs `marketing`, `research` and `writing` into this
   folder's `packs/` (`soot add 2found/soot-forge/packs/<id>`). `lohi-blog`
   is already there: it is Lohi's own publisher, kept out of the Forge
   catalog. Grant it with `soot grant lohi-blog`.
2. Export one random claim key. Both packs read it, so claims are signed and
   checked with the same value:
   `export LOHI_MARKETING_CLAIM_KEY=$(openssl rand -hex 32)`.
3. Set `LOHI_REPO` to a clone of the kiem-lai repository whose `origin` the
   machine can push to over SSH. The publisher keeps its own clean worktree
   under the pack's state directory and never touches yours.
   `LOHI_BLOG_URL` is optional; it defaults to `https://blog.lohi2.com`.
4. Sign in to Google from Nest for Search Console (`GSC_GOOGLE`). Until the
   first read, the Bài viết page shows "Chưa có số liệu", never 0.

To stop publishing, choose **Tạm dừng mọi kênh** on the Hàng đợi page, or call
`marketing_pause {paused: true}`. Writing and checking go on. To take a post
down, choose **Gỡ bài** on the Bài viết page. Removal goes through the same
claim and leaves one commit on the blog's history.
