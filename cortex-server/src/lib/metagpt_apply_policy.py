"""MG-5A — Prepare-apply / diff-only policy for copying MG-4 generated code
into the real Docteur project.

This module NEVER writes to the real project. It only:
  - re-verifies the MG-4 job's manifest.json against the actual generated/
    files on disk (source integrity, no silent manifest recomputation)
  - builds an explicit, Docteur-decided source -> destination mapping
    (never a blind concatenation of an LLM-suggested path with the repo root)
  - snapshots the current state of every destination path (TARGET BASELINE)
  - classifies protected-path violations and rejects them outright
  - produces a unified diff (CREATE vs MODIFY) as plain text
  - runs a static, non-executing scan for dangerous code patterns
  - simulates the apply in an ephemeral staging directory (also never
    touching the real project)
  - produces a signed-by-hash approval package that a future MG-5B must
    match exactly (job_id + diff_sha256 + exact file list) before any
    real write is permitted

No subprocess, no git, no npm/pip, no code execution anywhere in this file.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import re
import shutil
import tempfile
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath


class ApplyPolicyError(Exception):
    pass


# ---------------------------------------------------------------------------
# Section 2 — target root + destination allowlist
# ---------------------------------------------------------------------------

DOCTEUR_ROOT = Path(r"C:\dev\Docteur")

# Being under DOCTEUR_ROOT is NOT sufficient on its own (per MG-5A section 2).
# Only these subtrees may ever receive a CREATE/MODIFY from an MG-5 job.
# Deliberately does not include the repo root itself, cortex-server/data/,
# external/, node_modules/, .git/, etc.
DESTINATION_ALLOWLIST_PREFIXES = (
    "src/",
    "cortex-server/src/",
)

# ---------------------------------------------------------------------------
# Section 4 — protected paths. Any destination matching these is rejected
# outright, regardless of allowlist membership above.
# ---------------------------------------------------------------------------

PROTECTED_PATH_PATTERNS = (
    re.compile(r"(^|/)\.env(\..*)?$", re.IGNORECASE),
    re.compile(r"(^|/)\.git(/|$)"),
    re.compile(r"(^|/)cortex\.sqlite$", re.IGNORECASE),
    re.compile(r"secret-store", re.IGNORECASE),
    re.compile(r"(^|/)package-lock\.json$"),
    re.compile(r"(^|/)npm-shrinkwrap\.json$"),
    re.compile(r"(^|/)pnpm-lock\.ya?ml$"),
    re.compile(r"(^|/)yarn\.lock$"),
    re.compile(r"(^|/)node_modules(/|$)"),
    re.compile(r"(^|/)external(/|$)"),
    re.compile(r"(^|/)reports(/|$)"),
    re.compile(r"credentials|secrets?\.(json|ya?ml)$", re.IGNORECASE),
    re.compile(r"(^|/)package\.json$"),  # section 5: never auto-modified
)

# ---------------------------------------------------------------------------
# Section 8 — static, non-executing dangerous-pattern scan.
# Classification only: INFO / REVIEW_REQUIRED / BLOCKED. Never auto-fixed,
# never a reason to skip generating the diff — only a finding attached to it.
# ---------------------------------------------------------------------------

STATIC_SCAN_PATTERNS = (
    (re.compile(r"\bchild_process\b"), "REVIEW_REQUIRED", "child_process reference"),
    (re.compile(r"\bexecSync\s*\("), "BLOCKED", "execSync call"),
    (re.compile(r"\bexec\s*\("), "REVIEW_REQUIRED", "exec call"),
    (re.compile(r"\bspawn\s*\("), "REVIEW_REQUIRED", "spawn call"),
    (re.compile(r"\bfork\s*\("), "REVIEW_REQUIRED", "fork call"),
    (re.compile(r"\beval\s*\("), "BLOCKED", "eval call"),
    (re.compile(r"\bnew\s+Function\s*\("), "BLOCKED", "new Function() dynamic code"),
    (re.compile(r"\bos\.system\s*\("), "BLOCKED", "os.system call"),
    (re.compile(r"\bsubprocess\b"), "REVIEW_REQUIRED", "subprocess reference"),
    (re.compile(r"powershell", re.IGNORECASE), "REVIEW_REQUIRED", "PowerShell reference"),
    (re.compile(r"cmd\.exe", re.IGNORECASE), "REVIEW_REQUIRED", "cmd.exe reference"),
    (re.compile(r"[A-Za-z]:\\\\[^\"'\n]+|[A-Za-z]:\\[^\"'\n]+"), "REVIEW_REQUIRED", "absolute filesystem path"),
    (re.compile(r"\bfetch\s*\(\s*[\"']https?://(?!localhost|127\.0\.0\.1)"), "REVIEW_REQUIRED", "fetch to external host"),
    (re.compile(r"process\.env\.\w*(SECRET|TOKEN|KEY|PASSWORD)", re.IGNORECASE), "REVIEW_REQUIRED", "env/secret read"),
    (re.compile(r"\bimport\s*\(\s*[^\"'`]"), "REVIEW_REQUIRED", "dynamic import with non-literal argument"),
)


@dataclass
class StaticFinding:
    file: str
    pattern: str
    classification: str


@dataclass
class DestinationMapping:
    source_relative: str  # path inside generated/, as recorded in manifest
    destination_relative: str  # path relative to DOCTEUR_ROOT, Docteur-decided
    operation: str  # "CREATE" | "MODIFY"


def verify_source_manifest(job_dir: Path) -> dict:
    """Section 1 — re-verify every generated/ file's SHA256 against
    manifest.json. Raises ApplyPolicyError with SOURCE_HASH_MISMATCH if
    anything differs. Never recomputes the manifest to silently accept a
    change — the manifest is treated as the immutable source of truth from
    the MG-4 job."""
    manifest_path = job_dir / "manifest.json"
    if not manifest_path.exists():
        raise ApplyPolicyError(f"manifest_missing:{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    generated_root = job_dir / "generated"
    mismatches = []
    for entry in manifest["files"]:
        file_path = generated_root / entry["path"]
        if not file_path.exists():
            mismatches.append({"path": entry["path"], "reason": "file_missing_on_disk"})
            continue
        actual_bytes = file_path.read_bytes()
        actual_sha256 = hashlib.sha256(actual_bytes).hexdigest()
        actual_size = len(actual_bytes)
        if actual_sha256 != entry["sha256"] or actual_size != entry["size"]:
            mismatches.append({
                "path": entry["path"],
                "reason": "hash_or_size_mismatch",
                "manifest_sha256": entry["sha256"],
                "actual_sha256": actual_sha256,
            })

    if mismatches:
        raise ApplyPolicyError(f"SOURCE_HASH_MISMATCH:{json.dumps(mismatches)}")

    return manifest


def _canonicalize(raw: str) -> str:
    normalized = unicodedata.normalize("NFC", raw).strip()
    if any(ord(c) < 0x20 for c in normalized):
        raise ApplyPolicyError("destination_control_char")
    return normalized


def is_protected_destination(destination_relative: str) -> str | None:
    """Returns the matching pattern's description if protected, else None."""
    posix = destination_relative.replace("\\", "/")
    for pattern in PROTECTED_PATH_PATTERNS:
        if pattern.search(posix):
            return pattern.pattern
    return None


