# Set up a company from a template

Load this when the person asks you, the Lead, to set up a whole company or business
("dựng công ty bán hàng", "lập công ty nội dung", "dựng một SaaS", "dựng vòng công
ty"). A company here is: the **products** it sells, the **teams** that work on
them (each built from a group template), the **schedules** that keep them going
and **who may read what**. The templates below are data: follow them, do not
invent teams, Soots, souls or missions a template covers.

You only use the settings actions you already have (`manage`, `manage_gated`;
see the nest-manage skill for each action's input). There is no other endpoint.

You are the person's assistant, not part of the company you set up: never add
yourself to a team, never put a schedule on yourself, never make a team hand work
to you. Each team works through its own **Đầu mối** (the Soot the group
template makes its entry, or the member the person chooses when the template
has `asks_coordinator`; ask once per such team, in step 2's turns).

## The flow

1. **Pick the template.** Match the request to one template below. If two fit,
   name both in one line and ask which. If none fits, say so and offer the
   closest one or a single team (the nest-manage "Build a team" flow).
2. **Ask at most two questions, one per turn.** Only what the template marks
   `ask` and the conversation does not already say (usually the product's name
   and its website or what it sells). Never ask about budgets.
3. **Read before you propose.** `read` (revision, Soots, teams, products,
   schedules, access) and `templates.list` (which group templates this Nest has;
   `forge` `unavailable` means only local ones). A team the template names that
   the Nest cannot build is left out of the plan and said in one line. A product,
   team or schedule that already exists is reused, never duplicated.
4. **Propose once, in chat, and wait.** One short message: the products; each
   team with its members and packs (from `templates.list`); the schedules in
   plain Vietnamese ("Thứ 2–6 lúc 09:00"); who reads what; and the token note:
   each team's template profile and its `daily_tokens`, "chi phí tiền không ước
   tính được ở đây". End with: "Đồng ý thì mình bắt đầu; tạo nhóm cần bạn duyệt
   trong Cần bạn." Call no change before the person agrees.
5. **After consent, in this order:**
   1. `company.product.save` for each new product.
   2. `group.create` for each team, straight to `manage_gated` (one approval
      card per team in **Cần bạn**), with `{template, name, title, profile, brief}`
      and `coordinator` for a template with `asks_coordinator`; profile is the template's first (`lean`) unless the person chose.
   3. Say in one line what waits in Cần bạn, then stop. Continue when a team
      exists (the person approved it): read again, then
   4. `group.products` to point each created team at its product;
   5. `schedule.save` for each schedule the template lists **that the group
      template does not already ship** (read the team's schedules first);
   6. `access.grant` for each grant: read-only to internal teams is yours;
      `write`, or anything reaching a team that answers customers on a website,
      goes to `manage_gated`.
6. **Report once** with the links (`nest://team/<id>` for each team,
   `nest://schedules`) and Hoàn tác for what you changed yourself. Name what is
   still waiting in Cần bạn and any setup gap a template names (a key, a channel).

Never set or raise a budget here (`budget.save` is not part of a template), never
delete anything, and never start an adapter or connect a bot: a bot token is the
person's, on the team's Kênh tab (`nest://team/<team>/kenh`).

## Templates

Schedules use `timezone` "Asia/Ho_Chi_Minh" unless the person's differs. A
weekday schedule is `cron` (`0 9 * * 1-5` is Thứ 2–6 lúc 09:00); a daily one is
`every: "24h"` with `at`.

### ban-hang — Bán hàng online

For a shop that sells products online.
- ask: the shop's name (product name) and its website.
- product: `{id: <slug of the name>, name: <name>}`.
- teams:
  - `marketing-team` — name "Marketing"; brief: product = the shop and its site,
    goal = "tăng khách mới từ nội dung".
  - `support-team` — name "CSKH"; answers visitors from the product facts.
  - `team-op` — name "Vận hành" (only when the person mentions stock, orders or a
    catalog); brief: the one job (danh mục, kho).
- schedules: Marketing "Viết bài buổi sáng" Thứ 2–6 lúc 09:00 (on the team's Đầu mối,
  text: "Lên bài cho hôm nay từ chủ đề đã duyệt, đưa bài cần duyệt vào
  Cần bạn").
- access: Marketing reads CSKH's tables (`team:<marketing>` → `team:<cskh>`,
  kinds `["data"]`, read) so posts answer what customers ask.

### noi-dung — Nội dung

For a creator, a blog or a media page that lives on content.
- ask: the brand's name and its main channel (site, YouTube, Facebook…).
- product: the brand.
- teams: `marketing-team` — name "Nội dung"; `team-insight` — name "Insight"
  (weekly numbers and market radar).
- schedules: Nội dung "Lên lịch bài" Thứ 2–6 lúc 08:30; Insight "Tổng kết tuần"
  `cron` `0 17 * * 5` (Thứ 6 lúc 17:00, text: "Viết bản tổng kết tuần: bài nào
  hiệu quả, chủ đề nên làm tiếp").
- access: Nội dung reads Insight (`kinds ["data"]`, read).

### saas — SaaS

For a software product sold by subscription.
- ask: the product's name and its website.
- product: the SaaS.
- teams: `team-insight` — "Insight" (runs the company's weekly review);
  `team-marketing` — "Marketing"; `support-team` — "CSKH";
  `team-financial` — "Tài chính" (read-only revenue and cost).
- schedules: Insight "Đánh giá tuần" `cron` `0 9 * * 1` (Thứ 2 lúc 09:00);
  Tài chính "Báo cáo doanh thu" mỗi ngày lúc 18:00 (`every 24h`, `at 18:00`).
- access: Insight reads Marketing, CSKH and Tài chính (`kinds ["data"]`, read);
  Marketing reads Insight.

### vong-cong-ty — Vòng công ty (không có bước xây dựng)

The company loop (pack `company-loop`, the Công ty page) without the build
stage: an opportunity that gets "Go" becomes a recorded task (Việc đã ghi), not
code. Use it when the person wants the whole loop "tìm cơ hội → quyết định → đo
kết quả" for one product.
- ask: the product's name.
- product: the product.
- teams: `team-insight` — "Insight" (finds opportunities, runs the weekly
  review), `team-marketing` — "Marketing", `team-financial` — "Tài chính";
  `team-op` — "Vận hành" only when the person names an operations job.
- packs: Insight's Đầu mối selects `company-loop` (`soot.save` `changes.packs`:
  its current packs plus `company-loop`) so the Công ty page has its tables. Do
  not set `PRODUCT_REPO`: without it a Go stays a task, which is this template.
- schedules: Insight "Đánh giá tuần" `cron` `0 9 * * 1`; the group templates ship
  the rest.
- access: Marketing and Tài chính read Insight (`kinds ["data"]`, read); Insight
  reads both.
