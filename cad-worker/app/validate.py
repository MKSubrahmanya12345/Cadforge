"""Compare a measured shape against its PartSpec and produce a structured diff.

Tolerance rule from the spec: 0.3 mm or 2% of the expected value, whichever is
larger. The diff is fed back to the LLM as text so a retry has actionable
information rather than a bare "wrong size".
"""

from __future__ import annotations

from typing import Any

from app.schemas import Bbox, BboxComparison, MeasuredFeature, PartSpec, Vec3
from app.units import tolerance_for

#: Cap on the number of feature diffs we hand back to the LLM.
MAX_REPORTED_FEATURES = 12


def compare_bbox(expected: Bbox, actual: Bbox) -> BboxComparison:
    deltas = Vec3(
        x=actual.x - expected.x,
        y=actual.y - expected.y,
        z=actual.z - expected.z,
    )
    failing: list[str] = []
    for axis in ("x", "y", "z"):
        exp = getattr(expected, axis)
        act = getattr(actual, axis)
        if abs(act - exp) > tolerance_for(exp):
            failing.append(axis)
    return BboxComparison(
        expected=expected,
        actual=actual,
        delta_mm=deltas,
        ok=len(failing) == 0,
        failing_axes=failing,  # type: ignore[arg-type]
    )


def match_features(spec: PartSpec, measurement: dict[str, Any]) -> list[MeasuredFeature]:
    """Match spec holes against the shape's cylindrical faces.

    A spec hole is considered present when some measured cylinder has a
    diameter within tolerance and an axis position within tolerance of the
    spec position (projected onto the two axes the hole runs along).
    """
    expected = [f for f in spec.features if f.type in ("hole", "cylinder")]
    measured: list[dict[str, Any]] = list(measurement.get("cylinders", []))
    out: list[MeasuredFeature] = []
    used: set[int] = set()

    for f in expected:
        d = f.dims_mm.get("diameter")
        p = f.position_mm
        if d is None or float(d) <= 0:
            continue
        best_idx: int | None = None
        best_cost = float("inf")
        for i, m in enumerate(measured):
            if i in used:
                continue
            md = float(m.get("diameter_mm", 0.0) or 0.0)
            if abs(md - float(d)) > tolerance_for(float(d)):
                continue
            axis = m.get("axis") or {"x": 0.0, "y": 0.0, "z": 1.0}
            center = m.get("center_mm") or {"x": 0.0, "y": 0.0, "z": 0.0}
            cost = 0.0
            # Compare only the axes the cylinder actually runs along: a Z-axis
            # hole is located by x,y; a side-drilled hole by y,z or x,z.
            for axis_name in ("x", "y", "z"):
                if abs(float(axis.get(axis_name, 0.0))) < 0.5:
                    continue
                delta = abs(float(center.get(axis_name, 0.0)) - getattr(p, axis_name))
                cost += max(0.0, delta - tolerance_for(getattr(p, axis_name)))
            if cost < best_cost:
                best_cost = cost
                best_idx = i

        if best_idx is not None and best_cost <= tolerance_for(0.0) * 4:
            used.add(best_idx)
            m = measured[best_idx]
            out.append(
                MeasuredFeature(
                    name=f.name,
                    type=f.type,
                    position_mm=Vec3(
                        x=float(m.get("center_mm", {}).get("x", p.x)),
                        y=float(m.get("center_mm", {}).get("y", p.y)),
                        z=float(m.get("center_mm", {}).get("z", p.z)),
                    ),
                    diameter_mm=float(m.get("diameter_mm", 0.0) or 0.0),
                    depth_mm=float(m.get("depth_mm", 0.0) or 0.0),
                    matched=True,
                    delta_mm=round(best_cost, 6),
                )
            )
        else:
            out.append(
                MeasuredFeature(
                    name=f.name,
                    type=f.type,
                    position_mm=p,
                    diameter_mm=float(d),
                    matched=False,
                    delta_mm=None,
                )
            )

    for i, m in enumerate(measured):
        if i not in used and str(m.get("type")) == "hole":
            center = m.get("center_mm", {})
            out.append(
                MeasuredFeature(
                    name=f"unexpected_cylinder_{i}",
                    type="hole",
                    position_mm=Vec3(
                        x=float(center.get("x", 0.0)),
                        y=float(center.get("y", 0.0)),
                        z=float(center.get("z", 0.0)),
                    ),
                    diameter_mm=float(m.get("diameter_mm", 0.0) or 0.0),
                    depth_mm=float(m.get("depth_mm", 0.0) or 0.0),
                    matched=False,
                    delta_mm=None,
                )
            )

    return out[:MAX_REPORTED_FEATURES]


def features_ok(features: list[MeasuredFeature]) -> tuple[bool, list[str]]:
    """(ok, diff lines) for the matched/unmatched feature list."""
    lines: list[str] = []
    ok = True
    for f in features:
        if f.matched:
            continue
        ok = False
        if f.name.startswith("unexpected_cylinder"):
            lines.append(
                f"feature {f.name}: unexpected hole at "
                f"({f.position_mm.x:.3f}, {f.position_mm.y:.3f}) "
                f"dia {f.diameter_mm or 0:.3f} mm that is not in the spec"
            )
        else:
            lines.append(
                f"feature {f.name}: expected a {f.type} with diameter "
                f"{f.diameter_mm or 0:.3f} mm at "
                f"({f.position_mm.x:.3f}, {f.position_mm.y:.3f}, {f.position_mm.z:.3f}) "
                "but no matching feature was found in the model"
            )
    return ok, lines


def validate_measurement(
    spec: PartSpec, measurement: dict[str, Any]
) -> tuple[bool, BboxComparison, list[MeasuredFeature], list[str]]:
    """Full validation: bbox + feature presence. Returns (ok, bbox, features, diff lines)."""
    bbox_info = measurement.get("bbox") or {}
    size = bbox_info.get("size") or {"x": 0.0, "y": 0.0, "z": 0.0}
    actual = Bbox(
        x=max(float(size.get("x", 0.0)), 1e-6),
        y=max(float(size.get("y", 0.0)), 1e-6),
        z=max(float(size.get("z", 0.0)), 1e-6),
    )
    comparison = compare_bbox(spec.bbox_mm, actual)
    features = match_features(spec, measurement)
    feats_ok, feat_lines = features_ok(features)

    diff: list[str] = []
    if not comparison.ok:
        for axis in comparison.failing_axes:
            exp = getattr(comparison.expected, axis)
            act = getattr(comparison.actual, axis)
            delta = getattr(comparison.delta_mm, axis)
            diff.append(
                f"bbox.{axis}: expected {exp:.3f} mm, got {act:.3f} mm "
                f"(delta {delta:+.3f} mm, tolerance ±{tolerance_for(exp):.3f} mm)"
            )
    diff.extend(feat_lines)

    return (comparison.ok and feats_ok), comparison, features, diff


def diff_to_prompt(diff: list[str], attempt: int, max_attempts: int) -> str:
    """The correction message appended to the codegen retry."""
    body = "\n".join(f"- {line}" for line in diff)
    return (
        f"The previous attempt (attempt {attempt} of {max_attempts}) did not match the "
        f"PartSpec. Differences measured from the built solid:\n{body}\n\n"
        "Fix exactly these problems. Do not change the spec. Keep the same parameter "
        "names and the same build() signature."
    )
