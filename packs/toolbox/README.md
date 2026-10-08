# Toolbox pack

Reusable workspace and research tools, selected with the existing pack/capability
mechanism. These are linked Go tools from `agentray/sandbox`; no second plugin
loader or agent loop is introduced.

| Capability | Tools |
| --- | --- |
| `toolbox/read` | `read_file`, `grep`, `glob` |
| `toolbox/write` | `write_file`, `edit_file`, `edit_lines` |
| `toolbox/research` | `web_fetch`, `web_search` |
| `toolbox/http` | `http_request` |
| `toolbox/shell` | `run_shell` |

Copy this directory into the deployment's `packs_dir`. Attach
`"packs": ["toolbox"]` to a Soot to select read and research tools. Add individual
capabilities through `use`, for example:

```json
{
  "id": "analyst",
  "packs": ["toolbox"],
  "use": ["toolbox/write", "toolbox/shell", "toolbox/http"]
}
```

Put tool selection in a Soot definition file, not pack.json. Host bindings are
keyed by the root Soot ID in deployment.json, outside packs:

```json
{
  "tool_hosts": {
    "analyst": {
      "workspace": "./work/analyst",
      "http_allow_hosts": ["api.example.com"]
    }
  }
}
```

An omitted workspace creates a separate directory for each conversation at
`<data_dir>/workspaces/<soot>/<conversation-id>`. A configured `workspace` is
shared by that Soot's conversations unless `per_conversation` is true, which
uses `<workspace>/<conversation-id>` (Nest: `work/<conversation-id>`). File
tools enforce relative paths and reject escapes;
edits support content hashes from reads. Shell uses the same directory and
spills large output into files for follow-up reads. Web search uses DuckDuckGo;
web fetch is for public research and deliberately has no `save_as` capability.
HTTP requests use the explicit host allowlist and guarded DNS/IP checks.

`read_file` supports line windows or `byte_offset`/`byte_limit` (up to 64KiB).
Byte paging reaches files above the 16MiB line-read cap and the suffix of a very
long line; responses include a full-file hash and continuation offset. A partial
read blocks `write_file` replacement in the current workspace tool instance.
Prefer hash-checked edits, or explicitly set `allow_partial_overwrite` and
`expected_hash` for an intentional full replacement. This read guard is transient;
it is not a persisted lock against other processes or future runs.

`grep`/`glob` honor nested `.gitignore` rules (including parent rules for a scoped
search) and exclude dependency/VCS directories. They do not consult global Git
ignore files or `.git/info/exclude`. `path: "."` searches the workspace root.
Grep reports skipped unreadable/over-2MiB files, caps each page at 200 matches,
and supplies `offset` to continue. Long matching lines point to byte reads.
Listings are bounded at 100000 files; narrow `path`/`glob` when needed. Host and
sandbox substrates share the same Go matching and paging behavior.

`run_shell` executes on the host under the Soot process's OS permissions. Its
working directory is **not OS isolation**. Enable this capability only on a host/account
trusted with model-authored commands. It does not inherit the daemon's environment.
Credentials for fixed runbooks still use operation-scoped `secret_env`; this
pack does not expose a global credential resolver to the model.

Every toolbox tool accepts `async: true`. It returns a jobs receipt; use
`job_status`, `job_wait`, `job_list` or `job_cancel`. Jobs cancel with their run;
they are not durable process handles. Children may use granted read/research
tools and further delegate within configured limits. Writes, HTTP requests,
shell, operations and public replies remain on the parent.

Shell and HTTP calls claim durable action records before execution. Replaying
the same host invocation returns its recorded result. A new invocation executes
again even with identical arguments, so edit → rerun the same test command gets
a fresh observation. Concurrent opaque
effects against the same workspace are refused while an action is running;
uncertain effects fence subsequent external execution and cannot pass final
outcome validation. Inspect the durable record before operator reconciliation.
This is conservative replay protection, not exactly-once external execution.
Local file tools use direct writes/hash-checked edits; after interruption, read
the files before retrying. File and shell changes are not rolled back when the
agent run fails or the user stops it.

See [execution configuration](https://github.com/2found/2agent/blob/main/docs/execution.md) for long tasks.

The techniques follow [oh-my-pi](https://github.com/can1357/oh-my-pi) at
`898b09d32f147887a2242cf5ec9a1967bcac8873`: composable tools, stale-edit checks,
bounded views with full artifacts, and async job receipts. The implementations
reuse AgentRay's Go tools; OMP's TypeScript runtime was not copied.
