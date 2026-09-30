"""Export STEP (source of truth), GLB (Y-up, metres), STL, and optional FCStd.

Conventions:
* All work happens in millimetres, Z-up, origin at the lower-left of the base
  part. The STEP and STL files therefore carry millimetres directly.
* The GLB is scaled by 0.001 and rotated Z-up -> Y-up, because glTF is metres
  and Y-up. Each part becomes a named node carrying its spec colour.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from app.builder import default_color
from app.sandbox import re_sub
from app.schemas import Bbox, ExportItem, PartSpec, Vec3
from app.units import GLTF_SCALE, Vec3 as UVec3, hex_to_rgba, rotated_extent

log = logging.getLogger(__name__)

FREECAD_CMD = "freecadcmd"


def freecad_available() -> bool:
    return shutil.which(FREECAD_CMD) is not None


def _build_shape(code: str, workdir: Path, timeout_s: int = 60) -> Any:
    """Execute code in a *trusted* context (server-authored or validated)."""
    import cadquery as cq

    namespace: dict[str, Any] = {"cq": cq, "__name__": "cadforge_export"}
    exec(compile(code, "<cadforge-export>", "exec"), namespace)  # noqa: S102
    factory = namespace.get("build")
    if not callable(factory):
        raise ValueError("code does not define build()")
    return factory()


def _as_shape(obj: Any) -> Any:
    import cadquery as cq

    if isinstance(obj, cq.Workplane):
        return obj
    if isinstance(obj, cq.Shape):
        return cq.Workplane(obj=obj) if hasattr(obj, "wrapped") else obj
    raise TypeError(f"build() returned {type(obj).__name__}, expected Workplane or Shape")


def _normalize_part_origin(obj: Any) -> Any:
    """Place a part's measured lower-left-bottom corner at its local origin."""
    shape = _as_shape(obj)
    bounds = shape.val().BoundingBox()
    return shape.translate((-bounds.xmin, -bounds.ymin, -bounds.zmin))


def to_compound(parts: list[tuple[Any, Vec3, Vec3]]) -> Any:
    """Combine shapes with position/rotation into one compound."""
    import cadquery as cq

    moved = []
    for shape, pos, rot in parts:
        s = _normalize_part_origin(shape)
        if any(abs(v) > 1e-9 for v in (rot.x, rot.y, rot.z)):
            sx, sy, sz = s.val().BoundingBox().xlen, s.val().BoundingBox().ylen, s.val().BoundingBox().zlen
            # Rotate around the part centre, then put the rotated lower-left
            # corner back at the local origin used by placement offsets.
            s = s.translate((-sx / 2, -sy / 2, -sz / 2))
            rotated = s.rotate((0, 0, 0), (1, 0, 0), rot.x)
            rotated = rotated.rotate((0, 0, 0), (0, 1, 0), rot.y)
            rotated = rotated.rotate((0, 0, 0), (0, 0, 1), rot.z)
            s = _normalize_part_origin(rotated)
        s = s.translate((pos.x, pos.y, pos.z))
        moved.append(s)
    if len(moved) == 1:
        return moved[0]
    return cq.Compound.makeCompound([w.val() for w in moved])


def export_step(shape: Any, path: Path) -> None:
    import cadquery as cq

    cq.exporters.export(shape, str(path), cq.exporters.ExportTypes.STEP)


def export_stl(shape: Any, path: Path, tolerance: float = 0.05, angular: float = 0.2) -> None:
    import cadquery as cq

    cq.exporters.export(
        shape,
        str(path),
        cq.exporters.ExportTypes.STL,
        tolerance=tolerance,
        angularTolerance=angular,
    )


