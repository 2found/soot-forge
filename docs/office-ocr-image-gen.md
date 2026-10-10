# Office, OCR and Qwen image generation verification

Test date: 2026-10-10. Apple Silicon MacBookPro18,3, 16 GiB physical RAM,
macOS 26.5.2. Working-tree source was tested; no release or push was performed.

## Office and OCR

`scripts/test-media.py`: **58/58 passed**, including Word replacement across
runs/headers, bounded previews, Excel formula guards, grouped PowerPoint text,
PDF merge/rotation/forms, actual PDF raster pixels, original-file preservation,
public soot/v1 envelopes, traversal/symlink/zip-bomb rejection, native PDF OCR,
scan HTTP/rasterization, truncated completion and wrong-model rejection.
The suite also covers the existing Google, TTS and video clients.

`scripts/live-office-ocr.py`: **22 actual wrapper operations passed** using
LibreOfficeDev from the host's installed document runtime. Created and inspected
DOCX/XLSX/PPTX, edited a copied Word document, converted all three to PDF,
independently read PDF text and Excel's calculated sum (1,650,000), rendered and
decoded PNGs, merged/rotated PDF and extracted native Vietnamese text with OCR.
Visual review of all three renders confirmed Vietnamese text, table alignment,
the calculated sheet total and the slide's full visible content.
Negative cases refused output overwrite, traversal and scan recognition without
an OCR service, with no partial Markdown artifact.

**Real scan inference/accuracy: NOT RUN.** No DeepSeek OCR service binding was
available. The live scan correctly routes to the OCR engine and reports the
missing host binding. HTTP fixtures prove the client protocol and failure
handling; they do not prove model accuracy. To test a real authorized service:

```sh
/absolute/office/bin/python scripts/live-office-ocr.py \
  --output /absolute/new-evidence-directory \
  --libreoffice /absolute/path/to/soffice \
  --ocr-binding-file /absolute/host/ocr-binding.json
```

The live scan test checks the Vietnamese phrase and exact amount against the
source; full table/reading-order accuracy still needs visual ground truth.

Real Soot/provider integration (`scripts/live-media.mjs --only office-ocr`):
**4/4 journeys completed**. Office created and inspected DOCX/XLSX/PPTX/PDF and
rendered the PDF (57.756s); a traversal call failed as required (15.585s); OCR
assessed/extracted native PDF and routed a scan (43.674s); scan recognition
without a model binding produced a real failed tool event (44.310s). Public
tool-start/completion/failure events were checked; the provider was the host's
existing Devin login. Independent readers verified the artifacts afterward.
Evidence: `/tmp/soot-forge-office-ocr-soot-20261010/summary.json` and its event
files. The tested Soot binary was dev commit `756a14dfdd8dcdf5d46fcafd17985e10bab47c0c`.

