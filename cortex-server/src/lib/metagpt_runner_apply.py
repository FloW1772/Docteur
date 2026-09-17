"""MG-6J — Productized exact-approved-diff apply runner.

Invoked by metagpt-orchestrator.js as:
    <metagpt venv python> metagpt_runner_apply.py <job_workspace_dir> <job_id> <approved_diff_sha256>

Reuses the MG-5B methodology exactly: reloads
<job_workspace_dir>/approval/mg5a-approval-package.json, revalidates
job_id + diff_sha256 + exact file list + source hashes + source manifest
hash BYTE-FOR-BYTE against what the orchestrator was told was approved,
revalidates every destination is still absent (TOCTOU guard), then writes
atomically (temp file + os.replace) with transactional rollback if any
file after the first fails.

The orchestrator is responsible for only invoking this script after its
own human-approval-binding check (job's stored diff_sha256 + file list
matches what the UI's "Approuver ce diff" button actually showed the
user) — this script performs its OWN independent revalidation regardless,
never trusting the caller's approval claim alone (same "never trust the
other side's validation" rule as MG-2G/MG-4/MG-5).

Prints the final JSON result as the LAST line of stdout.
"""
from __future__ import annotations

import sys
import os
import json
import hashlib
import traceback
import shutil
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    if len(sys.argv) != 5:
        emit({"ok": False, "error": "usage: metagpt_runner_apply.py <job_workspace_dir> <job_id> <approved_diff_sha256>", "error_code": "USAGE"})
        return 2

    job_workspace_dir = Path(sys.argv[1]).resolve()
    approved_job_id = sys.argv[2]
    approved_diff_sha256 = sys.argv[3]

    try:
        result = _run_apply(job_workspace_dir, approved_job_id, approved_diff_sha256, sys.argv[4])
        emit(result)
        return 0 if result.get("ok") else 1
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": str(e), "error_code": "UNHANDLED_EXCEPTION", "traceback": traceback.format_exc(limit=10)})
        return 1


