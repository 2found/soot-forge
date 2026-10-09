# Office and media packs: choices and verification

Reviewed on 2026-10-10. These five packs provide working, bounded tools and
production guidance. Installation is separate from dependency preparation,
capability selection and credential binding. No release or publication is
performed by this work.

## Library choices

The selection favors editable files, practical platform support, predictable
installation and a small client. It does not claim one library is best for
every document or that a dedicated OCR model always beats GPT/Claude.

| Pack | Selected client/runtime | Prepared client footprint on macOS arm64 / Python 3.12 |
| --- | --- | --- |
| Office | python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2, pypdf 6.20.0, pypdfium2 5.14.0, ReportLab 5.0.1, Pillow 12.3.0, defusedxml 0.7.1 | 64 MiB |
| OCR | pypdfium2 5.14.0 and Pillow 12.3.0; separate DeepSeek OCR service | 23 MiB |
| Text to speech | Python standard library HTTP/WAV client; separate OmniVoice service | No third-party client packages |
| Google Workspace | google-auth[requests] 2.61.0; bounded Docs/Drive REST | 18 MiB |
| Video editor | Pillow 12.3.0 and separately installed FFmpeg/FFprobe | 14 MiB, excluding FFmpeg |

Footprints are rounded `du` measurements of prepared `site-packages`, including
transitive dependencies. They exclude Python itself, uv's cache, executables,
models and browser packages; other platforms/builds differ. Each client has a
complete hash-pinned uv lock. The optional model environment has separate
platform-dependent Torch requirements and is not represented as a small client.