Local evidence: `/tmp/soot-forge-office-ocr-20261010/report.json`, rendered PDFs
and PNGs beside it. Each public tool result includes byte count and SHA-256.
The Office interpreter was `/tmp/soot-forge-review-live-02/runtimes/office/bin/python`
(Python 3.12.3 with the pack's prepared dependencies).

## Image generation

Pack: `image-gen`. Selected diffusion file is exactly
`qwen_image_2.1_turbo_Q4_K_M.gguf`, not another quantization. Source:
[Abiray's conversion](https://huggingface.co/Abiray/Qwen-Image-2.1-Turbo-GGUF/tree/912070141874687f049212a50b710570882c61c7).
Diffusion, encoder and VAE revisions, byte counts and hashes are in the pack's
`model.json`; tools verify them before inference. The 8-step schedule comes
from the [official Turbo checkpoint](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/d65dbc9a7e8f6b5479e33dee6030eaab2a906509/model_index.json).
Its [scheduler](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/d65dbc9a7e8f6b5479e33dee6030eaab2a906509/scheduler/scheduler_config.json)
uses static shift=1; the native sampler gets these sigmas plus terminal zero.

Hermetic native CLI fixture: **9/9 passed**. Actual PNG publication/receipts,
fixed eight-step schedule and CFG, no shell interpolation, pinned hash checks,
host pixel budget, non-overwrite, lock contention, CLI failure/timeout, malformed
PNG, wrong dimensions and actual alpha validation are exercised. These tests
do not load a model.

Catalog/root Node tests: **19/19 passed**. Final full catalog validation with
`--soot /tmp/soot-forge-current-check-20261010 --remote` passed for **all 26
entries**, including image-gen and the pinned external 2build source. The local
installer was built from Soot commit `ec7df0e8b2d789cecc083fe597dae43547396f1d`
with a temporary Go workspace selecting the current 2ai checkout. An earlier
validation attempt used the older live-journey binary and rejected the existing
data-pool `resource_fields` metadata; the current installer supports that field
and passed the complete gate. No pack field was removed to make it pass.
The support-copy gate includes image-gen, and the trusted Python runner lane
now includes its tests.

The early benchmark below used CPU encoder/VAE stages. The current Metal-stage
default and real-provider Nest measurements are recorded in the final section.

The early native memory strategy was Q4 diffusion + Q4 encoder, disk-backed parameters,
CPU encoding/VAE decode, Metal diffusion with 3 GiB Metal / 2 GiB CPU managed buffer budgets,
Flash Attention, FP16 prefix cache, disabled weight prefetch, 256-pixel VAE tiles and one shared inference
lock. Default drafts are 512×512; high memory pressure can use 256×256 while
retaining Q4_K_M and eight steps. Full BF16 weights alone total 32.44 GB;
the three selected files total 9.89 GB. CPU offload alone cannot reduce total
unified RAM, so disk parameter backing is material here. These runtime features
are documented by [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/blob/f89d9b13d730eabeede7314ce49dacd18d3c90c2/docs/performance.md).

Real local model benchmark: **PASS**, two real 512×512 PNG generations through
the public wrapper. Native runtime is official macOS release
`master-951-f89d9b1`, source commit `f89d9b13d730eabeede7314ce49dacd18d3c90c2`;
downloaded archive SHA-256
`8057dbfb1529b4e0bc07d35eaf68fa821e44bca6852428c539bf70602189bf92`.
It initialized the M1 Pro Metal backend and ran successfully on macOS 26.5.2.
All three model files passed their pinned size/hash checks.

| Profile | Inference time | Peak child RSS | Swap used before → after |
| --- | ---: | ---: | ---: |
| Initial 6 GiB per-backend budget, prefetch enabled | 159.326s | 4.18 GiB | 3173.19 → 5355.56 MiB |
| Final Metal 3 GiB / CPU 2 GiB, prefetch disabled | 184.862s | 3.24 GiB | 5355.56 → 5179.56 MiB |

Native `vmmap -summary` sampled the final run's **physical footprint peak at
4.3 GiB**, including the native process's shared graphics buffers. The `time -l`
peak-footprint field pertains to the Python wrapper and is not used as a native
memory result. Both runs used the same prompt, seed 42, Q4_K_M weights, exact
eight sigmas, CFG=1 and 256-pixel VAE tiles. Their RGBA pixels and complete PNG
bytes were identical: SHA-256
`72941472b67801c07bcfa70239dbdc899559b43bd0287ffcf6e723416397dcf5`.
Visual inspection confirmed the requested red ceramic teapot, wooden table,
soft window daylight and absence of text.

That CPU-stage profile was the earlier pack default. It completed without additional net
system swap usage in this run. The machine already had swap in use, and other
applications/cache conditions differed between runs; these are practical
single-draft measurements, not a controlled speed comparison or a zero-swap
guarantee for every workload. Complex prompts, 2K output, image editing and
live transparency requests have not been model-benchmarked. Reference edits are
covered by the follow-up below.

Evidence: `/tmp/soot-forge-qwen-turbo-512-20261010/` (baseline) and
`/tmp/soot-forge-qwen-turbo-512-optimized-20261010/` (final), with PNG, request,
receipt, system snapshots, native log and native footprint samples. The
separate Pillow-only environment is `/tmp/soot-forge-image-gen-python`; weights
are `/tmp/soot-forge-qwen-models`, outside all pack trees. The deterministic
pack archive was approximately 37 KiB; the selected model files total 9.89 GB.

Reproduce with the prepared host binding and a new evidence directory:

```sh
/absolute/image-gen/bin/python scripts/live-image-gen.py \
  --binding-file /absolute/host/image-binding.json \
  --output /absolute/new-image-evidence --size 512
```

Record wall time, child RSS/peak footprint, system memory pressure and swap
before/after. A managed buffer limit is not a hard total process-memory
cap. Swap-backed success alone does not establish comfortable physical-RAM fit.
## General media follow-up (2026-10-10)

The General creation preset now explicitly selects Office, OCR and image-gen.
The real Nest test uploaded a reference PNG, passed its content-addressed
workspace path directly to `image-gen_generate`, then opened the new PNG in
the authenticated document panel. The Qwen Q4_K_M edit changed a red teapot to
cobalt blue. The provider was scripted to test routing, while the image model
and runtime were real. No OCR was called in this image-edit path.

Reference edits additionally need the pinned Qwen3-VL vision projector in
`model.json`. The edit uses Q8_0 prefix caching with the same exact eight-step
Turbo sigma schedule. The Nest edit took 373.5 s and sampled physical footprint
peaked at 5.6 GiB while other builds/model experiments ran. System swap grew;
do not extrapolate a no-swap budget from this shared-load run. An earlier FP16
reference edit took 262.1 s, but the runs were not controlled comparisons.

Real DeepSeek-OCR-2 4-bit recognition through the pack passed on M1 Pro 16 GB:
the Vietnamese source sentence “Báo cáo tiếng Việt: Tổng ngân sách 1.650.000 đồng.”
was reproduced exactly, in 7.16 s including cold load. MLX server physical
footprint peaked at 6.8 GiB and rested at 2.5 GiB. The tested model conversion
and working single-worker server versions are recorded in `packs/ocr/README.md`.
The HTTP client now avoids duplicating the chat template's image placeholder
and accepts a host-owned token limit for bounded output reservations.

Follow-up local evidence is in `/tmp/soot-nest-media-20261010` and
`/tmp/soot-deepseek-ocr-live-20261010`. The Nest negative case (no attached image)
asked for the missing image without invoking the tool. The successful browser
journey had no console errors. All owned browser/runtime/Vite/OCR processes
were stopped afterward. Forge media tests (58) and image runtime tests (10)
passed after these changes. The Soot native fresh-Nest lane remains blocked
until stable Forge release assets for Office/OCR/image-gen are published;
the local isolated journeys use explicit pack directories/archives.

## Real-provider Nest retest and optimization (2026-10-10)

All three media pack manifests were verified on the remote Forge `main`
(commit `4204abf845a5005e69999d7885e576f8b966d3e5`). The latest stable release
`v0.1.0` still lacked the Office/OCR/image-gen archives. New local changes are
not a published release; fresh General/Nest installation remains dependent on
publishing those reviewed assets. No source fallback or release gate was bypassed.

This retest uses the authorized host's actual `devin/swe-2` provider and real
Qwen Q4_K_M inference, not the scripted provider of the earlier transport test.
Only deployment/conversation state and synthetic operator credentials are
isolated; provider credentials stay in the existing private host configuration.
The uploaded red teapot is changed to cobalt blue; the result is opened via
its authenticated conversation file link in Nest.

| Run, 512×512 | Tool wall time | Sampled native peak physical footprint |
| --- | ---: | ---: |
| Real Nest, CPU text encoder/VAE baseline | 277.872 s | 5.7 GiB |
| Same native prompt/seed/reference, all Metal | 171.95 s | 3.9 GiB |
| Real Nest after default/alpha/mission changes | 178.740 s | 3.6 GiB |

The paired native comparison preserves the exact prompt extracted from PNG
metadata, seed 42, reference, model hashes, eight Turbo sigmas, CFG=1, Q8_0 edit
cache and 256px tiles. All-Metal native inference itself took 165.361 s; weight
verification took 6.477 s. Text conditioning fell from 52.24 to 12.39 s and
reference VAE encoding from 10.81 to 4.91 s. RGB mean absolute difference was
0.37/0.29/0.31 per channel on the 0–255 scale; visual review passed shape,
cobalt color, tabletop and soft window-light preservation. Outputs are not
claimed bit-identical. The paired run's system swap declined from 7191 to
6822.94 MiB, but this is a shared host and not a general no-swap guarantee.
The real Nest comparison has different agent-authored native prompts and is
an observed user-flow improvement, not a controlled statistical benchmark.

Text encoding and VAE now default to Metal with Metal diffusion; the host can
retain CPU stages through bounded `text_backend` / `vae_backend` fields. Disk
parameters, disabled prefetch and 3 GiB Metal / 2 GiB CPU budgets remain. Ordinary
PNG requests publish opaque RGB preserving native RGB values and provenance;
explicit transparency preserves actual alpha. General uses the verified receipt
and returns the file link rather than repeating checks or re-encoding with shell.
The baseline used two inspect calls and three post-generation shell calls; the
optimized edit used none of those. One initial 32 ms shell call prepared its
output folder, followed by exactly one generation call and a Vietnamese answer.
No OCR ran in either image-edit journey.

Cancellation regression was reproduced before fixing it: hard-killing the
Python wrapper left its detached native model alive. A private lifetime-pipe
guard now terminates its own native process group on parent EOF, including
SIGKILL, retaining the shared inference lock during cleanup. The real Nest Stop
case confirmed wrapper, guard and model had all exited, the shared lock was
available, the conversation remained stopped and no output/success reply was
published. Regression coverage also exercises a native child ignoring SIGTERM.
Busy requests now reject before reading/hashing ~11 GB of weights; admitted
requests still fully verify all pinned hashes after acquiring the lock.

Evidence: `/tmp/soot-nest-image-retest-20261010-evidence/` (real-provider baseline),
`/tmp/soot-image-all-metal-benchmark-20261010/` (paired experiment), and
`/tmp/soot-nest-image-optimized-20261010/` (optimized edit and Stop UI). These include
public events/messages, native metadata, images, loaded-preview screenshots,
owned-PID checks and native footprint samples. Do not copy private fixture
credentials into a report or repository.

The final source also passed a real-provider text-only Nest journey: one
512×512 cobalt mug photo, RGB PNG, 145.008 s tool wall time and 3.5 GiB sampled
native peak physical footprint. It used one generation, no shell and no OCR;
its authenticated preview loaded at 512×512 and visual prompt review passed.
Final Stop verification confirmed the lifetime guard retained the shared lock
while native inference was running, and wrapper/guard/model all disappeared
after the UI Stop. No PNG or late success reply was published. Final evidence:
`/tmp/soot-nest-image-final-20261010/report.json`, `text-preview.png`,
`text-result.png`, `stopped.png`, `stop-process-check.json`, public events and
native footprint samples. Final gates passed: 13 image runtime tests, 58 media
tests, 31 Forge Node tests, all 26 catalog entries with external content, and
Go race checks for scaffold/app/conversation/operations/conversation HTTP.
