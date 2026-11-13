# Simulated society

A society of persona Soots meets the thing you need a reaction to — a post, a video script, an article, a product page, a price, a campaign — in a shared feed, among ordinary posts. Each persona is its own Soot: it opens the feed in rounds, skips or finishes what it sees, likes, shares, comments, follows and posts, and sees what the others did. Afterwards every persona is interviewed, an expert panel records findings, and the analyst writes a cited report from deterministic statistics.

Members: Analyst (entry) and Expert panel. The persona Soots are not in the template: the [Micro Fish](../../packs/micro-fish/README.md) driver adds them to the workspace from a persona library, as many as the brief's audience asks for. There are no credentials to bind.

```sh
soot group add ./society-sim-group_VERSION.tar.gz --sha256 CHECKSUM
soot group create groups.d/society-sim --name sim --output ./sim --ai-config /private/ai.json
node ./sim/packs/micro-fish/tools/driver.mjs populate brief.json --workspace ./sim
(cd ./sim && soot serve --config deployment.json) &
node ./sim/packs/micro-fish/tools/driver.mjs run brief.json --workspace ./sim --out ./runs
```

From Claude Code, copy or link [`claude-code/micro-fish`](claude-code/micro-fish/SKILL.md) to `~/.claude/skills/micro-fish`. You install Soot and set the model in `~/.soot/config.json`; Claude writes the brief, runs the simulation, checks the report against the tally and stops the runtime.

## Model: DeepSeek v4.1 flash

The template carries no model; members use the host tier map. A crowd run makes many short calls, so a fast, cheap model fits. With an OpenCode Go subscription, take the API key from opencode.ai (Zen → API keys), export it as `OPENCODE_API_KEY` where the runtime starts, and use:

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

OpenCode Go requires an `x-opencode-session` header, which needs a Soot runtime built on a 2ai that sends it (older runtimes fail with `MissingSessionID`). `deepseek-v4.1-flash-free` works only inside the OpenCode app; use `deepseek-v4.1-flash`. The pay-as-you-go Zen endpoint takes the same model with `"type": "opencode-zen"`.

Through a signed-in Devin account (`soot login devin`), where the account's model list includes it:

```json
{
  "providers": {"devin": {"type": "devin"}},
  "model": {"provider": "devin", "name": "deepseek-v4.1-flash"},
  "tiers": {
    "flash": {"provider": "devin", "name": "deepseek-v4.1-flash"},
    "lite": {"provider": "devin", "name": "deepseek-v4.1-flash"}
  }
}
```

With a DeepSeek API key instead, use a `deepseek` provider (`{"type": "deepseek", "key_env": "DEEPSEEK_API_KEY"}`) and the flash model ID your account lists in Nest **Cài đặt → Mô hình AI**. Keep the key in the environment, never in the file.

## Size and time

Every persona session is one short run, and `workers` in `deployment.json` sets how many run side by side (the launcher sets 8). A simulation of 24 personas over 3 rounds is about 45 sessions plus 24 interviews; with a fast model it finishes in a few minutes. Raise `audience.n` before you raise `rounds`: intervals narrow with people, not with rounds.

## Use cases

- **Content**: a video script with timestamps, a post, a headline, an article opening. Do strangers stop, finish, retell it correctly?
- **A/B**: two to four variants, one arm each. A winner is named only when the intervals separate.
- **Product, feature or price**: the announcement or the price table as the post, with questions about intent and objections.
- **Campaign**: the launch posts as subjects in the feed of the platform they will run on.
- **Interview**: ask any persona why, in its own conversation.

A simulated society is one model family imagining people, reading text: use it to find objections, confusion and segment differences before spending money, then confirm the decision with real people.
