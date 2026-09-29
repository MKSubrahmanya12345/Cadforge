"""Worker unit tests: unit conversion and frame math must match shared/src/units.ts."""

from __future__ import annotations

import math

import pytest

from app.units import (
    GLTF_SCALE,
    MM_PER_INCH,
    MM_PER_MIL,
    Vec3,
    cad_to_gltf,
    hex_to_rgba,
    is_close,
    mm_to_inches,
    mm_to_meters,
    mm_to_mils,
    rotation_matrix,
    rotated_extent,
    to_millimetres,
    tolerance_for,
)


def test_mm_per_inch_exact():
    assert MM_PER_INCH == 25.4
    assert MM_PER_MIL == pytest.approx(0.0254, abs=1e-12)


@pytest.mark.parametrize(
    "value,unit,expected",
    [
        (1, "in", 25.4),
        (1, "inch", 25.4),
        (1, '"', 25.4),
        (1000, "mil", 25.4),
        (1, "mm", 1.0),
        (2.54, "cm", 25.4),
        (1, "m", 1000.0),
        (1000, "um", 1.0),
    ],
)
def test_to_millimetres(value, unit, expected):
    assert to_millimetres(value, unit) == pytest.approx(expected)


def test_to_millimetres_rejects_unknown_unit():
    with pytest.raises(ValueError):
        to_millimetres(1, "smoot")


def test_round_trips():
    assert mm_to_inches(25.4) == pytest.approx(1.0)
    assert mm_to_mils(25.4) == pytest.approx(1000.0)
    # 53.34 mm survives the mil round trip to within float noise, not to zero.
    assert to_millimetres(mm_to_mils(53.34), "mil") == pytest.approx(53.34, abs=1e-9)
    # mm -> metres -> mm is exact enough to be worth asserting.
    assert to_millimetres(mm_to_meters(1234.0) * 1000.0, "mm") == pytest.approx(1234.0, abs=1e-9)


def test_gltf_scale_is_point_zero_zero_one():
    assert GLTF_SCALE == 0.001
    assert mm_to_meters(1000.0) == pytest.approx(1.0)
    assert mm_to_meters(53.34) == pytest.approx(0.05334)


def test_cad_to_gltf_maps_z_to_y_and_inverts_y():
    out = cad_to_gltf(Vec3(1000.0, 2000.0, 3000.0))
    assert out.x == pytest.approx(1.0)
    assert out.y == pytest.approx(3.0)
    assert out.z == pytest.approx(-2.0)


def test_rotation_matrix_identity():
    m = rotation_matrix((0.0, 0.0, 0.0))
    for i in range(3):
        for j in range(3):
            assert m[i][j] == pytest.approx(1.0 if i == j else 0.0)


def test_rotation_matrix_preserves_length():
    m = rotation_matrix((13.0, -47.0, 91.0))
    v = Vec3(3.0, -2.0, 7.0)
    out = Vec3(
        m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
        m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
        m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
    )
    assert math.sqrt(out.x**2 + out.y**2 + out.z**2) == pytest.approx(
        math.sqrt(v.x**2 + v.y**2 + v.z**2)
    )


def test_rotated_extent_square_at_45_degrees():
    e = rotated_extent(Vec3(10.0, 10.0, 2.0), (0.0, 0.0, 45.0))
    assert e.x == pytest.approx(math.sqrt(200.0))
    assert e.y == pytest.approx(math.sqrt(200.0))
    assert e.z == pytest.approx(2.0)


def test_tolerance_rule():
    assert tolerance_for(1.0) == pytest.approx(0.3)
    assert tolerance_for(50.0) == pytest.approx(1.0)
    assert tolerance_for(100.0) == pytest.approx(2.0)


def test_is_close_uses_tolerance():
    # Small parts: the 0.3 mm floor applies. 1.6 vs 1.75 is 0.15 off -> ok.
    assert is_close(1.75, 1.6)
    # 0.4 off a 1.6 mm part is outside the floor.
    assert not is_close(2.0, 1.6)
    # Large parts: 2% takes over (2% of 100 = 2.0), so 1.5 off passes.
    assert is_close(101.5, 100.0)
    # 5% off a 100 mm part fails.
    assert not is_close(105.0, 100.0)
    # The 2% rule is what makes a 53.34 mm board tolerant of a 0.66 mm error,
    # which is deliberate: the tolerance must scale with the part.
    assert is_close(54.0, 53.34)
