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
