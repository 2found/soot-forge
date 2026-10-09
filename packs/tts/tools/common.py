"""Small public soot/v1 runner support, copied into each standalone media pack.

No Soot internals, model credentials, shell interpolation or automatic installs.
Edit this source and run scripts/sync-media-support.py; --check detects drift.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


class ToolError(Exception):
    pass


class Uncertain(ToolError):
    """A remote mutation may have happened; reconcile rather than retry."""


def require(condition, message):
    if not condition:
        raise ToolError(message)


def string(value, label, maximum=10000, empty=False):
    require(isinstance(value, str) and (empty or bool(value.strip())) and
            len(value) <= maximum and "\0" not in value, f"invalid {label}")
    return value


def integer(value, label, minimum=1, maximum=100):
    require(type(value) is int and minimum <= value <= maximum, f"invalid {label}")
    return value


def number(value, label, minimum=0, maximum=3600):
    import math
    require(type(value) in (int, float) and math.isfinite(value) and
            minimum <= value <= maximum, f"invalid {label}")
    return value


def fields(value, allowed, required=()):
    require(isinstance(value, dict) and not set(value).difference(allowed) and
            set(required).issubset(value), "missing or unknown input fields")


def binding(name):
    try:
        value = json.loads(os.environ.get(name, ""))
    except (ValueError, TypeError):
        raise ToolError(f"host must bind {name}") from None
    require(isinstance(value, dict), f"invalid {name} binding")
    return value


def root():
    value = os.environ.get("FILE_ROOT", "")
    require(value and Path(value).is_absolute() and Path(value).is_dir(),
            "host must bind FILE_ROOT to an existing absolute directory")
    return Path(value).resolve()


def path(value, existing=True, suffixes=None, max_bytes=64 * 1024 * 1024):
    string(value, "workspace-relative path", 512)
    p = Path(value)
    require(not p.is_absolute() and "\\" not in value and
            all(part not in ("", ".", "..") and not part.startswith(".")
                for part in value.split("/")), "path must be clean and relative")
    base = root()
    result = base / p
    ancestor = base
    for part in p.parts:
        ancestor = ancestor / part
        require(not ancestor.is_symlink(), "symlinks are not accepted")
    require(result.resolve().is_relative_to(base), "path escapes FILE_ROOT")
    if suffixes:
        require(result.suffix.lower() in suffixes, "unsupported file extension")
    if existing:
        require(result.is_file() and result.stat().st_size <= max_bytes,
                "input file missing or too large")
    else:
        require(result.parent.is_dir() and not result.exists(),
                "output parent must exist and output must be new")
    return result


def digest(p):
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def receipt(p, **extra):
    return {"path": p.relative_to(root()).as_posix(), "bytes": p.stat().st_size,
            "sha256": digest(p), **extra}


@contextlib.contextmanager
def output(destination, suffixes=None):
    p = path(destination, existing=False, suffixes=suffixes)
    fd, name = tempfile.mkstemp(prefix=".soot-", suffix=p.suffix, dir=p.parent)
    os.close(fd)
    temp = Path(name)
    try:
        yield temp
        require(temp.is_file() and temp.stat().st_size > 0, "empty output")
        require(not p.parent.is_symlink() and p.parent.resolve().is_relative_to(root()),
                "output parent changed")
        os.chmod(temp, 0o600)
        with temp.open("rb") as f:
            os.fsync(f.fileno())
        try:
            os.link(temp, p)  # atomic publication without overwriting an existing file
        except FileExistsError:
            raise ToolError("output already exists; choose a new path") from None
    finally:
        temp.unlink(missing_ok=True)


def zip_guard(p):
    import zipfile
    with zipfile.ZipFile(p) as z:
        info = z.infolist()
        require(len(info) <= 10000 and sum(i.file_size for i in info) <= 128 * 1024 * 1024,
                "Office archive exceeds expanded size limit")
        require(all(i.file_size <= 32 * 1024 * 1024 and not i.flag_bits & 1 and
                    (i.file_size < 1024 * 1024 or i.file_size <= max(i.compress_size, 1) * 300)
                    for i in info), "Office archive is encrypted or over-compressed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint(value):
    string(value, "host endpoint", 2048)
    u = urllib.parse.urlsplit(value)
    require(u.hostname and not u.username and not u.password and not u.query and not u.fragment,
            "invalid host endpoint")
    require(u.scheme == "https" or (u.scheme == "http" and u.hostname in
            ("localhost", "127.0.0.1", "::1")), "endpoint needs HTTPS or explicit loopback HTTP")
    return value.rstrip("/")


def http(url, method="GET", data=None, token=None, maximum=8 * 1024 * 1024,
         timeout=90, mutation=False, headers=None):
    h = dict(headers or {})
    if token:
        string(token, "host token", 16000)
        h["Authorization"] = "Bearer " + token
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        h["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=h, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            result = response.read(maximum + 1)
            if len(result) > maximum:
                if mutation:
                    raise Uncertain("mutation response exceeds size limit; reconcile before retry")
                raise ToolError("remote response exceeds size limit")
            return result, response.headers
    except urllib.error.HTTPError as e:
        if mutation and (e.code >= 500 or e.code == 408):
            raise Uncertain("remote mutation outcome unknown; reconcile before retry") from None
        raise ToolError(f"remote service returned HTTP {e.code}") from None
    except (OSError, TimeoutError):
        if mutation:
            raise Uncertain("remote mutation outcome unknown; reconcile before retry") from None
        raise ToolError("remote service unavailable or timed out") from None


def json_response(raw, mutation=False):
    try:
        result = json.loads(raw)
        require(isinstance(result, dict), "remote response must be an object")
        return result
    except (ValueError, ToolError):
        if mutation:
            raise Uncertain("invalid mutation response; reconcile before retry") from None
        raise ToolError("invalid JSON service response") from None


def invoke(pack_id, operations):
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in operations, "unknown operation")
        raw = sys.stdin.buffer.read(128 * 1024 + 1)
        require(len(raw) <= 128 * 1024, "tool envelope too large")
        call = json.loads(raw)
        require(isinstance(call, dict) and call.get("api_version") == "soot/v1" and
                call.get("hook") == "tool.call" and isinstance(call.get("soot"), str)
                and bool(call["soot"]), "invalid soot/v1 tool envelope")
        operation = sys.argv[1]
        require(call.get("operation") == f"{pack_id}_{operation}", "operation mismatch")
        args = call.get("input")
        require(isinstance(args, dict), "input must be an object")
        require(len(json.dumps(args).encode()) <= 16 * 1024, "input exceeds 16 KiB")
        result = operations[operation](args)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, default=str)
        require(len(encoded.encode()) <= 256 * 1024, "tool result too large; reduce the requested page/range limit")
        print(encoded)
    except Uncertain as e:
        print(json.dumps({"error": str(e), "outcome": "unknown"}), file=sys.stderr)
        sys.exit(2)
    except ToolError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    except ImportError:
        print('{"error":"dependency missing; follow pack setup instructions"}', file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Library exceptions can embed host credentials, paths or untrusted content.
        print('{"error":"invalid input or processing failed; inspect the source file and service"}', file=sys.stderr)
        sys.exit(1)
