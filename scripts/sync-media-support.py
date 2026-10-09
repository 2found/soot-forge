#!/usr/bin/env python3
"""Materialize portable support; never import siblings from an installed pack."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
PACKS = ("office", "ocr", "tts", "google-workspace", "video-editor", "image-gen")
source = (ROOT / "scripts/support/runner_common.py").read_bytes()
wrapper_source = '''#!/bin/sh
set -eu
base=$(CDPATH= cd -- "${0%/*}" && pwd)
case "${PYTHON_EXECUTABLE:-}" in
  /*) ;;
  *) printf '%s\\n' '{"error":"Host must bind an absolute PYTHON_EXECUTABLE outside packs_dir."}' >&2; exit 1 ;;
esac
if [ ! -x "$PYTHON_EXECUTABLE" ]; then
  printf '%s\\n' '{"error":"Host must prepare the bound Python environment outside packs_dir."}' >&2
  exit 1
fi
exec "$PYTHON_EXECUTABLE" -I "$base/runner.py" "$@"
'''
for name in PACKS:
    target = ROOT / "packs" / name / "tools/common.py"
    if "--check" in sys.argv:
        if not target.exists() or target.read_bytes() != source:
            raise SystemExit(f"Support drift: {target}")
        wrapper = target.parent / "run"
        if not wrapper.exists() or wrapper.read_text() != wrapper_source:
            raise SystemExit(f"Wrapper drift: {wrapper}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source)
        wrapper = target.parent / "run"
        wrapper.write_text(wrapper_source)
        # -I prevents user-controlled PYTHONPATH/site imports. runner adds its own folder.
        wrapper.chmod(0o755)
