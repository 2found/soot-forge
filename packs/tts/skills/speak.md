# Exact narration with OmniVoice

Use `tts_synthesize` with exact approved `text`, a host-authorized `voice`,
`language`, optional `speed` and a new `.wav` output. Put speaker labels, camera
notes, SFX and staging outside spoken text. Keep Vietnamese diacritics and
approved names. A short phrase may need its natural narrated context; do not
add padding or rewrite locked words merely to hide a bad take.

OmniVoice runs once in a resident host service; the client is Python standard
library only. Studio transport uses `/synthesize`; explicitly bound OpenAI
transport uses `/audio/speech`. Neither is an invented HyperFrames provider.
The service must actually run OmniVoice. Missing reference/model/service fails
without another engine or voice fallback. Long narration is split at semantic
boundaries into separate recordings, preserving source cue IDs and transcript.

The tool validates the returned WAV, measures actual duration and returns
transcript and text/audio hashes. Reuse unchanged takes during visual/caption
repairs. Caption alignment must be manual listening or acoustic alignment;
proportional timing estimates are never promoted to verified word timestamps.
For HyperFrames, adopt the finished WAV as local media and keep voice, transcript,
measured duration and provenance in the project's ledger.

The returned transcript is the request, not an ASR result or proof that the
model spoke every word. Listen to the final WAV; compare names, numbers,
negation and sentence endings against that text. A separately prepared ASR
pass can flag omissions but can also mishear names. Preserve the exact script,
retry only an affected take to a new path, and record unresolved differences
instead of silently rewriting or declaring a clean quality pass.
