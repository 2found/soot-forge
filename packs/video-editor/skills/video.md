# One video flow: plan, produce with FFmpeg or HyperFrames, verify

**A marketing video for your own product** (a hook, a pretest, per-platform files) is
the 2build `marketing-video` skill (`mvf`), and for a Soot the marketing pack's
`marketing-video` skill drives it. It renders with HyperFrames 0.8.153, the same
pin as this pack's `video-editor_hyperframes` tool. Do not build a second
script/hook/pretest flow here. This skill covers every other short video.

## 1. Plan a film someone can produce
Resolve audience, platform, length, aspect, source material, voice and scope
(plan / preview / render) from the request; don't add an approval pause when
rendering was already asked for. Missing essential assets are gaps, never a
licence to pass stock off as supplied references.

Write an original hook, causal beats, exact spoken script, visual treatment and
ending. Each beat says what changes on screen, what the viewer learns and the
sound/camera/cut relation. Distinguish quotation, adaptation and invented
staging. Keep portable files (`BRIEF.md`, `STORYBOARD.md`, exact `SCRIPT.md`,
asset/source ledger, timeline or composition); approved words stay unchanged.
Hash frozen inputs before handing them to another producer.

## 2. Route
- **FFmpeg** (`video-editor_validate` → `video-editor_render`): existing footage,
  stills, centered still zooms, cuts, black fades, explicit audio tracks and
  timed captions. Author the [timeline spec](../SPEC.md); validate before render.
  Audio is explicit (voice/music/SFX tracks with range, gain, fades); source
  clip audio is excluded unless added; the limiter is not loudness or ducking.
  Captions are measured against the local font inside the safe edges (house
  margins on 1080×1920: top 240, bottom 340, left 64, right 140); split text into
  timed phrases instead of shrinking it. ASS directives are rejected.
- **HyperFrames** (`video-editor_hyperframes`: `lint`, `check`, `snapshot` with
  times, `render` to a new output): custom typography, HTML motion, camera and
  complex choreography. Upstream skills (github.com/heygen-com/hyperframes) are
  the composition contract. Author `index.html` with local assets/fonts and
  correct `data-start`/`data-duration`; seek-safe timelines only (no Date.now,
  random live state, setTimeout); frame 0, reverse seeks and last-frame tails
  agree; screen-space captions stay outside camera transforms. `passed:false`
  from `check`/`lint` is a finding to fix, not a pass. Rendering runs authored
  JS: only operator-authorized projects on an isolated host.
- Narration is measured first (`tts_synthesize` WAV adopted as a file; never an
  invented HyperFrames TTS provider). TikTok default is 9:16 with header/footer
  room; the margins are assumptions, not TikTok's real UI.

## 3. Verify and deliver
`video-editor_render` checks the encoded duration and canvas. Then
`video-editor_contact_sheet` decodes real frames at the hook, cuts/reveals, the
longest caption and the ending. Zero samples is a
failure. Inspect at phone size and listen to the encoded file: complete speech,
caption timing, safe bounds, decisive events, final frame and audio tail. Fix
only affected shots and re-check. Deliver path, sha256, measured duration,
contact sheet and honest pending QA. Plan-only scope is a plan, not a render
claim. No posting, cloud upload or social credentials are implied.
