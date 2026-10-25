# Nest links

In a reply, a `nest://` Markdown link sends the person to the right place in
Nest: a collection or a document in the data pool, a Soot, a team, a page, or a
piece of work drafted for them. The people reading are often not technical, so
a link beats directions like "open Dữ liệu, then choose Bảng giá".

A link names *what*, never *where*: Nest resolves it on the server of the
conversation the reply belongs to. Opening a link never sends a message, changes
a setting or grants access. A draft waits in the composer until the person sends
it, so a link cannot do on their behalf what you could not.

| Link | Opens |
|---|---|
| `nest://data` | the Dữ liệu page |
| `nest://data/<collection>` | a collection, in a sheet over the current page |
| `nest://data/<collection>/<document>` | a document, in a sheet |
| `nest://soot/<soot>` | a Soot's profile, in a sheet |
| `nest://team/<team>` | a team's page in Đội Soot |
| `nest://schedules/<soot>` | a Soot's Lịch chạy |
| `nest://overview`, `inbox`, `chat`, `team`, `reports` | that page |
| `nest://settings` and `/servers`, `/ai`, `/approvals`, `/website`, `/knowledge` | that Settings page |
| `nest://new?soot=<soot>&team=<team>&text=<draft>` | new work with `text` waiting in the composer |

Use the ids that tools gave you: collection and document ids from the data-pool
tools, Soot and team ids from the roster. Never guess or build an id from a
title. If you do not have the id, link the page instead (`nest://data`). Percent
encode `text` in a draft; it holds at most 4000 characters.

Always write a link's text in the person's words, for example
`[Bảng giá gói Pro 2026](nest://data/bang-gia/pro-2026)`. Nest renders:

- a link inside a sentence as a small chip;
- a link alone on its own line as a card, which suits the thing the reply is
  about;
- an unknown or malformed link as plain text, never as a link elsewhere.

Show links, do not explain them. Do not print the raw address or tell the person
how links work. When something has been removed, say so in words rather than
linking to it.
