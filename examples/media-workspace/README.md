# Consumer setup: media workspace

Copy this example into your own workspace, rename `deployment.example.json` to
`deployment.json` and install only the packs you need with `soot add --config
deployment.json`. This example intentionally contains Soot definitions and host
configuration **outside** distributable packs. Installation grants nothing;
`pack_grants` is the one place the host grants what each pack's `needs` ask
for, and each Soot's `packs` selects whole packs. Remove unused Soots and
grants. Add the `toolbox` pack if the Soot needs to author specs rather than
consume supplied files.

Each host environment variable below is read only by the tools of the pack that
declares it in `needs`:

- `SOOT_MEDIA_PYTHON`: absolute path of a Python interpreter in a prepared
  environment **outside packs_dir**, shared by the media packs.
- `FILE_ROOT` is granted as `workspace`: each Soot works in its own workspace
  folder (use separate Soots for unrelated tenants).
- `SOOT_OFFICE_BINDING`: optional converter binding JSON for `office`.
- `SOOT_OCR_BINDING`: DeepSeek OCR endpoint JSON.
- `SOOT_TTS_BINDING`: OmniVoice endpoint/voice allowlist JSON.
- `SOOT_VIDEO_BINDING`: absolute FFmpeg/FFprobe executable JSON;
  `SOOT_HYPERFRAMES_BINDING` is optional.
- `SOOT_IMAGE_GEN_BINDING`: host sd-cli, pinned Qwen Turbo Q4_K_M weights,
  shared lock and memory-budget JSON from the image-gen README. Installation
  never downloads weights or builds/starts inference.
- `GOOGLE_WORKSPACE_BINDING`: scoped Google credential JSON, entered per Soot in
  Nest (`from: operator`), so it has no grant here.

See each installed pack README for exact binding shapes and explicit dependency
preparation. Prefer host credential files in production rather than literal
values or shell history. Never store real `.env`, tokens or model/provider
credentials here. `soot check --show --secrets` proves local availability, not
remote API success. Missing Google/OCR setup is a blocker for those operations.

Provider/model are deliberately omitted: inherit the operator's Soot settings
and existing Devin/Codex login. `soot serve --config deployment.json` runs an
owned local runtime; `soot run --config deployment.json --soot office "..."`
uses the real host provider. No publication/release is implied.
