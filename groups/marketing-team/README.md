# Marketing team

Ask Kamaji in Nest for a marketing team. Kamaji reads this template, asks for
what it needs one question at a time — the product, the readers, the goal, the
blog's hub site, the channels, the voice and the languages — and offers its
budget profiles. You approve once; Kamaji builds the team, writes the brief into
the team's memory and sets its cycles. **Hoàn tác** removes it all.

| member | does | capabilities |
| --- | --- | --- |
| Kamaji (lead) | runs the cycles, hands out tasks, reports once in the team thread | its own `soot-nest` playbooks |
| Radar | watches the sources the audience reads, keeps the `signals` table | `marketing/radar`, `research/web` |
| Writer | turns signals into article and social drafts; never publishes | `marketing/write`, `writing/article`, `writing/copy` |
| Editor | reviews, publishes what passes, hands off what a person must post, measures | `marketing/write`, `edit`, `publish`, `measure` |

**Cycles** (run as Kamaji): *Chu kỳ sáng* 08:00 plans the day from the signals
and the goal; *Duyệt chiều* 16:00 reviews and publishes; *Tổng kết tuần* reads
`content_stats`, keeps lessons and proposes one change. The *Tiết kiệm*
profile runs the morning cycle and the weekly review only.

**Budgets** are daily token caps per member, enforced by the host. Nest shows
the daily and monthly totals; it says when the cost cannot be estimated and
never invents a price. Raising a budget later asks you again.

**Work you can follow.** Every piece of work is a task (Việc), drafts and
signals are rows in the team tables `content` and `signals`, and the brief,
voice rules and lessons are team memory (Dữ liệu › Trí nhớ). Nothing goes live
without an editor's review task. TikTok, a channel without credentials and any
real decision come to you in **Cần bạn**.

## Set up after Kamaji builds it

The template carries no credentials and grants nothing. Each member needs a
`MARKETING_HUB` connection (Cài đặt → Kết nối) to a marketing hub client for
this product — the writer's and radar's without the publish right, the
editor's with it. Kamaji leaves one task per missing piece. See the
[marketing pack](../../packs/marketing/README.md) for the hub contract.

Whether each publish waits for your approval is your approval policy; the
template does not relax it.

## Without Nest

```sh
soot group add ./marketing-team-group_VERSION.tar.gz --sha256 CHECKSUM
soot group inspect groups.d/marketing-team
```

Source templates use zero placeholder digests; only the release build pins the
real pack archives. Never install the source JSON as a verified release.

For a team that lives in your own repository (git-reviewed, with product packs),
start from [examples/marketing-team](../../examples/marketing-team/README.md).
