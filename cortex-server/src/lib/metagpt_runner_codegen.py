"""MG-6G — Productized safe text-only code generation runner.

Invoked by metagpt-orchestrator.js as:
    <metagpt venv python> metagpt_runner_codegen.py <job_workspace_dir>

Reads planning/design.json and planning/tasks.json (already produced by
metagpt_runner_plan.py) plus a Docteur-authored generation_spec.json (which
file list to generate, capped by the orchestrator to MAX_FILES_PER_JOB
before this script ever runs) from <job_workspace_dir>/, and writes the
generated text files under <job_workspace_dir>/generated/ via the
certified MG-4 pipeline:

    SafeProjectContext -> WriteCode.run() -> CodegenJobWriter (policy-owned write)

with metagpt_git_guard.GitGuard installed for the ENTIRE run and asserted
clean at the end (0 ProjectRepo/GitRepository instantiation, 0 Repo.init,
0 shell_execute, 0 push/clone_from) — exactly the MG-4 guarantee, now
wired into the productized pipeline instead of a scratchpad script.

Never Engineer, never Terminal/Browser, never real code execution. The
generated content is written as DATA ONLY by CodegenJobWriter, which
itself is Docteur-owned (metagpt_codegen_policy.py), not MetaGPT's own
FileRepository/ProjectRepo write path.

Prints the final JSON result as the LAST line of stdout (same contract as
metagpt_runner_plan.py — MetaGPT's own retry/repair machinery may print
diagnostic noise before it).
"""
from __future__ import annotations

import sys
import os
import json
import asyncio
import traceback
from pathlib import Path

METAGPT_ROOT = Path(r"C:\dev\Docteur\external\MetaGPT")
sys.path.insert(0, str(METAGPT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    if len(sys.argv) != 2:
        emit({"ok": False, "error": "usage: metagpt_runner_codegen.py <job_workspace_dir>", "error_code": "USAGE"})
        return 2

    job_workspace_dir = Path(sys.argv[1]).resolve()

    sandbox_home = os.environ.get("METAGPT_HOME_SANDBOX")
    if not sandbox_home:
        emit({"ok": False, "error": "METAGPT_HOME_SANDBOX_env_missing", "error_code": "CONFIG_ERROR"})
        return 1
    if Path.home() != Path(sandbox_home):
        emit({"ok": False, "error": "home_sandbox_not_applied", "error_code": "SANDBOX_ERROR"})
        return 1

    planning_dir = job_workspace_dir / "planning"
    design_path = planning_dir / "design.json"
    tasks_path = planning_dir / "tasks.json"
    spec_path = job_workspace_dir / "generation_spec.json"

    for required in (design_path, tasks_path, spec_path):
        if not required.exists():
            emit({"ok": False, "error": f"missing_required_file:{required.name}", "error_code": "NOT_FOUND"})
            return 1

    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        files_to_generate = spec["files"]
        if not isinstance(files_to_generate, list) or not files_to_generate:
            raise ValueError("generation_spec.files must be a non-empty list")
    except Exception as e:
        emit({"ok": False, "error": f"invalid_generation_spec:{e}", "error_code": "CONFIG_ERROR"})
        return 1

    generated_dir = job_workspace_dir / "generated"
    generated_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = asyncio.run(_run_codegen(job_workspace_dir, design_path, tasks_path, files_to_generate, generated_dir))
        emit(result)
        return 0 if result.get("ok") else 1
    except Exception as e:  # noqa: BLE001 - top-level runner boundary, must always emit JSON
        emit({
            "ok": False,
            "error": str(e),
            "error_code": "UNHANDLED_EXCEPTION",
            "traceback": traceback.format_exc(limit=10),
        })
        return 1


async def _run_codegen(job_workspace_dir: Path, design_path: Path, tasks_path: Path, files_to_generate: list, generated_dir: Path) -> dict:
    from metagpt.actions.write_code import WriteCode
    from metagpt.schema import CodingContext, Document
    from pydantic import BaseModel

    from metagpt_git_guard import GitGuard, GitGuardViolation
    from metagpt_safe_project_context import SafeProjectContext
    from metagpt_codegen_policy import CodegenJobWriter, CodegenPolicyError, MAX_FILES_PER_JOB

    if len(files_to_generate) > MAX_FILES_PER_JOB:
        return {"ok": False, "error": f"too_many_files:{len(files_to_generate)}>{MAX_FILES_PER_JOB}", "error_code": "LIMIT_EXCEEDED"}

    design_content = design_path.read_text(encoding="utf-8")
    tasks_content = tasks_path.read_text(encoding="utf-8")

    requirement_path = job_workspace_dir / "requirement.txt"
    if not requirement_path.exists():
        requirement_path.write_text("(see planning/prd.json)", encoding="utf-8")

    class InputArgs(BaseModel):
        requirements_filename: str

    guard = GitGuard()
    guard.install()
    generated_files: dict[str, str] = {}
    job_id = job_workspace_dir.name

    try:
        existing_sources: dict[str, str] = {}
        for filename in files_to_generate:
            task_doc = Document(filename="tasks.json", content=tasks_content)
            design_doc = Document(filename="design.json", content=design_content)
            coding_context = CodingContext(filename=filename, design_doc=design_doc, task_doc=task_doc, code_doc=None)
            i_context_doc = Document(filename=filename, content=coding_context.model_dump_json())

            write_code = WriteCode(i_context=i_context_doc, input_args=InputArgs(requirements_filename=str(requirement_path)))
            write_code.repo = SafeProjectContext(
                task_documents={},
                existing_source_files=dict(existing_sources),
                src_relative_path="src",
            )

            result = await write_code.run()
            code = result.code_doc.content
            generated_files[filename] = code
            existing_sources[filename] = code

        guard.assert_clean()
    except GitGuardViolation as e:
        return {"ok": False, "error": str(e), "error_code": "GIT_GUARD_VIOLATION", "guard_counters": guard.counters.as_report_dict()}
    finally:
        guard.uninstall()

    writer = CodegenJobWriter(job_id=job_id, job_generated_root=str(generated_dir))
    written = []
    try:
        for filename, code in generated_files.items():
            record = writer.write_text_file(filename, code)
            written.append({"path": record.path, "size": record.size, "sha256": record.sha256})
    except CodegenPolicyError as e:
        return {"ok": False, "error": str(e), "error_code": "CODEGEN_POLICY_DENIED", "files_written_before_denial": written}

    manifest_path = writer.write_manifest()
    unlisted = writer.verify_no_unlisted_files()
    if unlisted:
        return {"ok": False, "error": f"unlisted_files_detected:{unlisted}", "error_code": "MANIFEST_INTEGRITY_ERROR"}

    return {
        "ok": True,
        "files": written,
        "manifest_path": str(manifest_path),
        "guard_counters": guard.counters.as_report_dict(),
    }


if __name__ == "__main__":
    sys.exit(main())
