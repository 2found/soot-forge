# Nest links

In a reply, a `nest://` Markdown link sends the person to the right place in
Nest: a collection or a document in the data pool, a Soot, a team, a page, a
piece of work drafted for them, a drafted Soot, team or schedule, or a drafted
change to a Soot or to Phê duyệt công cụ. The people reading are often not technical, so
a link beats directions like "open Dữ liệu, then choose Bảng giá".

A link names *what*, never *where*: Nest resolves it on the server of the
conversation the reply belongs to. Opening a link never sends a message, changes
a setting or grants access. A draft waits in the composer until the person sends
it, a drafted Soot, team or schedule waits in its wizard until the person
presses Tạo, and a drafted change waits until they press Lưu, so a link cannot
do on their behalf what you could not. When you can make the change yourself
with `manage`, do that and link the result; a draft is for when the person
wants to see it first (`nest-lead`).

| Link | Opens |
|---|---|
| `nest://data` | the Dữ liệu page |
| `nest://data/<collection>` | a collection, in a sheet over the current page |
| `nest://data/<collection>/<document>` | a document, in a sheet |
| `nest://soot/<soot>` | a Soot's profile, in a sheet |
| `nest://team/<team>` | a team's page in Đội Soot |
| `nest://schedules/<soot>` | a Soot's Lịch chạy |
| `nest://schedules/nest-morning-brief` | the morning brief's schedule, to turn it off or change the time (the fixed id of the Đầu mối's brief) |
| `nest://overview`, `tasks`, `chat`, `team`, `data`, `reports` | that page; `tasks` (Việc) is every server's work in one list |
| `nest://inbox` | Cần bạn, the queue on Tổng quan |
| `nest://settings` and `/servers`, `/ai`, `/approvals`, `/website`, `/knowledge` | that Settings page |
| `nest://new?soot=<soot>&team=<team>&text=<draft>` | new work with `text` waiting in the composer |
| `nest://new/soot?name=&mission=&packs=a,b` | the Tạo Soot wizard, filled in |
| `nest://new/team?name=&purpose=&members=a,b&lead=a` | the Tạo nhóm wizard, filled in; the lead is a member |
| `nest://new/schedule?soot=&team=&name=&text=&at=HH:MM&every=24h` | a new schedule on that Soot's Lịch chạy, filled in |
| `nest://edit/soot/<soot>?learn=&add=a,b&remove=c` (also `name`, `description`, `mission`, `soul`) | that Soot's editor on Xem lại, showing only what changes |
| `nest://edit/approvals?preset=careful\|balanced\|auto&soot=&ask=a,b&auto=c` | Phê duyệt công cụ, with the tools that would change listed above Lưu |

Use the ids that tools gave you: collection and document ids from the data-pool
tools, Soot and team ids from the roster. Never guess or build an id from a
title. If you do not have the id, link the page instead (`nest://data`). Percent
encode `text` in a draft; it holds at most 4000 characters. Join parameters
with a plain `&`, never `\u0026` or `&amp;`.

For `edit/soot`, `learn` is added to the Soot's Cách làm việc; `name`,
`description`, `mission` and `soul` replace what is there; a field left out stays
as it is. A draft that changes nothing is not a link. When to propose either
`edit/…` link is in `nest-lead`.

For the three `new/…` drafts: `name` holds at most 64 characters, `mission`,
`purpose` and `text` at most 4000; `packs` and `members` take up to 12 ids, and an
unknown id is dropped, never guessed. `at` is a 24-hour time; `every` is a number
with `m`, `h` or `d` (`30m`, `24h`, `7d`); a value Nest cannot read is left for the
person to fill in. A schedule needs `soot`. When to propose one is in
`nest-lead`.

Always write a link's text in the person's words, for example
`[Bảng giá gói Pro 2026](nest://data/bang-gia/pro-2026)`. Nest renders:

- a link inside a sentence as a small chip;
- a link alone on its own line as a card, which suits the thing the reply is
  about;
- an unknown or malformed link as plain text, never as a link elsewhere.

Show links, do not explain them. Do not print the raw address or tell the person
how links work. When something has been removed, say so in words rather than
linking to it.
