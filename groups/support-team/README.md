# Support team

Ask Kamaji in Nest for a support team. Kamaji asks for the product, the website
the chat goes on, where the answers come from, what must go to a person, and the
tone; you approve once.

| member | does | capabilities |
| --- | --- | --- |
| Kamaji (lead) | the daily digest and weekly review | its own `soot-nest` playbooks |
| Answerer | answers website visitors from the product facts, records what they ask, report or want | `live-chat/conversation` |
| Feedback desk | sorts each note into the workspace table `voc` and flags what a person can act on now | workspace tables |

**Cycles** (run as Kamaji): *Tổng hợp phản hồi* 17:00 summarises the day's
`voc` rows and opens tasks for product changes; *Báo cáo tuần* counts the week
and proposes facts the answerer was missing.

## Set up after Kamaji builds it

The answerer talks to the public, so creating the team always waits for your
approval. It reads only the knowledge you give it — never the workspace's
tables, memory or files. Kamaji leaves one task per missing piece:

- the website chat (Cài đặt → Live chat, `soot-nest/website-chat`) pointed at
  the answerer, and the product facts it answers from;
- a route for the answerer's `record_feedback` notes to the desk;
- a write grant for the desk on the workspace table `voc` (the desk asks for it
  with **Cấp quyền** the first time a write is refused).

No credentials ship with the template.
