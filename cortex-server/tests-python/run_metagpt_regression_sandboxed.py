"""Runs test_metagpt_xmlfill_regression.py (and test_metagpt_policy.py) with
the HOME/USERPROFILE sandbox required by any test that actually imports the
`metagpt` package (metagpt/config2.py executes Config.default() at module
load time and requires a syntactically-valid config2.yaml under the
sandboxed HOME — see reports/METAGPT_DOCTEUR_PATCHES_2026-09.md, MG-2E).

Tests that only read MetaGPT source as text (no import) don't strictly need
this, but running everything through the same sandboxed launcher keeps the
suite uniform and avoids ever accidentally touching the real user HOME.

Usage:
    python cortex-server/tests-python/run_metagpt_regression_sandboxed.py
"""
import subprocess
import os
import sys
from pathlib import Path

SANDBOX = r"C:\dev\Docteur\cortex-server\data\metagpt-home-test"
PYTHON = r"C:\dev\Docteur\external\MetaGPT\.venv\Scripts\python.exe"
TESTS_DIR = Path(__file__).resolve().parent

env = {
    "PATH": os.environ.get("PATH", ""),
    "SYSTEMROOT": os.environ.get("SYSTEMROOT", os.environ.get("windir", "C:\\Windows")),
    "PATHEXT": os.environ.get("PATHEXT", ""),
    "TEMP": SANDBOX + r"\tmp",
    "TMP": SANDBOX + r"\tmp",
    "HOME": SANDBOX,
    "USERPROFILE": SANDBOX,
    "HOMEDRIVE": SANDBOX[:2],
    "HOMEPATH": SANDBOX[2:],
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
}
os.makedirs(env["TEMP"], exist_ok=True)

targets = [
    TESTS_DIR / "test_metagpt_policy.py",
    TESTS_DIR / "test_metagpt_xmlfill_regression.py",
]

overall_ok = True
for target in targets:
    print(f"\n{'='*20} {target.name} {'='*20}")
    result = subprocess.run(
        [PYTHON, str(target), "-v"],
        cwd=r"C:\dev\Docteur\external\MetaGPT",
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    print(result.stdout)
    print(result.stderr)
    if result.returncode != 0:
        overall_ok = False

print(f"\n{'='*20} OVERALL: {'PASS' if overall_ok else 'FAIL'} {'='*20}")
sys.exit(0 if overall_ok else 1)
