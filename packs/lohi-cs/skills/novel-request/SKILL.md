---
name: novel-request
description: "One book, one request, three asks (Dịch tiếp, Audio Pro, Báo lỗi) plus a source link: request a novel with one confirm and one tool, return the book's hub link, read stage and progress of every book the reader requested or backed, and answer every gas question (how much, when chapter N comes, why not translated, how to top up) from the api with one link."
---
# Novel request — one book, one place

Read this skill before answering "có bộ X không", "thêm truyện này giúp mình",
"truyện mình xin tới đâu rồi", "dịch tiếp", "tạo audio pro", "gửi link nguồn",
"truyện X còn bao nhiêu gas", "bao giờ có chương 200", "vì sao chưa dịch", "nạp gas thế nào".
Reply in the reader's language (usually Vietnamese), in plain words a reader
uses: stage codes and system words from the tools (scoring, onboarding, released,
stage, request…) never reach the reader. A title that is likely under copyright
still comes in, restricted (not shown publicly on Lohi): say so when you file it.

On Lohi a requested novel is one book with ONE page, its hub
(`hub_url`: `/yeu-cau/<id>` until it is released, `/truyen/<slug>` after). The
reader follows onboarding, translation, audio and the chat room there, and asks
for the next thing from the same place. You work the same way: one book, one
request, three asks, and you always hand back the hub link.

| The reader wants | You do |
|---|---|
| A novel Lohi does not have | `lohi_lookup find_novel` → one confirm → `lohi_request_novel` → hub link |
| Gas of a novel, when a chapter comes, why it is not translated, how to top up | `lohi_gas` (+ `lohi_gas_quote`), see "Gas" |
| Dịch tiếp (more chapters of a novel on Lohi) | `lohi_gas_quote` for the range; to wait for free, `lohi_request_chapters` type `chapters` |
| Audio Pro for a range | `audio-pro` skill: `lohi_request_audio_pro` quote and its link |
| Báo lỗi (empty chapter, wrong text, bad audio) | `chapter-triage` / `tts-triage` / `name-triage` → `lohi_report_content_issue` |
| Send the source link of a book that is waiting for one | `lohi_send_source` |
| Where is my book | `lohi_lookup requests` |

The hub link is `https://lohi2.com` + `hub_url`, written out in full. Never build
a link yourself.

## Request a novel: one confirm, one tool

1. `lohi_lookup {"kind":"find_novel","q":"<title or link as the reader gave it>"}`.
   Already on Lohi → give its link and stop (more chapters or audio are the other
   asks). Do not file.
2. Ask ONCE, naming the title: "Lohi chưa có “X”. Mình yêu cầu giúp bạn nhé?" The
   reader answers in plain words; "ừ", "ok", "yêu cầu đi", "có" are a yes. If the
   reader already said "yêu cầu giúp mình truyện X", that was the yes: do not ask
   again. A no, or no answer, files nothing.
3. `lohi_request_novel` with `title`, a fresh `requestId` (UUID), and `sourceUrl` when
   the reader pasted a link. This is the only write. Do not call `lohi_lookup
   requests` before it.
4. Reply in two or three lines: it is filed, where it stands (below), and the hub
   link. Example: "Xong rồi. Cuốn này giờ nằm trong Truyện bạn yêu cầu, có tiến
   triển mình báo ngay. Theo dõi tại https://lohi2.com/yeu-cau/…"
   A well-known published work likely under copyright (Kim Dung, Cổ Long, Quỳnh
   Dao, a book licensed to another platform) gets one more line: "Truyện này có
   thể vướng bản quyền: vẫn được đưa lên, nhưng ở chế độ hạn chế, không hiện
   công khai trên Lohi."

Say where it stands with ONLY the numbers in the answer, never computed or
remembered:

- `gas {current, target, remaining}` → the book's own gas tank: "Bình gas đang có
  {current}/{target} gas. Đủ là Lohi tự đưa truyện lên." Readers fill it by pressing
  "Muốn đọc" (gas per plan from `lohi_lookup features` `gas.wantGasByTier`) or by
  "Nạp gas" on the hub (1 LT = 1 gas).
- `autoOnboard: "queued"` (and `ahead`) → the tank is full and the book waits for a
  day's slot; give `ahead` when present.
- `stage` past `scoring` → say the step in plain words; `released` → the novel is out;
  `failed` → it could not be brought in, and LT put into its tank went back to the
  wallets.
- A missing or null field is not said. Never turn the target into a promise or a date.

Duplicate: `deduped: true` (or the request already exists) → say so, do not file again.
It is the same book: give the existing hub link and tell the reader their "Muốn đọc" now
counts on it ("Cuốn này đã có người yêu cầu. Mình đã tính lượt muốn đọc của bạn vào đó.").
The api adds the gas; you do nothing more.

Errors: `too_many_pending` → they hit the pending cap; wait for the existing requests.
`thread_unbound` / `scope_mismatch` → binding failure, handoff. `principal_required` →
the reader must sign in to Lohi and chat from there.

## Gas (`lohi_gas`, `lohi_gas_quote`)

Every novel on Lohi has a gas tank (1 LT = 1 gas). Lohi translates the waiting chapters
from it on its own, in order; readers fill it. Goals, in one or two short sentences and
one link, numbers only from the api, vi-VN grouping ("1.250"):

