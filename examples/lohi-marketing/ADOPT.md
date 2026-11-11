# Adopt: move the Lohi workspace onto teams

Experimental, internal. Lohi is a single product `lohi`; nothing extra is declared.
Teams (the five standard ones): insight (lead), growth, finance, operations (Soot `lohi-catalog`), and support as a
remote team at `https://soot.lohi2.com`. Build stays outside Soot (Claude Code with
`bbs team`), so it is not in the compiled company; the compiler says so.

You need a runtime with `soot company adopt` and `soot teams health` (L6), found through
`LOOP_SOOT_BIN`. Run from the soot-forge checkout.

## 1. Build the workspace

```bash
export SOOT_HOME=<private dir, mode 0700>
node examples/lohi-marketing/setup.mjs <ws> --no-video      # add --blog-remote / --product-repo as in the README
chmod 700 <ws>                                              # the runtime refuses an unsafe root
```

## 2. Keep the way back

```bash
cp <ws>/deployment.json <ws>/deployment.pre-adopt.json
cp -R <state dir> <state dir>.pre-adopt                     # the runtime state next to the config
```

## 3. Compile and check

```bash
node scripts/company.mjs compile --mode adopt \
  --overlay examples/lohi-marketing/company.lohi.json \
  --remotes examples/lohi-marketing/remotes.lohi.json --out lohi.company.json
node scripts/company.mjs check --mode adopt --overlay examples/lohi-marketing/company.lohi.json \
  --remotes examples/lohi-marketing/remotes.lohi.json --config <ws>/deployment.json
```

Diagnostics come from `soot company check`. An overlay that removes a team a required edge
depends on is refused with `company_edge_required`.

## 4. Adopt

```bash
soot company adopt lohi.company.json --config <ws>/deployment.json
```

## What changes

- `groups` appear: insight, growth, finance, operations, and support as a remote team. (The live Mac Nest was adopted
  before the standard and keeps its ids `marketing`, `financial`, `op-catalog` and `cs`; see the 2found Soot migration plan.)
- Every schedule gets a `group` (the `company-*` schedules and the other `lohi-editor`
  schedules land in growth).
- A team budget is the sum of its members' daily caps (insight 130000, growth 250000,
  finance 30000, operations 80000 in the lean profile).
- Each old `soot:` scope gets a `team:<id>` read grant, and `default_groups` is set so each
  Soot can still be chatted to.
- support needs `CS_RUNTIME_TOKEN` in Nest.

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

## Known runtime issue

`soot company check` in create mode reports `company_invalid` ("entries must name 1 to 32
members") for a lead-led template. Adopt mode is not affected; the tests work around it
only for create mode.
