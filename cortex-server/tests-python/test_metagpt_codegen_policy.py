"""MG-4 — sentinel tests for metagpt_codegen_policy.py (path containment,
extension allowlist, size limits). Pure Python, no MetaGPT import required.

Run:
    python -m pytest cortex-server/tests-python/test_metagpt_codegen_policy.py -v
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "lib"))

from metagpt_codegen_policy import (  # noqa: E402
    CodegenJobWriter,
    CodegenPolicyError,
    resolve_generated_path,
    MAX_FILES_PER_JOB,
    MAX_BYTES_PER_FILE,
    MAX_TOTAL_BYTES_PER_JOB,
)


class TestPathContainment(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = str(Path(self._tmp.name) / "generated")
        Path(self.root).mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self._tmp.cleanup()

    def test_pass_simple_relative_path(self):
        resolved = resolve_generated_path(self.root, "src/App.tsx")
        self.assertTrue(str(resolved).endswith("App.tsx"))

    def test_deny_parent_traversal(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "../App.tsx")

    def test_deny_absolute_windows_path(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, r"C:\dev\Docteur\App.tsx")

    def test_deny_git_config(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, ".git/config")

    def test_deny_dotenv(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, ".env")

    def test_deny_unc_path(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, r"\\server\share\x.ts")

    def test_deny_unc_path_forward_slash(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "//server/share/x.ts")

    def test_deny_disallowed_extension(self):
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "script.exe")
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "script.ps1")
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "script.sh")
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "script.bat")

    def test_pass_all_allowed_extensions(self):
        for ext in (".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json", ".md"):
            resolve_generated_path(self.root, f"file{ext}")

    def test_deny_symlink_escape(self):
        # Create a symlink inside root pointing outside, then try to write through it.
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        link = Path(self.root) / "escape_link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self._assert_symlink_escape_denied_via_mock()
            return
        with self.assertRaises(CodegenPolicyError):
            resolve_generated_path(self.root, "escape_link/evil.ts")

    def _assert_symlink_escape_denied_via_mock(self):
        """Fallback for environments without symlink privilege (e.g. non-elevated
        Windows accounts): proves the same code path (Path.is_symlink() check on
        each existing path segment) denies escape, using unittest.mock instead
        of a real filesystem symlink."""
        from unittest.mock import patch

        link_dir = Path(self.root) / "escape_link"
        link_dir.mkdir()

        real_is_symlink = Path.is_symlink

        def fake_is_symlink(self_path):
            if self_path == link_dir:
                return True
            return real_is_symlink(self_path)

        with patch.object(Path, "is_symlink", fake_is_symlink):
            with self.assertRaises(CodegenPolicyError):
                resolve_generated_path(self.root, "escape_link/evil.ts")


class TestDangerousContentStoredNotExecuted(unittest.TestCase):
    """MG-4I: dangerous-looking content (child_process.exec, subprocess.run,
    os.system, rm/del) must be storable as plain text. This test does not
    (and must not) execute any of it — it only proves the writer stores it
    byte-for-byte as data."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = str(Path(self._tmp.name) / "generated")
        Path(self.root).mkdir(parents=True, exist_ok=True)
        self.writer = CodegenJobWriter(job_id="test-job", job_generated_root=self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_dangerous_content_stored_as_text_only(self):
        dangerous = (
            "const { exec } = require('child_process');\n"
            "exec('rm -rf /');\n"
            "import subprocess\n"
            "subprocess.run(['del', '/f', 'C:\\\\'])\n"
            "os.system('shutdown now')\n"
        )
        record = self.writer.write_text_file("src/dangerous.js", dangerous)
        written = (Path(self.root) / "src" / "dangerous.js").read_text(encoding="utf-8")
        self.assertEqual(written, dangerous)
        self.assertEqual(record.size, len(dangerous.encode("utf-8")))


class TestLimits(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = str(Path(self._tmp.name) / "generated")
        Path(self.root).mkdir(parents=True, exist_ok=True)
        self.writer = CodegenJobWriter(job_id="test-job", job_generated_root=self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_max_files_per_job(self):
        for i in range(MAX_FILES_PER_JOB):
            self.writer.write_text_file(f"file{i}.md", "x")
        with self.assertRaises(CodegenPolicyError):
            self.writer.write_text_file("one_too_many.md", "x")

    def test_max_bytes_per_file(self):
        with self.assertRaises(CodegenPolicyError):
            self.writer.write_text_file("big.md", "x" * (MAX_BYTES_PER_FILE + 1))

    def test_max_total_bytes_per_job(self):
        # Each chunk stays under MAX_BYTES_PER_FILE individually, but 6 of
        # them exceed MAX_TOTAL_BYTES_PER_JOB (500KB) in aggregate.
        chunk = "x" * (MAX_BYTES_PER_FILE - 1024)  # ~99KB per file
        for i in range(5):
            self.writer.write_text_file(f"chunk{i}.md", chunk)
        with self.assertRaises(CodegenPolicyError):
            self.writer.write_text_file("one_too_many.md", chunk)


class TestManifest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = str(Path(self._tmp.name) / "generated")
        Path(self.root).mkdir(parents=True, exist_ok=True)
        self.writer = CodegenJobWriter(job_id="job-abc", job_generated_root=self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_manifest_lists_every_written_file(self):
        self.writer.write_text_file("src/App.tsx", "export default function App() {}")
        self.writer.write_text_file("README.md", "# Todo app")
        manifest = self.writer.manifest()
        self.assertEqual(manifest["job_id"], "job-abc")
        paths = {f["path"] for f in manifest["files"]}
        self.assertEqual(paths, {"src/App.tsx", "README.md"})
        for f in manifest["files"]:
            self.assertIn("sha256", f)
            self.assertIn("size", f)

    def test_no_unlisted_files_after_normal_writes(self):
        self.writer.write_text_file("src/App.tsx", "x")
        self.assertEqual(self.writer.verify_no_unlisted_files(), [])

    def test_unlisted_file_detected(self):
        self.writer.write_text_file("src/App.tsx", "x")
        (Path(self.root) / "sneaky.md").write_text("not in manifest", encoding="utf-8")
        unlisted = self.writer.verify_no_unlisted_files()
        self.assertEqual(unlisted, ["sneaky.md"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
