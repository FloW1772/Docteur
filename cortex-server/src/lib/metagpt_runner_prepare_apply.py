"""MG-6H — Productized prepare-apply / diff-only runner.

Invoked by metagpt-orchestrator.js as:
    <metagpt venv python> metagpt_runner_prepare_apply.py <job_workspace_dir>

Reuses metagpt_apply_policy.py (MG-5A) exactly. Never modifies the real
Docteur project — produces mapping, diff, static findings, dependency
requests, apply simulation, and the approval package (with DIFF_SHA256),
written to <job_workspace_dir>/approval/mg5a-approval-package.json.

Destination convention (generalizing the MG-5A precedent, which found
that Docteur's real src/App.tsx already exists and must never collide
with generated sample content): every generated file lands under

    src/_metagpt_generated_samples/<job_id>/<same relative path as generated/>

This is NEVER a path suggested by the LLM-generated content itself — it is
a fixed, Docteur-decided template using only the job_id (Docteur-generated
UUID) and the source's own relative path inside generated/ (which is
itself already policy-validated by metagpt_codegen_policy.py at generation
time). resolve_destination() in metagpt_apply_policy.py independently
re-validates this against the allowlist/protected-path rules regardless.

Prints the final JSON result as the LAST line of stdout.
"""
from __future__ import annotations

import sys
import os
import json
import hashlib
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    if len(sys.argv) != 3:
        emit({"ok": False, "error": "usage: metagpt_runner_prepare_apply.py <job_workspace_dir> <job_id>", "error_code": "USAGE"})
        return 2

    job_workspace_dir = Path(sys.argv[1]).resolve()
    job_id = sys.argv[2]

    if not (job_id and __import__("re").match(r"^[a-zA-Z0-9-]{1,64}$", job_id)):
        emit({"ok": False, "error": "job_id_invalid", "error_code": "PATH_DENIED"})
        return 1

    try:
        result = _run_prepare_apply(job_workspace_dir, job_id)
        emit(result)
        return 0 if result.get("ok") else 1
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": str(e), "error_code": "UNHANDLED_EXCEPTION", "traceback": traceback.format_exc(limit=10)})
        return 1


def _run_prepare_apply(job_workspace_dir: Path, job_id: str) -> dict:
    from metagpt_apply_policy import (
        ApplyPolicyError,
        verify_source_manifest,
        resolve_destination,
        snapshot_target,
        static_scan,
        unified_diff_text,
        simulate_apply,
        FileApplyPlan,
        ApprovalPackage,
    )

    generated_dir = job_workspace_dir / "generated"
    manifest_path = generated_dir.parent / "manifest.json"
    if not manifest_path.exists():
        return {"ok": False, "error": "manifest_missing", "error_code": "NOT_FOUND"}

    try:
        manifest = verify_source_manifest(job_workspace_dir)
    except ApplyPolicyError as e:
        return {"ok": False, "error": str(e), "error_code": "SOURCE_HASH_MISMATCH"}

    manifest_bytes = manifest_path.read_bytes()
    source_manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()

    resolved_destinations = {}
    protected_violations = []
    destination_map = {}
    for entry in manifest["files"]:
        src = entry["path"]
        dst = f"src/_metagpt_generated_samples/{job_id}/{src}"
        destination_map[src] = dst
        try:
            resolved_destinations[src] = resolve_destination(dst)
        except ApplyPolicyError as e:
            protected_violations.append({"destination": dst, "reason": str(e)})

    if protected_violations:
        return {"ok": False, "error": "protected_or_invalid_destination", "error_code": "BLOCKED_BY_POLICY", "violations": protected_violations}

    target_baselines = {src: snapshot_target(resolved) for src, resolved in resolved_destinations.items()}

    all_findings = []
    proposed_contents = {}
    for entry in manifest["files"]:
        src = entry["path"]
        dst = destination_map[src]
        content = (generated_dir / src).read_text(encoding="utf-8")
        proposed_contents[dst] = content
        all_findings.extend(static_scan(content, file_label=src))

    blocked = [f for f in all_findings if f.classification == "BLOCKED"]

    plans = []
    for entry in manifest["files"]:
        src = entry["path"]
        dst = destination_map[src]
        resolved = resolved_destinations[src]
        baseline = target_baselines[src]
        proposed_text = proposed_contents[dst]
        proposed_sha256 = hashlib.sha256(proposed_text.encode("utf-8")).hexdigest()
        operation = "MODIFY" if baseline.exists else "CREATE"
        old_content = resolved.read_text(encoding="utf-8") if baseline.exists else ""
        diff_text = unified_diff_text(source_label=f"generated/{src}", target_label=dst, old_content=old_content, new_content=proposed_text)

        plans.append(FileApplyPlan(
            source_relative=src,
            destination_relative=dst,
            operation=operation,
            source_sha256=entry["sha256"],
            target_baseline_sha256=baseline.sha256,
            proposed_result_sha256=proposed_sha256,
            diff_text=diff_text,
            findings=[f for f in all_findings if f.file == src],
        ))

    dependency_requests = []
    seen = set()
    for entry in manifest["files"]:
        src = entry["path"]
        dst = destination_map[src]
        content = proposed_contents[dst]
        if ("from 'react'" in content or 'from "react"' in content) and ("react", dst) not in seen:
            seen.add(("react", dst))
            dependency_requests.append({"package": "react", "reason": f"{src} imports react", "file": dst})

    outcome, staging_dir = simulate_apply(plans, proposed_contents)
    import shutil
    shutil.rmtree(staging_dir, ignore_errors=True)

    diff_concat = "\n".join(p.diff_text for p in plans)
    diff_sha256 = hashlib.sha256(diff_concat.encode("utf-8")).hexdigest()

    package = ApprovalPackage(
        job_id=job_id,
        source_manifest_sha256=source_manifest_sha256,
        files=plans,
        diff_sha256=diff_sha256,
        security_findings=all_findings,
        dependency_requests=dependency_requests,
        apply_simulation=outcome,
    )

    approval_dir = job_workspace_dir / "approval"
    approval_dir.mkdir(parents=True, exist_ok=True)
    approval_path = approval_dir / "mg5a-approval-package.json"
    package_data = package.to_dict()
    package_data["diff_text"] = diff_concat
    approval_path.write_text(json.dumps(package_data, indent=2), encoding="utf-8")

    return {
        **package_data,
        "ok": outcome == "PASS" and not blocked,
        "approval_package_path": str(approval_path),
        "package_sha256": hashlib.sha256(approval_path.read_bytes()).hexdigest(),
        "diff_sha256": diff_sha256,
        "apply_simulation": outcome,
        "blocked_findings": len(blocked),
        "error_code": "BLOCKED_BY_POLICY" if blocked else None,
    }


if __name__ == "__main__":
    sys.exit(main())
