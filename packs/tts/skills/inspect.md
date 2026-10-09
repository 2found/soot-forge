# Inspect voices and real audio

`tts_voices` lists reference voices exposed by the bound OmniVoice service.
The host `TTS_BINDING.voices` also defines which of these IDs this tool may use.
Never invent a reference, silently substitute a performer or clone from a URL.
Use `tts_inspect` to measure a PCM WAV's sample rate, channels and duration;
truncated sample data is rejected. This local inspection needs no TTS server.

A duration comes from samples. It is not phrase/word alignment, an ASR result,
proof of pronunciation or a listening check. Listen for missing/repeated words,
reference-text leakage, clipping and unnatural endings. If listening has not
happened, state that it remains pending.
