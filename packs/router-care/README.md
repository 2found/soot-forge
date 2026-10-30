# Router care

Understand 9router release observations and rollout fences using a host-bound,
read-only status tool. The pack contains reusable skills/tools; the consuming
host owns Soot identity, policy, schedules, credentials and the Docker worker.

## Install and select

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/router-care
```

Pin a reviewed full commit with `--ref` when installing a release workspace.
Installation neither grants anything nor runs dependency/build scripts.
The pack is selected whole; it supplies:

| Part | Supplies | Preparation |
| --- | --- | --- |
| skill `release-care` | Guidance for interpreting maintenance evidence and fences | None |
| tool `router-care_status` (read) | Typed status tool, called with `{}` | Node.js 22+ on operator PATH; host-approved status-file environment binding |

Select it in a Soot definition **outside this pack**:

```json
{"id":"router-keeper","soul":"SOUL.md","mission":"mission.md",
 "packs":["router-care"]}
```

The pack declares `needs.env: ["ROUTER_CARE_STATUS_FILE"]`; the host grants that one non-secret variable in the deployment:

```json
{"pack_grants":{"router-care":{"env":["ROUTER_CARE_STATUS_FILE"]}}}
```

(or `soot grant router-care`).

Set `ROUTER_CARE_STATUS_FILE` to the absolute path of the worker’s sanitized
`status.json` in the Soot service environment. It must be a regular file readable
by that daemon. Bind neither its private journal nor runner configuration.
There are no npm dependencies, build step, tokens or network calls for this tool.
The path cannot come from model input. Run `soot check --show --secrets` to
validate selection and host grants, then call the selected status tool to
verify its binding and file readability. `--secrets` alone permits a missing
non-secret variable and does not probe the status file.
A guide-only consumer does not need Node.js or this environment binding.

## Status contract

`router-care_status({})` runs in read mode with a five-second timeout and an
8 KiB output limit. It reads at most 16 KiB, rejects symlinks/non-regular files,
and returns only the worker’s public observation fields. It never executes a
worker, probes health, reads a journal or changes Docker/data/timers.

```json
{"status":{"release_source":"npm","npm_package":"9router","phase":"idle",
 "category":"current","current":"0.5.95","latest":"0.5.95",
 "checked":"2026-10-09T00:00:00Z","digest":""}}
```

`checked` identifies the last worker observation, not live health. Empty/zero
versions and a zero timestamp are unavailable evidence. Known read failures
return `{error:{code}}`: `binding_unavailable`, `status_unavailable` or
`invalid_status`. Invalid tool input/envelopes fail the invocation with a fixed
diagnostic; no file content or path is echoed. Read the skill before interpreting
results or proposing recovery.

## Host integration and verification

The [historical 9router consuming integration](https://github.com/2found/2agent/tree/5e5d79ceec019a3d1e68dd9eabe2a63024300c73/contrib/9router)
contained a Docker worker, deployment example and systemd installer. That example
has been removed from current Soot source; the host must supply its own worker. Its existing
`caretaker_status` operation is a host-owned compatibility operation; this pack
uses the typed `router-care_status` tool. Install/grant updates explicitly and
review that host’s policy before activating any worker. Installing this pack never
installs infrastructure or grants deployment authority.

From this pack directory in a Soot Forge checkout (release archives omit `tests/`), run `node --test tests/*.test.mjs`. Tests use isolated
files and real tool stdin/output, including malformed input, missing bindings,
oversized/private status and symlink rejection. The local `sdk/` wire codec is a
reviewed export of the public soot/v1 SDK; no sibling checkout is required.
