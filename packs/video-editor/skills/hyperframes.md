# Optional HyperFrames motion

Use the installed, pinned upstream HyperFrames CLI and its skills as the source
of the current composition/runtime contract. Operator setup is separate from
pack installation. No dynamic `npx` install, publishing, cloud render, secret
lookup or arbitrary CLI argv is exposed by this pack.

Upstream sources: https://github.com/heygen-com/hyperframes and
https://hyperframes.app/docs. Start with its `hyperframes` router; choose the
appropriate workflow (motion graphics, faceless explainer, product launch,
talking-head overlays, music-driven video, slideshow or general video), then
read needed core/animation/audio/media domains. Install/update skills only as an
explicit operator action. Don't copy vendor skills with personal paths into a pack.

Author a portable project with `index.html`, local assets/fonts and correct
clip timing (`data-start`, `data-duration`, source offsets, tracks). Use seek-safe
animation timelines: avoid Date.now, random live state and setTimeout effects.
Frame zero, reverse seeks, scene boundaries and last-frame tails must agree.
Use the upstream sub-composition contract for nested scenes: root mounts point
to local composition files, whose template contains the styles and scripts.
Match mount IDs, inner composition IDs and registered paused timeline keys.
Do not treat zero sampled layout/contrast checks as a successful visual audit.
Use registry primitives before rebuilding named effects. Keep screen-space
captions outside camera/world transforms. Preserve exact approved speech.
OmniVoice WAVs are adopted as files, not an invented `--provider omnivoice`.

The fixed `video-editor_hyperframes` tool accepts `lint`, `check`, `snapshot`
(with times) or `render` (new output). `check` includes lint and browser audits;
missing Chromium is a real blocker. It can create local QA snapshots/history,
so this tool is classified as write.
`check`/`lint` return a structured `passed` verdict and upstream findings,
including failing audits. Repair those findings before rendering; a successful
tool call with `passed:false` is not a QA pass.
Rendering may execute authored JS:
only operator-authorized projects in an appropriately isolated host environment.
Check and inspect snapshots, then decode final frames and listen. A lint pass
alone never proves the film or captions work. Keep requested preview-only scope.
