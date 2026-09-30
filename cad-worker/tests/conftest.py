"""pytest fixtures. Adds the worker root to sys.path so `app.*` imports work."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.schemas import Feature, PartSpec, Vec3  # noqa: E402


@pytest.fixture(scope="session")
def uno_spec() -> PartSpec:
    return PartSpec(
        id="arduino-uno-r3",
        name="Arduino Uno R3",
        category="board",
        bbox_mm={"x": 68.58, "y": 53.34, "z": 14.0},
        base_thickness_mm=1.6,
        features=[
            Feature(
                type="hole",
                name="mount_hole_1",
                position_mm=Vec3(x=13.97, y=2.54, z=0.0),
                dims_mm={"diameter": 3.2},
            ),
            Feature(
                type="hole",
                name="mount_hole_2",
                position_mm=Vec3(x=15.24, y=50.8, z=0.0),
                dims_mm={"diameter": 3.2},
            ),
        ],
        anchors=[],
        confidence=0.95,
        verified=True,
    )


@pytest.fixture(scope="session")
def led_spec() -> PartSpec:
    return PartSpec(
        id="led-5mm",
        name="5mm LED",
        category="led",
        bbox_mm={"x": 5.8, "y": 5.8, "z": 8.6},
        features=[
            Feature(
                type="cylinder",
                name="dome",
                position_mm=Vec3(x=2.9, y=2.9, z=8.6),
                dims_mm={"diameter": 5.0, "height": 0.01},
            )
        ],
        anchors=[
            {"name": "lead_1", "position_mm": {"x": 1.27, "y": 0.0, "z": 0.0}},
            {"name": "lead_2", "position_mm": {"x": -1.27, "y": 0.0, "z": 0.0}},
        ],
        confidence=0.85,
        verified=True,
    )


@pytest.fixture(scope="session")
def has_cadquery() -> bool:
    try:
        import cadquery  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False