def _tessellate(shape: Any, tolerance: float = 0.05) -> Any:
    """Triangulate a shape into a trimesh.Trimesh in millimetres."""
    import trimesh

    verts, tris = shape.val().tessellate(tolerance, 0.2)
    if len(verts) == 0 or len(tris) == 0:
        return trimesh.Trimesh(vertices=[[0, 0, 0]], faces=[[0, 0, 0]], process=False)
    v = [[p.x, p.y, p.z] for p in verts]
    f = [list(t) for t in tris]
    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def export_glb(
    parts: list[tuple[str, Any, Vec3, Vec3, str]],
    path: Path,
) -> None:
    """Assemble a glTF binary.

    ``parts`` is a list of (instance_name, shape, position_mm, rotation_deg, color_hex).
    Each part becomes a named node, scaled 0.001 and rotated Z-up -> Y-up.
    """
    import trimesh

    scene = trimesh.Scene()
    for name, shape, pos, rot, color in parts:
        mesh = _tessellate(shape)
        # CAD mm -> glTF metres, Z-up -> Y-up. Rotation is folded in first so
        # the node transform is a pure translation in glTF space.
        from app.units import rotation_matrix, apply_matrix

        m = rotation_matrix((rot.x, rot.y, rot.z))
        bounds = mesh.bounds
        center = (bounds[0] + bounds[1]) / 2.0
        rotated = [
            apply_matrix(
                m,
                UVec3(
                    float(v[0] - center[0]),
                    float(v[1] - center[1]),
                    float(v[2] - center[2]),
                ),
            )
            for v in mesh.vertices
        ]
        min_x = min(v.x for v in rotated)
        min_y = min(v.y for v in rotated)
        min_z = min(v.z for v in rotated)
        verts = [UVec3(v.x - min_x, v.y - min_y, v.z - min_z) for v in rotated]
        mesh = trimesh.Trimesh(
            vertices=[[v.x, v.y, v.z] for v in verts],
            faces=mesh.faces,
            process=False,
        )
        rgb = hex_to_rgba(color)
        visual = trimesh.visual.ColorVisuals(
            mesh=mesh,
            face_colors=[rgb] * len(mesh.faces),
        )
        mesh.visual = visual
        # Keep CADForge's authored Z-up orientation in the GLB. The web viewer
        # applies the single Z-up -> Y-up conversion at render time.
        scene.add_geometry(
            mesh,
            geom_name=name,
            node_name=name,
            transform=trimesh.transformations.translation_matrix(
                [pos.x, pos.y, pos.z]
            ),
        )

    # CAD mm -> GLB metres. Do not rotate the exported frame here: the client
    # owns the single Z-up -> Y-up conversion.
    scene.apply_transform(trimesh.transformations.scale_matrix(GLTF_SCALE))
    scene.export(path, file_type="glb")