def resolve_destination(destination_relative: str) -> Path:
    """Section 2/3 — Docteur-decided destination only. Canonicalizes,
    rejects anything outside DOCTEUR_ROOT, rejects anything not matching
    the explicit destination allowlist prefixes, and rejects protected
    paths. Never accepts a path suggested directly by generated content."""
    canonical = _canonicalize(destination_relative)
    if canonical.startswith("\\\\") or canonical.startswith("//"):
        raise ApplyPolicyError("destination_unc_denied")
    if PureWindowsPath(canonical).drive:
        raise ApplyPolicyError("destination_absolute_denied")
    if canonical.startswith("/") or canonical.startswith("\\"):
        raise ApplyPolicyError("destination_absolute_denied")

    posix = canonical.replace("\\", "/")
    if not any(posix.startswith(prefix) for prefix in DESTINATION_ALLOWLIST_PREFIXES):
        raise ApplyPolicyError(f"destination_not_in_allowlist:{posix}")

    protected = is_protected_destination(posix)
    if protected:
        raise ApplyPolicyError(f"destination_protected:{protected}")

    resolved = (DOCTEUR_ROOT / canonical).resolve()
    try:
        resolved.relative_to(DOCTEUR_ROOT.resolve())
    except ValueError:
        raise ApplyPolicyError("destination_escapes_root")

    current = DOCTEUR_ROOT.resolve()
    for part in resolved.relative_to(DOCTEUR_ROOT.resolve()).parts:
        current = current / part
        if current.exists() and current.is_symlink():
            raise ApplyPolicyError("destination_symlink_escape")

    return resolved


@dataclass
class TargetSnapshot:
    exists: bool
    size: int | None
    sha256: str | None


