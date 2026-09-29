"""Validator tests: bbox tolerance, feature matching, diff generation."""

from __future__ import annotations

import pytest

from app.schemas import Bbox, Feature, PartSpec, Vec3
from app.validate import (
    compare_bbox,
    diff_to_prompt,
    features_ok,
    match_features,
    validate_measurement,
)


def _measurement(x, y, z, cylinders=None):
    return {
        "bbox": {
            "min": {"x": 0.0, "y": 0.0, "z": 0.0},
            "max": {"x": x, "y": y, "z": z},
            "size": {"x": x, "y": y, "z": z},
        },
        "cylinders": cylinders or [],
        "planar_faces": [],
        "volume_mm3": x * y * z,
    }


def test_exact_bbox_passes():
    c = compare_bbox(Bbox(x=68.58, y=53.34, z=1.6), Bbox(x=68.58, y=53.34, z=1.6))
    assert c.ok
    assert c.failing_axes == []
    assert (c.delta_mm.x, c.delta_mm.y, c.delta_mm.z) == (0.0, 0.0, 0.0)


def test_small_parts_use_the_0_3mm_floor():
    # 1.6 vs 1.75 is 0.15 off, inside the floor.
    assert compare_bbox(Bbox(x=5.8, y=5.8, z=1.6), Bbox(x=5.8, y=5.8, z=1.75)).ok
    # 0.4 off a 1.6 mm part is outside it.
    assert not compare_bbox(Bbox(x=5.8, y=5.8, z=1.6), Bbox(x=5.8, y=5.8, z=2.0)).ok
    # An LED is 8.6 mm tall; 1.75 mm is not a LED.
    assert not compare_bbox(Bbox(x=5.8, y=5.8, z=8.6), Bbox(x=5.8, y=5.8, z=1.75)).ok


def test_large_part_uses_two_percent():
    # 68.58 expected, 1% over = 69.27 -> within 2% (1.37) so ok
    assert compare_bbox(Bbox(x=68.58, y=53.34, z=1.6), Bbox(x=69.27, y=53.34, z=1.6)).ok
    # 5% over -> fails
    c = compare_bbox(Bbox(x=68.58, y=53.34, z=1.6), Bbox(x=72.0, y=53.34, z=1.6))
    assert not c.ok
    assert "x" in c.failing_axes


def test_failing_axes_reported_independently():
    c = compare_bbox(Bbox(x=68.58, y=53.34, z=1.6), Bbox(x=68.58, y=90.0, z=1.6))
    assert c.failing_axes == ["y"]
    # The diff line names the axis and both values, so a retry prompt can act on it.
    line = f"bbox.y: expected {c.expected.y:.3f} mm, got {c.actual.y:.3f} mm"
    assert "bbox.y" in diff_to_prompt([line], 1, 4)


def test_1000x_error_is_caught():
    c = compare_bbox(Bbox(x=53.34, y=53.34, z=1.6), Bbox(x=53340.0, y=53340.0, z=1600.0))
    assert not c.ok
    assert set(c.failing_axes) == {"x", "y", "z"}


def test_missing_feature_reported():
    spec = PartSpec(
        id="board",
        name="Board",
        category="board",
        bbox_mm={"x": 50.0, "y": 50.0, "z": 1.6},
        features=[
            Feature(
                type="hole",
                name="mh1",
                position_mm=Vec3(x=10.0, y=10.0, z=0.0),
                dims_mm={"diameter": 3.2},
            )
        ],
        confidence=0.9,
    )
    ok, comparison, features, diff = validate_measurement(spec, _measurement(50.0, 50.0, 1.6))
    assert comparison.ok  # bbox is right
    assert not ok  # but the hole is missing
    assert features[0].name == "mh1"
    assert not features[0].matched
    assert any("mh1" in line for line in diff)


def test_matched_feature():
    spec = PartSpec(
        id="board",
        name="Board",
        category="board",
        bbox_mm={"x": 50.0, "y": 50.0, "z": 1.6},
        features=[
            Feature(
                type="hole",
                name="mh1",
                position_mm=Vec3(x=10.0, y=10.0, z=0.0),
                dims_mm={"diameter": 3.2},
            )
        ],
        confidence=0.9,
    )
    measurement = _measurement(
        50.0,
        50.0,
        1.6,
        [
            {
                "face_index": 0,
                "type": "hole",
                "diameter_mm": 3.2,
                "depth_mm": 1.6,
                "center_mm": {"x": 10.0, "y": 10.0, "z": 0.0},
                "axis": {"x": 0.0, "y": 0.0, "z": 1.0},
            }
        ],
    )
    ok, _comparison, features, diff = validate_measurement(spec, measurement)
    assert ok
    assert features[0].matched
    assert diff == []


def test_wrong_diameter_is_unmatched():
    spec = PartSpec(
        id="board",
        name="Board",
        category="board",
        bbox_mm={"x": 50.0, "y": 50.0, "z": 1.6},
        features=[
            Feature(
                type="hole",
                name="mh1",
                position_mm=Vec3(x=10.0, y=10.0, z=0.0),
                dims_mm={"diameter": 3.2},
            )
        ],
        confidence=0.9,
    )
    measurement = _measurement(
        50.0,
        50.0,
        1.6,
        [
            {
                "face_index": 0,
                "type": "hole",
                "diameter_mm": 5.0,
                "depth_mm": 1.6,
                "center_mm": {"x": 10.0, "y": 10.0, "z": 0.0},
                "axis": {"x": 0.0, "y": 0.0, "z": 1.0},
            }
        ],
    )
    features = match_features(spec, measurement)
    # 3.2 vs 5.0 is outside tolerance -> the expected hole is missing and the
    # measured cylinder shows up as unexpected.
    assert not any(f.matched and f.name == "mh1" for f in features)
    assert any(f.name.startswith("unexpected_cylinder") for f in features)


def test_features_ok_flags_unmatched():
    from app.schemas import MeasuredFeature

    feats = [
        MeasuredFeature(
            name="mh1", type="hole", position_mm=Vec3(x=1, y=1, z=0), diameter_mm=3.2, matched=False
        )
    ]
    ok, lines = features_ok(feats)
    assert not ok
    assert "mh1" in lines[0]


def test_diff_prompt_mentions_attempt_and_diff():
    text = diff_to_prompt(["bbox.x: expected 68.580, got 10.000"], 2, 4)
    assert "attempt 2 of 4" in text
    assert "bbox.x" in text
    assert "Do not change the spec" in text


def test_zero_size_measurement_does_not_crash():
    spec = PartSpec(
        id="x",
        name="X",
        category="other",
        bbox_mm={"x": 1.0, "y": 1.0, "z": 1.0},
        confidence=0.5,
    )
    ok, comparison, _features, _diff = validate_measurement(spec, _measurement(0.0, 0.0, 0.0))
    assert not ok
    assert comparison.actual.x > 0  # clamped, so pydantic does not reject