class AbortApply(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _run_apply(job_workspace_dir: Path, approved_job_id: str, approved_diff_sha256: str, approved_package_sha256: str) -> dict:
    from metagpt_apply_policy import ApplyPolicyError, verify_source_manifest, resolve_destination, snapshot_target
    from metagpt_codegen_policy import resolve_generated_path

    approval_path = job_workspace_dir / "approval" / "mg5a-approval-package.json"
    if not approval_path.exists():
        return {"ok": False, "error": "approval_package_missing", "error_code": "APPROVAL_INVALIDATED"}

    package_bytes = approval_path.read_bytes()
    if hashlib.sha256(package_bytes).hexdigest() != approved_package_sha256:
        return {"ok": False, "error": "approval_package_changed", "error_code": "APPROVAL_INVALIDATED"}
    package = json.loads(package_bytes)

    try:
        if package["job_id"] != approved_job_id:
            raise AbortApply("APPROVAL_INVALIDATED", f"job_id mismatch: {package['job_id']!r} != {approved_job_id!r}")
        if package["diff_sha256"] != approved_diff_sha256:
            raise AbortApply("APPROVAL_INVALIDATED", f"diff_sha256 mismatch: {package['diff_sha256']!r} != {approved_diff_sha256!r}")
        if hashlib.sha256(package["diff_text"].encode("utf-8")).hexdigest() != approved_diff_sha256:
            raise AbortApply("APPROVAL_INVALIDATED", "diff_text_hash_mismatch")
        if not package["files"] or package["apply_simulation"] != "PASS" or any(f["classification"] == "BLOCKED" for f in package["security_findings"]):
            raise AbortApply("APPROVAL_INVALIDATED", "package_not_applicable")

        manifest = verify_source_manifest(job_workspace_dir)
        manifest_sha256 = hashlib.sha256((job_workspace_dir / "manifest.json").read_bytes()).hexdigest()
        if manifest_sha256 != package["source_manifest_sha256"]:
            raise AbortApply("APPROVAL_INVALIDATED", "source manifest sha256 changed since approval")

        generated_dir = job_workspace_dir / "generated"
        if sorted(f["source"] for f in package["files"]) != sorted(f["path"] for f in manifest["files"]):
            raise AbortApply("APPROVAL_INVALIDATED", "source_file_list_changed")
        final_dir = resolve_destination(f"src/_metagpt_generated_samples/{approved_job_id}")
        if final_dir.exists():
            raise AbortApply("APPROVAL_INVALIDATED", "target_changed_since_approval")
        contents = {}
        for f in package["files"]:
            source = resolve_generated_path(str(generated_dir), f["source"])
            content = source.read_bytes()
            actual_sha256 = hashlib.sha256(content).hexdigest()
            if actual_sha256 != f["source_sha256"]:
                raise AbortApply("APPROVAL_INVALIDATED", f"source hash changed for {f['source']}")
            if f["destination"] != f"src/_metagpt_generated_samples/{approved_job_id}/{f['source']}":
                raise AbortApply("APPROVAL_INVALIDATED", "destination_mapping_changed")
            if actual_sha256 != f["proposed_result_sha256"]:
                raise AbortApply("APPROVAL_INVALIDATED", "proposed_content_changed")
            contents[f["source"]] = content
            if f["operation"] != "CREATE" or f["target_baseline_sha256"] != "NEW_FILE":
                # MG-6 V1 scope only auto-applies CREATE-on-absent, same as MG-5B.
                raise AbortApply("APPROVAL_INVALIDATED", f"unsupported operation for V1 apply: {f['operation']} on {f['destination']}")

        resolved_map = {}
        for f in package["files"]:
            resolved = resolve_destination(f["destination"])
            snap = snapshot_target(resolved)
            if snap.exists:
                raise AbortApply("APPROVAL_INVALIDATED", f"target_changed_since_approval:{resolved}")
            resolved_map[f["destination"]] = resolved

    except Exception as e:
        code = getattr(e, "code", "APPROVAL_INVALIDATED")
        return {"ok": False, "error": str(e), "error_code": code}

    # Publish the entire isolated job directory in one rename. A killed
    # process during staging cannot expose a partially applied job.
    staging = None
    try:
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".mg6-{approved_job_id}-", dir=final_dir.parent))
        for f in package["files"]:
            staged = staging / f["source"]
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(contents[f["source"]])
            if hashlib.sha256(staged.read_bytes()).hexdigest() != f["proposed_result_sha256"]:
                raise AbortApply("APPLY_HASH_MISMATCH", "staging_hash_mismatch")
        # Windows rename refuses an existing destination (no os.replace).
        if final_dir.exists():
            raise AbortApply("APPROVAL_INVALIDATED", "target_changed_since_approval")
        os.rename(staging, final_dir)
        staging = None

        return {
            "ok": True,
            "files_created": [str(p) for p in resolved_map.values()],
            "diff_sha256": approved_diff_sha256,
        }

    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "error_code": getattr(e, "code", "APPLY_FAILED"),
            "rollback_triggered": True,
            "rollback_count": 0,
        }
    finally:
        if staging is not None:
            shutil.rmtree(staging)


def _atomic_write(destination: Path, content: str, expected_sha256: str) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = content.encode("utf-8")
    tmp_path = destination.parent / f".{destination.name}.mg6-tmp-{os.getpid()}"
    with open(tmp_path, "wb") as fh:
        fh.write(encoded)
        fh.flush()
        os.fsync(fh.fileno())
    tmp_sha256 = hashlib.sha256(tmp_path.read_bytes()).hexdigest()
    if tmp_sha256 != expected_sha256:
        tmp_path.unlink(missing_ok=True)
        raise AbortApply("APPLY_HASH_MISMATCH", f"temp file hash mismatch: {destination}")
    os.replace(tmp_path, destination)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


if __name__ == "__main__":
    sys.exit(main())
