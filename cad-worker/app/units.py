"""Unit and frame helpers for the worker. Mirrors shared/src/units.ts."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

MM_PER_INCH = 25.4
MM_PER_MIL = 0.0254
MM_PER_CM = 10.0

#: glTF is metres; the CAD world is millimetres.
GLTF_SCALE = 0.001

_UNIT_FACTORS = {
    "mm": 1.0,
    "millimeter": 1.0,
    "millimetre": 1.0,
    "millimeters": 1.0,
    "millimetres": 1.0,
    "cm": MM_PER_CM,
    "centimeter": MM_PER_CM,
    "centimetre": MM_PER_CM,
    "m": 1000.0,
    "meter": 1000.0,
    "metre": 1000.0,
    "um": 0.001,
    "micron": 0.001,
    "in": MM_PER_INCH,
    "inch": MM_PER_INCH,
    "inches": MM_PER_INCH,
    '"': MM_PER_INCH,
    "mil": MM_PER_MIL,
    "mils": MM_PER_MIL,
    "thou": MM_PER_MIL,
}


def to_millimetres(value: float, unit: str) -> float:
    """Convert ``value`` expressed in ``unit`` to millimetres."""
    key = unit.strip().lower()
    if key not in _UNIT_FACTORS:
        raise ValueError(f"Unknown unit {unit!r}")
    return value * _UNIT_FACTORS[key]


def mm_to_inches(mm: float) -> float:
    return mm / MM_PER_INCH


def mm_to_mils(mm: float) -> float:
    return mm / MM_PER_MIL


def mm_to_meters(mm: float) -> float:
    return mm * GLTF_SCALE


@dataclass(frozen=True)
class Vec3:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "z": self.z}

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, s: float) -> "Vec3":
        return Vec3(self.x * s, self.y * s, self.z * s)


ZERO = Vec3(0.0, 0.0, 0.0)


def euler_xyz_deg(deg: Sequence[float]) -> tuple[float, float, float]:
    """Euler XYZ degrees -> cos/sin triple used to build a rotation."""
    rx = math.radians(deg[0])
    ry = math.radians(deg[1])
    rz = math.radians(deg[2])
    return math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)


def rotation_matrix(deg: Sequence[float]) -> list[list[float]]:
    """Row-major 3x3 rotation matrix for XYZ Euler angles in degrees."""
    cx, sx, cy, sy, cz, sz = euler_xyz_deg(deg)
    return [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]


def apply_matrix(m: Sequence[Sequence[float]], v: Vec3) -> Vec3:
    return Vec3(
        m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
        m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
        m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
    )


def rotated_extent(size: Vec3, deg: Sequence[float]) -> Vec3:
    """Axis-aligned extent of a box of ``size`` rotated by Euler degrees."""
    m = rotation_matrix(deg)
    h = Vec3(size.x / 2.0, size.y / 2.0, size.z / 2.0)
    out = []
    for row in m:
        out.append(abs(row[0]) * h.x + abs(row[1]) * h.y + abs(row[2]) * h.z)
    return Vec3(out[0] * 2.0, out[1] * 2.0, out[2] * 2.0)


def bbox_corners(size: Vec3) -> Iterable[Vec3]:
    for sx in (0.0, size.x):
        for sy in (0.0, size.y):
            for sz in (0.0, size.z):
                yield Vec3(sx, sy, sz)


def tolerance_for(expected: float) -> float:
    """0.3 mm or 2% of expected, whichever is larger."""
    return max(0.3, abs(expected) * 0.02)


def is_close(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= tolerance_for(expected) + 1e-9


def cad_to_gltf(v: Vec3) -> Vec3:
    """CAD (Z-up, mm) -> glTF (Y-up, metres)."""
    return Vec3(v.x * GLTF_SCALE, v.z * GLTF_SCALE, -v.y * GLTF_SCALE)


def hex_to_rgba(color_hex: str | None, default: tuple[int, int, int, int] = (180, 180, 190, 255)) -> list[int]:
    """'#rrggbb' -> trimesh-friendly RGBA ints."""
    if not color_hex:
        return list(default)
    s = color_hex.lstrip("#")
    if len(s) != 6:
        return list(default)
    try:
        r = int(s[0:2], 16)
        g = int(s[2:4], 16)
        b = int(s[4:6], 16)
    except ValueError:
        return list(default)
    return [r, g, b, 255]


def jsonable(value: Any) -> Any:
    """Coerce nested dataclasses/lists/tuples into JSON-safe primitives."""
    if isinstance(value, Vec3):
        return value.as_dict()
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, float):
        # Guard against NaN/Infinity, which are not valid JSON.
        if math.isnan(value) or math.isinf(value):
            return 0.0
        return value
    return value
