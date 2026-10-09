#!/usr/bin/env python3
"""Reproducible local microbenchmarks; no timing assertions or vendor claims."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import statistics
import time
import tracemalloc

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("atlas", ROOT / "packs/soot/tools/atlas.py")
atlas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atlas)


def previous_clean(image):
    image.putdata([(0, 0, 0, 0) if a == 0 else (r, g, b, a)
                   for r, g, b, a in atlas.pixels(image)])
    return image


def measure(fn, source):
    timings = []
    for _ in range(3):
        image = source.copy()
        started = time.perf_counter()
        fn(image)
        timings.append(time.perf_counter() - started)
    image = source.copy()
    tracemalloc.start()
    fn(image)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {"median_seconds": statistics.median(timings), "python_peak_bytes": peak,
            "sha256": hashlib.sha256(image.tobytes()).hexdigest()}


parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
# Actual final seven-state Soot atlas dimensions. Include transparent pixels
# with stray RGB and every nonzero alpha value; compare exact output bytes.
size = (2304, 208 * 7)
pattern = bytes(v for alpha in range(256) for v in (127, 64, 255, alpha))
source = Image.frombytes("RGBA", size, pattern * (size[0]*size[1]//256))
before, after = measure(previous_clean, source), measure(atlas.clean_rgba, source)
assert before["sha256"] == after["sha256"], "Visible or transparent pixel bytes changed"
report = {"scope":"RGBA cleanup microbenchmark, not full pet generation or model latency",
          "platform":platform.platform(), "python":platform.python_version(),
          "size":size, "iterations":3, "before":before, "after":after,
          "speedup":before["median_seconds"]/after["median_seconds"],
          "memory_scope":"tracemalloc Python allocations; native Pillow buffers and process RSS excluded"}
args.output.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
