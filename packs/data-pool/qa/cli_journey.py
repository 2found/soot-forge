#!/usr/bin/env python3
"""Real soot add/run journey with an isolated PostgreSQL database and scripted provider.

No paid model, deployment, global Soot installation, or existing runtime is used.
Every owned process/thread is joined even when a check fails.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sys
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body["messages"]
        last = messages[-1]
        delta = {"role": "assistant"}
        reason = "stop"
        system = str(messages[0].get("content", ""))
        if "Distill reusable lessons" in system:
            delta["content"] = '{"changes":[]}'
        elif "Review the agent's proposed final answer" in system:
            delta["content"] = '{"notes":[]}'
        elif last["role"] == "tool":
            content = last["content"]
            if not isinstance(content, str):
                content = json.dumps(content)
            delta["content"] = content + "\nSTATUS: DONE"
        else:
            user = next(m for m in reversed(messages) if m["role"] == "user")
            text = user["content"]
            if isinstance(text, list):
                text = "".join(b.get("text", "") for b in text)
            try:
                task = json.loads(text)
                if "tool" not in task:
                    event = task.get("event", task)
                    task = json.loads(event.get("text", "{}"))
            except (json.JSONDecodeError, TypeError):
                delta["content"] = "No scripted task"
            else:
                if "tool" not in task:
                    raise AssertionError("unrecognized scripted event shape: " + text[:1000])
                delta["tool_calls"] = [{"index": 0, "id": "qa-call", "type": "function", "function": {
                    "name": task["tool"], "arguments": json.dumps(task["input"], ensure_ascii=False)
                }}]
                reason = "tool_calls"
        payload = {"id": "qa", "object": "chat.completion.chunk", "model": "qa-scripted", "choices": [
            {"index": 0, "delta": delta, "finish_reason": reason}
        ]}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(("data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n").encode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--soot", required=True, type=Path)
    ap.add_argument("--database-url", default=os.environ.get("DATA_POOL_TEST_DATABASE_URL"),
                    help="disposable PostgreSQL database (or DATA_POOL_TEST_DATABASE_URL); the journey creates schema data_pool")
    ap.add_argument("--runner", required=True, type=Path)
    ap.add_argument("--shared", action="store_true", help="two independent Soot hosts using one data-pool service")
    args = ap.parse_args()
    if not args.database_url:
        ap.error("supply --database-url or DATA_POOL_TEST_DATABASE_URL with a disposable PostgreSQL database")
    args.soot, args.runner = [p.resolve() for p in (args.soot, args.runner)]
    pack = Path(__file__).resolve().parents[1]
    processes = []
    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=provider.serve_forever)
    thread.start()
    cases = []
    try:
        with tempfile.TemporaryDirectory(prefix="soot-data-pool-qa-") as tmp:
            root = Path(tmp)
            env = os.environ.copy()
            env.update(SOOT_HOME=str(root / "soot-home"), SOOT_API_TOKEN="synthetic-runtime-token-1234567890", QA_MODEL_KEY="synthetic-model-key-1234567890")
            soot_addr = "127.0.0.1:" + str(port())
            binding = {"database_url": args.database_url, "namespace": "qa-company",
                       "soots": ["data-manager", "marketing", "support", "outsider"], "managers": ["data-manager"]}
            env["QA_DATA_POOL"] = json.dumps(binding)
            log = open(root / "processes.log", "wb")

            def boot(argv, host=None, hostenv=None):
                process = subprocess.Popen([str(x) for x in argv], env=hostenv or env, cwd=host or root, stdout=log, stderr=log)
                processes.append(process)
                return process

            def stop(process):
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)

            def ready(url, process):
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise AssertionError("owned process exited before readiness")
                    try:
                        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + env["SOOT_API_TOKEN"]})
                        with urllib.request.urlopen(req, timeout=1) as response:
                            if response.status == 200:
                                return
                    except (OSError, urllib.error.URLError):
                        time.sleep(.05)
                raise AssertionError("isolated local target did not become ready")

            def cli(*argv, host=None, hostenv=None):
                result = subprocess.run([str(args.soot), *[str(x) for x in argv]], env=hostenv or env, cwd=host or root,
                                        capture_output=True, text=True, timeout=35)
                if result.returncode:
                    raise AssertionError("CLI failed: " + result.stderr[:1500] + " " + result.stdout[:1500])
                return result.stdout

            if args.shared:
                backend_config = root / "backend.json"
                backend_config.write_text(json.dumps(binding))
                backend_config.chmod(0o600)
                gateway_url = "http://127.0.0.1:" + str(port())
                private = root / "shared-private"
                rendered = subprocess.run([sys.executable, str(pack / "operator" / "configure-service.py"),
                    "--backend-config", str(backend_config), "--service-url", gateway_url,
                    "--listen", gateway_url.removeprefix("http://"), "--output-dir", str(private)], capture_output=True, text=True, timeout=10)
                assert rendered.returncode == 0, rendered.stderr
                assert (private / "service.json").stat().st_mode & 0o077 == 0
                assert (private / "bindings" / "marketing.json").stat().st_mode & 0o077 == 0
                gateway = boot([args.runner, "serve", "--config", private / "service.json"])
                ready(gateway_url + "/healthz", gateway)
                for actor in binding["soots"]:
                    env["QA_POOL_" + actor.replace("-", "_").upper()] = (private / "bindings" / (actor + ".json")).read_text()
                # No direct database credential or local policy binding reaches Soot.
                del env["QA_DATA_POOL"]
                cases.append("Operator config renderer created private per-Soot credentials without installing infrastructure")
            deployment = {"listen": soot_addr, "data_dir": "runtime-data", "packs_dir": "packs", "model": {"provider": "demo"},
                          "soots": ["soots/" + s + ".json" for s in binding["soots"]]}
            (root / "soots").mkdir()
            for s in binding["soots"]:
                (root / "soots" / (s + ".json")).write_text(json.dumps({"id": s, "packs": []}))
            (root / "deployment.json").write_text(json.dumps(deployment))
            staged = root / "data-pool"
            shutil.copytree(pack, staged, ignore=shutil.ignore_patterns("bin", "__pycache__", "*.db"))
            (staged / "bin").mkdir()
            shutil.copy2(args.runner, staged / "bin" / "soot-data-pool")
            archive = root / "data-pool.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                tf.add(staged, arcname="data-pool")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            cli("add", archive, "--sha256", digest, "--config", root / "deployment.json")
            effective = cli("check", "--show", "--json", "--config", root / "deployment.json")
            if "data-pool_query" in effective:
                raise AssertionError("install implicitly granted tools")
            cases.append("Install verified archive through soot add; installation granted no tools")

            example = root / "consumer-example"
            shutil.copytree(pack / "examples", example)
            shutil.copytree(root / "packs", example / "packs")
            cli("check", "--show", "--json", "--config", example / "deployment.json")
            cases.append("Unselected consumer example validates without premature credential grants")

            selected = {"data-manager": ["read", "write", "manage"], "marketing": ["read"], "support": ["read"], "outsider": []}
            credentials = {}
            for s, caps in selected.items():
                (root / "soots" / (s + ".json")).write_text(json.dumps({"id": s, "packs": ([] if not caps else ["data-pool" if "manage" in caps else "data-pool:read"])}))
                operations = ["data-pool_" + op for op in (["pools", "query", "status"] if "read" in caps else []) +
                              (["write"] if "write" in caps else []) + (["manage"] if "manage" in caps else [])]
                if operations:
                    credentials[s] = {"DATA_POOL": {"env": "QA_POOL_" + s.replace("-", "_").upper() if args.shared else "QA_DATA_POOL", "operations": operations}}
            deployment.update(model={"provider": "qa", "name": "qa-scripted"},
                              providers={"qa": {"type": "openai", "base_url": "http://127.0.0.1:" + str(provider.server_port), "key_env": "QA_MODEL_KEY"}},
                              credentials=credentials)
            (root / "deployment.json").write_text(json.dumps(deployment))
            cli("check", "--secrets", "--json", "--config", root / "deployment.json")
            runtime = boot([args.soot, "serve", "--config", root / "deployment.json"])
            ready("http://" + soot_addr + "/healthz", runtime)

            if args.shared:
                vm_root = root / "vm-host"
                vm_root.mkdir()
                shutil.copytree(root / "soots", vm_root / "soots")
                shutil.copytree(root / "packs", vm_root / "packs")
                vm_addr = "127.0.0.1:" + str(port())
                vm_env = dict(env, SOOT_HOME=str(vm_root / "soot-home"), SOOT_API_TOKEN="synthetic-vm-runtime-token-1234567890")
                vm_deployment = dict(deployment, listen=vm_addr, soots=["soots/marketing.json", "soots/support.json"],
                    credentials={actor: credentials[actor] for actor in ("marketing", "support")})
                (vm_root / "deployment.json").write_text(json.dumps(vm_deployment))
                cli("check", "--secrets", "--json", "--config", vm_root / "deployment.json", host=vm_root, hostenv=vm_env)
                vm_runtime = boot([args.soot, "serve", "--config", vm_root / "deployment.json"], vm_root, vm_env)
                ready("http://" + vm_addr + "/healthz", vm_runtime)
                cases.append("Two independent Soot runtime stores and homes connected to one authoritative service")

            def run(actor, op, data, denied=False, trigger_pad="", vm=None):
                task = json.dumps({"tool": "data-pool_" + op, "input": data, "context": trigger_pad}, ensure_ascii=False)
                on_vm = args.shared and (vm if vm is not None else actor == "support")
                result = json.loads(cli("run", "--url", "http://" + (vm_addr if on_vm else soot_addr), "--token-env", "SOOT_API_TOKEN", "--soot", actor, "--json", task,
                    host=vm_root if on_vm else root, hostenv=vm_env if on_vm else env))
                text = result["text"]
                if denied:
                    if not any(s in text.lower() for s in ["denied", "not found", "not granted", "unknown tool", "not allowed", "unavailable", "invalid input", "validation", "not public", "read limit must fit"]):
                        raise AssertionError("denial missing from tool result: " + text[:1000])
                    return text
                # Soot executable output may carry a tool/result wrapper; locate
                # the JSON object emitted by the runner inside the transcript.
                decoder = json.JSONDecoder()
                for i, ch in enumerate(text):
                    if ch == "{":
                        try:
                            value, _ = decoder.raw_decode(text[i:])
                            if any(k in value for k in ("status", "hits", "pools", "content", "documents", "grants")):
                                return value
                        except (ValueError, TypeError):
                            pass
                raise AssertionError("runner JSON not returned through real CLI: " + text[:1500])

            run("outsider", "query", {"action": "search", "pool": "company", "query": "company"}, denied=True)
            run("data-manager", "manage", {"action": "pool_create", "pool": "company", "name": "Company", "request_id": "create"})
            assert run("marketing", "pools", {})["pools"] == []
            run("marketing", "query", {"action": "search", "pool": "company", "query": "company"}, denied=True)
            for actor in ("marketing", "support"):
                run("data-manager", "manage", {"action": "grant", "pool": "company", "soot": actor, "level": "read", "request_id": "grant-" + actor})
            imported = {"action": "upsert", "pool": "company", "id": "handbook", "title": "Company handbook", "content": "Doanh nghiệp Việt Nam có chính sách hỗ trợ khách hàng. Đường dẫn thương hiệu.", "source": "urn:company:handbook", "request_id": "import"}
            assert run("data-manager", "write", imported)["status"] == "succeeded"
            assert run("data-manager", "write", imported)["document"]["revision"] == 1
            web = {"action": "upsert", "pool": "company", "id": "web-overview", "title": "Public page snapshot", "url": "https://example.com", "request_id": "web-import"}
            assert run("data-manager", "write", web)["status"] == "succeeded"
            saved_web = run("support", "query", {"action": "read", "pool": "company", "id": "web-overview"})
            assert saved_web["document"]["source"] == "https://example.com" and "documentation examples" in saved_web["content"]
            cases.append("Explicit public webpage imported once with provenance; support read its saved snapshot")
            for actor in ("marketing", "support"):
                hits = run(actor, "query", {"action": "search", "pool": "company", "query": "doanh nghiemp"})["hits"]
                assert len(hits) == 1 and hits[0]["document"]["source"] == "urn:company:handbook"
                assert "Việt Nam" in run(actor, "query", {"action": "read", "pool": "company", "id": "handbook"})["content"]
            if args.shared:
                assert "Việt Nam" in run("marketing", "query", {"action": "read", "pool": "company", "id": "handbook"}, vm=True)["content"]
            escaped = dict(imported, id="escaped", request_id="escaped", content="<" * 500)
            assert run("data-manager", "write", escaped, trigger_pad="<" * 6000)["status"] == "succeeded"
            assert run("support", "query", {"action": "read", "pool": "company", "id": "escaped", "limit": 4})["content"] == "<<<<"
            unicode_doc = dict(imported, id="unicode", request_id="unicode", content="Đ😀")
            assert run("data-manager", "write", unicode_doc)["status"] == "succeeded"
            run("support", "query", {"action": "read", "pool": "company", "id": "unicode", "limit": 1}, denied=True)
            assert run("support", "query", {"action": "read", "pool": "company", "id": "unicode", "limit": 4})["next_offset"] == 2
            cases.append("Escaped legal trigger works through host envelope; undersized UTF-8 read errors instead of stalling")
            cases.append("Two Soots reused one imported company document; typo/accent search and source/revision citations PASS")
            run("marketing", "write", {"action": "remove", "pool": "company", "id": "handbook", "request_id": "forbidden"}, denied=True)
            run("marketing", "query", {"action": "search", "pool": "company", "query": "company", "soot": "data-manager"}, denied=True)
            run("data-manager", "write", {"action": "upsert", "pool": "company", "id": "private-url", "title": "Private", "url": "http://127.0.0.1", "request_id": "private-url"}, denied=True)
            run("data-manager", "manage", {"action": "revoke", "pool": "company", "soot": "marketing", "request_id": "revoke"})
            run("marketing", "query", {"action": "read", "pool": "company", "id": "handbook"}, denied=True)
            if args.shared:
                run("marketing", "query", {"action": "read", "pool": "company", "id": "handbook"}, denied=True, vm=True)
                cases.append("One grant revocation blocked the same identity on both independent hosts")
            cases.append("Ungrant, read-only write denial, forged identity field, private source and revoked read denied")
            stop(runtime)
            if args.shared:
                stop(vm_runtime)
                stop(gateway)
                gateway = boot([args.runner, "serve", "--config", private / "service.json"])
                ready(gateway_url + "/healthz", gateway)
                vm_runtime = boot([args.soot, "serve", "--config", vm_root / "deployment.json"], vm_root, vm_env)
                ready("http://" + vm_addr + "/healthz", vm_runtime)
                cases.append("Service restart preserved one shared data pool in PostgreSQL")
            runtime = boot([args.soot, "serve", "--config", root / "deployment.json"])
            ready("http://" + soot_addr + "/healthz", runtime)
            assert "Việt Nam" in run("support", "query", {"action": "read", "pool": "company", "id": "handbook"})["content"]
            changed = dict(imported, content="Chính sách hoàn tiền trong ba mươi ngày.", request_id="update")
            assert run("data-manager", "write", changed)["document"]["revision"] == 2
            assert run("support", "query", {"action": "search", "pool": "company", "query": "hoan tien"})["hits"]
            assert run("data-manager", "write", {"action": "remove", "pool": "company", "id": "handbook", "request_id": "remove"})["status"] == "succeeded"
            assert not run("support", "query", {"action": "search", "pool": "company", "query": "hoan tien"})["hits"]
            cases.append("Runtime restart retained data/grants; update advanced revision; completed delete removed indexed content")
            run("data-manager", "manage", {"action": "pool_remove", "pool": "company", "request_id": "pool-remove"})
            run("data-manager", "manage", {"action": "pool_create", "pool": "company", "name": "Replacement", "request_id": "replacement"})
            run("data-manager", "manage", {"action": "grant", "pool": "company", "soot": "support", "level": "manage", "request_id": "replacement-manager"})
            run("support", "status", {"owner": "data-manager", "request_id": "import"}, denied=True)
            cases.append("Replacement-pool manager denied historical receipt metadata from deleted generation")
            for process in reversed(processes):
                stop(process)
            log.close()
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)
        if thread.is_alive() or any(p.poll() is None for p in processes):
            raise AssertionError("owned QA resource survived cleanup")
    for case in cases:
        print("PASS:", case)
    print("CLEANUP: exact owned Soot/data-pool processes exited; scripted provider threads joined; temporary state removed; pre-existing resources retained")


if __name__ == "__main__":
    main()
