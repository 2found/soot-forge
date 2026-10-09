# FFmpeg production and verifiable delivery

Author the [timeline spec](../SPEC.md) through separately granted workspace file
tools, then validate it. Clips can trim video or hold stills, choose cover/contain,
apply centered still zooms and fade in/out. Durations are rounded to frame counts.
Hard cuts are deliberate; fades are black fades, not crossfade transitions.
For complex reveal/camera/transition design, use selected HyperFrames tools.

Audio is explicit: separate voice/music/SFX tracks with source range, placement,
gain and fades. Embedded source-clip audio is excluded unless added as a track.
Choose music gain against the actual voice, preserving pauses and tails. The
mix peak limiter does not establish loudness, ducking or speech intelligibility;
for automated side-chain/carving use HyperFrames audio domains or a reviewed
external audio preparation tool. No fabricated audio-sync assurance.

Captions use measured font wrapping inside configurable safe edges. Default
portrait assumptions scale from top 240, bottom 340, left 64, right 140 pixels on
1080×1920. They are house margins. Split text into exact timed phrases instead
of shrinking/cropping words. ASS directives in model-authored text are rejected.

`video-editor_render` writes a new H.264/AAC MP4 and verifies measured duration
and canvas. Then `video-editor_contact_sheet` decodes actual final frames at the
hook, cut/reveal boundaries, longest caption and ending. Zero samples is failure.
Inspect at phone size and listen to the encoded video, not just the source WAV.
Check complete speech, caption timing, safe bounds, decisive events and final
frame/audio tail. Iterate affected shots/recordings and rerun relevant checks.
Deliver file path/hash, measured duration, contact sheet and honest pending QA.
