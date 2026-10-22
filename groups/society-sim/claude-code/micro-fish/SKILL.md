---
name: micro-fish
description: Run a Micro Fish simulated society on the user's local Soot — a persona crowd, expert panel and analyst judge a feature, product, price, video script or marketing campaign and return a cited report. Use when the user wants to test an idea, A/B a hook, pick a price or pre-test a campaign with simulated people before real ones.
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

- **Soot** on PATH (`soot version` works) and **Node.js 20+**: the pack's
  tools run on node.
- **The AI model** in `~/.soot/config.json`. Every Micro Fish member uses the
  `flash` tier, so a fast, cheap model fits best. For example, with OpenCode
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
release and creates the workspace in `~/.soot/micro-fish/sim`, with a budget
large enough for a standard run.

If the release has no `society-sim` yet, use
`micro-fish.sh setup --from <soot-forge checkout>` and say that this build
comes from the checkout.

Environment overrides:
- `MICRO_FISH_HOME` moves the workspace;
- `MICRO_FISH_PORT` changes the port (default 7801);
- `MICRO_FISH_AI_CONFIG` points at another AI config.

A model change in `~/.soot/config.json` does not reach an existing workspace.
To apply it, delete `~/.soot/micro-fish/sim` (after `stop`) and run `setup`
again. Stored simulations live in that directory, so tell the user before
deleting it.

## 4. Write the brief

Put the request in a file, in the user's language. Include:
- the decision to make (A vs B, go/no-go, which price);
- target markets and audiences;
- the run size: quick (24 personas, ~10 min), standard (48), deep (96);
- **the real material, verbatim**: the feature description, price table,
  video script with timestamps, campaign posts.

A simulation can judge only what it is shown, so ask the user for the
material rather than summarising it. When the user gives no size, choose
quick.

## 5. Run

```sh
micro-fish.sh start
micro-fish.sh ask /path/brief.txt     # prints state, conversation id, answer and progress paths
```

A run takes 10–30 minutes, so start it as a background command and tell the
user it is running.

When it finishes, read the answer file. If `state` is not `completed`, read
the progress file and the server log (`~/.soot/micro-fish/serve.log`, look
for `failure_kind`). If the run failed on turn 1, the model call was
rejected; that is a provider or config problem, so a retry will not help. A stopped run resumes when you send "làm tiếp" / "continue"
in the same conversation (`ask <file> <conversation-id>`).

## 6. Verify before you relay

`micro-fish.sh sims` lists the simulations; `micro-fish.sh tally <sim-id>`
prints the deterministic statistics. Check the report's headline numbers
against the tally:
- `preference` shares, with `clear` (true means the leader is separated);
- `shift.*.direction`;
- per-round `intent_top2`, `price_ok`, `watch_through_mean`;
- expert verdicts;
- `warnings`.

Correct any mismatch in your summary, and pass the tally's warnings and caveat
through unchanged. If the report draws on more than one simulation (for
example after a failed population build), say so.

## 7. Follow up, then stop

Follow-up questions and persona interviews go to the same conversation id:
"Hỏi lại ba sinh viên ghét phương án B vì sao".

When the user is done, or before you end your turn without a follow-up
pending, run `micro-fish.sh stop`. It stops only the server this script
started.

Report in the user's language:
- the decision and the evidence for it;
- the objections and what to fix;
- the limits: one model family imagining people. It gives direction,
  objections and wording, never a forecast, so the decision still needs
  confirming with real people.
