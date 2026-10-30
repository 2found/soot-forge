# Website chat

Configures the Live chat on the owner's websites from chat; Nest's **Cài đặt →
Live chat** edits the same gateway records. Tools: `website_view` (read) and
`website_action` (write), plus the `website-chat` skill. Select the pack for an
owner configurator Soot only; it is not part of Nest's general template.

`needs.credentials` asks the operator for `NO_CODE_URL` (the complete
`/admin/control` endpoint URL) and that owner's `NO_CODE_TOKEN`, entered per Soot
in Nest or bound from the host through the deployment `credentials` configuration
described in [pack authoring](../../CONTRIBUTING.md). The credential's tenant,
actor and role are selected by the gateway host, never by tool input.

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

Tests: `node --test tests/*.test.mjs`.