**Office:** [python-docx](https://python-docx.readthedocs.io/en/latest/),
[openpyxl](https://openpyxl.readthedocs.io/en/stable/) and
[python-pptx](https://python-pptx.readthedocs.io/en/latest/) work with editable
Open XML without a licensed Office process. openpyxl is used in streaming mode
for inspection; formulas remain formulas or existing cached values, with no
claim of recalculation. XML protections include defusedxml and bounded ZIP
expansion. Native libraries preserve practical text/style workflows; they do
not promise complete Word layout, macros, tracked changes or arbitrary charts.

[pypdf](https://pypdf.readthedocs.io/en/stable/) handles PDF text/forms/page
operations, ReportLab creates PDFs with an explicitly supplied Unicode font,
and [PDFium](https://github.com/pypdfium2-team/pypdfium2) provides real raster
rendering. This avoids making a full office suite mandatory. PDFium's permissive
licensing was a selection factor; PyMuPDF is capable but uses
[AGPL/commercial licensing](https://pymupdf.readthedocs.io/en/latest/faq/index.html).
Dependencies retain their own licenses. Optional LibreOffice handles conversion
on a prepared host, with visual review required for layout-sensitive delivery.

**OCR:** preserve native text first, then use DeepSeek OCR for images, sparse or
broken text layers, or a deliberate forced pass after visual comparison. The
text-layer heuristic is not a quality score. The thin client sends bounded
rasterized pages to an image-capable OpenAI-compatible endpoint, checks
completion and writes provenance-marked Markdown without invented confidence.
The generic DeepSeek chat API is not this model service.

Reviewed [DeepSeek OCR 2](https://github.com/deepseek-ai/DeepSeek-OCR-2) source:
`2f3699ebbb96fa8af32212e8c170f2cc28730fad`. Its model/runtime is operated
separately. Upstream [vLLM support](https://docs.vllm.ai/en/latest/api/vllm/model_executor/models/deepseek_ocr2/)
owns serving compatibility. This work does not pretend the older offline CUDA
scripts provide a REST API or ship Torch/vLLM/model weights in every Soot tool.

**Speech:** [OmniVoice](https://github.com/k2-fsa/OmniVoice), reviewed source
`08be0b4ccbac3e13e374e86fbfead4b4cac343e2`, runs once in a resident service.
The client enforces the bound voice allowlist and exact requested text, checks
actual PCM frame extent and publishes a new WAV with sample-derived duration
and text/file hashes. No automatic engine or voice substitution. An optional
loopback server uses official `omnivoice==0.2.1`; platform-specific Torch and
model preparation remain operator work. That server implementation's full
weight-backed execution is separate from the native-service test below.

**Google Docs:** direct REST keeps the client small and avoids an unnecessary
discovery SDK. [Tabbed document guidance](https://developers.google.com/workspace/docs/api/how-tos/tabs)
and [batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
define real tab IDs, UTF-16 indexes and `requiredRevisionId`. Local receipts are
reserved and fsynced before mutations, scoped by stable host account identity.
Unknown effects remain pending across restarts and cannot be silently resent.
The pack does not share files, grant OAuth consent or impersonate a domain.

**Video:** FFmpeg performs encoding/trimming/mixing/caption burn-in directly;
the basic pack needs neither MoviePy nor Torch/Chromium. Captions are measured
against the supplied font, explicit phrase timings and configurable safe bounds.
It supports cuts, still zooms and black fades; its limiter is not an assertion
of speech intelligibility, loudness normalization or side-chain ducking.

[HyperFrames](https://github.com/heygen-com/hyperframes), reviewed source
`6ae1af7470133db72de6d9bbceeaf80e85695c68`, is optional for authored HTML motion.
The operator npm lock pins CLI 0.8.143. The CLI alone is about 33 MiB unpacked
before its dependencies/browser. The tool exposes fixed check/lint/snapshot/
render actions, with no arbitrary argv, installing, cloud rendering or posting.
Its upstream skills remain authoritative for the current composition contract.

## Preparation and repeatable tests

Prepare each pack's dependencies outside `packs_dir`, following its README.
Soot snapshots pack source: a virtualenv inside a pack is both too large and
can contain certificate keys that the source snapshot correctly rejects.
Bind the absolute interpreter through operation-scoped `PYTHON_EXECUTABLE`.
The wrapper uses isolated Python mode and only imports its own shipped support.

The [consumer example](../examples/media-workspace/README.md) contains placeholder
host configuration outside distributable pack roots. Specs are authored through
separately selected workspace file tools; there is no implicit toolbox grant.
Models, reference voices, fonts and credentials are prepared by the host.

```sh
node --test scripts/*.test.mjs
node scripts/validate.mjs --soot /absolute/path/to/soot --remote
/absolute/host-runtimes/office/bin/python scripts/test-media.py
```

The Python suite requires FFmpeg/FFprobe and a local Arial or DejaVu Sans font.
Missing prerequisites fail explicitly. It exercises actual Office/PDF files and
FFmpeg codecs; OCR/TTS HTTP responses and Google transport fixtures are labeled
as fixtures, not vendor inference evidence. Regression coverage includes styled
Word replacements, explicit Excel formulas versus literal strings, PDF forms
and pixels, forced OCR rasterization, completion truncation, invalid WAVs,
redirect rejection, account-scoped receipts, unknown-write replay prevention,
UTF-16/tab/revision contracts and decoded video frames.

Opt-in real Soot/provider journeys run only when explicitly invoked:

```sh
node scripts/live-media.mjs --soot /absolute/path/to/soot \
  --output /absolute/new-evidence-directory --provider devin --model swe-2 \
  --tts-url http://127.0.0.1:8042 --voice AUTHORIZED_VOICE
```

Use an existing authorized Devin or Codex provider; no login credentials are
shipped or acquired by the test. Optional flags bind OCR/Google credential files
and an operator-prepared HyperFrames CLI/project/browser. Google live QA is
read-only. Test state and runtime logs remain outside pack roots. Runtime logs
are private vendor diagnostics; publish only reviewed, sanitized evidence.

The journey materializes release-like archives, installs with `soot add`,
prepares separate locked environments, runs `soot check`, starts an owned local
runtime and uses real provider-driven tools. It requires actual public tool
events, expected outputs and independent artifact checks; a model's prose alone
cannot make it pass. Negative lanes require actual tool-failure events.

## Verified scope and remaining prerequisites

The [sanitized verification record](media-packs-verification.json) records
16 passing Node tests, 38 passing Python regression tests, 25 catalog entries,
11 real Soot/Devin lanes plus a final Soot motion iteration, public tool-event
counts and file/archive/source hashes. Negative lanes include deliberately
blocked missing/expired-service cases; those are not live vendor success claims.
Reviewed source archives are reproducible and about 11–38 KB compressed each;
client environments and optional engines are not included in those bytes.

Local verification used `soot dev` at runtime identity
`756a14dfdd8dcdf5d46fcafd17985e10bab47c0c` / Go 1.26.5, built from the existing
local checkout without changes to Soot core, and the real Devin `swe-2` provider.
This identifies the executable; the existing checkout was not represented as a
clean released commit. Local test evidence includes each archive's SHA-256 and
public tool events.

| Area | Evidence | Scope limit |
| --- | --- | --- |
| Official installation/configuration | All five packs installed with `soot add`; complete catalog validation includes 25 entries and pinned external content | No publishing/release performed |
| Office/PDF | Real Soot created and inspected DOCX/XLSX/PPTX/PDF and rasterized PDF; independent readers checked Vietnamese text, tables, numbers and formulas | LibreOffice unavailable; conversion not live-tested |
| OCR | Real Soot native extraction and scan routing; missing model service produced an actual blocked tool result; forced raster/HTTP/completion covered by regression tests | No live DeepSeek endpoint; scan accuracy remains unverified |
| OmniVoice | Real Soot called a resident host service performing native OmniVoice GGUF Q8_0 inference on Apple Metal; PCM duration/hash inspected | Full shipped Python server model load and human listening are not established by this test |
| FFmpeg video | Actual H.264/AAC exports, dimensions/duration checks and decoded contact sheets; optional chain adopts the actual OmniVoice WAV | Manual phrase captions are not claimed as word alignment; final listening is separate |
| HyperFrames | Actual local CLI/browser check and MP4 render, plus optional real Soot tool lane | No cloud/posting; decoded-frame inspection required |
| Google Docs (historical `google-doc`) | Expired token exercised through real Soot; transport tests cover tab reads, exports, guarded writes, deduplication and unknown effects | No authorized Google document/account available; live reads/mutations not verified |

PDF and FFmpeg contact sheets were visually inspected for Vietnamese glyphs,
content and safe placement. Measurements and automated ASR do not replace human
listening or prove that all future documents preserve layout. Supply an OCR
service and an authorized Google test document to complete those vendor lanes.
Independent Whisper screening preserved the main Vietnamese sentence in both
the source WAV and final MP4, but rendered the brand name differently. That is
flagged for human listening, not reported as verified verbatim speech. The final
HyperFrames review executed lint/runtime/layout/contrast audits; its separate
motion audit was disabled, which was explicitly reported by the real Soot.

## Google Workspace expansion

The unreleased `google-doc` pack was renamed to `google-workspace` and expanded
with Sheets and Drive. The historical verification JSON above keeps the old
archive identities and results. See [current Workspace contracts](../packs/google-workspace/SPEC.md)
and [Workspace verification](google-workspace-verification.json) for the new
identity and changed scope. Client dependencies remain unchanged.

Current expansion checks: 49 Python regression cases and 17 Node tests passed;
the official Soot installer validated all 25 catalog entries including pinned
external content. Workspace live QA separately selects Docs, Sheets and Drive
read capabilities; write capabilities remain unselected in the live test.
