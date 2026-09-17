"""MG-2G — Certification de la tool policy MetaGPT cote Python (bootstrap
controle par Docteur, cortex-server/src/lib/metagpt_policy.py). Aucun
workflow MetaGPT reel n'est execute ici — les tests couvrent uniquement
l'autorisation d'execution/arguments et le scrub de tool_execution_map via
mocks/sentinelles (FakeRole). Aucun callable n'est reellement invoque
au-dela des mocks explicitement definis dans ce fichier.

Ce fichier ne depend PAS du venv MetaGPT (external/MetaGPT/.venv) — il ne
teste que le module de policy Docteur lui-meme, avec un FakeRole standalone,
donc il peut etre execute avec n'importe quel interpreteur Python 3.10+
ayant seulement la stdlib. La certification avec de VRAIS roles MetaGPT
instancies (import reel + scrub sur un tool_execution_map genuinement
peuple par MetaGPT) est couverte separement par le harnais MG-2G deja
execute manuellement dans le venv isole + HOME sandboxe (voir
reports/METAGPT_DOCTEUR_PATCHES_2026-09.md pour les resultats empiriques).

Run:
    python -m pytest cortex-server/tests-python/test_metagpt_policy.py -v
ou:
    python cortex-server/tests-python/test_metagpt_policy.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "lib"))

from metagpt_policy import (  # noqa: E402
    PolicyError,
    authorize_tool_arguments,
    authorize_tool_call,
    bind_editor_to_workspace,
    execute_authorized_tool,
    scrub_tool_execution_map,
    ALLOWED_EXECUTION_KEYS_BY_ROLE,
)

WORKSPACE = str(Path(__file__).resolve().parent.parent / "data" / "metagpt-workspaces" / "mg2g-test")


class FakeEditor:
    def __init__(self, working_dir="C:\\somewhere\\wrong\\default"):
        self.working_dir = working_dir


class FakeRole:
    """Sentinel stand-in for a real MetaGPT role instance — avoids needing a
    live Ollama config / HOME sandbox just to test the policy logic itself."""

    def __init__(self, tool_execution_map=None, tools=None, editor=None):
        self.tool_execution_map = tool_execution_map or {}
        self.tools = tools or []
        self.editor = editor


class TestAuthorizeToolCall(unittest.TestCase):
    def test_pass_editor_methods_for_each_v1_role(self):
        for role in ("ProductManager", "Architect", "ProjectManager", "RoleZero"):
            for key in ("Editor.write", "Editor.read", "Editor.similarity_search"):
                self.assertEqual(authorize_tool_call(role, key), key)

    def test_pass_writetasks_aliases_project_manager_only(self):
        self.assertEqual(authorize_tool_call("ProjectManager", "WriteTasks"), "WriteTasks")
        self.assertEqual(authorize_tool_call("ProjectManager", "WriteTasks.run"), "WriteTasks.run")

    def test_deny_writetasks_on_wrong_role(self):
        for role in ("ProductManager", "Architect", "RoleZero"):
            with self.assertRaises(PolicyError):
                authorize_tool_call(role, "WriteTasks")
            with self.assertRaises(PolicyError):
                authorize_tool_call(role, "WriteTasks.run")

    def test_deny_other_editor_methods(self):
        denied = [
            "Editor.append_file", "Editor.create_file", "Editor.edit_file_by_replace",
            "Editor.find_file", "Editor.goto_line", "Editor.insert_content_at_line",
            "Editor.open_file", "Editor.scroll_down", "Editor.scroll_up",
            "Editor.search_dir", "Editor.search_file", "Editor.delete", "Editor.execute", "Editor.foo",
        ]
        for key in denied:
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", key)

    def test_deny_dangerous_classes(self):
        denied = [
            "Browser.goto", "Browser.click", "Terminal.run_command", "Bash", "Bash.run",
            "Git.push", "Git.commit", "Plan.append_task", "Plan.replace_task", "Plan.reset_task",
            "RunCode.run", "ExecuteNbCode.run", "RoleZero.ask_human", "RoleZero.reply_to_human",
        ]
        for role in ("ProductManager", "Architect", "ProjectManager", "RoleZero"):
            for key in denied:
                with self.assertRaises(PolicyError):
                    authorize_tool_call(role, key)

    def test_deny_unknown_tool_or_method(self):
        with self.assertRaises(PolicyError):
            authorize_tool_call("ProductManager", "TotallyUnknownTool")
        with self.assertRaises(PolicyError):
            authorize_tool_call("ProductManager", "Editor.totallyUnknownMethod")

    def test_deny_bypass_values(self):
        for bypass in ("<all>", "*", "ALL", "all", "All"):
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", bypass)

    def test_deny_case_variants(self):
        for variant in ("editor.write", "EDITOR.WRITE", "terminal.run_command"):
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", variant)

    def test_pass_peripheral_whitespace_trim(self):
        self.assertEqual(authorize_tool_call("ProductManager", " Editor.write"), "Editor.write")
        self.assertEqual(authorize_tool_call("ProductManager", "  Editor.write  "), "Editor.write")

    def test_deny_internal_whitespace(self):
        for variant in ("Editor . write", "Editor:write", "Editor .write", "Editor. write"):
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", variant)

    def test_deny_invisible_control_characters(self):
        with self.assertRaises(PolicyError):
            authorize_tool_call("ProductManager", "Editor.write\u200b")
        with self.assertRaises(PolicyError):
            authorize_tool_call("ProductManager", "Editor.write\x00")

    def test_deny_filesystem_path_as_tool_identity(self):
        # register_tools_from_path() bypass vector confirmed in MG-1B/MG-2G
        # design review — a path-shaped "tool name" must never match.
        paths = [
            "../../../etc/passwd",
            "C:\\Windows\\System32",
            "\\\\attacker\\share\\evil.py",
            "./evil.py",
            "C:\\dev\\Docteur\\external\\MetaGPT\\metagpt",
        ]
        for p in paths:
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", p)

    def test_deny_unknown_role(self):
        with self.assertRaises(PolicyError):
            authorize_tool_call("Engineer", "Editor.write")
        with self.assertRaises(PolicyError):
            authorize_tool_call("QaEngineer", "Editor.write")

    def test_deny_non_string_execution_key(self):
        for bad in (None, 42, ["Editor.write"]):
            with self.assertRaises(PolicyError):
                authorize_tool_call("ProductManager", bad)


class TestAuthorizeToolArguments(unittest.TestCase):
    def test_pass_file_inside_workspace(self):
        self.assertTrue(authorize_tool_arguments("ProductManager", "Editor.write", ("spec.md",), {}, WORKSPACE))
        self.assertTrue(authorize_tool_arguments("ProductManager", "Editor.write", ("subdir/spec.md",), {}, WORKSPACE))

    def test_deny_relative_traversal(self):
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.write", ("../../etc/passwd",), {}, WORKSPACE)
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.read", ("..\\..\\secrets.txt",), {}, WORKSPACE)

    def test_deny_absolute_path_outside_workspace(self):
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.write", ("C:\\dev\\Docteur\\package.json",), {}, WORKSPACE)

    def test_deny_unc_path(self):
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.write", ("\\\\attacker\\share\\file.txt",), {}, WORKSPACE)

    def test_deny_forbidden_substrings(self):
        forbidden = [
            "..\\..\\..\\cortex-server\\data\\cortex.sqlite",
            "..\\..\\..\\.env",
            "..\\..\\..\\src\\lib\\secret-store.js",
            "..\\..\\..\\..\\external\\MetaGPT\\metagpt\\config2.py",
        ]
        for p in forbidden:
            with self.assertRaises(PolicyError):
                authorize_tool_arguments("ProductManager", "Editor.write", (p,), {}, WORKSPACE)

    def test_deny_real_home_appdata(self):
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.write", ("C:\\Users\\flow1\\AppData\\Local\\evil.txt",), {}, WORKSPACE)

    def test_pass_non_path_methods_always_pass_argument_policy(self):
        self.assertTrue(authorize_tool_arguments("ProductManager", "Editor.similarity_search", ("some query",), {}, WORKSPACE))
        self.assertTrue(authorize_tool_arguments("ProjectManager", "WriteTasks", (), {}, WORKSPACE))
        self.assertTrue(authorize_tool_arguments("ProjectManager", "WriteTasks.run", (), {}, WORKSPACE))

    def test_deny_missing_path_argument(self):
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("ProductManager", "Editor.write", (), {}, WORKSPACE)


class TestScrubAndExecute(unittest.TestCase):
    def test_scrub_removes_forbidden_keys_and_enforces_post_condition(self):
        role = FakeRole(tool_execution_map={
            "Editor.write": lambda: "ok",
            "Editor.read": lambda: "ok",
            "Editor.similarity_search": lambda: "ok",
            "Editor.delete": lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN")),
            "Terminal.run_command": lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN")),
            "Browser.goto": lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN")),
            "Bash": lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN")),
        })
        result = scrub_tool_execution_map(role, "ProductManager")
        remaining = set(role.tool_execution_map.keys())
        allowed = ALLOWED_EXECUTION_KEYS_BY_ROLE["ProductManager"]
        self.assertTrue(remaining <= allowed, f"post-condition violated: {remaining - allowed}")
        self.assertIn("Editor.delete", result["removed_keys"])
        self.assertIn("Terminal.run_command", result["removed_keys"])
        self.assertIn("Browser.goto", result["removed_keys"])
        self.assertIn("Bash", result["removed_keys"])
        self.assertEqual(remaining, {"Editor.write", "Editor.read", "Editor.similarity_search"})

    def test_scrub_does_not_reassign_role_tools(self):
        role = FakeRole(tool_execution_map={"Editor.write": lambda: "ok"}, tools=["some-sentinel-value"])
        scrub_tool_execution_map(role, "ProductManager")
        self.assertEqual(role.tools, ["some-sentinel-value"])

    def test_mutation_after_construction_is_neutralized_by_scrub(self):
        role = FakeRole(tool_execution_map={"Editor.write": lambda: "ok"})
        role.tool_execution_map["Editor.delete"] = lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN"))
        role.tool_execution_map["Terminal.run_command"] = lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN"))
        role.tools = ["<all>"]
        scrub_tool_execution_map(role, "ProductManager")
        self.assertNotIn("Editor.delete", role.tool_execution_map)
        self.assertNotIn("Terminal.run_command", role.tool_execution_map)

    def test_execute_authorized_tool_never_reaches_forbidden_callable(self):
        role = FakeRole(tool_execution_map={"Editor.write": lambda path, content="": "written"})
        role.tool_execution_map["Editor.delete_everything"] = lambda: (_ for _ in ()).throw(AssertionError("SHOULD NEVER RUN"))
        with self.assertRaises(PolicyError):
            execute_authorized_tool(role, "ProductManager", "Editor.delete_everything", workspace_root=WORKSPACE)

    def test_execute_authorized_tool_denies_path_escape_before_reaching_callable(self):
        called = {"count": 0}

        def fake_write(path, content=""):
            called["count"] += 1
            return "written"

        role = FakeRole(tool_execution_map={"Editor.write": fake_write})
        with self.assertRaises(PolicyError):
            execute_authorized_tool(role, "ProductManager", "Editor.write", "../../etc/passwd", workspace_root=WORKSPACE)
        self.assertEqual(called["count"], 0, "the callable must never be reached when the path is denied")

    def test_execute_authorized_tool_succeeds_for_a_safe_call(self):
        called = {"count": 0}

        def fake_write(path, content=""):
            called["count"] += 1
            return f"wrote {path}"

        role = FakeRole(tool_execution_map={"Editor.write": fake_write})
        result = execute_authorized_tool(role, "ProductManager", "Editor.write", "spec.md", content="hello", workspace_root=WORKSPACE)
        self.assertEqual(called["count"], 1)
        self.assertEqual(result, "wrote spec.md")

    def test_unknown_role_rejected_everywhere(self):
        with self.assertRaises(PolicyError):
            scrub_tool_execution_map(FakeRole(), "Engineer")
        with self.assertRaises(PolicyError):
            authorize_tool_arguments("Engineer", "Editor.write", ("x",), {}, WORKSPACE)


class TestBindEditorToWorkspace(unittest.TestCase):
    def test_binds_editor_working_dir_to_job_workspace(self):
        role = FakeRole(editor=FakeEditor())
        self.assertNotEqual(str(role.editor.working_dir), WORKSPACE)
        bound = bind_editor_to_workspace(role, WORKSPACE)
        self.assertTrue(bound)
        self.assertEqual(str(role.editor.working_dir), str(Path(WORKSPACE).resolve()))

    def test_returns_false_when_role_has_no_editor(self):
        role = FakeRole(editor=None)
        self.assertFalse(bind_editor_to_workspace(role, WORKSPACE))

    def test_execute_authorized_tool_binds_editor_before_argument_check(self):
        # Regression test for the real end-to-end divergence found manually:
        # Editor.write validated the argument against WORKSPACE but the
        # real Editor instance still wrote inside its own default
        # working_dir (METAGPT_ROOT/workspace) because nothing had bound it.
        written = {}

        class RecordingEditor:
            def __init__(self):
                self.working_dir = "C:\\wrong\\default"

            def write(self, path, content=""):
                written["working_dir_at_call_time"] = self.working_dir
                written["path"] = path
                return "ok"

        editor = RecordingEditor()
        role = FakeRole(tool_execution_map={"Editor.write": editor.write}, editor=editor)
        execute_authorized_tool(role, "ProductManager", "Editor.write", "spec.md", workspace_root=WORKSPACE)
        self.assertEqual(str(written["working_dir_at_call_time"]), str(Path(WORKSPACE).resolve()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
