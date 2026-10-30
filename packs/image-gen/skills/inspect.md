# Inspect a PNG

Use `image-gen_inspect` to decode a completed PNG, read its dimensions, mode and
actual alpha extrema, and obtain byte count and SHA-256. Paths are relative to
the host FILE_ROOT; hidden paths, traversal and symlinks are rejected. The tool
accepts single-frame PNGs only and detects truncated pixel data.

Compare the returned dimensions with the requested deliverable. The presence
of an alpha channel alone is insufficient: `has_transparency` means at least
one decoded pixel is nonopaque. Inspect edge quality and the intended cutout
visually before claiming successful background removal.

File validation cannot prove prompt fidelity, legible typography, accurate
Vietnamese accents or aesthetic quality. Open the artifact with a separately
authorized image-viewing tool and review those points. Do not infer that a PNG
was made by the pinned model from its filename or the inspection receipt.

Inspection uses only Pillow; it does not load model weights, invoke inference,
contact a network service or require IMAGE_GEN_BINDING. Installing this pack
grants nothing: a Soot selects the pack in `soot.json`; `image-gen:read` gives inspection only.
