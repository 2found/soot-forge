# Measured media and preflight

Use `video-editor_probe` for real duration, codecs, dimensions and audio streams.
Use `video-editor_validate` on the [timeline spec](../SPEC.md) before rendering.
It checks source ranges against real recordings, frame-quantized timing, explicit
tracks, caption ordering, font-measured wrapping and local safe bounds. An absent
asset, out-of-range trim, unsupported zoom or overlong caption blocks rendering.

Captions require `timing:manual|aligned`. Never label equal word spacing or
proportional cue estimates acoustic alignment. Text stays in the screen-space
caption layer, independent of shot zooms. Use a local font with Vietnamese glyphs.
Validation proves structural/bounds facts; it does not prove a good hook,
accurate pronunciation, real TikTok preview or an attractive final frame.
