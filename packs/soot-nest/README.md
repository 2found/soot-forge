# Soot Nest

Platform skill pack for Nest. Its `side-bar` capability describes the shared right
tool area; it grants no browser access and starts no ingress. The Nest general
Soot template selects both `soot-nest` and `browser-use`. Browser-use owns browser
configuration; Nest owns presentation and reads `interface.tool_area` metadata.

Its `nest-links` capability teaches the `nest://` link grammar a Soot writes in a
reply to send the person to a data-pool collection or document, a Soot, a team, a
page or a drafted piece of work. Links grant nothing and send nothing. The
grammar mirrors `desktop/src/nest-links.ts` in 2agent; change both together.

Its `manage` capability gives the Đầu mối two tools, `manage` and
`manage_gated`, that run `soot manage` to change the host's Soots, schedules,
teams, approvals, data access and model tiers. The runtime acts only for the
host's `default_soot` and holds every change that would grant more than the lead
holds, delete, relax an approval or touch a customer-facing Soot until the person
approves it through `manage_gated`. The capability is not in the pack's `use`
recipe: installing the pack grants nothing, and the Nest general template selects
`soot-nest/manage` for the lead only. It needs a Soot runtime with `soot manage`;
release the runtime before this pack. On an older runtime the tool call fails and
the `nest-lead` skill falls back to draft links.
