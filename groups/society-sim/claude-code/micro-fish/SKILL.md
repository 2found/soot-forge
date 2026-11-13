---
name: micro-fish
description: Run a Micro Fish simulated society on the user's local Soot — every persona is its own Soot on a shared feed, meeting a post, video script, article, product, price or campaign among ordinary posts and reacting to each other; interviews, an expert panel and an analyst return a cited report. Use when the user wants to test content or an idea, A/B variants, pick a price or pre-test a campaign with simulated people before real ones.
---

# Micro Fish

Micro Fish runs as the `society-sim` Soot group template on the user's computer.
The user installs Soot and chooses the AI model; you do everything else with
`micro-fish.sh`, which sits beside this file. Call it by its full path
(`<this directory>/micro-fish.sh`).

## 1. Check the machine

Run `micro-fish.sh doctor`. On `READY`, go to step 3. On `NOT_READY`, guide
the user through the missing lines in step 2 and run `doctor` again.

## 2. What the user sets up (you only guide)

- **Soot** on PATH (`soot version` works) and **Node.js 22+**: the pack's
  tools run on node.
- **The AI model** in `~/.soot/config.json`. A run is many short persona sessions, so a
  fast, cheap model fits best. For example, with OpenCode
  Go and DeepSeek v4.1 flash:

  ```json
  {
    "providers": {"opencode": {"type": "opencode-go", "key_env": "OPENCODE_API_KEY"}},
    "model": {"provider": "opencode", "name": "deepseek-v4.1-flash"},
    "tiers": {
      "flash": {"provider": "opencode", "name": "deepseek-v4.1-flash"},
      "lite": {"provider": "opencode", "name": "deepseek-v4.1-flash"}
    }
  }
  ```

  Other providers follow the same shape:
  - `{"type": "deepseek", "key_env": "DEEPSEEK_API_KEY"}`;
  - `{"type": "opencode-zen", ...}`;
  - any OpenAI-compatible endpoint: `{"type": "openai", "base_url": "https://…/v1", "key_env": "…"}`;
  - OAuth accounts: `soot login <provider>` instead of a key.

  `soot providers` lists what this Soot supports. Only the model ID changes
  between providers.

  OpenCode Go needs a Soot built on 2ai v0.1.4 or later, which sends the
  `x-opencode-session` header. Soot 0.2.4 and older does not send it, so every
  model call fails with `provider_rejected` (the server log names
  `MissingSessionID`). Upgrade Soot, or use another provider.
- **The API key**, exported in the user's shell profile (for example
  `export OPENCODE_API_KEY=…` in `~/.zshrc`). Claude Code must be restarted
  afterwards so its shell sees the key.
  - Ask the user to set the key themselves.
  - Never ask them to paste it into the chat.
  - Never print, write or commit a key.
  - `doctor` reports only whether each variable is set.

## 3. Prepare the workspace (once)

`micro-fish.sh setup` installs the group template from the latest soot-forge
release and creates the workspace in `~/.soot/micro-fish/society`.

If the release predates Micro Fish 2 (setup says so), use
`micro-fish.sh setup --from <soot-forge checkout>` and say that this build
comes from the checkout.

Environment overrides:
- `MICRO_FISH_HOME` moves the workspace;
- `MICRO_FISH_PORT` changes the port (default 7801);
- `MICRO_FISH_AI_CONFIG` points at another AI config.

A model change in `~/.soot/config.json` does not reach an existing workspace.
To apply it, delete `~/.soot/micro-fish/society` (after `stop`) and run
`setup` again. Stored simulations live in that directory, so tell the user
before deleting it.

## 4. Write the brief

The brief is a JSON file; the pack's README (`packs/micro-fish/README.md` in
the workspace) has the full shape. What you decide:

- `sim`: a new id. `goal`: the decision in one sentence, in the audience's
  language. Do not name a preferred variant or call anything a control.
- `subjects`: **the real material, verbatim**, one entry per variant (up to 4),
  each with the `account` that would post it. A simulation judges only what it
  is shown, so ask the user for the material rather than summarising it. A
  video or image goes in as an honest description of what is seen and heard,
  in order; say in your report that nobody saw the footage.
- `platform` and `context`: where it will run and what it competes with.
  `vi-short-video` ships with the pack; for another platform, market or
  language, write 12–20 ordinary posts of that platform as
  `[{account, content}]`, spanning things people finish and things they skip.
- `audience`: `n` and filters over the persona library (`age`, `sex`, `zone`,
  `region`, a `match` regex). The shipped library is the general Vietnamese
  adult population, so filter it to who would actually meet the post.
- `rounds` (default 4), `questions` (default: retell, clarity, intent,
  objections, why), `experts` (lenses; none by default).

Size: quick is `n` 24 (a few minutes), standard 48, deep 96 or more. With
variants every arm gets `n / variants` people; under 30 per arm the tally
calls the result directional. When the user gives no size, choose quick.

## 5. Run

```sh
micro-fish.sh run /path/brief.json     # prints one JSON line: state, tally and report paths
```

`run` adds the brief's personas as Soots (restarting the server when it adds
any), plays the feed rounds, interviews, runs the experts and asks the analyst
for the report. Start it as a background command when `n` is large.

`completed_with_failures` means some sessions failed; the tally's warnings say
how many personas recorded nothing. For a failed run read
`~/.soot/micro-fish/serve.log` (look for `failure_kind`): a rejected model
call is a provider or config problem, so a retry will not help. Otherwise run
the same command again; it resumes from the recorded round.

## 6. Verify before you relay

`micro-fish.sh tally <sim>` prints the deterministic statistics (also saved
beside the report). Check the report's headline numbers against it:
- per subject `reached`, the `skip` / `some` / `full` split and `rank_in_feed`;
- `comparison.clear` (true means the leader is separated) before any "winner";
- interview `top2` rates and the quoted `retell` answers;
- `spread`, `experts.blocking`, `warnings`.

Correct any mismatch in your summary, and pass the warnings and caveat through
unchanged. Read rates against the context posts: simulated people are kinder
than real ones, so "70% finished it" matters only next to what the same people
did with the other posts.

## 7. Follow up, then stop

Interview a persona in its own conversation:
`micro-fish.sh ask <sim> "<persona id or name>" question.txt`.
`micro-fish.sh tally <sim> --by age|zone|sex` splits the audience.

When the user is done, or before you end your turn without a follow-up
pending, run `micro-fish.sh stop`. It stops only the server this script
started.

Report in the user's language:
- the decision and the evidence for it;
- the objections and what to fix;
- the limits: one model family imagining people who read text. It gives
  direction, objections and wording, never a forecast, so the decision still
  needs confirming with real people.
