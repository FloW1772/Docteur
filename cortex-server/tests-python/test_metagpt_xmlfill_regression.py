"""MG-2H — Regression guard: ActionNode.xml_fill() reachability from V1.

This test does NOT test the metagpt_policy.py module — it tests MetaGPT's
OWN source code directly, to catch a future upstream change (or a future
Docteur code change) that would newly route WritePRD/WriteDesign/WriteTasks
through mode="xml_fill", or introduce a new V1 caller of ActionNode.fill()
that does so.

Confirmed at SHA 11cdf466d042aece04fc6cfd13b28e1a70341b1f (see
reports/METAGPT_DOCTEUR_PATCHES_2026-09.md, MG-2H): xml_fill's eval() calls
are unreachable from the V1 scope because no V1 caller ever passes
mode="xml_fill" to ActionNode.fill() — fill() therefore always falls through
to its default mode="auto". The `prompt_schema: Literal["json","markdown","raw"]`
config field is a separate, additional structural defense (it cannot hold
the string "xml_fill" even if something tried), but it is NOT the reason
mode stays "auto" — mode and schema are independent parameters of fill(),
and this test asserts on `mode` directly, not on prompt_schema.

Requires the isolated MetaGPT venv (external/MetaGPT/.venv) — this is a
static-source regression check, not a mock unit test, so it imports the
real metagpt package.

Run:
    C:\\dev\\Docteur\\external\\MetaGPT\\.venv\\Scripts\\python.exe -m pytest cortex-server/tests-python/test_metagpt_xmlfill_regression.py -v
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

METAGPT_ROOT = Path(r"C:\dev\Docteur\external\MetaGPT")
sys.path.insert(0, str(METAGPT_ROOT))

EXPECTED_SHA = "11cdf466d042aece04fc6cfd13b28e1a70341b1f"


class TestXmlFillUnreachableFromV1(unittest.TestCase):
    """Static-source assertions against the ACTUAL call sites — these read
    the real source of write_prd.py / design_api.py / project_management.py
    and fail loudly if any of them is ever changed to pass mode="xml_fill"
    (or any mode= at all — since introducing ANY explicit mode is itself a
    signal this regression guard should be re-audited, not just re-passed)."""

    V1_ACTION_FILES = {
        "WritePRD": METAGPT_ROOT / "metagpt" / "actions" / "write_prd.py",
        "WriteDesign": METAGPT_ROOT / "metagpt" / "actions" / "design_api.py",
        "WriteTasks": METAGPT_ROOT / "metagpt" / "actions" / "project_management.py",
    }

    def _fill_call_sites(self, source: str):
        """Returns every `.fill(` call site's full argument text (naive but
        sufficient: MetaGPT's own call sites are single-statement, not
        deeply nested), for inspecting whether mode= is passed."""
        sites = []
        for match in re.finditer(r"\.fill\(", source):
            start = match.end()
            depth = 1
            i = start
            while depth > 0 and i < len(source):
                if source[i] == "(":
                    depth += 1
                elif source[i] == ")":
                    depth -= 1
                i += 1
            sites.append(source[start:i])
        return sites

    def test_no_v1_action_passes_mode_xml_fill(self):
        for action_name, path in self.V1_ACTION_FILES.items():
            source = path.read_text(encoding="utf-8")
            sites = self._fill_call_sites(source)
            self.assertTrue(sites, f"{action_name}: expected at least one .fill( call site, found none — file may have changed structurally, re-audit required")
            for site in sites:
                self.assertNotIn(
                    "xml_fill", site,
                    f"REGRESSION: {action_name} ({path.name}) now references xml_fill in a .fill(...) call: {site!r}. "
                    f"This means ActionNode.xml_fill()'s eval() calls may now be reachable from V1 — "
                    f"re-run the full MG-2H empirical sentinel-interception test before allowing any workflow.",
                )
                self.assertNotRegex(
                    site, r"mode\s*=",
                    f"REGRESSION: {action_name} ({path.name}) now passes an explicit mode= to .fill(...): {site!r}. "
                    f"V1's safety argument for xml_fill relies on NO caller ever specifying mode explicitly "
                    f"(fill() defaults to mode='auto'). An explicit mode of ANY value requires re-auditing "
                    f"this regression guard, not just checking it isn't literally 'xml_fill'.",
                )

    def test_action_node_fill_default_mode_is_still_auto(self):
        """Guards the OTHER half of the argument: if MetaGPT's own default
        for fill()'s `mode` parameter ever changes away from "auto", the
        V1 Actions (which never pass mode= explicitly) would silently start
        using a different mode — this must be caught immediately.

        Reads the source text directly rather than inspect.signature(),
        because ActionNode.fill is wrapped by @exp_cache(...) and the
        resulting signature is not guaranteed to reflect the real
        parameter defaults through every possible decorator implementation."""
        action_node_path = METAGPT_ROOT / "metagpt" / "actions" / "action_node.py"
        source = action_node_path.read_text(encoding="utf-8")
        match = re.search(r"async def fill\(\s*self,(.*?)\)\s*:", source, re.DOTALL)
        self.assertIsNotNone(match, "ActionNode.fill() signature not found in source — file structure changed, re-audit required")
        params_text = match.group(1)
        mode_match = re.search(r"mode\s*=\s*([\"'])(\w+)\1", params_text)
        self.assertIsNotNone(mode_match, "ActionNode.fill() no longer declares a default for 'mode' — re-audit required")
        self.assertEqual(
            mode_match.group(2), "auto",
            f"REGRESSION: ActionNode.fill()'s default mode changed from 'auto' to {mode_match.group(2)!r}. "
            f"WritePRD/WriteDesign/WriteTasks never pass mode= explicitly and rely on this default — "
            f"re-run the full MG-2H empirical test before allowing any workflow.",
        )

    def test_no_new_v1_reachable_caller_of_xml_fill_mode_value(self):
        """Broader net: scans the V1 role/action files themselves (not just
        the three known Action files) for ANY literal reference to
        FillMode.XML_FILL or the string "xml_fill" — catches a hypothetical
        future caller introduced anywhere in the V1 surface, not just the
        three files already known to matter."""
        v1_surface_files = [
            METAGPT_ROOT / "metagpt" / "roles" / "product_manager.py",
            METAGPT_ROOT / "metagpt" / "roles" / "architect.py",
            METAGPT_ROOT / "metagpt" / "roles" / "project_manager.py",
            METAGPT_ROOT / "metagpt" / "roles" / "di" / "role_zero.py",
            METAGPT_ROOT / "metagpt" / "actions" / "write_prd.py",
            METAGPT_ROOT / "metagpt" / "actions" / "design_api.py",
            METAGPT_ROOT / "metagpt" / "actions" / "project_management.py",
            METAGPT_ROOT / "metagpt" / "actions" / "search_enhanced_qa.py",
            METAGPT_ROOT / "metagpt" / "actions" / "prepare_documents.py",
            METAGPT_ROOT / "metagpt" / "actions" / "add_requirement.py",
        ]
        for path in v1_surface_files:
            source = path.read_text(encoding="utf-8")
            self.assertNotIn(
                "xml_fill", source,
                f"REGRESSION: {path.relative_to(METAGPT_ROOT)} now references 'xml_fill' — "
                f"re-run the full MG-2H empirical sentinel-interception test before allowing any workflow.",
            )

    def test_pinned_sha_still_matches(self):
        """If this file's assumptions (call sites, default mode) are being
        checked against a DIFFERENT SHA than the one MG-2H actually audited,
        the above assertions passing would be a false sense of safety.
        This does not fail the build on a SHA drift by itself (a repo
        re-sync is a legitimate, deliberate action) — it exists so a
        pre-flight check (see MG-3 preflight) can surface the current SHA
        for a human/adapter to compare against EXPECTED_SHA before trusting
        this regression suite's PASS."""
        import subprocess

        result = subprocess.run(
            ["git", "-C", str(METAGPT_ROOT), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        actual_sha = result.stdout.strip()
        if actual_sha != EXPECTED_SHA:
            self.fail(
                f"MetaGPT clone SHA drift detected: expected {EXPECTED_SHA}, found {actual_sha}. "
                f"This regression suite's assumptions were audited against the expected SHA only — "
                f"a full MG-2H re-audit is required before trusting any result here."
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