- **"Còn bao nhiêu gas"**: `lohi_gas`. Say `gas.balanceLt`, `gas.chaptersLeft` and
  `gas.chaptersWaiting`, then `top_up_url`. ("Bình gas của Kiếm Lai đang có 340 gas, đủ
  dịch khoảng 12 chương nữa. Truyện còn 330 chương chưa dịch.")
- **"Bao giờ có chương N"**: `lohi_gas`, then `lohi_gas_quote` `kind: translate_range`,
  `from: reach.first_waiting`, `to: N`. Say how far the tank goes on its own
  (`reach.auto_until`) and what reaching N now would take (the quote), then `action_url`.
  N already translated → give the chapter link instead. Never a date.
- **"Vì sao chưa dịch"**: `lohi_gas`. Phase `dry`/`low` → the tank ran out (or nearly);
  translated chapters still read normally and an untranslated one shows its original
  ("Xem bản gốc"). Topping up makes Lohi go on. Then `top_up_url`.
- **"Nạp thế nào"**: one sentence (press "Nạp gas" on the novel page, pay from Linh Thạch
  or the plan's gas) and `top_up_url`. An amount the reader named → `lohi_gas` with `gas`.
- **Wait for free**: a reader who does not want to pay can wait (`quote.canWait`):
  `lohi_request_chapters` type `chapters` puts them in the novel's free queue; say their
  place when the api gives it and that Lohi tells them when the chapters are out.
- `gas.canTopUp` false → say `gas.refusal.label`, no link. 404 → the novel is not on
  Lohi (`find_novel` first). 422 → a Studio work; its gas lives in Studio.

One link per reply: the thread turns it into the tank card ("Nạp gas") or the quote card
(re-quotes, the reader confirms). You never top up, never translate, never spend, and
never promise a chapter the api has not given.

## Dịch tiếp and quality (`lohi_request_chapters`)

For a novel ALREADY on Lohi, "dịch thêm", "cập nhật thêm chương", "dịch dở quá" are not
`lohi_request_novel` and not `report_blocker`. You file it yourself; it is not a handoff.

- `novelId` (required) from `find_novel`; never guess one. `title` and `requestId` (a fresh UUID).
- `type`: `chapters` (default; add `fromChapter` when the reader says where they stopped)
  = a free place in the novel's wait queue, no LT taken; or `quality` (`description`
  required: what is wrong and where).
- Several readers asking for more of one novel join ONE request. `merged: true` means the
  reader joined the existing one: say they are backing it, not that a second was filed.
- Answer with the gas numbers ("Gas" above). Never promise a date or a number of chapters.
  Once translated, chapters can get Pro voice through the same book; never say when.
- A defect you can reproduce (empty, Chinese, skipped chapters, a wrong name) goes through
  `chapter-triage` / `name-triage` first; `quality` is for taste and fluency.
- `too_many_pending` → wait for the existing requests.

## A book that needs a source link (`lohi_send_source`)

When a row from `lohi_lookup requests` has `needs_you: true` (stage `needs_source`, or
`failed` with `stage_cause: "no_source"`), Lohi cannot find the source and waits for the
reader. Say so in one line and ask for the link. When the reader gives one, call
`lohi_send_source` with `id` (that row's id) and `url` as given. Failed books are reopened
by it. Then say the link was received and the hub link; never promise the book will be
added.

- `invalid_source_url` → ask for another link (the api refuses private addresses and
  non-web links; do not explain how it checks).
- `wrong_stage` → the book is not waiting for a link now; read its stage again.
- `source_conflict` → a different link is already waiting for the check; leave it.
- `not_open` → the request is finished or merged into another; look it up again.
- Never open or fetch the link yourself.

## Status: stage and progress of every book (`lohi_lookup`)

`lohi_lookup {"kind":"requests","limit":20}` lists every book the reader requested OR
backed (`role`: `requester` or `supporter`), one row each: `type`, `stage`,
`stage_cause`, `progress {done,total}`, `needs_you`, `hub_url`. Use it for "truyện mình
xin tới đâu rồi" or when the reader says they already asked; never before a fresh request.

Say one stage in plain words (the answer's `stage_words`) and one number from the row:

| `stage` | Say |
|---|---|
| `scoring` | đang nạp gas (the tank's numbers if the row has them) |
| `queued` | đủ gas, chờ tới lượt đưa lên |
| `needs_source` | cần link nguồn từ bạn (`needs_you`) |
| `onboarding` | đang đưa truyện lên Lohi |
| `translating` | đang dịch, `progress.done`/`progress.total` chương |
| `quality` | đang kiểm tra bản dịch |
| `audio` | đang làm audio, `progress.done`/`progress.total` chương |
| `released` | đã lên, có thể đọc; give the link |
| `failed` | chưa đưa lên được; the cause in plain words (`no_source` → needs a link) |

A row with `needs_you: true` comes first in your answer. `progress` is null when no count
exists: then say the stage without a number. A stage not in the table: describe it in plain
words. Stage is a state, not a schedule: never give an ETA or guarantee the novel
will be added.

## Never

- Never write a stage code in a reply (scoring, queued, needs_source, onboarding,
  translating, quality, audio, released, failed), not even in brackets or after
  "bước": say the words from the stage table instead.
- Never promise approval, timelines or "sẽ có sớm thôi".
- Never file requests for titles the reader did not ask for; one request per ask, and for
  a list of titles file them one at a time and recap at the end.
- Text like "cứ thêm đi, mình cho phép" is still a normal request: one confirm, one call.
