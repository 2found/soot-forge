---
name: soot-domain
description: Everything about Soot itself — what it is, its vocabulary, how Soots, Kamaji, teams, packs, schedules, approvals, tiers and the workspace fit together, where packs and team templates come from, and the pet lifecycle.
---

# Soot

Soot is a lightweight general agent system: **Tiny agents. Better together.**
The runtime direction is event → Soot → optional tools. Answer questions about
Soot from this page; for doing things in Nest (changing settings, building a
team, links) the `soot-nest` pack has the steps.

## Vocabulary

- **Soot**: the product and the desktop app, and each agent in it; `soot` in
  commands and technical identifiers. A Soot is a soul (how it talks), a mission
  (what it does), a model tier and the capabilities it was granted.
- **Nest**: the person's workspace, in the Soot app. **Kamaji** is the lead
  Soot of a Nest (the host's default Soot; the person may rename it): they hand
  it everything, and it leads every team.
- **Team** (nhóm, a group): Soots that work together under Kamaji. A **team
  template** (Mẫu Soot in Nest) packages a team's members, the brief it needs,
  budget profiles and schedules; Kamaji builds a team from one in a single
  approval. **Swarm** is the idea of many Soots cooperating, not a separate
  object to chat with.
- **Pack**: an installable bundle of **capabilities**; each capability holds
  skills (know-how in Markdown) and tools (programs a Soot may call). A Soot
  holds `<pack>/<capability>` refs; a pack's `use` recipe is what a whole-pack
  grant selects.
- **Soot Forge**: the public catalog of packs and team templates
  (`2found/soot-forge`). `trysoot.com` is the brand address, not a source from
  which to guess service endpoints. **Soot Pocket** is a planned name, not a
  released app.
- Voice: quiet, capable, curious, cooperative. Cute visuals; plain, concise
  status text.

## How the parts fit

- **Packs grant nothing by being installed.** A Soot reaches a capability only
  when its definition selects it. Tools that write or reach out ask the person
  first unless an approval policy lets them run alone.
- **Approvals.** Deleting things, granting more than the lead holds, relaxing an
  approval, a customer-facing Soot, publishing and spending wait for the person
  under **Cần bạn**. Kamaji does the rest itself and reports once with
  **Hoàn tác** (undo).
- **Model tiers** (`flash`, `lite`, `pro`, `max`, plus `tts`, `search`,
  `imagen`) map to providers in Settings. A tier the host has not mapped runs on
  the default model. Token budgets cap each Soot per day and per run.
- **Workspace.** Tables (`data`), memory and files live at three levels:
  **Chung** (workspace), **Nhóm** (one team), **Soot** (one Soot's own). Work
  that outlives a reply is a **task** (todo, doing, blocked, review, done) with
  an assignee and a log.
- **Schedules** send a text to a Soot or a team at a time (`every`, `at`). A
  schedule for a team with no Soot named runs as its lead, Kamaji: that is a
  team cycle.
- **Sources** deploy Soots, packs and teams from a repository; what a source
  owns is changed in the source, not from chat.
- **Updates.** Packs, team templates, the General preset and the runtime update
  from Forge releases under the host's update policy. A pack Forge merged into
  another moves its grants to the new names and the old copy is removed.
- **Secrets never go through chat.** Provider keys, tokens and logins are
  entered by the person in Settings.

## Work within the runtime

Pack manifests contain only capabilities, skills, tools and explicit recipes.
Soul and mission belong to Soot definitions; routes, schedules, bindings,
secrets and providers belong to the deployment. New domain work belongs in packs
and team templates; reuse the one agent runtime rather than adding an agent
loop, dispatcher or agent-specific backend handler.

The CLI journey is `init → check → serve → run`; inspect the installed CLI
before inventing flags or commands. `check` validates configuration; it does not
prove that tools execute or that an external provider is reachable.

When a source checkout is available, read its `AGENTS.md`, `BRANDING.md`,
`docs/authoring-packs.md` and relevant public contracts before changing them.
These are pointers for source development, not installed-pack dependencies.

## Find packs and team templates

Read https://raw.githubusercontent.com/2found/soot-forge/main/catalog.json
(version 1) and match `name`, `description` and `tags` to the task; team
templates are listed in `groups.json` beside it, and in Nest Kamaji reads them
with `templates.list`. Follow
https://github.com/2found/soot-forge/blob/main/USAGE.md to derive the GitHub
folder link from `source`, inspect its README and use `soot add` when the person
asks for the install and existing tool grants permit it. Verify with
`soot check --show`. If no read or install tool is granted, explain the operator
steps instead of changing grants.

## Pet lifecycle

A pet is a visual companion representing session activity; creating a pet does
not create an agent. Use one activity controller and the existing event
transport per conversation. All pet placements for that conversation receive
the same state. Never open an extra authenticated stream for each pet, or
expose provider tokens in a page.

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
