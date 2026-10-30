# Nest lead

The lead pack for Nest. It gives Kamaji, the lead, two tools, `manage` and
`manage_gated`, that run `soot manage` to change the host's Soots, schedules,
teams, approvals, data access and model tiers, and two skills: `nest-lead`
(how the lead works with the person and its teams) and `nest-manage` (how to
read, change, report and undo).

Only the host's default Soot may select this pack (`"packs": ["nest-lead"]`); the
Nest general template does that for the lead and nobody else. Both tools are
write tools. The runtime acts only for the default Soot and holds every change
that would grant more than the lead holds, delete, relax an approval or touch a
customer-facing Soot until the person approves it through `manage_gated`
(`run.approval: operator`, with a preflight that shows what would change).

Needs a Soot runtime with `soot manage`; release the runtime before this pack.
Where a tool call fails, the `nest-lead` skill falls back to draft links.
The tool schema lists the actions the runtime accepts (`LeadActions` in 2agent
`internal/management/lead.go`); change both together.

Evals: `evals/nest-lead/`.
