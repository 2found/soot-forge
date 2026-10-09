#!/usr/bin/env python3
"""Explicit operator action: fetch/check pinned weights outside the pack tree."""
import argparse
import hashlib
import json
from pathlib import Path
import os
import urllib.request

pack = Path(__file__).resolve().parent.parent
model = json.loads((pack / "model.json").read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--directory", type=Path, required=True)
parser.add_argument("--check", action="store_true", help="Verify existing files without network access")
args = parser.parse_args()
directory = args.directory.resolve()
if directory.is_relative_to(pack.parent.parent):
    parser.error("weights must stay outside the repository/installed packs directory")
directory.mkdir(parents=True, exist_ok=True)


def checksum(p):
    h = hashlib.sha256()
    with p.open("rb") as stream:
        for block in iter(lambda: stream.read(4*1024*1024), b""): h.update(block)
    return h.hexdigest()


for name, weight in model["weights"].items():
    file = directory / weight["file"]
    if file.is_file():
        if file.stat().st_size != weight["bytes"] or checksum(file) != weight["sha256"]:
            raise SystemExit(f"Invalid {name}; remove/reconcile the incorrect host file before downloading again")
    elif args.check:
        raise SystemExit(f"Missing {name}: {weight['file']}")
    else:
        file.parent.mkdir(parents=True, exist_ok=True)
        staged = file.with_name(file.name + ".partial")
        url = f"https://huggingface.co/{weight['repository']}/resolve/{weight['revision']}/{weight['file']}"
        print(f"Downloading {name}: {weight['file']} ({weight['bytes']} bytes)", flush=True)
        h, total, created = hashlib.sha256(), 0, False
        try:
            with urllib.request.urlopen(url, timeout=120) as source, staged.open("xb") as dest:
                created = True
                for block in iter(lambda: source.read(4*1024*1024), b""):
                    total += len(block)
                    if total > weight["bytes"]: raise ValueError("download exceeds pinned size")
                    h.update(block); dest.write(block)
            if total != weight["bytes"] or h.hexdigest() != weight["sha256"]:
                raise ValueError("download does not match pinned SHA-256/size")
            os.link(staged, file)  # Never overwrite a host file.
        finally:
            if created:
                staged.unlink(missing_ok=True)
    print(f"Verified {name}: {weight['sha256']}", flush=True)
