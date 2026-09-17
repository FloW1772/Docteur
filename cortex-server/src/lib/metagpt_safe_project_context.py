"""MG-4 — SafeProjectContext: the minimal read-only facade for WriteCode.run().

MG-4B empirically proved (real execution against the actual WriteCode class,
not a mock) that WriteCode.run() and its get_codes() staticmethod only ever
touch 7 members on self.repo, all read-only:

    docs.task.get(filename)                -> Document | None
    docs.code_plan_and_change.get(filename) -> Document | None
    docs.code_summary.get(filename)         -> Document | None
    test_outputs.get(filename)              -> Document | None
    srcs.get(filename)                      -> Document | None
    srcs.all_files                          -> list[str]
    src_relative_path                       -> str

This facade implements exactly those 7 members via plain in-memory dicts
supplied by Docteur, and NOTHING else — no generic passthrough, no
__getattr__ fallback, no inheritance from ProjectRepo. A real
metagpt.utils.project_repo.ProjectRepo is never constructed anywhere in
this module (see metagpt_git_guard.py for the permanent runtime sentinel
that enforces this even if a future code change tried to).
"""
from __future__ import annotations

from typing import Optional


class _SafeDocStore:
    """Duck-types `.get(filename) -> Document | None` only, backed by an
    in-memory dict Docteur populates directly. No filesystem access."""

    def __init__(self, documents: Optional[dict] = None):
        self._documents = dict(documents or {})

    async def get(self, filename):
        from metagpt.schema import Document

        content = self._documents.get(str(filename))
        if content is None:
            return None
        return Document(filename=str(filename), content=content)


class _SafeSrcsStore(_SafeDocStore):
    """Duck-types `.get(filename)` (inherited) plus `.all_files` (list[str])."""

    @property
    def all_files(self) -> list:
        return list(self._documents.keys())


class _SafeDocs:
    """Duck-types `.task`, `.code_plan_and_change`, `.code_summary` —
    each a _SafeDocStore. Nothing else is exposed."""

    def __init__(self, task_documents: Optional[dict] = None):
        self.task = _SafeDocStore(task_documents)
        # V1 scope is non-incremental, first-pass generation: no prior
        # code-plan-and-change or code-summary artifacts exist yet.
        self.code_plan_and_change = _SafeDocStore()
        self.code_summary = _SafeDocStore()


class SafeProjectContext:
    """The complete MG-4 facade passed as WriteCode.repo. Exposes exactly
    the 7 read-only members WriteCode.run()/get_codes() use — no more.

    Deliberately NOT a subclass of ProjectRepo and does not import
    metagpt.utils.project_repo or metagpt.utils.git_repository anywhere.
    """

    def __init__(
        self,
        task_documents: Optional[dict] = None,
        existing_source_files: Optional[dict] = None,
        src_relative_path: str = "src",
    ):
        self.docs = _SafeDocs(task_documents)
        self.srcs = _SafeSrcsStore(existing_source_files)
        # No prior test run exists in V1 first-pass generation.
        self.test_outputs = _SafeDocStore()
        self.src_relative_path = src_relative_path
