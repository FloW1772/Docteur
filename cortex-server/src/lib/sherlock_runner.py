"""Docteur-only runner: JSON input, structured output, no CLI or sockets."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time

SOURCE_SHA = "a38ba54fda799cd786a2ab67a50143e1a63169e6"
DB_SHA256 = "3fdfc6694c5cd99798881215554b09e617c6d5284a6219fae309882566a9fb30"


def install_guard(workspace: Path, source: Path):
    read_roots = [workspace.resolve(), source.resolve(), Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve()]
    runner = Path(__file__).resolve()

    def inside(target, root):
        return target == root or root in target.parents

    def check(raw, writing=False):
        if isinstance(raw, int):
            if raw not in (0, 1, 2):
                raise PermissionError("file_descriptor_denied")
            return
        target = Path(os.fsdecode(raw)).resolve()
        if writing:
            if not inside(target, workspace):
                raise PermissionError("filesystem_write_denied")
        elif target != runner and not any(inside(target, root) for root in read_roots):
            raise PermissionError("filesystem_read_denied")

    def audit(event, args):
        if event.startswith("socket.") or event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile", "os.startfile/2", "ctypes.dlsym"):
            raise PermissionError("process_or_network_denied")
        if event == "open":
            mode = args[1] or ""
            flags = args[2] or 0
            writing = any(c in str(mode) for c in "wax+") or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
            check(args[0], bool(writing))
        elif event in ("os.listdir", "os.scandir"):
            check(args[0] or os.curdir)
        elif event in ("os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.utime", "os.truncate"):
            check(args[0], True)
        elif event in ("os.rename", "os.link", "os.symlink"):
            check(args[0], True)
            check(args[1], True)
    sys.addaudithook(audit)
    return check


def main():
    if len(sys.argv) != 2:
        raise ValueError("runner_arguments_denied")
    workspace = Path(sys.argv[1]).resolve()
    source = Path(__file__).resolve().parents[3] / "external" / "Sherlock-source" / SOURCE_SHA
    if Path.home().resolve() != workspace / "home":
        raise PermissionError("home_sandbox_required")
    request = json.loads(sys.stdin.readline(32768))
    username = request["username"]
    if not isinstance(username, str) or not 1 <= len(username) <= 64 or username.startswith(("-", ".")) or any(not (c.isalnum() or c in "_.-") for c in username) or ".." in username:
        raise ValueError("username_invalid")
    data_file = source / "sherlock_project/resources/data.json"
    if hashlib.sha256(data_file.read_bytes()).hexdigest() != DB_SHA256:
        raise PermissionError("site_database_changed")
    all_sites = json.loads(data_file.read_text(encoding="utf-8"))
    names = request["sites"]
    if not isinstance(names, list) or not 1 <= len(names) <= 30 or any(name not in all_sites for name in names):
        raise ValueError("site_filter_invalid")

    # Trusted dependencies load with -I/-B, dedicated HOME and venv. Imports
    # are not the untrusted network phase; the guard is installed before
    # importing any Sherlock module or processing site data.
    import requests
    import pandas  # noqa: F401 (preload native dependencies before audit)
    import requests_futures.sessions  # noqa: F401
    import colorama  # noqa: F401
    import tomli  # noqa: F401
    install_guard(workspace, source)
    sys.path.insert(0, str(source))
    from sherlock_project.sherlock import sherlock
    from sherlock_project.notify import QueryNotify

    lock = threading.Lock()
    sequence = 0

    def broker_request(self, method, url, **kwargs):
        nonlocal sequence
        if method.upper() not in ("GET", "HEAD") or kwargs.get("json") or kwargs.get("data") or kwargs.get("proxies"):
            raise requests.RequestException("http_method_denied")
        with lock:
            sequence += 1
            started = time.monotonic()
            sys.stdout.write(json.dumps({"kind": "http", "id": sequence, "method": method.upper(), "url": url, "redirects": kwargs.get("allow_redirects", True)}) + "\n")
            sys.stdout.flush()
            raw = sys.stdin.readline(800000)
            reply = json.loads(raw)
            if reply.get("id") != sequence or not reply.get("ok"):
                raise requests.RequestException("network_request_denied_or_failed")
            response = requests.Response()
            response.status_code = reply["response"]["status"]
            response.url = reply["response"]["url"]
            response._content = base64.b64decode(reply["response"]["body"], validate=True)
            response.encoding = "utf-8"
            response.elapsed = time.monotonic() - started
            return response

    requests.sessions.Session.request = broker_request
    results = []

    class Notifier(QueryNotify):
        def update(self, result):
            statuses = {"Claimed": "found", "Available": "absent", "Illegal": "invalid", "Unknown": "error", "WAF": "error"}
            results.append({"site": result.site_name, "status": statuses.get(str(result.status), "error"), "responseTime": result.query_time})

    sites = {}
    for name in names:
        entry = dict(all_sites[name])
        if entry.get("request_method", "GET") not in ("GET", "HEAD") or entry.get("request_payload"):
            raise PermissionError("site_method_denied")
        entry["headers"] = {}
        sites[name] = entry
    # No main(), SitesInformation(), QueryNotifyPrint(), exports or updates.
    sherlock(username, sites, Notifier(), dump_response=False, proxy=None, timeout=8)
    sys.stdout.write(json.dumps({"kind": "result", "results": results}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stdout.write(json.dumps({"kind": "error", "error": "sherlock_runner_failed"}) + "\n")
        sys.stdout.flush()
        sys.exit(1)
