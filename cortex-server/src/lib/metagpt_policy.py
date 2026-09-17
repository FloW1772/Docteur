"""Docteur-controlled security policy for the MetaGPT adapter (V1 scope).

This file is NOT part of the MetaGPT clone (external/MetaGPT/) — it lives in
Docteur's own adapter and is loaded/executed by the bootstrap process that
Docteur spawns, before any MetaGPT role does real work.

Independent validation: this module never trusts the tools/execution-key
list a caller (e.g. the Node adapter, over JSON) claims is safe. It rebuilds
its own allowlists from scratch and revalidates every call, even though the
logical contract mirrors cortex-server/src/lib/metagpt-policy.js.

Confirmed empirically (see reports/METAGPT_DOCTEUR_PATCHES_2026-09.md):
- Passing a filtered `tools=[...]` to a role constructor has NO effect on
  the resulting `tool_execution_map` — MetaGPT populates it independently
  (verified: a ProductManager built with tools=["Editor:write,read,similarity_search"]
  still had 31 keys in tool_execution_map, including every Browser.* method).
  `role.tools` is therefore NEVER a security boundary in this codebase.
- `role.tools` and `role.tool_execution_map` are both freely mutable after
  construction (Pydantic model_config has no frozen=True here) — any
  security decision must be re-checked at call time, not just once after
  construction.
"""
from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Any


class PolicyError(Exception):
    pass


# Table 1 — the ONLY table that matters for security: exact execution keys
# (e.g. "Editor.write"), not class/method-name substrings, not tool
# declarations. Mirrors metagpt-policy.js::ALLOWED_EXECUTION_KEYS_BY_ROLE.
ALLOWED_EXECUTION_KEYS_BY_ROLE: dict[str, frozenset[str]] = {
    "ProductManager": frozenset({"Editor.write", "Editor.read", "Editor.similarity_search"}),
    "Architect": frozenset({"Editor.write", "Editor.read", "Editor.similarity_search"}),
    "ProjectManager": frozenset({
        "Editor.write", "Editor.read", "Editor.similarity_search",
        "WriteTasks", "WriteTasks.run",
    }),
    "RoleZero": frozenset({"Editor.write", "Editor.read", "Editor.similarity_search"}),
}

# Table 2 — cosmetic only. Passed to the role constructor so the declared
# `tools` looks intentional; NEVER consulted by authorize_tool_call() or
# authorize_tool_arguments(). Not a security boundary (see module docstring).
DECLARED_TOOLS_BY_ROLE: dict[str, tuple[str, ...]] = {
    "ProductManager": ("Editor:write,read,similarity_search",),
    "Architect": ("Editor:write,read,similarity_search",),
    "ProjectManager": ("Editor:write,read,similarity_search", "WriteTasks"),
    "RoleZero": ("Editor:write,read,similarity_search",),
}

FORBIDDEN_TOOL_VALUES = {"<all>", "*", "all", "ALL"}

# Editor methods whose first positional/keyword argument is a filesystem
# path that must be checked against the job workspace. Explicit list, not
# "any Editor.* method", so future allowlist additions never silently skip
# argument checking.
EDITOR_PATH_ARG_METHODS = {"write", "read"}

FORBIDDEN_PATH_SUBSTRINGS = (
    "cortex.sqlite",
    ".env",
    "secret-store",
    str(Path(".git")),
    "certs",
    ".claude",
    ".ssh",
    ".aws",
    "appdata",
    str(Path("external") / "MetaGPT"),
)


