"""Sandboxed execution of LLM-authored CadQuery code.

Design constraints from the CADForge spec:

* The LLM's code must never touch the file system, the network, or the OS.
* Only ``cadquery``, ``math`` and ``numpy`` may be imported.
* A hard 30s timeout per attempt, enforced by the parent process.
* Everything runs in a *child* process (``_sandbox_child``) so a segfault or a
  runaway loop cannot take the worker down.

The parent writes a small job file (base64-encoded JSON) to a temp directory,
spawns ``sys.executable -m app._sandbox_child <job>``, and reads a JSON result
back from the child's stdout.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = int(os.environ.get("CADFORGE_CODE_TIMEOUT_S", "30"))
MAX_CODE_BYTES = int(os.environ.get("CADFORGE_MAX_CODE_BYTES", "200000"))

#: Modules the generated code may import. Anything else raises ImportError.
ALLOWED_IMPORTS = ("cadquery", "math", "numpy")

#: Patterns that indicate an attempt to escape the sandbox. These are rejected
#: before execution so we fail fast with a clear message instead of relying on
#: the import hook alone.
BANNED_SUBSTRINGS = (
    "__import__",
    "importlib",
    "subprocess",
    "socket",
    "shutil",
    "pathlib",
    "builtins",
    "__builtins__",
    "eval(",
    "exec(",
    "compile(",
    "globals(",
    "locals(",
    "getattr(__",
    "os.system",
    "os.popen",
    "open(",
    "urllib",
    "requests",
    "http.client",
    "tempfile",
    "sys.exit",
    "input(",
)


class SandboxError(RuntimeError):
    """Raised when generated code cannot be run at all."""


@dataclass
class SandboxResult:
    ok: bool
    value: Any = None
    error: str | None = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    timed_out: bool = False


def preflight(code: str) -> None:
    """Reject obviously hostile code before spawning a process."""
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise SandboxError(
            f"generated code is {len(code.encode('utf-8'))} bytes, limit is {MAX_CODE_BYTES}"
        )
    lowered = code.lower()
    for needle in BANNED_SUBSTRINGS:
        if needle in lowered:
            raise SandboxError(
                f"generated code contains forbidden construct {needle!r}; "
                "only cadquery/math/numpy imports are permitted"
            )


def make_job(code: str, fn_name: str = "build") -> dict[str, Any]:
    return {
        "code": base64.b64encode(code.encode("utf-8")).decode("ascii"),
        "fn_name": fn_name,
        "cwd": str(Path.cwd()),
    }


def run_sandboxed(code: str, fn_name: str = "build", timeout_s: int | None = None) -> SandboxResult:
    """Execute ``code`` in a restricted subprocess and return a JSON-safe result.

    The executed code must define ``fn_name()`` returning something
    ``jsonable``-serialisable (the child handles the conversion), e.g.::

        def build():
            import cadquery as cq
            return cq.Workplane("XY").box(10, 5, 2)
    """
    preflight(code)
    timeout = timeout_s if timeout_s is not None else DEFAULT_TIMEOUT_S
    job = make_job(code, fn_name)

    job_dir = Path(tempfile.mkdtemp(prefix="cadforge-job-"))
    job_file = job_dir / "job.json"
    job_file.write_text(json.dumps(job), encoding="utf-8")

    # -I isolates the interpreter from user site-packages and PYTHON* env vars.
    cmd = [sys.executable, "-I", "-m", "app._sandbox_child", str(job_file)]
    env = {
        "PATH": "/usr/bin:/bin",
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        # CadQuery needs these to be present to work at all.
        "OMP_NUM_THREADS": "1",
        "MPLBACKEND": "Agg",
    }
    if sys.platform == "win32":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "C:\\Windows")
        env["TEMP"] = str(job_dir)
        env["TMP"] = str(job_dir)
        env["PATH"] = os.environ.get("PATH", "")

    started = __import__("time").perf_counter()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(Path(__file__).resolve().parent.parent),
            env=env,
        )
    except subprocess.TimeoutExpired:
        elapsed = int((__import__("time").perf_counter() - started) * 1000)
        _cleanup(job_dir)
        return SandboxResult(
            ok=False,
            error=f"execution exceeded {timeout}s and was killed",
            timed_out=True,
            duration_ms=elapsed,
        )
    finally:
        pass

    elapsed = int((__import__("time").perf_counter() - started) * 1000)
    payload = _extract_payload(proc.stdout)
    _cleanup(job_dir)

    if payload is None:
        detail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        return SandboxResult(
            ok=False,
            error=f"sandbox child produced no result: {detail}",
            stdout=proc.stdout,
            stderr=proc.stderr,
            duration_ms=elapsed,
            timed_out=False,
        )

    return SandboxResult(
        ok=bool(payload.get("ok", False)),
        value=payload.get("value"),
        error=payload.get("error"),
        stdout=proc.stdout,
        stderr=proc.stderr,
        duration_ms=elapsed,
        timed_out=bool(payload.get("timed_out", False)),
    )


def _extract_payload(stdout: str) -> dict[str, Any] | None:
    """The child prints a single line prefixed with CADFORGE_RESULT=."""
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if stripped.startswith("CADFORGE_RESULT="):
            try:
                return json.loads(stripped[len("CADFORGE_RESULT=") :])
            except json.JSONDecodeError:
                log.warning("sandbox child emitted unparseable payload")
                return None
    return None


def _cleanup(job_dir: Path) -> None:
    try:
        for child in job_dir.iterdir():
            child.unlink(missing_ok=True)
        job_dir.rmdir()
    except OSError:
        log.debug("could not clean temp job dir %s", job_dir)


def new_artifact_dir(base: Path) -> Path:
    """Sanitised, unique directory name for one run."""
    safe = re_sub(uuid.uuid4().hex)
    d = base / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def re_sub(value: str) -> str:
    return "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in value)[:64]
