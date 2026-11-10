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

The morning brief runs read-only: `manage` answers reads and refuses every
change on that run (`read_only` on the tool call).

Needs a Soot runtime with `soot manage`; release the runtime before this pack.
Where a tool call fails, the `nest-lead` skill falls back to draft links.
The tool schema lists the actions the runtime accepts (`LeadActions` in 2agent
`internal/management/lead.go`); change both together.

Evals: `evals/nest-lead/`.
