# Image generation

Generate one PNG locally with **qwen_image_2.1_turbo_Q4_K_M.gguf** from
[Abiray/Qwen-Image-2.1-Turbo-GGUF](https://huggingface.co/Abiray/Qwen-Image-2.1-Turbo-GGUF).
The model, Q4 text encoder and correct Qwen Image 2.1 VAE are pinned by commit,
size and SHA-256 in [model.json](model.json). No model substitution or automatic
downloads. Text-to-image only; reference-image editing is not exposed here.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/image-gen
# In the installed pack, explicitly prepare a small Python client:
uv venv --python 3.12 /absolute/host-runtimes/image-gen
uv pip sync --python /absolute/host-runtimes/image-gen/bin/python --require-hashes requirements.lock
# Explicitly download ~9.9 GB of weights OUTSIDE packs_dir:
python3 operator/download.py --directory /absolute/host-models/qwen-turbo
python3 operator/download.py --directory /absolute/host-models/qwen-turbo --check
```

Installing runs none of those commands. Python 3.12+, Pillow and a separately
prepared native `sd-cli` from [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
are required. Follow [operator/runtime.md](operator/runtime.md) for the pinned
build and inference configuration. Environments, binaries, model weights,
locks and caches stay outside the distributed pack tree.

## Host binding

Bind an existing absolute FILE_ROOT, absolute PYTHON_EXECUTABLE and
IMAGE_GEN_BINDING JSON. Example (paths are placeholders):

```json
{
  "sd_cli": "/absolute/host-runtimes/sd/bin/sd-cli",
  "diffusion": "/absolute/host-models/qwen-turbo/qwen_image_2.1_turbo_Q4_K_M.gguf",
  "llm": "/absolute/host-models/qwen-turbo/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
  "vae": "/absolute/host-models/qwen-turbo/vae/diffusion_pytorch_model.safetensors",
  "lock_file": "/absolute/host-models/qwen-turbo/inference.lock",
  "backend": "metal",
  "max_pixels": 262144,
  "max_vram_gib": 3,
  "max_ram_gib": 2,
  "timeout_sec": 1700
}
```

Scope FILE_ROOT and PYTHON_EXECUTABLE to `image-gen_inspect` / `image-gen_generate`;
scope IMAGE_GEN_BINDING only to `image-gen_generate`. Select `image-gen/inspect`
and/or `image-gen/generate` in the Soot definition, then `soot check --show`.
The default `use` is empty; installation grants nothing. The host owns executable
paths and memory budgets; the model cannot supply command flags or model URLs.

Generation input:

```json
{"prompt":"A red ceramic teapot on a wooden table, soft daylight", "output":"teapot.png", "width":512, "height":512, "seed":42}
```

Dimensions must be multiples of 32 between 256 and 768 and fit the host pixel
budget. One inference at a time per shared host lock. Outputs must be new PNGs
with existing parents; traversal, hidden paths and symlinks are rejected.
The runner checks pinned model hashes, fully decodes the generated PNG, verifies
dimensions, then atomically publishes it with private permissions and a receipt.
`transparent: true` adds the RGBA prompt and requires real nonopaque pixels.
Timeout, wrong dimensions, malformed pixels and missing transparency publish
nothing. This is path validation, not an OS sandbox.

## Mac with 16GB unified memory

Full BF16 weights total **32.44 GB** (diffusion + encoder + VAE), before working
buffers. This pack uses **4.19 GB diffusion + 5.03 GB encoder + 0.68 GB VAE**,
disk-backed parameters, CPU text encoding/decoding, Metal diffusion, Flash
Attention, prefix cache in FP16 and 256-pixel VAE tiles. Graph working budgets
are 3 GiB for Metal and 2 GiB for CPU; asynchronous weight prefetch is disabled
to avoid a second segment’s weights being resident at the same time. Defaults limit drafts
to 512×512, one image, CFG=1 and the checkpoint's **exact 8-step sigma schedule**
with a terminal zero. Merely setting `--steps 8` would lose that schedule.

Apple Silicon shares CPU/GPU memory: CPU offload by itself does not reduce the
total RAM required. Disk-backed parameters let the runtime release weights
between stages/segments. This trades latency for memory; Q4 and tiled VAE can
also affect quality. Metal/CPU budgets control managed inference buffers, not all
system memory. Close other heavy model processes before benchmarking. Start at
256×256 if memory pressure is high, preserving Q4_K_M and all eight steps.

Receipts include inference seconds and child RSS. RSS is not a measurement of
all unified memory or other running applications. See the [verification report](../../docs/office-ocr-image-gen.md)
for actual machine results and limitations; do not call a transport fixture a
model benchmark. Review prompt fidelity and typography visually after generation.

The model inherits the [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/d65dbc9a7e8f6b5479e33dee6030eaab2a906509/LICENSE).
It is not an Apache-2.0 model. Read its terms before distribution or commercial use.

```sh
/absolute/host-runtimes/image-gen/bin/python tests/test_runner.py
```

These hermetic tests execute the public wrapper and a native CLI transport
fixture. They cover receipts, schedule, argv isolation, hashes, pixel budgets,
single-inference locking, non-overwrite, failure/timeout and alpha validation.
They do not load the real model or measure its quality/performance.
