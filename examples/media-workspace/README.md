# Consumer setup: media workspace

Copy this example into your own workspace, rename `deployment.example.json` to
`deployment.json` and install only the packs you need with `soot add --config
deployment.json`. This example intentionally contains Soot definitions and host
configuration **outside** distributable packs. Installation grants nothing;
the definitions show deliberate capability selection. Remove unused Soots and
credential bindings. Add `toolbox/read`/`toolbox/write` explicitly if the Soot
needs to author specs rather than consume supplied files.

Each host environment variable below is read only by its scoped selected tool:

- `SOOT_MEDIA_OFFICE_PYTHON`, `SOOT_MEDIA_OCR_PYTHON`, `SOOT_MEDIA_TTS_PYTHON`,
  `SOOT_MEDIA_GOOGLE_WORKSPACE_PYTHON`, `SOOT_MEDIA_VIDEO_EDITOR_PYTHON`,
  `SOOT_MEDIA_IMAGE_GEN_PYTHON`: absolute
  Python interpreter paths in prepared environments **outside packs_dir**.
- `SOOT_MEDIA_FILE_ROOT`: existing absolute artifact workspace (shared for this
  example, but use separate roots/credentials for unrelated tenants).
- `SOOT_MEDIA_OCR_BINDING`: DeepSeek OCR endpoint JSON.
- `SOOT_MEDIA_TTS_BINDING`: OmniVoice endpoint/voice allowlist JSON.
- `SOOT_MEDIA_GOOGLE_WORKSPACE_BINDING`: scoped Google credential JSON.
- `SOOT_MEDIA_VIDEO_BINDING`: absolute FFmpeg/FFprobe executable JSON.
- `SOOT_MEDIA_IMAGE_GEN_BINDING`: host sd-cli, pinned Qwen Turbo Q4_K_M weights,
  shared lock and memory-budget JSON from the image-gen README. Installation
  never downloads weights or builds/starts inference.

See each installed pack README for exact binding shapes and explicit dependency
preparation. Prefer host credential files in production rather than literal
values or shell history. Never store real `.env`, tokens or model/provider
credentials here. `soot check --show --secrets` proves local availability, not
remote API success. Missing Google/OCR setup is a blocker for those operations.

Provider/model are deliberately omitted: inherit the operator's Soot settings
and existing Devin/Codex login. `soot serve --config deployment.json` runs an
owned local runtime; `soot run --config deployment.json --soot office "..."`
uses the real host provider. No publication/release is implied.
