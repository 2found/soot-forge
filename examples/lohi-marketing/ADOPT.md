# Adopt: move the Lohi workspace onto teams

Experimental, internal. Lohi is a single product `lohi`; nothing extra is declared.
Teams (the five in [workspace.lohi.json](workspace.lohi.json)): insight (lead), marketing, financial,
op-catalog (Soot `lohi-catalog`), and cs as a remote team at `https://soot.lohi2.com`.
Build stays outside Soot (Claude Code with `bbs:autopilot`), so it is not a team.

You need a runtime with `soot workspace adopt` (the rename of `soot company adopt`) and
`soot teams health`, found through `LOOP_SOOT_BIN`. Run from the soot-forge checkout.

## 1. Build the workspace

```bash
export SOOT_HOME=<private dir, mode 0700>
node examples/lohi-marketing/setup.mjs <ws> --no-video      # add --blog-remote / --product-repo as in the README
chmod 700 <ws>                                              # the runtime refuses an unsafe root
```

A workspace built with `--video` also has `lohi-video`: add `"lohi-video"` to
marketing's `members` in your copy of `workspace.lohi.json` first (`soot workspace
check` refuses a member the deployment does not have).

## 2. Keep the way back

```bash
cp <ws>/deployment.json <ws>/deployment.pre-adopt.json
cp -R <state dir> <state dir>.pre-adopt                     # the runtime state next to the config
```

## 3. Check

```bash
soot workspace check examples/lohi-marketing/workspace.lohi.json --config <ws>/deployment.json
```

`soot workspace` composes the template and any `--overlay` files itself; there is no
compile step to run first.

## 4. Adopt

```bash
soot workspace adopt examples/lohi-marketing/workspace.lohi.json --config <ws>/deployment.json
```

## What changes

- `workspace` and `groups` appear: insight, marketing, financial, op-catalog, and cs as
  a remote team.
- Every schedule gets a `group` (the `company-*` schedules and the other `lohi-editor`
  schedules land in marketing).
- A team budget is the sum of its members' daily caps (insight 130000, marketing 250000,
  financial 30000, op-catalog 80000 in the lean profile).
- Each old `soot:` scope gets a `team:<id>` read grant, and `default_groups` is set so each
  Soot can still be chatted to.
- cs needs `CS_RUNTIME_TOKEN` in Nest.

## 5. Verify

The runtime applies an adopted file only when it runs with `soot serve --watch` (the live Lohi runtime does).
A runtime started without `--watch` keeps serving the old configuration and `soot teams health` prints no teams.

```bash
soot check --config <ws>/deployment.json                    # expect: Valid, all Soots
soot teams health --config <ws>/deployment.json             # needs the runtime running; a remote team is skipped
```

## Left behind

The old writer's private `content` table (`soot:lohi-writer`, one row on live, the same post as `posts` P-FEB01D22D1)
stays in the workspace database. Nothing reads it any more and no CLI drops a Soot-scope table; leaving it is safe.
Everything the Writer saves goes to the marketing `posts` table now.

## Rollback

Stop the runtime, restore `deployment.pre-adopt.json` over `deployment.json` and the saved
state directory. Do not run an older binary on the adopted config: it rejects the new
fields.
