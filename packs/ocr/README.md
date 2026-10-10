# OCR

Extract native PDF text first; recognize scans with a host-bound DeepSeek OCR model.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/ocr
# From the installed pack directory, explicitly prepare the selected tools:
uv venv --python 3.12 /absolute/host-runtimes/ocr
uv pip sync --python /absolute/host-runtimes/ocr/bin/python --require-hashes requirements.lock
```

Python 3.12+ and uv. PDFium and Pillow; the model server is separate. Bind `PYTHON_EXECUTABLE` to that environment's absolute `bin/python` path.
Keep environments outside `packs_dir`: Soot snapshots pack source; virtualenv
certificates, large native libraries and runtime caches are not pack source.
Direct and transitive client dependencies are pinned with hashes in
`requirements.lock`; installation never executes a setup script.

Select only the capabilities you need in your Soot definition:

```json
{
  "use": [
    "ocr/assess",
    "ocr/recognize"
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
Operation IDs: `ocr_assess`, `ocr_recognize`.

Bindings use `secret_env` references and host credentials scoped to operation IDs.
A complete consumer example is in the repository
[`examples/media-workspace`](../../examples/media-workspace/); it is not inside the pack.
Use placeholder files only in Git. Credentials and endpoint URLs are never model inputs.


## DeepSeek OCR service

Bind `OCR_BINDING` to host JSON such as:

```json
{"base_url":"http://127.0.0.1:8041/v1","model":"deepseek-ai/DeepSeek-OCR-2"}
```

The server must actually expose `/chat/completions` with image data URLs for
DeepSeek OCR. This is not `api.deepseek.com` generic chat. Use a separately
operated vLLM service compatible with its DeepseekOCR2 model support, or an
operator-reviewed hosted service. Keep `api_key` only in the host credential
file. The client refuses redirects and requires HTTPS except explicit loopback.

Model/runtime setup is intentionally outside installation: PyTorch, CUDA, model
weights and vLLM are far heavier than this client. The official
[DeepSeek OCR 2 source](https://github.com/deepseek-ai/DeepSeek-OCR-2) and
[vLLM model implementation](https://docs.vllm.ai/en/latest/api/vllm/model_executor/models/deepseek_ocr2/)
own inference compatibility. Start from their current GPU/operator setup;
do not claim that their older custom offline scripts are a REST service.

No universal GPT/Claude accuracy ranking is claimed. Native text first is a
cost/latency choice; dedicated OCR is justified by the actual document.

## Apple Silicon with 16 GB RAM

The small PDFium/Pillow client does not load the model. For local model inference,
the tested MLX conversion is
[mlx-community/DeepSeek-OCR-2-4bit](https://huggingface.co/mlx-community/DeepSeek-OCR-2-4bit)
at revision `378131e9d1a6fb1fa2e130d2e81e46ada0a2c10d`.
Its single weight file is 2,559,362,324 bytes with SHA-256
`607c518dbcff24b4195eea39510d7ed30a99e6cef97878b05a138ea90829c6a9`.
Prepare it separately, outside `packs_dir`; the client never downloads weights.

One real Vietnamese page on M1 Pro 16 GB completed through this pack in 7.16 s
(including a cold model load), with server physical footprint peaking at
6.8 GiB and resting at 2.5 GiB afterward. Weight size is not peak RAM.
This is a short page, not a throughput or accuracy guarantee for long tables.

The verified server stack was Python 3.12, `mlx-vlm==0.4.0`,
`mlx-lm==0.31.1`, `mlx==0.32.3` and `mlx-metal==0.32.3`.
Do not use the yanked `mlx-lm==0.31.0`. The tested `mlx-vlm==0.7.6`
CLI recognized the same page, but its concurrent HTTP server failed with a
GPU stream/thread error on this machine. Use the verified single-worker path:

```sh
# Explicit operator setup in a separate model-server environment:
uv venv --python 3.12 /absolute/host-runtimes/deepseek-ocr
uv pip install --python /absolute/host-runtimes/deepseek-ocr/bin/python \
  mlx-vlm==0.4.0 mlx-lm==0.31.1 mlx==0.32.3 mlx-metal==0.32.3
# After downloading and verifying the pinned model in the directory below:
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /absolute/host-runtimes/deepseek-ocr/bin/python -m uvicorn mlx_vlm.server:app \
  --host 127.0.0.1 --port 8042 --workers 1
```

Bind `OCR_BINDING` as host JSON, with the actual absolute model directory:

```json
{"base_url":"http://127.0.0.1:8042/v1","model":"/absolute/host-models/deepseek-ocr-2-4bit","max_tokens":2048}
```

The directory name must identify DeepSeek OCR. `max_tokens` is a host-owned
output limit (1..8192), never a model tool argument. Use a smaller reservation
for short pages; incomplete generations are rejected without publishing an
output. Long pages may need cropping and a new output path.
The chat template supplies the image token; the client does not duplicate it.

Keep OCR jobs serial. Stop the model server to release its retained weights
before image generation on a 16 GB host. Installation and General preset
selection do not start a model server or reserve GPU memory.
