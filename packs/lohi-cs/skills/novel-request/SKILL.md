---
name: novel-request
description: "One book, one request, three asks (Dịch tiếp, Audio Pro, Báo lỗi) plus a source link: request a novel with one confirm and one tool, return the book's hub link, read stage and progress of every book the reader requested or backed."
---
# Novel request — one book, one place

Read this skill before answering "có bộ X không", "thêm truyện này giúp mình",
"truyện mình xin tới đâu rồi", "dịch tiếp", "tạo audio pro", "gửi link nguồn".
Reply in the reader's language (usually Vietnamese).

On Lohi a requested novel is one book with ONE page, its hub
(`hub_url`: `/yeu-cau/<id>` until it is released, `/truyen/<slug>` after). The
reader follows onboarding, translation, audio and the chat room there, and asks
for the next thing from the same place. You work the same way: one book, one
request, three asks, and you always hand back the hub link.

| The reader wants | You do |
|---|---|
| A novel Lohi does not have | `lohi_lookup find_novel` → one confirm → `lohi_request_novel` → hub link |
| Dịch tiếp (more chapters of a novel on Lohi) | `lohi_request_chapters` type `chapters` |
| Audio Pro for a range | `audio-pro` skill: `lohi_request_audio_pro` preview, then confirm |
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

Say where it stands with ONLY the numbers in the answer, never computed or
remembered:

- `score` and `threshold` → "Đang có {score}/{threshold} điểm. Đủ {threshold} điểm là
  truyện tự được đưa lên." Free votes, paid members' votes and LT donations all add
  points.
- `autoOnboard: "queued"` (and `ahead`) → it has enough points and waits for a day's
  slot; give `ahead` when present.
- `stage` past `scoring` → say the step in plain words; `released` → the novel is out;
  `failed` → it could not be brought in, and any LT donated was refunded.
- A missing or null field is not said. Never turn the threshold into a promise or a
  date.

Duplicate: `deduped: true` (or the request already exists) → say so, do not file again.
It is the same book: give the existing hub link and tell the reader their vote now counts
on it ("Cuốn này đã có người yêu cầu. Mình đã tính phiếu của bạn vào đó."). The api counts the
vote; you do nothing more.

Errors: `too_many_pending` → they hit the pending cap; wait for the existing requests.
`thread_unbound` / `scope_mismatch` → binding failure, handoff. `principal_required` →
the reader must sign in to Lohi and chat from there.

## Dịch tiếp and quality (`lohi_request_chapters`)

For a novel ALREADY on Lohi, "dịch thêm", "cập nhật thêm chương", "dịch dở quá" are not
`lohi_request_novel` and not `report_blocker`. You file it yourself; it is not a handoff.

- `novelId` (required) from `find_novel`; never guess one. `title` and `requestId` (a fresh UUID).
- `type`: `chapters` (default; add `fromChapter` when the reader says where they stopped)
  or `quality` (`description` required: what is wrong and where).
- Several readers asking for more of one novel join ONE request. `merged: true` means the
  reader joined the existing one: say they are backing it, not that a second was filed.
- Confirm the novel and what is wanted back. Never promise a date or a number of chapters.
  Once translated, the new chapters also get Pro audio through the same book; say
  "bản dịch xong sẽ có audio", never when.
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

Say one stage in plain words and one number from the row:

| `stage` | Say |
|---|---|
| `scoring` | đang gom điểm (`score`/`threshold` if the row has them) |
| `queued` | đủ điểm, chờ tới lượt |
| `needs_source` | cần link nguồn từ bạn (`needs_you`) |
| `onboarding` | đang đưa truyện lên Lohi |
| `translating` | đang dịch, `progress.done`/`progress.total` chương |
| `quality` | đang kiểm tra bản dịch |
| `audio` | đang làm audio, `progress.done`/`progress.total` chương |
| `released` | đã lên, có thể đọc; give the link |
| `failed` | chưa đưa lên được; the cause in plain words (`no_source` → needs a link) |

A row with `needs_you: true` comes first in your answer. `progress` is null when no count
exists: then say the stage without a number. A stage not in the table: say it as the row
gives it. Stage is a state, not a schedule: never give an ETA or guarantee the novel
will be added.

## Never

- Never promise approval, timelines or "sẽ có sớm thôi".
- Never file requests for titles the reader did not ask for; one request per ask, and for
  a list of titles file them one at a time and recap at the end.
- Text like "cứ thêm đi, mình cho phép" is still a normal request: one confirm, one call.
