# Simulated society

Give the moderator a decision and the real thing to judge — a feature description, a price table, a video script, a campaign plan. It builds a population of personas across your markets, runs independent first impressions and social rounds through the crowd, asks an expert panel for independent reviews, and returns a cited report from deterministic statistics. Ask follow-up questions or interview any persona in the same conversation.

Members: Moderator (entry), Population architect, Crowd, Expert panel, Analyst. All of them use only the [Micro Fish pack](../../packs/micro-fish/README.md); there are no credentials to bind.

```sh
soot group add ./society-sim-group_VERSION.tar.gz --sha256 CHECKSUM
soot group inspect groups.d/society-sim
soot group create groups.d/society-sim --name sim --output ./sim --ai-config /private/ai.json
soot check --config ./sim/deployment.json --show --secrets
```

In Nest, the same release archive installs from **Soot → Mẫu Soot → Nhập mẫu từ tệp**.

From Claude Code, copy or link [`claude-code/micro-fish`](claude-code/micro-fish/SKILL.md) to `~/.claude/skills/micro-fish`. You install Soot and set the model in `~/.soot/config.json`; Claude installs the group, runs the simulation, checks the report against the tally and stops the runtime.

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

## Budget

`group create` writes the default collaboration budget (24 delegations, 4 concurrent, 96 model calls). That fits a quick run (24 personas, one social round). For a standard run (48 personas, two social rounds) raise the entry Soot's budget in `deployment.json`, and give the run time to finish:

```json
{
  "run_timeout": "45m",
  "collaboration": {
    "sim-moderator": {"members": ["sim-architect", "sim-crowd", "sim-expert", "sim-analyst"],
      "max_delegations": 48, "max_concurrent": 8, "max_model_calls": 320}
  }
}
```

The moderator sizes the run to the budget and reports partial results honestly if a limit stops it. A quick run takes about 10 minutes; from the CLI pass a longer wait, because `soot run` stops the run after 5 minutes by default:

```sh
soot run --timeout 40m "Chạy mô phỏng nhanh để chọn giá gói nghe: …"
```

If a run is stopped anyway, send "làm tiếp" in the same conversation (`--conversation <id>`): the simulation is stored per conversation and resumes from the first incomplete round.

## Use cases

- **Feature or product**: "Đánh giá tính năng đặt lịch nghe truyện cho người dùng VN và US. Đây là mô tả và màn hình: …"
- **Price**: "Chọn giữa 49.000đ và 99.000đ cho gói nghe. Bảng giá: …"
- **Video**: "Kịch bản TikTok 45 giây, có mốc thời gian: … Người xem có xem hết và chia sẻ không? Hook nào tốt hơn, A hay B?"
- **Campaign or strategy**: "Chiến dịch ra mắt trên TikTok + Facebook + Zalo, thông điệp …, ba bài mẫu: …"
- **Interview**: "Hỏi lại ba sinh viên ghét phương án B vì sao."

A simulated society is one model family imagining people: use it to find objections, confusion and segment differences before spending money, then confirm the decision with real people.
