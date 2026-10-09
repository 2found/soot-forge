# FFmpeg timeline JSON

The UTF-8 `spec` file is at most 2 MiB, with no unknown fields. Assets are local,
under FILE_ROOT; remote media URLs and shell/FFmpeg filter strings are not inputs.

```json
{
 "width":1080,"height":1920,"fps":30,
 "clips":[
  {"path":"assets/hook.png","duration":2,"zoom_start":1,"zoom_end":1.08},
  {"path":"assets/demo.mp4","source_start":1.5,"duration":4,"fit":"cover","fade_in":0.15},
  {"path":"assets/end.png","duration":2,"fit":"contain","fade_out":0.3}
 ],
 "audio":[
  {"path":"assets/voice.wav","role":"voice","start":0,"gain":1},
  {"path":"assets/music.wav","role":"music","start":0,"gain":0.08,"fade_in":0.3,"fade_out":1}
 ],
 "font":"assets/NotoSans-Regular.ttf","caption_size":56,
 "safe_area":{"top":0.125,"bottom":0.1771,"left":0.0593,"right":0.1296},
 "captions":[
  {"start":0.1,"end":1.8,"text":"Tài liệu, giọng đọc, video.","timing":"manual"},
  {"start":2,"end":5.7,"text":"Một Soot, công cụ bạn chọn.","timing":"aligned"}
 ]
}
```

Only label `aligned` when real acoustic alignment exists; `manual` means actual
editor-assigned cue times. The example labels illustrate the shape, not proof.

Clips concatenate in order, at most 100 and ten minutes total. Canvas dimensions
128..3840 must be even. FPS 12..60. Source ranges are checked against FFprobe.
Clip durations round to frame counts; reported total is this quantized duration.
Still zooms 1..1.5 are centered and deterministic. `cover` crops; `contain` pads.
Image zooms are supported; video camera choreography uses HyperFrames instead.
Fades go to/from black, not overlap crossfades.

Audio: at most 30 tracks, with explicit role, source_start, duration, placement,
gain 0..2 and fades. Defaults use the available portion of the actual recording,
bounded by the picture duration. Voice/music/SFX are preserved as separate inputs.
The mix sums explicit gains and limits peaks; it does not infer ducking. Source
video audio is excluded unless explicitly added as an audio track. No speed
changes, word-timestamp invention or silent voice substitution.

Captions: at most 1000, 240 chars each, strictly ordered/nonoverlapping, inside
the actual duration. Text is wrapped using the provided local font, up to three
lines, within safe edges. Overlong words/blocks fail. Text cannot contain ASS
control directives. The starting safe margins are house assumptions, not a
certified organic/advertising TikTok overlay.

Render output is MP4 H.264, yuv420p, AAC 192k when audio exists and faststart.
The tool verifies canvas/duration after encoding. Use contact sheets and actual
playback/listening for visual/audio acceptance. `validate` is not creative QA.
