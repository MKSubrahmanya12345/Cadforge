"""Child process entry point for :mod:`app.sandbox`.

Reads a job file (path in argv[1]), executes the LLM-authored code under a
restricted import hook, calls the requested factory function, measures the
result, and prints one line of JSON prefixed with ``CADFORGE_RESULT=``.

Measurement happens *inside* the child so the parent never has to unpickle or
re-serialise a CadQuery shape across the process boundary.
"""

from __future__ import annotations

import base64
import builtins
import json
import sys
import traceback
from pathlib import Path
from typing import Any

# ``python -I`` does not add the working directory to sys.path, so make the
# worker package importable explicitly. app/ lives next to this file.
_WORKER_ROOT = str(Path(__file__).resolve().parent.parent)
if _WORKER_ROOT not in sys.path:
    sys.path.insert(0, _WORKER_ROOT)

ALLOWED_ROOTS = ("cadquery", "math", "numpy")


class ForbiddenImport(ImportError):
    pass


def _make_trap(name: str):
    def trap(*_args: Any, **_kwargs: Any):
        raise PermissionError(f"{name!r} is not available inside the CADForge sandbox")

    trap.__name__ = name
    return trap


def _install_import_hook() -> None:
    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: ANN001
        root = name.split(".", 1)[0]
        if root not in ALLOWED_ROOTS:
            raise ForbiddenImport(
                f"import of {name!r} is not allowed; permitted modules: {', '.join(ALLOWED_ROOTS)}"
            )
        return real_import(name, globals, locals, fromlist, level)

    builtins.__import__ = guarded_import

    for attr in ("eval", "exec", "compile", "open", "input", "__import__", "globals", "locals"):
        if hasattr(builtins, attr):
            setattr(builtins, attr, _make_trap(attr))


def _jsonable(value: Any, depth: int = 0) -> Any:
    from app.units import jsonable

    if depth > 8:
        return repr(value)[:200]
    if isinstance(value, bool) or value is None or isinstance(value, (int, float, str)):
        return jsonable(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in list(value.items())[:128]}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth + 1) for v in list(value)[:1024]]
    return repr(value)[:200]


def main() -> int:
    if len(sys.argv) < 2:
        _emit({"ok": False, "error": "no job file supplied"})
        return 1
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            job = json.load(fh)
        code = base64.b64decode(job["code"]).decode("utf-8")
        fn_name = job.get("fn_name", "build")
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": f"could not read job: {exc}"})
        return 1

    _install_import_hook()

    namespace: dict[str, Any] = {"__name__": "cadforge_generated", "__builtins__": builtins}
    try:
        exec(compile(code, "<cadforge-generated>", "exec"), namespace)  # noqa: S102
        factory = namespace.get(fn_name)
        if not callable(factory):
            _emit({"ok": False, "error": f"generated code does not define a callable {fn_name}()"})
            return 1
        shape = factory()
        from app.measure import measure

        measurement = measure(shape)
        _emit({"ok": True, "value": measurement})
        return 0
    except ForbiddenImport as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    except Exception as exc:  # noqa: BLE001
        _emit(
            {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc()[-4000:],
            }
        )
        return 1


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("CADFORGE_RESULT=" + json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
