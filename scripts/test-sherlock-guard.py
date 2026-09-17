"""Direct negative tests of application audit guards (not an OS sandbox)."""
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runner', root / 'cortex-server/src/lib/sherlock_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
workspace = root / 'cortex-server/data/sherlock-workspaces/guard-certification'
workspace.mkdir(parents=True, exist_ok=True)
source = root / 'external/Sherlock-source' / runner.SOURCE_SHA
real_home = Path.home()
runner.install_guard(workspace, source)
checks = 0
for action in [lambda: socket.socket(), lambda: subprocess.Popen([sys.executable, '-V']),
               lambda: os.system('echo forbidden'), lambda: (real_home / '.ssh/id_rsa').read_bytes(),
               lambda: (root / '.env').read_bytes(), lambda: (root / 'forbidden-write').write_text('forbidden'),
               lambda: list(real_home.iterdir()), lambda: (workspace / '../outside').write_text('forbidden')]:
    try:
        action()
        raise AssertionError('guard failed')
    except PermissionError:
        checks += 1
allowed = workspace / 'permitted.txt'
allowed.write_text('data')
assert allowed.read_text() == 'data'
allowed.unlink()
checks += 1
print(f'SHERLOCK Python guard: {checks}/{checks} PASS')