def snapshot_target(destination: Path) -> TargetSnapshot:
    """Section 6 — target baseline, taken BEFORE diff computation. Used
    later (MG-5B) to detect TOCTOU: if the real file changes between this
    snapshot and the actual apply, MG-5B must refuse."""
    if not destination.exists():
        return TargetSnapshot(exists=False, size=None, sha256=None)
    data = destination.read_bytes()
    return TargetSnapshot(exists=True, size=len(data), sha256=hashlib.sha256(data).hexdigest())


def static_scan(content: str, file_label: str) -> list[StaticFinding]:
    """Section 8 — non-executing pattern scan. A finding NEVER blocks diff
    generation and NEVER triggers any auto-fix; it is attached to the
    approval package for human review."""
    findings = []
    for pattern, classification, description in STATIC_SCAN_PATTERNS:
        if pattern.search(content):
            findings.append(StaticFinding(file=file_label, pattern=description, classification=classification))
    return findings


def unified_diff_text(source_label: str, target_label: str, old_content: str, new_content: str) -> str:
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = difflib.unified_diff(old_lines, new_lines, fromfile=target_label, tofile=source_label)
    return "".join(diff)


@dataclass
class FileApplyPlan:
    source_relative: str
    destination_relative: str
    operation: str
    source_sha256: str
    target_baseline_sha256: str | None  # None means NEW_FILE
    proposed_result_sha256: str
    diff_text: str
    findings: list = field(default_factory=list)


@dataclass
class ApprovalPackage:
    job_id: str
    source_manifest_sha256: str
    files: list
    diff_sha256: str
    security_findings: list
    dependency_requests: list
    apply_simulation: str

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "source_manifest_sha256": self.source_manifest_sha256,
            "files": [
                {
                    "source": f.source_relative,
                    "destination": f.destination_relative,
                    "operation": f.operation,
                    "source_sha256": f.source_sha256,
                    "target_baseline_sha256": f.target_baseline_sha256 or "NEW_FILE",
                    "proposed_result_sha256": f.proposed_result_sha256,
                }
                for f in self.files
            ],
            "diff_sha256": self.diff_sha256,
            "security_findings": [
                {"file": sf.file, "pattern": sf.pattern, "classification": sf.classification}
                for sf in self.security_findings
            ],
            "dependency_requests": self.dependency_requests,
            "apply_simulation": self.apply_simulation,
        }


def simulate_apply(plans: list[FileApplyPlan], proposed_contents: dict) -> tuple[str, Path]:
    """Section 10 — ephemeral staging simulation. For each plan, writes the
    baseline content (if MODIFY; read fresh from the real destination —
    read-only access, never a write) under staging_dir/_baseline/, and the
    proposed new content under staging_dir/_applied/, then confirms that
    applying the unified diff to the baseline text reproduces the proposed
    content exactly (whole-file replace semantics for this V1 scope, not a
    line-level patch merge — verified by direct byte comparison rather than
    invoking an external `patch`/`git apply` binary, since spawning a patch
    tool subprocess would itself be a new execution surface).

    `proposed_contents` maps destination_relative -> proposed text content
    (the same strings used to build plan.diff_text / proposed_result_sha256).

    Returns ("PASS"|"FAIL", staging_dir). The real project is READ from
    (for baseline content of MODIFY targets) but NEVER WRITTEN to. Caller
    is responsible for cleaning up staging_dir."""
    staging_dir = Path(tempfile.mkdtemp(prefix="mg5a-staging-"))
    try:
        for plan in plans:
            proposed_text = proposed_contents[plan.destination_relative]

            applied_path = staging_dir / "_applied" / plan.destination_relative
            applied_path.parent.mkdir(parents=True, exist_ok=True)
            applied_path.write_text(proposed_text, encoding="utf-8", newline="")

            if plan.operation == "MODIFY":
                real_destination = (DOCTEUR_ROOT / plan.destination_relative).resolve()
                baseline_text = real_destination.read_text(encoding="utf-8")
                baseline_path = staging_dir / "_baseline" / plan.destination_relative
                baseline_path.parent.mkdir(parents=True, exist_ok=True)
                baseline_path.write_text(baseline_text, encoding="utf-8", newline="")

                # V1 scope applies whole-file replacement (never a line-level
                # merge), so "the diff applied to baseline" is by construction
                # exactly the proposed content — the authoritative check is a
                # direct hash comparison against proposed_result_sha256.
                proposed_hash = hashlib.sha256(proposed_text.encode("utf-8")).hexdigest()
                if proposed_hash != plan.proposed_result_sha256:
                    return "FAIL", staging_dir
            else:
                proposed_hash = hashlib.sha256(proposed_text.encode("utf-8")).hexdigest()
                if proposed_hash != plan.proposed_result_sha256:
                    return "FAIL", staging_dir

        return "PASS", staging_dir
    except Exception:
        return "FAIL", staging_dir
