# Marketing team

Ask the Lead in Nest for a marketing team. The Lead reads this template, asks for
what it needs one question at a time — the product, the readers, the goal, the
blog, the channels, the voice, the languages and whether each publish waits for
you (`publish_approval`, default `required`) — and offers its budget
profiles, then asks which member is the team's **Đầu mối** (the template
leaves that to you; the Editor is the usual choice). You approve once; the Lead
builds the team, writes the brief into the team's memory and sets its cycles. **Hoàn tác** removes it all.

| member | does | packs |
| --- | --- | --- |

| Radar | watches the sources the audience reads, keeps the `signals` table | `marketing`, `research` |
| Writer | saves article and social drafts with `marketing_draft_save`; never publishes | `marketing`, `writing` |
| Editor | checks (`marketing_check`), schedules what passes, publishes through `marketing_claim`, measures and runs campaigns | `marketing` |

The **Đầu mối** (the member you chose) takes the team's messages and bots,
runs the cycles, hands out tasks and reports once in the team thread. The Lead,
your assistant, is not in the team.

**Cycles** (run as the Đầu mối): *Chu kỳ sáng* 08:00 plans the day from the signals
and the goal; *Duyệt chiều* 16:00 reviews and publishes; *Tổng kết tuần* reads
the pack's published posts and Search Console numbers, keeps lessons and
proposes one change. The *Tiết kiệm*
profile runs the morning cycle and the weekly review only.

**Budgets** are daily token caps per member, enforced by the host. Nest shows
the daily and monthly totals; it says when the cost cannot be estimated and
never invents a price. Raising a budget later asks you again.

**Work you can follow.** Every piece of work is a task (Việc), drafts and
drafts are the marketing pack's `posts` (no second `content` table) and signals its `signals` table, and the brief,
voice rules and lessons are team memory (Dữ liệu › Trí nhớ). Posts, the queue
and campaigns live in the marketing pack's own storage, on its **Bài viết**,
**Hàng đợi** and **Chiến dịch** pages; there is no marketing hub. Nothing goes
live without the editor's `marketing_check` verdict on that exact content. TikTok, a channel without credentials and any
real decision come to you in **Cần bạn**.

## Set up after the Lead builds it

The template carries no credentials and grants nothing. The editor needs a
`MARKETING_CLAIM_KEY` connection (Cài đặt → Kết nối) that signs each publish
claim, and optionally `PRODUCT_ADMIN_KEY` so campaigns get short links and
signup numbers from the product's api (its address is the `PRODUCT_API_URL`
env the host grants the pack). The Lead leaves one task per missing piece. See
the [marketing pack](../../packs/marketing/README.md) for the publishing
contract.

**Publish approval.** `marketing_claim` asks for an operator approval on every
publish, and the template never relaxes it: `publish_approval` defaults to
`required`. Only an answer of `none` sets the host's approval policy to
`{"marketing_claim": "auto"}`; the guard (facts, personal data, channel rules,
duplicates, pause, caps, spacing, quiet hours) still runs inside every claim.

## Without Nest

```sh
soot group add ./marketing-team-group_VERSION.tar.gz --sha256 CHECKSUM
soot group inspect groups.d/marketing-team
```

Source templates use zero placeholder digests; only the release build pins the
real pack archives. Never install the source JSON as a verified release.

**Why it stays three roles.** A group schedule is a text task for the team's Đầu mối and cannot carry tool-only chains, so this template keeps the classic radar / writer / editor flow and only leans its budgets (Radar on lite, Writer on flash). The job-split team (Ops, Writer, Analyst, Radar) is the [company team](../company-team/README.md).

For a team that lives in your own repository (git-reviewed, with product packs),
start from [examples/marketing-team](../../examples/marketing-team/README.md).
