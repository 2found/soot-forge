# Soot Nest

Platform skill pack for Nest. Its `side-bar` capability describes the shared right
tool area; it grants no browser access and starts no ingress. The Nest general
Soot template selects both `soot-nest` and `browser-use`. Browser-use owns browser
configuration; Nest owns presentation and reads `interface.tool_area` metadata.

Its `nest-links` capability teaches the `nest://` link grammar a Soot writes in a
reply to send the person to a data-pool collection or document, a Soot, a team, a
page or a drafted piece of work. Links grant nothing and send nothing. The
grammar mirrors `desktop/src/nest-links.ts` in 2agent; change both together.

Its `manage` capability gives Kamaji, the lead, two tools, `manage` and
`manage_gated`, that run `soot manage` to change the host's Soots, schedules,
teams, approvals, data access and model tiers. The runtime acts only for the
host's `default_soot` and holds every change that would grant more than the lead
holds, delete, relax an approval or touch a customer-facing Soot until the person
approves it through `manage_gated`. The capability is not in the pack's `use`
recipe: installing the pack grants nothing, and the Nest general template selects
`soot-nest/manage` for the lead only. It needs a Soot runtime with `soot manage`;
release the runtime before this pack. On an older runtime the tool call fails and
the `nest-lead` skill falls back to draft links.

Its `website-chat` capability configures the Live chat on the owner's websites
from chat; Nest's **Cài đặt → Live chat** edits the same gateway records. It
was the `nest-no-code` pack, which is retired into this one: an update moves
every grant, approval and connection from `nest-no-code/configure` (tools
`view`, `action`) to `soot-nest/website-chat` (`website_view`,
`website_action`) and removes the old copy. Like `manage`, it is not in the
`use` recipe: grant it to an owner configurator Soot, and bind `NO_CODE_URL`
(the complete `/admin/control` endpoint URL) plus that owner's `NO_CODE_TOKEN`
to its two operations through the host credential configuration described in
[pack authoring](../../CONTRIBUTING.md). The credential's tenant, actor and
role are selected by the gateway host, never by tool input.

Deploy the host-owned Live chat gateway and a trusted-backend runtime binding.
In Nest select the configurator, create a website, enter its HTTPS origins,
save and publish, then copy the embed snippet. From chat ask that same
configurator: “Đổi tên Live chat thành Mây Store và phát hành.” The skill reads
the latest revision and uses CAS; Nest keeps a dirty draft when chat changes the
configuration at the same time. Google Sheets export is the optional
[live-chat-sheets](../live-chat-sheets/README.md) pack.

The tools use the bundled `sdk/` public wire codec; there is no private npm or
sibling dependency. The control client permits only the configured HTTPS
endpoint (or explicit local HTTP), refuses redirects, bounds replies to 60 KiB
and applies one 12-second deadline to headers and body. A write with a lost or
invalid reply, or HTTP 5xx/408, exits 2 (unknown effect); inspect the stable
request ID before retrying. Vendor error bodies are not exposed, and a read
operation cannot dispatch a mutation. `tools/gateway.mjs` is a copy of
`scripts/support/owner_gateway.mjs` (`node scripts/sync-owner-support.mjs`).
