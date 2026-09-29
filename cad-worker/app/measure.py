"""Measurement of a CadQuery shape: bounding box, holes, and feature positions.

This module is imported by the sandbox child, so it must not import anything
outside ``cadquery``/``math``/``numpy`` at module scope, and must never touch
the filesystem or network.
"""

from __future__ import annotations

import math
from typing import Any

#: Below this, a cylindrical face is treated as a hole rather than a boss.
MIN_HOLE_RADIUS_MM = 0.15
#: Cylinder depth shorter than this is noise/surface curvature.
MIN_HOLE_DEPTH_MM = 0.2


def _unwrap(obj: Any) -> Any:
    """Turn whatever the factory returned into a single cadquery Shape."""
    import cadquery as cq

    if isinstance(obj, cq.Workplane):
        # ``.val()`` returns the first object; combine everything else.
        vals = obj.vals()
        if len(vals) == 1:
            return vals[0]
        combined = obj.combine()
        return combined.val() if isinstance(combined, cq.Workplane) else vals[0]
    if isinstance(obj, cq.Shape):
        return obj
    if isinstance(obj, (list, tuple)):
        for item in obj:
            try:
                return _unwrap(item)
            except Exception:  # noqa: BLE001
                continue
    raise TypeError(
        f"factory returned {type(obj).__name__}; expected a cadquery Workplane or Shape"
    )


def shape_bbox(shape: Any) -> dict[str, Any]:
    """Axis-aligned bbox of a shape as {min, max, size} in mm."""
    bb = shape.BoundingBox()
    minv = (bb.xmin, bb.ymin, bb.zmin)
    maxv = (bb.xmax, bb.ymax, bb.zmax)
    return {
        "min": {"x": minv[0], "y": minv[1], "z": minv[2]},
        "max": {"x": maxv[0], "y": maxv[1], "z": maxv[2]},
        "size": {"x": maxv[0] - minv[0], "y": maxv[1] - minv[1], "z": maxv[2] - minv[2]},
    }


def _cylinder_measurements(shape: Any) -> list[dict[str, Any]]:
    """Every cylindrical face, classified as hole or boss."""
    out: list[dict[str, Any]] = []
    try:
        faces = shape.Faces()
    except Exception:  # noqa: BLE001
        return out
    for i, face in enumerate(faces):
        try:
            surf = face.geomType()
        except Exception:  # noqa: BLE001
            continue
        if surf != "CYLINDER":
            continue
        try:
            adaptor = face._geomAdaptor()
            cyl = adaptor.Cylinder()
            radius = float(cyl.Radius())
            axis = cyl.Axis()
            loc = axis.Location()
            direction = axis.Direction()
            fbb = face.BoundingBox()
            depth = max(fbb.zlen, fbb.xlen, fbb.ylen)
        except Exception:  # noqa: BLE001
            continue
        if radius <= 0 or not math.isfinite(radius):
            continue
        # A cylinder is a hole when its axis direction is not the Z axis
        # (i.e. it is drilled sideways) or when it is clearly smaller than the
        # part thickness. Both cases are the mounting-hole case for PCBs.
        is_through_z = abs(abs(direction.Z()) - 1.0) < 1e-6
        classified = "boss" if (is_through_z and radius >= MIN_HOLE_RADIUS_MM) else "hole"
        if classified == "boss" and depth < MIN_HOLE_DEPTH_MM:
            classified = "hole"
        out.append(
            {
                "face_index": i,
                "type": classified,
                "diameter_mm": radius * 2.0,
                "depth_mm": float(depth),
                "center_mm": {"x": float(loc.X()), "y": float(loc.Y()), "z": float(loc.Z())},
                "axis": {"x": float(direction.X()), "y": float(direction.Y()), "z": float(direction.Z())},
            }
        )
    return out


def _box_measurements(shape: Any) -> list[dict[str, Any]]:
    """Planar faces, used as a weak proxy for pads and cutout edges."""
    out: list[dict[str, Any]] = []
    try:
        faces = shape.Faces()
    except Exception:  # noqa: BLE001
        return out
    for i, face in enumerate(faces):
        try:
            if face.geomType() != "PLANE":
                continue
            c = face.Center()
            fbb = face.BoundingBox()
        except Exception:  # noqa: BLE001
            continue
        out.append(
            {
                "face_index": i,
                "type": "pad",
                "center_mm": {"x": float(c.x), "y": float(c.y), "z": float(c.z)},
                "area_mm2": float(fbb.xlen * fbb.ylen),
            }
        )
    return out


def measure(obj: Any) -> dict[str, Any]:
    """Full measurement payload for a generated shape."""
    shape = _unwrap(obj)
    return {
        "bbox": shape_bbox(shape),
        "cylinders": _cylinder_measurements(shape),
        "planar_faces": _box_measurements(shape),
        "volume_mm3": float(shape.Volume()),
    }
