"""Private native-process lifetime guard; EOF means the Soot wrapper was killed.

The wrapper owns the writing end of stdin. No native subprocess inherits that
descriptor. Even SIGKILL of the wrapper closes it, so Stop cannot orphan a
memory-heavy native model outside Soot's process group.
"""
import json
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys


def main():
    # One bounded JSON line, then keep stdin open as a lifetime pipe.
    raw = sys.stdin.buffer.readline(64 * 1024 + 1)
    argv = json.loads(raw)
    if len(raw) > 64 * 1024 or not isinstance(argv, list) or not argv or not all(isinstance(v, str) for v in argv):
        return 1
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, close_fds=True) as native:
        selector = selectors.DefaultSelector()
        selector.register(sys.stdin, selectors.EVENT_READ)
        try:
            while native.poll() is None:
                if selector.select(.1) and not os.read(sys.stdin.fileno(), 1):
                    # We own this session. Reap the direct child first when it
                    # obeys TERM, then hard-kill any remaining descendants.
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                    os.killpg(os.getpgrp(), signal.SIGTERM)
                    try:
                        native.wait(timeout=.5)
                    except subprocess.TimeoutExpired:
                        pass
                    os.killpg(os.getpgrp(), signal.SIGKILL)
            rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            Path("native-metrics.json").write_text(json.dumps({
                "peak_child_rss_bytes": int(rss if sys.platform == "darwin" else rss * 1024)
            }))
            return native.returncode if native.returncode >= 0 else 1
        finally:
            selector.close()


if __name__ == "__main__":
    sys.exit(main())
