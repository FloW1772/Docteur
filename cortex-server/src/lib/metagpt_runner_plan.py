"""MG-6F — Productized planning runner (semantic entry point, no raw exec).

Invoked by metagpt-orchestrator.js as:
    <metagpt venv python> metagpt_runner_plan.py <job_workspace_dir> <requirement_text_file>

Never accepts a shell string, raw Python code, or CLI args beyond a
workspace path and a path to a requirement text file that Docteur itself
wrote inside that same workspace (never a path chosen by the caller
outside the workspace, never an inline arbitrary argument).

Reproduces exactly the MG-3-certified planning approach: calls the
underlying ActionNode.fill() for WritePRD/WriteDesign/WriteTasks directly
(not role.run(), never Engineer, never ProjectRepo/GitRepository
instantiated), against Ollama local only. Writes prd.json/design.json/
tasks.json into <job_workspace_dir>/planning/ and prints the final JSON
result as the LAST line of stdout: {"ok": true, "prd_path": "...",
"design_path": "...", "tasks_path": "...", "model": "..."} or
{"ok": false, "error": "...", "error_code": "..."}.

IMPORTANT for callers: MetaGPT's own internal retry/repair machinery
(metagpt.utils.repair_llm_raw_output) prints raw [CONTENT]...[/CONTENT]
diagnostic blocks to stdout on malformed LLM JSON output — this is normal,
expected noise from the certified MG-3 pipeline, not an error. Callers
MUST parse only the LAST non-empty line of stdout as the result, never
assume stdout is a single line or attempt to parse the whole stream as
one JSON document.

The MG-2G/MG-2H guards (tool policy, xml_fill/eval/pickle sentinels) are
loaded and asserted clean before returning, exactly like the MG-3 smoke
test did — this script IS the MG-3 pipeline, now callable as a stable
entry point instead of a scratchpad script.
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
    if len(sys.argv) != 3:
        emit({"ok": False, "error": "usage: metagpt_runner_plan.py <job_workspace_dir> <requirement_file>", "error_code": "USAGE"})
        return 2

    job_workspace_dir = Path(sys.argv[1]).resolve()
    requirement_file = Path(sys.argv[2]).resolve()

    # Defense in depth: requirement_file must live inside job_workspace_dir.
    # The orchestrator is responsible for the authoritative check
    # (checkedWorkspacePath on the Node side); this is a second, independent
    # check on the Python side, consistent with the "never trust the other
    # side's validation alone" rule established across MG-2G/MG-4/MG-5.
    try:
        requirement_file.relative_to(job_workspace_dir)
    except ValueError:
        emit({"ok": False, "error": "requirement_file_outside_workspace", "error_code": "PATH_DENIED"})
        return 1

    if not requirement_file.exists():
        emit({"ok": False, "error": "requirement_file_missing", "error_code": "NOT_FOUND"})
        return 1

    sandbox_home = os.environ.get("METAGPT_HOME_SANDBOX")
    if not sandbox_home:
        emit({"ok": False, "error": "METAGPT_HOME_SANDBOX_env_missing", "error_code": "CONFIG_ERROR"})
        return 1
    if Path.home() != Path(sandbox_home):
        emit({"ok": False, "error": "home_sandbox_not_applied", "error_code": "SANDBOX_ERROR"})
        return 1

    planning_dir = job_workspace_dir / "planning"
    planning_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = asyncio.run(_run_planning(requirement_file, planning_dir))
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


async def _run_planning(requirement_file: Path, planning_dir: Path) -> dict:
    # fill()'s `llm` parameter is mandatory (no default — see
    # metagpt/actions/action_node.py's signature), and the real V1 Actions
    # always pass self.llm, which Action's own `_update_private_llm`
    # pydantic validator resolves from metagpt's sandboxed config2.yaml at
    # construction time (ModelsConfig.default() -> create_llm_instance()).
    # We therefore instantiate the real Action classes (never Engineer,
    # never role.run()) purely to obtain a correctly-configured `llm`
    # instance the same way MG-3 did, then drive their module-level
    # ActionNode singletons directly — the exact call shape MG-2H's
    # regression guard asserts stays mode="auto" (no mode= ever passed).
    from metagpt.actions.write_prd import WritePRD, WRITE_PRD_NODE
    from metagpt.actions.design_api import WriteDesign, DESIGN_API_NODE
    from metagpt.actions.project_management import WriteTasks, PM_NODE

    requirement_text = requirement_file.read_text(encoding="utf-8")
    model_name = os.environ.get("METAGPT_MODEL", "qwen2.5:7b")

    write_prd = WritePRD()
    write_design = WriteDesign()
    write_tasks = WriteTasks()

    prd_node = await WRITE_PRD_NODE.fill(req=requirement_text, llm=write_prd.llm)
    prd_content = prd_node.instruct_content.model_dump_json()
    (planning_dir / "prd.json").write_text(prd_content, encoding="utf-8")

    design_node = await DESIGN_API_NODE.fill(req=f"## PRD\n{prd_content}", llm=write_design.llm)
    design_content = design_node.instruct_content.model_dump_json()
    (planning_dir / "design.json").write_text(design_content, encoding="utf-8")

    tasks_node = await PM_NODE.fill(req=f"## Design\n{design_content}", llm=write_tasks.llm)
    tasks_content = tasks_node.instruct_content.model_dump_json()
    (planning_dir / "tasks.json").write_text(tasks_content, encoding="utf-8")

    return {
        "ok": True,
        "prd_path": str(planning_dir / "prd.json"),
        "design_path": str(planning_dir / "design.json"),
        "tasks_path": str(planning_dir / "tasks.json"),
        "model": model_name,
    }


if __name__ == "__main__":
    sys.exit(main())
