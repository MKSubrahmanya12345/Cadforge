"""Export placement must use the documented lower-left-bottom part origin."""

from __future__ import annotations

import pytest

from app.export import assembly_bbox, build_item_shape, to_compound
from app.schemas import ExportItem, PartSpec, Vec3

pytestmark = pytest.mark.usefixtures("has_cadquery")


def _item(rotation: Vec3 = Vec3()) -> ExportItem:
    spec = PartSpec(
        id="part",
        name="Centered test part",
        category="mechanical",
        bbox_mm={"x": 10, "y": 8, "z": 2},
        confidence=1.0,
    )
    return ExportItem(
        instance_name="part_1",
        part_id="part",
        spec=spec,
        position_mm=Vec3(x=10, y=20, z=3),
        rotation_deg=rotation,
        code=(
            "import cadquery as cq\n"
            "def build():\n"
            "    return cq.Workplane('XY').box(10, 8, 2, centered=(True, True, False))\n"
        ),
    )


def test_export_normalizes_centered_geometry_to_lower_left_origin(tmp_path):
    item = _item()
    shape = build_item_shape(item, tmp_path)
    local = shape.val().BoundingBox()
    assert (local.xmin, local.ymin, local.zmin) == pytest.approx((0, 0, 0))
    assert (local.xmax, local.ymax, local.zmax) == pytest.approx((10, 8, 2))

    world = to_compound([(shape, item.position_mm, item.rotation_deg)]).val().BoundingBox()
    assert (world.xmin, world.ymin, world.zmin) == pytest.approx((10, 20, 3))
    assert (world.xmax, world.ymax, world.zmax) == pytest.approx((20, 28, 5))


def test_rotated_part_matches_reported_assembly_bounds(tmp_path):
    item = _item(Vec3(x=0, y=0, z=90))
    shape = build_item_shape(item, tmp_path)
    world = to_compound([(shape, item.position_mm, item.rotation_deg)]).val().BoundingBox()
    expected = assembly_bbox([item])
    assert world.xlen == pytest.approx(expected.x)
    assert world.ylen == pytest.approx(expected.y)
    assert world.zlen == pytest.approx(expected.z)
