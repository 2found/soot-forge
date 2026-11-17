# Toolbox pack

Reusable workspace and research tools. These are linked Go tools from
`agentray/sandbox`; no second plugin loader or agent loop is introduced.

| Group | Tools |
| --- | --- |
| read | `read_file`, `grep`, `glob` |
| write | `write_file`, `edit_file`, `edit_lines` |
| research | `web_fetch`, `web_search` |
| http | `http_request` |
| code | `run_shell`, `eval`, `run_js` |

Copy this directory into the deployment's `packs_dir`. The pack is selected
whole: `"packs": ["toolbox"]` gives every tool above, including write, HTTP and
shell. `"toolbox:read"` gives only its read-mode tools.

```json
{
  "id": "analyst",
  "packs": ["toolbox"]
}
```

Put pack selection in a Soot definition file, not pack.json. Host bindings are
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
web fetch is for public research and deliberately has no `save_as` option.
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
Listings are bounded at 100000 files; narrow `path`/`glob` when needed. `grep`
runs ripgrep when `rg` is on the host's PATH (it then also searches files above
2MiB) and the Go engine otherwise, with the same rows and paging; `output_mode`
returns matching lines, only file paths, or per-file counts.

`run_shell` and `eval` (a persistent Python or JavaScript session) run inside
the OS sandbox by default: Seatbelt on macOS, bubblewrap on Linux. A command
reads only system and toolchain directories, the workspace and its own temp
directory; it writes only the workspace (never `.soot/`, `.git/hooks` or
`.git/config`); it gets a clean environment and no network unless the Soot's
`execution.sandbox.network_allow` lists a host, reached through a filtering
proxy. A refused host shows up in Cần bạn, where a person can allow it. When the
sandbox cannot start the call is refused with how to fix it; it never falls back
to the host. `execution.sandbox.backend: "host"` runs unsandboxed and is flagged
by `soot check`; on Windows the code tools need the `docker` backend. Credentials
for fixed runbooks are declared in the owning pack's `needs`; this pack does not
expose a global credential resolver to the model.

`run_js` is different: it runs a JavaScript script inside the runtime itself
(QuickJS compiled to WebAssembly), with no operating system, network,
environment, modules or timers behind it, so it is offered on every platform,
Windows without Docker included. A script gets `read(path)` and
`write(path, text)` on its workspace (same confinement and quota as the file
tools, never `.soot/`), `tool(name, args)` to call any tool its run holds (the
call goes through the run's permission policy, budget and journal like a model
call) and `console.log`. Each call starts fresh and is bounded in time, memory,
output and tool calls; a runaway loop or memory bomb ends with a clear error.

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
