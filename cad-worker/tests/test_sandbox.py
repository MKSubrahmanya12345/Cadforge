"""Sandbox tests: import restrictions, banned constructs, timeouts.

These run the real child process, so they need CadQuery installed (the child
imports it for measurement). They are skipped cleanly when it is not.
"""

from __future__ import annotations

import pytest

from app.sandbox import MAX_CODE_BYTES, SandboxError, preflight, re_sub, run_sandboxed

pytestmark = pytest.mark.usefixtures("has_cadquery")


def test_simple_cadquery_code_runs_and_is_measured():
    code = (
        "import cadquery as cq\n"
        "def build():\n"
        "    return cq.Workplane('XY').box(68.58, 53.34, 1.6, centered=(True, True, False))\n"
    )
    result = run_sandboxed(code, "build", timeout_s=60)
    assert result.ok, result.error
    size = result.value["bbox"]["size"]
    assert size["x"] == pytest.approx(68.58, abs=1e-6)
    assert size["y"] == pytest.approx(53.34, abs=1e-6)
    assert size["z"] == pytest.approx(1.6, abs=1e-6)


def test_forbidden_import_is_rejected_at_runtime():
    code = "import os\ndef build():\n    return None\n"
    result = run_sandboxed(code, "build", timeout_s=60)
    assert not result.ok
    assert "not allowed" in (result.error or "")


def test_socket_import_blocked():
    code = "import socket\ndef build():\n    return None\n"
    result = run_sandboxed(code, "build", timeout_s=60)
    assert not result.ok


def test_open_is_trapped_even_though_name_is_allowed():
    # `open(` is caught by preflight before the process is ever spawned.
    with pytest.raises(SandboxError):
        preflight("def build():\n    return open('/etc/passwd')\n")


def test_missing_build_function_reported():
    code = "import cadquery as cq\n"
    result = run_sandboxed(code, "build", timeout_s=60)
    assert not result.ok
    assert "build" in (result.error or "")


def test_runtime_error_is_reported_not_raised():
    code = "def build():\n    raise ValueError('boom')\n"
    result = run_sandboxed(code, "build", timeout_s=60)
    assert not result.ok
    assert "boom" in (result.error or "")


def test_timeout_is_enforced():
    code = "def build():\n    while True:\n        pass\n"
    result = run_sandboxed(code, "build", timeout_s=2)
    assert not result.ok
    assert result.timed_out
    assert "exceeded" in (result.error or "")


def test_preflight_rejects_dangerous_constructs():
    for snippet in (
        "def build():\n    return eval('1')\n",
        "def build():\n    import subprocess\n",
        "def build():\n    return __import__('os')\n",
        "def build():\n    import urllib.request\n",
        "def build():\n    return open('/etc/passwd')\n",
        "def build():\n    import os.system\n",
        "def build():\n    import socket\n",
        "def build():\n    import pathlib\n",
    ):
        with pytest.raises(SandboxError):
            preflight(snippet)


def test_preflight_accepts_legitimate_cadquery():
    # A correct build must not be rejected by the prefilter.
    preflight(
        "import cadquery as cq\n"
        "import math\n"
        "import numpy as np\n"
        "\n"
        "LENGTH_MM = 68.58\n"
        "\n"
        "def build() -> cq.Workplane:\n"
        "    return cq.Workplane('XY').box(LENGTH_MM, 53.34, 1.6)\n"
    )


def test_preflight_rejects_oversized_code():
    with pytest.raises(SandboxError):
        preflight("x" * (MAX_CODE_BYTES + 1))


def test_re_sub_sanitises_names():
    # No path separator can survive, so a sanitised name can never traverse.
    assert "/" not in re_sub("../../etc/passwd")
    assert "\\" not in re_sub("..\\..\\windows\\system32")
    assert re_sub("../../etc/passwd") == "______etc_passwd"
    assert re_sub("uno_1") == "uno_1"
    assert re_sub("a.b-c") == "a_b-c"
    assert len(re_sub("x" * 200)) == 64