def _canonical_key(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    normalized = unicodedata.normalize("NFC", raw).strip()
    if not normalized:
        return None
    if any(ord(c) < 0x20 or 0x200B <= ord(c) <= 0x200F or c == "﻿" for c in normalized):
        return None
    return normalized


def is_known_role(role_name: str) -> bool:
    return role_name in ALLOWED_EXECUTION_KEYS_BY_ROLE


def authorize_tool_call(role_name: str, execution_key: Any) -> str:
    """Deny-by-default check. Returns the CANONICAL key on success — callers
    must use this returned value for any subsequent lookup, never the raw
    input that was passed in."""
    if not is_known_role(role_name):
        raise PolicyError(f"role_not_recognized:{role_name}")
    raw_trimmed = execution_key.strip() if isinstance(execution_key, str) else ""
    if raw_trimmed in FORBIDDEN_TOOL_VALUES or raw_trimmed.upper() in FORBIDDEN_TOOL_VALUES:
        raise PolicyError(f"tool_bypass_value_denied:{execution_key}")
    canonical = _canonical_key(execution_key)
    if canonical is None or canonical not in ALLOWED_EXECUTION_KEYS_BY_ROLE[role_name]:
        raise PolicyError(f"tool_execution_denied:{role_name}:{execution_key}")
    return canonical


def _path_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def authorize_tool_arguments(
    role_name: str,
    canonical_execution_key: str,
    args: tuple,
    kwargs: dict,
    workspace_root: str,
) -> bool:
    """Must be called AFTER authorize_tool_call() succeeds and BEFORE the
    callable is invoked. A method being on the execution allowlist does NOT
    make its arguments safe — every path-bearing argument must resolve
    strictly inside workspace_root. Deny by default.

    IMPORTANT — confirmed empirically: metagpt.tools.libs.editor.Editor
    resolves every relative path through its OWN `working_dir` instance
    attribute (default: DEFAULT_WORKSPACE_ROOT = METAGPT_ROOT / "workspace",
    i.e. a directory INSIDE the MetaGPT clone itself), NOT through whatever
    root this function is told to validate against. Validating the raw
    argument here is necessary but NOT sufficient: the caller (see
    bind_editor_to_workspace() below) MUST also set the real Editor
    instance's `working_dir` to workspace_root before any call, and this
    function additionally re-derives the resolution the SAME way Editor
    does (relative to workspace_root) so the two never diverge. A real
    end-to-end test (see tests-python/test_metagpt_policy_real_roles.py)
    caught a first version of this function validating a path successfully
    while the real Editor.write() call still wrote inside
    external/MetaGPT/workspace/ instead — that divergence is exactly what
    bind_editor_to_workspace() closes."""
    if not is_known_role(role_name):
        raise PolicyError(f"role_not_recognized:{role_name}")
    if not workspace_root:
        raise PolicyError("workspace_root_required")
    root = Path(workspace_root).resolve()

    parts = canonical_execution_key.split(".", 1)
    method_base = parts[0]
    method = parts[1] if len(parts) == 2 else None

    if method_base == "Editor" and method in EDITOR_PATH_ARG_METHODS:
        candidate_path = None
        if args:
            candidate_path = args[0]
        elif "path" in kwargs:
            candidate_path = kwargs["path"]
        if not isinstance(candidate_path, str) or not candidate_path:
            raise PolicyError("tool_arguments_denied:missing_path")
        if candidate_path.startswith("\\\\") or candidate_path.startswith("//"):
            raise PolicyError("tool_arguments_denied:unc_path")
        resolved = (root / candidate_path).resolve() if not Path(candidate_path).is_absolute() else Path(candidate_path).resolve()
        if not _path_within(root, resolved):
            raise PolicyError("tool_arguments_denied:path_escape")
        lower = str(resolved).lower()
        for needle in FORBIDDEN_PATH_SUBSTRINGS:
            if needle.lower() in lower:
                raise PolicyError("tool_arguments_denied:forbidden_path")
        # Reject symlink escapes for any path segment that already exists.
        current = root
        try:
            rel_parts = resolved.relative_to(root).parts
        except ValueError:
            rel_parts = ()
        for part in rel_parts:
            current = current / part
            if current.exists() and current.is_symlink():
                raise PolicyError("tool_arguments_denied:symlink_escape")
    # Editor.similarity_search and WriteTasks/WriteTasks.run take no
    # filesystem path argument in the V1 surface.
    return True


def bind_editor_to_workspace(role_instance: Any, workspace_root: str) -> bool:
    """Sets the real Editor tool instance's `working_dir` to workspace_root,
    so its own internal relative-path resolution (_try_fix_path) matches
    what authorize_tool_arguments() validates against. MUST be called once
    right after scrub_tool_execution_map() and before any Editor.write/read
    call — otherwise Editor resolves relative paths against its upstream
    default (METAGPT_ROOT / "workspace", inside the MetaGPT clone itself),
    which authorize_tool_arguments() has no visibility into and cannot
    prevent by checking the raw argument alone (confirmed by a real
    end-to-end write that landed in external/MetaGPT/workspace/ despite the
    argument itself validating cleanly against the job workspace).

    Returns True if an Editor instance was found and bound; False if this
    role has no Editor attribute (e.g. a future role added to the table
    without one) — callers should treat False as a configuration error for
    any role whose allowlist includes an Editor.* key.
    """
    editor = getattr(role_instance, "editor", None)
    if editor is None:
        return False
    editor.working_dir = Path(workspace_root).resolve()
    return True


def scrub_tool_execution_map(role_instance: Any, role_name: str) -> dict:
    """Defense-in-depth cleanup, NOT the primary boundary — authorize_tool_call()
    remains mandatory on every execution, including right after a scrub,
    because role.tool_execution_map stays mutable in Python and a later
    mutation is never excluded.

    Deliberately does NOT reassign role_instance.tools: role.tools is not a
    security boundary, and reassigning it after the scrub risks re-triggering
    a validator/hook (present now or added later upstream) that could
    rebuild tool_execution_map right after it was just cleaned. The scrub
    must be the LAST mutation before validation."""
    if not is_known_role(role_name):
        raise PolicyError(f"role_not_recognized:{role_name}")
    allowed = ALLOWED_EXECUTION_KEYS_BY_ROLE[role_name]
    exec_map = getattr(role_instance, "tool_execution_map", None) or {}
    removed = []
    for key in list(exec_map.keys()):
        canonical = _canonical_key(key)
        if canonical is None or canonical not in allowed:
            del exec_map[key]
            removed.append(key)
    remaining = set(exec_map.keys())
    # Mandatory post-condition.
    assert remaining <= allowed, f"scrub post-condition violated: {remaining - allowed}"
    return {"removed_keys": removed, "remaining_keys": sorted(remaining)}


def execute_authorized_tool(role_instance: Any, role_name: str, execution_key: Any, *args, workspace_root: str, **kwargs):
    """THE single authorized entry point for invoking a tool_execution_map
    callable. The Docteur adapter must never expose any other path to call
    role_instance.tool_execution_map[key](...) directly.

    Mandatory order, never reordered:
      1. scrub_tool_execution_map — clean up any mutation since last check
      2. bind_editor_to_workspace — align Editor's own path resolution with
                                     the workspace this call is scoped to
                                     (required — see bind_editor_to_workspace
                                     docstring for why authorize_tool_arguments
                                     alone is not sufficient)
      3. authorize_tool_call       — deny-by-default on the execution key,
                                     returns the canonical key
      4. authorize_tool_arguments  — deny-by-default on path arguments,
                                     using the CANONICAL key only
      5. lookup tool_execution_map[canonical] — only after all checks pass
      6. invoke the callable

    For MG-2G: this function is designed and unit-tested with mocks only.
    No tool is actually invoked against a real MetaGPT workflow in this
    phase (a real-role end-to-end smoke test exists separately and is run
    manually, not as part of the automated suite, since it requires the
    isolated MetaGPT venv).
    """
    scrub_tool_execution_map(role_instance, role_name)
    bind_editor_to_workspace(role_instance, workspace_root)
    canonical = authorize_tool_call(role_name, execution_key)
    authorize_tool_arguments(role_name, canonical, args, kwargs, workspace_root)

    exec_map = getattr(role_instance, "tool_execution_map", None) or {}
    if canonical not in exec_map:
        # Should never happen if authorize_tool_call succeeded and scrub just
        # ran — defense in depth against an inconsistent state.
        raise PolicyError(f"tool_execution_key_missing_after_scrub:{canonical}")

    callable_fn = exec_map[canonical]
    return callable_fn(*args, **kwargs)
