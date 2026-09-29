"""
Runs the CadQuery-free parts of the pytest suite using the standard library only.

This exists so the worker's pure logic (unit conversion, frame math, bbox
validation, diff formatting, sandbox prefilter) can be verified on a machine
where CadQuery is not installed yet. `python -m pytest tests` is the real suite
and covers everything, including the CadQuery-dependent tests; run that once
Python 3.11 and requirements.txt are installed (SETUP.md section 4).

    python tests/run_without_cadquery.py
"""

from __future__ import annotations

import builtins
import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _Raises:
    def __init__(self, exc: type[BaseException]) -> None:
        self.exc = exc

    def __enter__(self) -> "_Raises":
        return self

    def __exit__(self, exc_type, exc, _tb) -> bool:
        if exc_type is None:
            raise AssertionError(f"expected {self.exc.__name__} to be raised")
        if not issubclass(exc_type, self.exc):
            return False
        return True


def _approx(expected: float, rel: float | None = None, abs: float | None = None):
    """Stand-in for pytest.approx, honouring the rel/abs keyword forms."""
    # `abs` is shadowed by the parameter, so reach the builtin explicitly.
    tolerance = abs if abs is not None else (builtins.abs(expected) * (rel if rel is not None else 1e-6))

    class _Approx:
        def __eq__(self, other: object) -> bool:
            try:
                return builtins.abs(float(other) - expected) <= tolerance  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return False

        def __repr__(self) -> str:
            return f"approx({expected}, abs={tolerance})"

    return _Approx()


class _Mark:
    @staticmethod
    def parametrize(_argnames, _argvalues):
        def decorate(fn):
            # Expand into one call per parameter set, driven by the runner below.
            fn.__parametrize__ = (  # type: ignore[attr-defined]
                _argnames,
                _argvalues,
            )
            return fn

        return decorate

    @staticmethod
    def usefixtures(*_names):
        def decorate(fn):
            return fn

        return decorate

    def __getattr__(self, _name):
        def decorate(fn):
            return fn

        return decorate


def install_pytest_stub() -> None:
    """A pytest stand-in with just the surface these tests use."""
    module = types.ModuleType("pytest")
    module.raises = _Raises  # type: ignore[attr-defined]
    module.approx = _approx  # type: ignore[attr-defined]
    module.mark = _Mark()  # type: ignore[attr-defined]
    module.fixture = lambda *a, **k: (a[0] if a and callable(a[0]) else (lambda f: f))  # type: ignore[attr-defined]
    sys.modules["pytest"] = module


def run_module(path: Path) -> tuple[int, list[str]]:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    passed = 0
    failures: list[str] = []
    for name in sorted(dir(module)):
        if not name.startswith("test_"):
            continue
        fn = getattr(module, name)
        if not callable(fn):
            continue
        params = getattr(fn, "__parametrize__", None)
        cases: list[tuple] = [()]
        if params is not None:
            argnames, argvalues = params
            names = (
                [n.strip() for n in argnames.split(",")]
                if isinstance(argnames, str)
                else list(argnames)
            )
            cases = []
            for values in argvalues:
                # A single parameter name may still be given a bare scalar, and
                # multiple names may be given a tuple.
                if len(names) == 1 and not isinstance(values, (tuple, list)):
                    cases.append((values,))
                else:
                    cases.append(tuple(values))
        for case in cases:
            try:
                fn(*case)
                passed += 1
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{name}{case}: {type(exc).__name__}: {exc}")
    return passed, failures


def main() -> int:
    install_pytest_stub()

    total = 0
    all_failures: list[str] = []

    # test_builder.py and test_sandbox.py need CadQuery for most of their cases,
    # so only the prefilter tests (which need no kernel) are run here.
    for name in ("test_units.py", "test_validator.py"):
        path = Path(__file__).parent / name
        passed, failures = run_module(path)
        print(f"{name}: {passed} passed, {len(failures)} failed")
        total += passed
        all_failures.extend(f"{name}::{f}" for f in failures)

    # Sandbox prefilter + path sanitising, with no CadQuery required.
    # The sandbox tests that spawn the real child process need CadQuery in that
    # child, so they are out of scope for this runner.
    NEEDS_CADQUERY = (
        "test_simple_cadquery_code_runs_and_is_measured",
        "test_forbidden_import_is_rejected_at_runtime",
        "test_socket_import_blocked",
        "test_missing_build_function_reported",
        "test_runtime_error_is_reported_not_raised",
        "test_timeout_is_enforced",
    )

    path = Path(__file__).parent / "test_sandbox.py"
    passed, failures = run_module(path)
    real = [f for f in failures if f.split("(")[0] not in NEEDS_CADQUERY]
    print(
        f"test_sandbox.py: {passed} passed, {len(real)} failed "
        f"({len(NEEDS_CADQUERY)} tests spawn a real CadQuery child and were skipped)"
    )
    total += passed
    all_failures.extend(f"test_sandbox.py::{f}" for f in real)

    if all_failures:
        print("\nFAILURES:")
        for failure in all_failures:
            print(f"  {failure}")
        return 1

    print(f"\n{total} checks passed. Run `python -m pytest tests -q` with CadQuery "
          "installed for the full suite.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
