"""Deterministic builder tests.

The fallback builder is the guarantee that a correctly-scaled model is ALWAYS
produced, so its output is validated against the spec the same way LLM output
is.
"""

from __future__ import annotations

import pytest

from app.builder import CATEGORY_COLORS, build_fallback, default_color, fallback_code
from app.generate import generate_fallback
from app.validate import validate_measurement

pytestmark = pytest.mark.usefixtures("has_cadquery")


def _measure(spec):
    from app.measure import measure

    return measure(build_fallback(spec))


def test_fallback_bbox_matches_spec_exactly(uno_spec):
    m = _measure(uno_spec)
    size = m["bbox"]["size"]
    assert size["x"] == pytest.approx(68.58, abs=0.01)
    assert size["y"] == pytest.approx(53.34, abs=0.01)
    assert size["z"] == pytest.approx(1.6, abs=0.01)


def test_fallback_validates_against_uno_spec(uno_spec):
    response = generate_fallback("uno_1", uno_spec, timeout_s=120)
    assert response.ok, response.error
    assert response.fallback
    assert response.valid, response.error
    assert response.bbox is not None and response.bbox.ok


def test_fallback_places_holes_where_the_spec_says(uno_spec):
    m = _measure(uno_spec)
    holes = [c for c in m["cylinders"] if c["type"] == "hole"]
    assert len(holes) >= 2
    positions = {(round(h["center_mm"]["x"], 2), round(h["center_mm"]["y"], 2)) for h in holes}
    # spec mount_hole_1 is at (13.97, 2.54) with the part origin centred, so the
    # measured centre is offset by half the board.
    assert any(
        abs(px - (13.97 - 68.58 / 2)) < 0.05 and abs(py - (2.54 - 53.34 / 2)) < 0.05
        for px, py in positions
    )
    diameters = {round(h["diameter_mm"], 2) for h in holes}
    assert 3.2 in diameters


def test_led_fallback_is_led_sized(led_spec):
    m = _measure(led_spec)
    size = m["bbox"]["size"]
    assert size["x"] == pytest.approx(5.8, abs=0.01)
    assert size["z"] == pytest.approx(8.6, abs=0.01)
    # the dome cylinder is present at 5.0 mm
    dias = {round(c["diameter_mm"], 2) for c in m["cylinders"]}
    assert 5.0 in dias


def test_fallback_code_is_valid_python_and_self_consistent(uno_spec):
    code = fallback_code(uno_spec)
    compile(code, "<fallback>", "exec")
    namespace: dict = {}
    exec(compile(code, "<fallback>", "exec"), namespace)  # noqa: S102
    assert "build" in namespace
    assert namespace["LENGTH_MM"] == pytest.approx(68.58)
    assert namespace["WIDTH_MM"] == pytest.approx(53.34)
    assert namespace["HEIGHT_MM"] == pytest.approx(1.6)
    assert "MOUNT_HOLE_1_DIAMETER_MM" in namespace


def test_fallback_code_runs_through_the_same_sandbox(uno_spec):
    from app.sandbox import run_sandboxed

    result = run_sandboxed(fallback_code(uno_spec), "build", timeout_s=120)
    assert result.ok, result.error
    assert result.value["bbox"]["size"]["x"] == pytest.approx(68.58, abs=0.01)


def test_default_colors():
    from app.schemas import PartSpec

    spec = PartSpec(
        id="x", name="X", category="board", bbox_mm={"x": 1, "y": 1, "z": 1}, confidence=0.5
    )
    assert default_color(spec) == CATEGORY_COLORS["board"]
    spec.color_hex = "#ff0000"
    assert default_color(spec) == "#ff0000"


def test_assembly_of_uno_and_led_keeps_ratio():
    """The core product guarantee, checked on real geometry."""
    from app.schemas import PartSpec
    from app.validate import compare_bbox

    uno = PartSpec(
        id="uno",
        name="Uno",
        category="board",
        bbox_mm={"x": 68.58, "y": 53.34, "z": 1.6},
        features=[],
        confidence=1.0,
        verified=True,
    )
    led = PartSpec(
        id="led",
        name="LED",
        category="led",
        bbox_mm={"x": 5.8, "y": 5.8, "z": 8.6},
        features=[],
        confidence=1.0,
        verified=True,
    )
    uno_size = _measure(uno)["bbox"]["size"]
    led_size = _measure(led)["bbox"]["size"]
    # LED dome 5.0 / Uno width 53.34 must hold on the actual solids.
    assert led_size["x"] / uno_size["y"] == pytest.approx(5.0 / 53.34, rel=0.02)
    assert led_size["x"] < uno_size["x"]
    # and a fresh validation of both is exact
    assert compare_bbox(uno.bbox_mm, uno.bbox_mm).ok
    assert led.bbox_mm.z > uno.bbox_mm.z
