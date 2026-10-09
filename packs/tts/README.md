# Text to speech

Generate measured WAV narration with OmniVoice through a resident host-owned service.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/tts
# From the installed pack directory, explicitly prepare the selected tools:
uv venv --python 3.12 /absolute/host-runtimes/tts
```

Python 3.12+ and uv. The client uses only Python standard library. OmniVoice model serving is separate. Bind `PYTHON_EXECUTABLE` to that environment's absolute `bin/python` path.
Keep environments outside `packs_dir`: Soot snapshots pack source; virtualenv
certificates, large native libraries and runtime caches are not pack source.
Direct and transitive client dependencies are pinned with hashes in
`requirements.lock`; installation never executes a setup script.

Select only the capabilities you need in your Soot definition:

```json
{
  "use": [
    "tts/inspect",
    "tts/speak"
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
PCM inspection streams the declared WAV frames and reports `digital_silence`.
Synthesis rejects truncated WAV, digital silence and duration above 600 seconds
before publishing. These checks do not prove pronunciation or transcript fidelity;
listening and content comparison remain part of audio QA.
Operation IDs: `tts_inspect`, `tts_voices`, `tts_synthesize`.

Bindings use `secret_env` references and host credentials scoped to operation IDs.
A complete consumer example is in the repository
[`examples/media-workspace`](../../examples/media-workspace/); it is not inside the pack.
Use placeholder files only in Git. Credentials and endpoint URLs are never model inputs.


## Host-owned OmniVoice

Bind `TTS_BINDING` to JSON such as:

```json
{"engine":"omnivoice","transport":"studio","base_url":"http://127.0.0.1:8042",
 "voices":["vi_female_thuytrang"]}
```

Studio uses `GET /voices` and `POST /synthesize` (PCM WAV). An existing service
implementing that contract can hold the model; `api_key` is optional for HTTPS.
OpenAI-compatible OmniVoice services use `transport:openai`, a `/v1` base URL,
`model`, bound `language` and the same voice allowlist. `/audio/voices` is a
service extension; list support depends on the selected server. No claim is made
that official OmniVoice itself ships an OpenAI REST endpoint.

A standalone optional service is included under [operator/](operator/serve.py).
It uses the official OmniVoice Python API, loads the model once, caches prompts
and serializes inference on loopback. Operator setup, in a separate environment:

```sh
uv venv --python 3.12 /absolute/host-runtimes/omnivoice-model
uv pip install --python /absolute/host-runtimes/omnivoice-model/bin/python -r operator/requirements.in
/absolute/host-runtimes/omnivoice-model/bin/python operator/serve.py --voices /absolute/authorized-voices --device mps
```

Each authorized ID needs matching `.wav` and `.txt` reference files. Select
platform-appropriate Torch packages and pre-download licensed model weights
when preparing an offline host. CUDA uses float16; CPU/MPS use float32 and MPS
uses eager attention. Model/tokenizer download, memory and inference cost are
separate from the zero-dependency client. Installing/selecting the pack never
starts this process. Keep it loopback-only or put it behind an authenticated
operator-managed HTTPS proxy. Never copy real voice recordings into this repo.

[OmniVoice upstream](https://github.com/k2-fsa/OmniVoice) owns the model API.
No engine fallback, speaker fabrication or automatic HyperFrames TTS provider.
