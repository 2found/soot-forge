---
name: claude-code
description: "Hand long creative or coding work (a video, a feature, a document set) to a Claude Code session on the founder's machine: when to, how to write the brief, one session per key, check with jobs, what to do when it fails."
---
# Claude Code: hand off long work, then watch

Claude Code runs on the founder's machine with a strong model (Opus, high effort) on the founder's own Claude
subscription. You start it, you do not do its work, and you do not wait for it.

## When to hand off

- Hand off: long creative or code work that needs a strong model and many steps: a video (the 2build
  `marketing-video` skill), a feature in a repository, a set of documents.
- Do it yourself: anything short, a lookup, an edit of a few lines, a message, or work your own tools already do.
- Never hand off what needs a person's decision. Ask the person first, then brief.

## Brief it (the `prompt` of `claude-code_start`)

The session cannot ask you anything. Write the brief once and completely:

1. The goal, in one or two sentences.
2. Inputs, with absolute paths (briefs, assets, the repository). Name a skill to use when there is one
   ("use the marketing-video skill").
3. The done condition: what must exist, and where, for the work to count as finished.
4. Constraints. Always say: never publish, post, send, commit or push unless this brief says to; stay inside `dir`.
5. The exact result JSON shape, for example `{"file": "/abs/path/video.mp4", "caption": "..."}`. The session writes it
   as one object to the result path the tool adds to the brief. A schedule may feed that object to the next tool, so
   keep the shape exactly as that tool needs it.

`dir` is the folder it works in and must be inside the operator's allowed folders. `model`, `effort` and `timeout_min`
have good defaults; leave them out unless the work needs less (`haiku` or `low` for a trivial job) or more time.

## One session per key

- `key` names the work: `video-2026-11-24`, `feature-search-box`. Same key while it runs: the tool answers the
  running job (`already: true`). Never start a second session for the same work, and never change the key to get one.
- `{started: false, waiting: "busy"}` means the machine already runs its limit and nothing started. Do nothing; the
  next run tries again.
- `not_configured` or `dir_not_allowed`: report it to the operator in one line; do not retry.

## Check and finish

- `claude-code_jobs` (`key`, or `state: "running"`) shows state, minutes, cost, `last_text` and the `result`. Look when
  asked or when a run wakes you; do not poll.
- A tool-only schedule (`claude-code_watch`) collects the result and passes it on with no model call; you are woken
  only when a job fails. With `emit: "job"` a failed job is passed on too (`job.state`, `job.error`), so the next tool
  records it before you are woken.
- Job folders that ended more than 14 days ago are deleted; read a job's log before then if it matters.
- `claude-code_stop {id}` ends a session that is wrong or no longer wanted.

## When a job fails

1. Read `error` and `last_text` from `jobs`. They say what it could not do.
2. If the brief was the cause (a missing input, a wrong path, an unclear done condition), fix the brief once and start
   again under a new key (`<key>-2`).
3. If it fails again, or the cause is not the brief (the machine, a login, a quota), stop and report: the key, what
   `last_text` says, and what a person must do. Do not loop.
