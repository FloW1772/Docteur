"""MG-4 — Docteur-owned filesystem policy for safe text-only code generation.

WriteCode/MetaGPT never writes the final file directly. The content it
produces (CodingContext.code_doc.content) is treated as UNTRUSTED DATA —
Docteur alone decides the final path, validates it, enforces size/count
limits and extension allowlist, computes the manifest, and performs the
actual write, always strictly under:

    cortex-server/data/metagpt-workspaces/<job-id>/generated/

Mirrors the canonicalization/containment approach already used in
metagpt_policy.py (authorize_tool_arguments) and openmontage-policy.js,
but this module is standalone: it is never given a role_instance or a
tool_execution_map, only a relative path + content string proposed by the
untrusted generated text.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath


class CodegenPolicyError(Exception):
    pass


ALLOWED_EXTENSIONS = frozenset({
    ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json", ".md",
})

MAX_FILES_PER_JOB = 10
MAX_BYTES_PER_FILE = 100 * 1024
MAX_TOTAL_BYTES_PER_JOB = 500 * 1024

FORBIDDEN_PATH_SUBSTRINGS = (
    ".git",
    ".env",
    "cortex.sqlite",
    "secret-store",
    str(Path("external") / "MetaGPT"),
    "appdata",
    ".ssh",
    ".aws",
    ".claude",
    "certs",
)


def _canonicalize_relative_path(raw: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise CodegenPolicyError("path_empty")
    normalized = unicodedata.normalize("NFC", raw).strip()
    if any(ord(c) < 0x20 for c in normalized):
        raise CodegenPolicyError("path_control_char")
    return normalized


def _reject_unc_and_absolute(raw: str) -> None:
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise CodegenPolicyError("unc_path_denied")
    if raw.startswith("\\") or raw.startswith("/"):
        raise CodegenPolicyError("absolute_path_denied")
    # Windows drive-letter absolute path, e.g. "C:\\dev\\Docteur\\..."
    if PureWindowsPath(raw).drive:
        raise CodegenPolicyError("absolute_path_denied")


def resolve_generated_path(job_generated_root: str, relative_path: str) -> Path:
    """Canonicalizes `relative_path` (as proposed by untrusted LLM-generated
    content — e.g. a filename the model itself suggested) and resolves it
    strictly inside job_generated_root. Raises CodegenPolicyError on ANY
    attempt to escape (../, absolute path, UNC, drive letter, symlink
    traversal) or reference a forbidden substring. Deny by default."""
    root = Path(job_generated_root).resolve()
    canonical = _canonicalize_relative_path(relative_path)
    _reject_unc_and_absolute(canonical)

    candidate = Path(canonical)
    if candidate.is_absolute():
        raise CodegenPolicyError("absolute_path_denied")

    resolved = (root / candidate).resolve()
    try:
        rel_to_root = resolved.relative_to(root)
    except ValueError:
        raise CodegenPolicyError("path_escape_denied")

    # Forbidden substrings are checked ONLY against the relative portion
    # (what the untrusted content actually proposed), never against the
    # full absolute path — job_generated_root itself legitimately lives
    # under a path that may contain substrings like "appdata" (e.g. a test
    # tempdir, or Docteur's own data directory structure), which must not
    # cause a false DENY.
    lower_relative = rel_to_root.as_posix().lower()
    for needle in FORBIDDEN_PATH_SUBSTRINGS:
        if needle.lower() in lower_relative:
            raise CodegenPolicyError("forbidden_path_denied")

    # Reject symlink/junction escape for any already-existing path segment.
    current = root
    rel_parts = rel_to_root.parts
    for part in rel_parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise CodegenPolicyError("symlink_escape_denied")

    suffix = resolved.suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise CodegenPolicyError(f"extension_denied:{suffix or '(none)'}")

    return resolved


@dataclass
class GeneratedFileRecord:
    path: str  # relative, forward-slash, as stored in the manifest
    size: int
    sha256: str


@dataclass
class CodegenJobWriter:
    """Accumulates validated writes for one MG-4 job and produces the
    manifest. Enforces MAX_FILES_PER_JOB / MAX_BYTES_PER_FILE /
    MAX_TOTAL_BYTES_PER_JOB. Every file that lands under generated/ MUST
    go through this writer — no other code path may write there."""

    job_id: str
    job_generated_root: str
    _records: list = field(default_factory=list)
    _total_bytes: int = 0

    def write_text_file(self, relative_path: str, content: str) -> GeneratedFileRecord:
        if not isinstance(content, str):
            raise CodegenPolicyError("content_must_be_text")

        encoded = content.encode("utf-8")
        size = len(encoded)

        if len(self._records) >= MAX_FILES_PER_JOB:
            raise CodegenPolicyError(f"max_files_per_job_exceeded:{MAX_FILES_PER_JOB}")
        if size > MAX_BYTES_PER_FILE:
            raise CodegenPolicyError(f"max_bytes_per_file_exceeded:{size}>{MAX_BYTES_PER_FILE}")
        if self._total_bytes + size > MAX_TOTAL_BYTES_PER_JOB:
            raise CodegenPolicyError(
                f"max_total_bytes_per_job_exceeded:{self._total_bytes + size}>{MAX_TOTAL_BYTES_PER_JOB}"
            )

        resolved = resolve_generated_path(self.job_generated_root, relative_path)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(encoded)

        root = Path(self.job_generated_root).resolve()
        rel_posix = resolved.relative_to(root).as_posix()
        sha256 = hashlib.sha256(encoded).hexdigest()

        record = GeneratedFileRecord(path=rel_posix, size=size, sha256=sha256)
        self._records.append(record)
        self._total_bytes += size
        return record

    def manifest(self) -> dict:
        return {
            "job_id": self.job_id,
            "files": [
                {"path": r.path, "size": r.size, "sha256": r.sha256}
                for r in self._records
            ],
        }

    def write_manifest(self) -> Path:
        """Writes manifest.json at the job_generated_root's parent level
        (sibling of generated/, not inside it, so it is never mistaken for
        a generated source file itself)."""
        manifest_path = Path(self.job_generated_root).resolve().parent / "manifest.json"
        manifest_path.write_text(json.dumps(self.manifest(), indent=2), encoding="utf-8")
        return manifest_path

    def verify_no_unlisted_files(self) -> list:
        """Walks job_generated_root and returns any file path NOT present
        in the manifest — should always be empty. Defense-in-depth check
        against a bug that wrote outside write_text_file()."""
        root = Path(self.job_generated_root).resolve()
        if not root.exists():
            return []
        manifest_paths = {r.path for r in self._records}
        unlisted = []
        for p in root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                if rel not in manifest_paths:
                    unlisted.append(rel)
        return unlisted
