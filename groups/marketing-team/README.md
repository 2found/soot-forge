# Marketing team

Give the Soot a brief. It automatically coordinates authorized collaborators and returns one result in the same conversation. This operator template configures the entry Soot with Radar, content creator, editor, Blog publisher and X publisher. Use --draft-only during setup to omit publishers; additional channels require explicit host configuration. Editor plans against the host-admitted roster. Chat users never select or edit a session team.

Group release archives contain `group.json` plus exact checksummed dependency archives. Installing downloads the whole group but never starts it, runs scripts, grants credentials or activates schedules.

```sh
soot group add ./marketing-team-group_VERSION.tar.gz --sha256 CHECKSUM
soot group inspect groups.d/marketing-team
soot group create groups.d/marketing-team --name acme --output ./acme-marketing --ai-config /private/ai.json
# Add --draft-only to omit publisher members.
```

Review `required-bindings.json`, build the data-pool runner explicitly, grant per-Soot read/write access to the source pool, and bind the marketing ledger. Publisher bindings require a reviewed channel gateway and default to approval of the exact content revision. No live X/blog credentials ship here. See [marketing pack](../../packs/marketing/README.md) for the gateway/approval contract and uncertainty handling.

Run `soot check --config ./acme-marketing/deployment.json --show --secrets` before explicitly starting or importing this configuration through your host settings. A missing provider, data-pool binary, binding or channel adapter remains a setup blocker. Source templates use zero placeholder digests; only the release builder resolves these to real pack archive hashes. Never install the source JSON as a verified release.

A plan row is not a scheduled job. Automatic publication and host schedules require separate explicit host configuration. QA uses local fixture gateways and never posts to real accounts.
