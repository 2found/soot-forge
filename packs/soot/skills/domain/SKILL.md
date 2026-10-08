---
name: soot-domain
description: Soot product vocabulary, architecture boundaries and pet lifecycle for work on Soot itself.
---

# Soot domain

Soot is a lightweight general agent system: **Tiny agents. Better together.**
The runtime direction is event → Soot → optional tools. A pet is a visual
companion representing session activity; creating a pet does not create an agent.

## Product vocabulary

- **Soot**: product and desktop app; `soot` in command/technical identifiers.
- **Nest**: user's workspace. **Swarm**: a group of collaborating Soots.
- **Pack**: installable capability bundle. **Skill**: reusable ability.
- **Soot Pocket** and **Soot Forge** are planned product names, not proof of
  released mobile/marketplace features. `trysoot.com` is the brand address,
  not a source from which to guess service endpoints.
- Quiet, capable, curious, cooperative. Cute visuals; plain, concise status text.

## Work within the existing runtime

Pack manifests contain only capabilities, skills, tools and explicit recipes.
Soul/mission belong to Soot definitions; routes, schedules, bindings, secrets and
providers belong to the deployment. Installing a pack does not grant it or start
ingress. New domain work belongs in packs; reuse AgentCore rather than adding an
agent loop, dispatcher or agent-specific backend handler.

The current CLI journey is `init → check → serve → run`; inspect the installed
CLI before inventing flags or commands. `check` validates configuration; it does
not prove that tools execute or that an external provider is reachable.

When a source checkout is available, read its `AGENTS.md`, `BRANDING.md`,
`docs/authoring-packs.md` and relevant public contracts before changing them.
These are pointers for source development, not installed-pack dependencies.

## Find and add packs

Read https://raw.githubusercontent.com/2found/soot-forge/main/catalog.json
(version 1) and match `name`, `description` and `tags` to the user's task.
Follow https://github.com/2found/soot-forge/blob/main/USAGE.md to derive the
GitHub folder link from `source`, inspect its README and use `soot add` when
the user requests installation and existing tool grants permit it. Verify with
`soot check --show`; installing files never grants capabilities. If no read or
install tool is granted, explain the operator steps instead of changing grants.

## Pet lifecycle

Use one activity controller and the existing event transport per conversation.
All pet placements for that conversation receive the same state. Never open an
extra authenticated stream for each pet, or expose provider tokens in a page.

| Public signal | Pet state |
| --- | --- |
| Connecting/reconnecting, or `run.queued` | `waiting`, with a precise label |
| `run.started`, `run.progress` | `thinking` unless work is active |
| Active tools or `message.delta` | `working` |
| Last run completes | `success` briefly, then `idle` |
| `run.failed` | `error` until fresh work begins |
| `run.stopped` | `idle`, stopped label |
| Quiet idle timeout with no unfinished run or failure | `sleeping` |

A failed tool may be recovered within a run. `message.completed` alone is not
a run completion. Replayed historical completions must not trigger celebration.
The public stream currently has no structured approval/input-required event;
do not infer that state from response text or private reasoning.

For creating a new pet, use the separately selected `soot/create-pet` capability.
