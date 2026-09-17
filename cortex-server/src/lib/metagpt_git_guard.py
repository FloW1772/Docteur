"""MG-4 — Permanent Git/shell non-reachability guard.

MG-4B established empirically that importing WritePRD/WriteDesign/WriteTasks
(the same three Actions already certified PASS in MG-3) unconditionally loads
GitPython, PyGithub, metagpt.utils.git_repository.GitRepository and
metagpt.utils.project_repo.ProjectRepo into memory, because design_api.py,
project_management.py and write_prd.py each do
`from metagpt.utils.project_repo import ProjectRepo` at module level.

Per the MG-4 OPTION A decision:
  - This import is TOLERATED (it already happened during MG-3; not a new
    MG-4 surface).
  - INSTANTIATION of ProjectRepo/GitRepository, and reaching
    git.repo.Repo.init / shell_execute / GitRepository.push /
    GitRepository.clone_from, are NEVER allowed during any MG-4 job.

This module installs sentinels on exactly those six choke points and
raises immediately if any of them is ever reached, aborting the job. It
must be installed AFTER metagpt has been imported (so the real classes
exist to patch) and BEFORE any WriteCode/WritePRD/WriteDesign/WriteTasks
call is made.

Note on subprocess sentinels (MG-4B section 11): a naive global patch of
subprocess.run is NOT used here. MG-4B found that Windows CPython's stdlib
`platform.system()` (invoked transitively by metagpt/_compat.py at import
time) can itself invoke `cmd /c ver` via subprocess.check_output, which
would be a false positive under a global sentinel. This module patches
`metagpt.tools.libs.shell.shell_execute` directly instead — the actual
function GitRepository.push()/clone_from() call — never bare subprocess.
"""
from __future__ import annotations

from dataclasses import dataclass, field


class GitGuardViolation(RuntimeError):
    """Raised immediately when a forbidden Git/shell choke point is reached.
    Any job catching this must ABORT immediately — never retry, never
    suppress, never continue with partial results."""


@dataclass
class GitGuardCounters:
    project_repo_init: int = 0
    git_repository_init: int = 0
    repo_init: int = 0
    shell_execute: int = 0
    git_push: int = 0
    git_clone_from: int = 0

    def total(self) -> int:
        return (
            self.project_repo_init
            + self.git_repository_init
            + self.repo_init
            + self.shell_execute
            + self.git_push
            + self.git_clone_from
        )

    def as_report_dict(self) -> dict:
        return {
            "ProjectRepo.__init__ reached": self.project_repo_init,
            "GitRepository.__init__ reached": self.git_repository_init,
            "Repo.init reached": self.repo_init,
            "shell_execute reached": self.shell_execute,
            "push reached": self.git_push,
            "clone_from reached": self.git_clone_from,
        }


class GitGuard:
    """Installs/removes the six sentinels. Use as a context manager so
    guards are always removed even if the job raises, and so a fresh
    GitGuardCounters is used per job (no cross-job state leakage)."""

    def __init__(self):
        self.counters = GitGuardCounters()
        self._installed = False
        self._originals: dict = {}

    def install(self) -> None:
        if self._installed:
            raise RuntimeError("GitGuard already installed — do not install twice in the same job")

        from metagpt.utils.project_repo import ProjectRepo
        from metagpt.utils.git_repository import GitRepository
        import git

        counters = self.counters

        orig_project_repo_init = ProjectRepo.__init__

        def sentinel_project_repo_init(self_, *a, **k):
            counters.project_repo_init += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: ProjectRepo.__init__ reached. This is forbidden under "
                "MG-4 OPTION A (import tolerated, instantiation never allowed). ABORT job."
            )

        orig_git_repository_init = GitRepository.__init__

        def sentinel_git_repository_init(self_, *a, **k):
            counters.git_repository_init += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: GitRepository.__init__ reached. Forbidden under MG-4 "
                "OPTION A. ABORT job."
            )

        orig_repo_init = git.repo.Repo.init

        def sentinel_repo_init(*a, **k):
            counters.repo_init += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: git.repo.Repo.init reached — a real `git init` was about "
                "to happen. Forbidden under MG-4 OPTION A. ABORT job."
            )

        orig_push = GitRepository.push

        async def sentinel_push(self_, *a, **k):
            counters.git_push += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: GitRepository.push reached — a real network push to a "
                "remote Git host was about to happen. Forbidden under MG-4. ABORT job."
            )

        orig_clone_from = GitRepository.clone_from

        async def sentinel_clone_from(*a, **k):
            counters.git_clone_from += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: GitRepository.clone_from reached — a real `git clone` was "
                "about to happen. Forbidden under MG-4. ABORT job."
            )

        # shell_execute: patch the actual call sites' bound reference inside
        # git_repository module (never a global subprocess patch — see module
        # docstring re: platform.system() false positive found in MG-4B).
        from metagpt.utils import git_repository as _git_repository_module

        orig_shell_execute = _git_repository_module.shell_execute

        async def sentinel_shell_execute(*a, **k):
            counters.shell_execute += 1
            raise GitGuardViolation(
                "MG-4 GitGuard: shell_execute reached from metagpt.utils.git_repository — "
                "a real shell command was about to run. Forbidden under MG-4. ABORT job."
            )

        self._originals = {
            "ProjectRepo.__init__": (ProjectRepo, "__init__", orig_project_repo_init),
            "GitRepository.__init__": (GitRepository, "__init__", orig_git_repository_init),
            "Repo.init": (git.repo.Repo, "init", orig_repo_init),
            "GitRepository.push": (GitRepository, "push", orig_push),
            "GitRepository.clone_from": (GitRepository, "clone_from", orig_clone_from),
            "git_repository.shell_execute": (_git_repository_module, "shell_execute", orig_shell_execute),
        }

        ProjectRepo.__init__ = sentinel_project_repo_init
        GitRepository.__init__ = sentinel_git_repository_init
        git.repo.Repo.init = staticmethod(sentinel_repo_init)
        GitRepository.push = sentinel_push
        GitRepository.clone_from = staticmethod(sentinel_clone_from)
        _git_repository_module.shell_execute = sentinel_shell_execute

        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        for _name, (owner, attr, original) in self._originals.items():
            setattr(owner, attr, original)
        self._installed = False

    def assert_clean(self) -> None:
        """Call at end of job. Raises if ANY counter is non-zero — belt and
        suspenders in case a violation was somehow caught/suppressed
        upstream instead of propagating."""
        if self.counters.total() != 0:
            raise GitGuardViolation(
                f"MG-4 GitGuard: non-zero reach count(s) at job end: {self.counters.as_report_dict()}"
            )

    def __enter__(self) -> "GitGuard":
        self.install()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.uninstall()
