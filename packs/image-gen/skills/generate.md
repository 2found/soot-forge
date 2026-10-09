# Generate an image

Use `image-gen/generate` only when image creation is authorized. Ask for subject,
composition and intended text when they are missing; choose one 512×512 draft
and a fixed seed. `generate` accepts prompt, new output PNG, dimensions in
multiples of 32, seed and optional transparent. The host can restrict pixels
further. Keep prompts within 4000 characters. Output parents must already exist.

The selected model is Qwen Image 2.1 Turbo, Abiray's Q4_K_M conversion. There is
no substitute-model fallback. Its checkpoint schedule is eight Euler steps,
CFG=1. Do not add negative prompts, change sampling, request batches, or put
model paths, URLs, shell flags or credentials in the input.

Inspect the resulting image visually against the prompt. Verify spelling,
Vietnamese accents, composition and unintended artifacts. A SHA-256 receipt
proves the file identity, not image quality. Quantization, 512-pixel drafts and
VAE tiling can reduce fidelity compared with full precision at 2K resolution.
`transparent: true` adds the model's RGBA instruction and requires actual
nonopaque alpha pixels before publishing. It does not promise a perfect mask.

Never overwrite or silently retry a completed generation. Use a new output
path for an authorized revision. A busy runtime means another inference is
active; wait before retrying. Missing dependencies or mismatched model hashes
require host preparation; tools never install, download or start a service.

On a 16GB Mac, leave the host's default pixel and Metal budgets in place.
Memory limits are an inference configuration, not a guarantee that the whole
machine has enough free unified memory. Report timeout or OOM honestly. Do not
raise limits or switch to a different quantization without operator approval.
