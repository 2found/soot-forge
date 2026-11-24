# Soot x Claude Code

Hands long creative or coding work to a **Claude Code session on your own machine**, running a strong model
(Opus, high effort) on your Claude subscription instead of the API. A Soot (a cheaper model) starts the session, a
tool-only schedule watches it, and the result chains into the next tool with no model call. First use: making a
marketing video with the 2build `marketing-video` skill.

The pack runs `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` in a folder you allow,
unattended, in a detached process. Nothing here talks to a network or holds a credential.

## Setup (on the machine that runs the session)

1. **Log in to Claude Code once, interactively:** run `claude` in a terminal and sign in with your subscription. The
   pack never sets an API key: it passes only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`,
   `TERM` and `CLAUDE_CONFIG_DIR` (if set) to Claude Code. No `ANTHROPIC_API_KEY`, no `*_KEY`, `*_TOKEN` or `SOOT_*`.
2. Set these in Nest (the pack's settings), all optional except the first:

| name | meaning |
| --- | --- |
| `CLAUDE_CODE_DIRS` | **Required.** Absolute folders, separated by `:`. A job's `dir` must exist and be inside one (symlinks resolved). Unset: `start` answers `not_configured`. |
| `CLAUDE_BIN` | Absolute path of `claude`. Default: `claude` on `PATH`, then `~/.local/bin/claude`. |
| `CLAUDE_CODE_MODEL` | Default model (`opus`). |
| `CLAUDE_CODE_EFFORT` | Default effort: `low`, `medium`, `high` (default), `xhigh` or `max`. |
| `CLAUDE_CODE_MAX_RUNNING` | Sessions at once, 1 to 8 (default 1). Over it `start` answers `{done: true, waiting: "busy"}`, quiet for a chain. |
| `CLAUDE_CONFIG_DIR` | Claude Code's own config folder, when you keep it somewhere else. |

## Tools

| tool | mode | what it does |
| --- | --- | --- |
| `start` | write | `{key, title, dir, prompt, model?, effort?, timeout_min?}` (timeout 5 to 720, default 240). One session per `key`: a running job with that key is answered (`already: true`). Writes `jobs/<id>/` under the pack's state, adds an unattended footer to the prompt that names the `result.json` path, starts a detached runner. Answers `{started, id, key, title, log, result_path}`. |
| `jobs` | read | `{key?, state?, limit?}`, newest first: state (`running`, `done`, `failed`, `timed_out`, `stopped`), minutes, `cost_usd`, `num_turns`, `usage`, `last_text`, `result` (at most 4 KiB), `error`, log path. A runner that disappeared reads `failed` (`runner_gone`). Writes nothing. |
| `stop` | write | `{id}`: kills the session's process group, records `stopped`. `watch` does not report a stop. |
| `watch` | write | `{key_prefix?, emit?}` for a tool-only schedule. One finished, not yet reported job per call, oldest first. Nothing finished: `{done: true, running: n}`. Success: `emit: "result"` answers the session's `result.json` verbatim, `emit: "job"` (default) answers `{job, result}`. Failure, timeout, a missing or invalid result or `ok: false`: `{ok: false, notify: true, job: {id, key, title, state, error, last_text}}`. Also ends jobs whose runner died or outlived their timeout. |

A session writes its result to the path in its prompt footer: one JSON object, or `{"ok": false, "error": "..."}`.
The brief says what shape the next tool needs.

## Schedules

Watch finished videos and hand each result to the marketing pack (a tool-only schedule, no model):

```json
{
  "every": "10m",
  "tool": {"pack": "claude-code", "name": "watch", "input": {"key_prefix": "video-", "emit": "result"}},
  "then": [{"pack": "marketing", "tool": "video_import", "input_from": "previous"}]
}
```

A failed job answers `{ok: false, notify: true, ...}`, which wakes the Soot under `wake_when: {notify: true}` (or ends
the chain as a failed step). Nothing finished answers `{done: true}` and the chain stops quietly.

Start one video a day: a chain from the marketing brief into `start` (the brief tool's output is the `prompt` source;
shape the fields your `video_brief` returns to match `start`'s input):

```json
{
  "every": "1d",
  "tool": {"pack": "marketing", "name": "video_brief", "input": {}},
  "then": [{"pack": "claude-code", "tool": "start", "input_from": "previous"}]
}
```

Put the day in `key` (`video-2026-11-24`) so each day is its own session and a repeated run is answered, never doubled.

## Files and limits

- Job folders live under the pack's state (`$SOOT_PACK_STATE/jobs/<id>/`): `job.json`, `prompt.md`, `log.jsonl`
  (stream-json), `stderr.log`, `result.json`, `exit.json`. They are not deleted by the pack.
- The session runs with permission checks off, in `dir`, as you. Keep `CLAUDE_CODE_DIRS` narrow. Briefs should say never to
  publish, post, commit or push unless wanted; the skill teaches the Soot to write that.
- The timeout kills the session's whole process group (claude and what it started).
- macOS and Linux (process groups). A session needs the machine awake.