def export_fcstd(shape: Any, path: Path) -> bool:
    """Best-effort FCStd via ``freecadcmd``. Returns False when unavailable."""
    if not freecad_available():
        return False
    with tempfile.TemporaryDirectory(prefix="cadforge-fcstd-") as tmp:
        step_file = Path(tmp) / "part.step"
        try:
            export_step(shape, step_file)
        except Exception:  # noqa: BLE001
            log.exception("could not write intermediate STEP for FCStd")
            return False
        script = Path(tmp) / "to_fcstd.py"
        script.write_text(
            "\n".join(
                [
                    "import FreeCAD as App",
                    "import Part",
                    f"doc = App.newDocument('cadforge')",
                    f"shp = Part.Shape(); shp.read({str(step_file)!r})",
                    "obj = doc.addObject('Part::Feature', 'Model')",
                    "obj.Shape = shp",
                    "doc.recompute()",
                    f"doc.saveAs({str(path)!r})",
                ]
            ),
            encoding="utf-8",
        )
        try:
            proc = subprocess.run(
                [FREECAD_CMD, str(script)],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (subprocess.TimeoutExpired, OSError):
            log.warning("freecadcmd failed or timed out; skipping FCStd")
            return False
        if proc.returncode != 0 or not path.exists():
            log.warning("freecadcmd exited %s: %s", proc.returncode, proc.stderr[-500:])
            return False
    return True


def assembly_bbox(items: list[ExportItem]) -> Bbox:
    """Axis-aligned world bbox of the assembly, in mm."""
    minx = miny = minz = float("inf")
    maxx = maxy = maxz = float("-inf")
    for item in items:
        size = UVec3(item.spec.bbox_mm.x, item.spec.bbox_mm.y, item.spec.bbox_mm.z)
        ext = rotated_extent(size, (item.rotation_deg.x, item.rotation_deg.y, item.rotation_deg.z))
        # Our parts are modelled with their origin at the lower-left corner of
        # the base, so the world offset directly indexes the box corners.
        minx = min(minx, item.position_mm.x)
        miny = min(miny, item.position_mm.y)
        minz = min(minz, item.position_mm.z)
        maxx = max(maxx, item.position_mm.x + ext.x)
        maxy = max(maxy, item.position_mm.y + ext.y)
        maxz = max(maxz, item.position_mm.z + ext.z)
    if minx == float("inf"):
        return Bbox(x=1.0, y=1.0, z=1.0)
    return Bbox(
        x=max(maxx - minx, 1e-6),
        y=max(maxy - miny, 1e-6),
        z=max(maxz - minz, 1e-6),
    )


def item_color(spec: PartSpec) -> str:
    return default_color(spec)


def build_item_shape(item: ExportItem, workdir: Path) -> Any:
    """Rebuild one part at a lower-left-bottom origin, or import its STEP."""
    import cadquery as cq

    if item.code:
        shape = _build_shape(item.code, workdir)
    elif item.step_path:
        imported = cq.importers.importStep(str(item.step_path))
        shape = imported
    else:
        raise ValueError(
            f"item {item.instance_name} has neither code nor step_path; cannot rebuild geometry"
        )
    return _normalize_part_origin(shape)


def export_assembly(
    items: list[ExportItem],
    out_dir: Path,
    with_fcstd: bool | None = None,
) -> dict[str, Any]:
    """Build and export the whole assembly. Returns artifact paths + bbox.

    ``out_dir`` must already exist. Every artifact path returned is absolute.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    skipped: list[str] = []
    per_part: list[dict[str, Any]] = []
    shapes: list[tuple[Any, Vec3, Vec3]] = []
    glb_parts: list[tuple[str, Any, Vec3, Vec3, str]] = []

    for item in items:
        shape = _as_shape(build_item_shape(item, out_dir))
        shapes.append((shape, item.position_mm, item.rotation_deg))
        glb_parts.append(
            (item.instance_name, shape, item.position_mm, item.rotation_deg, item_color(item.spec))
        )

    compound = to_compound(shapes)

    step_path = out_dir / "assembly.step"
    export_step(compound, step_path)

    stl_path = out_dir / "assembly.stl"
    try:
        export_stl(compound, stl_path)
    except Exception:  # noqa: BLE001
        log.exception("STL export failed")
        stl_path = None  # type: ignore[assignment]
        skipped.append("stl")

    glb_path = out_dir / "assembly.glb"
    try:
        export_glb(glb_parts, glb_path)
    except Exception as exc:  # noqa: BLE001
        log.exception("GLB export failed")
        glb_path = None  # type: ignore[assignment]
        skipped.append(f"glb ({type(exc).__name__}: {exc})")

    # Per-part artifacts so the UI can isolate a single component.
    parts_dir = out_dir / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    for item, (shape, pos, rot) in zip(items, shapes):
        safe = re_sub(item.instance_name)
        p_step = parts_dir / f"{safe}.step"
        entry: dict[str, Any] = {"instance_name": item.instance_name}
        try:
            export_step(shape, p_step)
            entry["step_path"] = str(p_step)
        except Exception:  # noqa: BLE001
            entry["step_path"] = None
        p_glb = parts_dir / f"{safe}.glb"
        try:
            export_glb(
                [(item.instance_name, shape, UVec3(0, 0, 0), UVec3(0, 0, 0), item_color(item.spec))],
                p_glb,
            )
            entry["glb_path"] = str(p_glb)
        except Exception:  # noqa: BLE001
            entry["glb_path"] = None
        per_part.append(entry)

    fcstd_path: Path | None = None
    want_fcstd = freecad_available() if with_fcstd is None else with_fcstd
    if want_fcstd:
        candidate = out_dir / "assembly.FCStd"
        if export_fcstd(compound, candidate):
            fcstd_path = candidate
        else:
            skipped.append("fcstd")

    return {
        "step_path": str(step_path),
        "stl_path": str(stl_path) if stl_path else None,
        "glb_path": str(glb_path) if glb_path else None,
        "fcstd_path": str(fcstd_path) if fcstd_path else None,
        "per_part": per_part,
        "assembly_bbox_mm": assembly_bbox(items).model_dump(),
        "skipped": skipped,
    }
