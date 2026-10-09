# Video editor

Plan and produce short videos with FFmpeg, measured audio, safe captions and optional HyperFrames motion.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/video-editor
# From the installed pack directory, explicitly prepare the selected tools:
uv venv --python 3.12 /absolute/host-runtimes/video-editor
uv pip sync --python /absolute/host-runtimes/video-editor/bin/python --require-hashes requirements.lock
```

Python 3.12+ and uv. Pillow plus separately installed FFmpeg/FFprobe. HyperFrames/Chromium are optional. Bind `PYTHON_EXECUTABLE` to that environment's absolute `bin/python` path.
Keep environments outside `packs_dir`: Soot snapshots pack source; virtualenv
certificates, large native libraries and runtime caches are not pack source.
Direct and transitive client dependencies are pinned with hashes in
`requirements.lock`; installation never executes a setup script.

Select only the capabilities you need in your Soot definition:

```json
{
  "use": [
    "video-editor/plan",
    "video-editor/inspect",
    "video-editor/edit",
    "video-editor/hyperframes"
  ]
}
```

The example lists available capabilities, not a recommended blanket grant.
The default recipe is read/plan-only or empty; mutation capabilities are explicit.
Then run `soot check --show --secrets`. Provider/model settings remain host-owned.
To author JSON specs, separately select `toolbox/write` and `toolbox/read` if
needed; there is no implicit dependency or grant.

All files are relative to a host-bound absolute `FILE_ROOT`. Each output must
be new, and its parent must already exist. Traversal, hidden paths and symlinks
are rejected. New artifacts are privately staged and atomically published with
SHA-256/byte receipts. This is path validation, not an OS sandbox. The tool uses
the public `soot/v1` stdin envelope and fixed argv; no model-controlled shell.
Dependency setup is an operator action; `soot add` and tools never install it.

See each [skill](skills/) for workflow, limitations and operation semantics.
Validation probes repeated assets once per invocation, keyed by path, size and
mtime; there is no persistent stale metadata cache. CLI stdout is capped at
2 MiB while running. On failure/timeout, the runner terminates its process group,
including child encoders/browsers (Linux/macOS). Probe metadata rejects non-finite
duration and oversized picture dimensions before decoding.
Operation IDs: `video-editor_probe`, `video-editor_validate`, `video-editor_render`, `video-editor_contact_sheet`, `video-editor_hyperframes`.

Bindings use `secret_env` references and host credentials scoped to operation IDs.
A complete consumer example is in the repository
[`examples/media-workspace`](../../examples/media-workspace/); it is not inside the pack.
Use placeholder files only in Git. Credentials and endpoint URLs are never model inputs.


## Host executables and optional motion

Bind `VIDEO_BINDING` to `{"ffmpeg":"/absolute/path/to/ffmpeg",
"ffprobe":"/absolute/path/to/ffprobe"}`. FFmpeg must support libx264 and libass
for the supplied caption pipeline. Fonts/assets are user-provided local files.
Read [SPEC.md](SPEC.md) before authoring timelines. Do not install MoviePy,
PyTorch or Chromium for the basic editor.

For optional HTML motion, explicitly install reviewed HyperFrames 0.8.143 and
its lockfile outside the pack's distributed tree:

```sh
# Copy the pinned operator dependency files outside packs_dir.
mkdir -p /absolute/host-runtimes/hyperframes
cp operator/hyperframes/package*.json /absolute/host-runtimes/hyperframes/
npm ci --prefix /absolute/host-runtimes/hyperframes --ignore-scripts
# Run the operator-controlled dependency preparation documented by upstream
# if this platform needs sharp/browser binaries; not through a model tool.
```

The included operator npm lock pins the optional CLI; `node_modules` never ships.
Bind `HYPERFRAMES_BINDING` to absolute `node` and installed CLI `cli` paths.
Optional absolute `ffmpeg`, `ffprobe` and `browser` executable paths are passed
to upstream's corresponding `HYPERFRAMES_*_PATH` settings. Use those bindings
on hosts whose executables are outside the minimal tool PATH.
The operator must also install compatible Chromium according to upstream. The
CLI is about 33 MiB unpacked before dependencies/browser, so it is optional.
Its commands may execute the authored project's JS and create local QA/history
files. Only use authorized projects on an appropriately isolated host.

The upstream [HyperFrames skills](https://github.com/heygen-com/hyperframes)
remain authoritative. This pack's original planning/production guidance adapts
the source-fidelity, measured-audio and QA lessons of the local TikTok skills;
it does not vendor personal voice settings, Lohi brand assets or private paths.
No posting, publishing or cloud render operation is granted.
