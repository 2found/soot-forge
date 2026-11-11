# Nest lead

The Lead's pack for Nest. It gives the Lead, the person's own assistant (in
no team), two tools, `manage` and
`manage_gated`, that run `soot manage` to change the host's Soots, schedules,
teams, approvals, data access and model tiers, and three skills: `nest-lead`
(how the Lead works with the person and hands teams their work), `nest-manage` (how to
read, change, report and undo) and `nest-company` (company templates as data:
bán hàng online, nội dung, SaaS, vòng công ty without a build stage, proposed in
one message and created after consent through the same actions).

Only the host's Lead may select this pack (`"packs": ["nest-lead"]`): the
deployment's `lead`, or `default_soot` on a Nest made before that field. The
Nest general template does that for the Lead and nobody else. Both tools are
write tools. The runtime acts only for the Lead and holds every change that
would grant more than the Lead holds, delete, relax an approval or touch a
customer-facing Soot until the person approves it through `manage_gated`
(`run.approval: operator`, with a preflight that shows what would change).

`lead/SOUL.md` and `lead/MISSION.md` are the Lead's soul and mission: when an
existing workspace has no Lead yet, Nest (Soot 0.16.2+) creates the Soot `lead`
with this pack and copies those two files into it. A fresh Nest's Lead is its
General, which keeps General's own soul and mission.

The morning brief runs read-only: `manage` answers reads and refuses every
change on that run (`read_only` on the tool call).

Goals: the skill `nest-lead` also tells the Lead how to steer the company with goals
(the runtime's `goal` and `task` tools, not tools of this pack): draft goals from
the person's words as proposals, handle a `goal_changed` attention, and create
repeating jobs as recurring tasks. The weekly rhythm of a team (Monday
commitments, Friday check-in, cycle review) is the Đầu mối's, in the
[team-rhythm](../team-rhythm/README.md) pack. Needs a runtime with goals (Soot 0.14.0+); an older
one has neither tool and the Lead keeps to schedules and drafts.

Needs a Soot runtime with `soot manage`; release the runtime before this pack.
Where a tool call fails, the `nest-lead` skill falls back to draft links.
The tool schema lists the actions the runtime accepts (`LeadActions` in 2agent
`internal/management/lead.go`); change both together.

Evals: `evals/nest-lead/`.
