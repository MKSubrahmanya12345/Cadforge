"""Pydantic mirrors of the shared Zod schemas used on the worker boundary.

Field names are snake_case on the wire; the shapes are identical to
shared/src/schemas.ts.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

StrictModel = ConfigDict(extra="ignore", populate_by_name=True)


class Vec3(BaseModel):
    model_config = StrictModel
    x: float
    y: float
    z: float

    def tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


class Bbox(BaseModel):
    model_config = StrictModel
    x: float
    y: float
    z: float

    @field_validator("x", "y", "z")
    @classmethod
    def _positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("bbox dimensions must be positive")
        return v

    def size(self) -> "Vec3":
        return Vec3(x=self.x, y=self.y, z=self.z)


class Feature(BaseModel):
    model_config = StrictModel
    type: Literal["hole", "cylinder", "box", "rounded_box", "pin", "pad", "cutout"]
    name: str
    position_mm: Vec3
    dims_mm: dict[str, float] = Field(default_factory=dict)
    note: str | None = None
    axis: Literal['x', 'y', 'z'] | None = None
    operation: Literal['add', 'cut'] | None = None


class ProfilePoint(BaseModel):
    model_config = StrictModel
    x: float
    y: float


class Anchor(BaseModel):
    model_config = StrictModel
    name: str
    position_mm: Vec3
    normal: Vec3 | None = None


class SourceField(BaseModel):
    model_config = StrictModel
    field: str
    value: str
    source_url: str | None = None
    conflict: str | None = None


class Source(BaseModel):
    model_config = StrictModel
    url: str
    title: str
    extracted_fields: list[SourceField] = Field(default_factory=list)


class PartSpec(BaseModel):
    model_config = StrictModel
    id: str
    name: str
    category: str
    aliases: list[str] = Field(default_factory=list)
    bbox_mm: Bbox
    base_thickness_mm: float | None = None
    profile_mm: list[ProfilePoint] | None = None
    features: list[Feature] = Field(default_factory=list)
    anchors: list[Anchor] = Field(default_factory=list)
    pitch_mm: float | None = None
    material: str | None = None
    color_hex: str | None = None
    sources: list[Source] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    verified: bool = False
    origin: str = "research"
    notes: str | None = None


class WorkerPart(BaseModel):
    model_config = StrictModel
    instance_name: str
    part_id: str
    code: str
    spec: PartSpec


class GenerateRequest(BaseModel):
    model_config = StrictModel
    parts: list[WorkerPart] = Field(min_length=1, max_length=48)


class MeasuredFeature(BaseModel):
    model_config = StrictModel
    name: str
    type: str
    position_mm: Vec3
    diameter_mm: float | None = None
    depth_mm: float | None = None
    matched: bool = False
    delta_mm: float | None = None


class BboxComparison(BaseModel):
    model_config = StrictModel
    expected: Bbox
    actual: Bbox
    delta_mm: Vec3
    ok: bool
    failing_axes: list[Literal["x", "y", "z"]] = Field(default_factory=list)


class GenerateResponse(BaseModel):
    model_config = StrictModel
    ok: bool
    instance_name: str
    fallback: bool = False
    valid: bool = False
    attempts: int = 1
    bbox: BboxComparison | None = None
    features: list[MeasuredFeature] = Field(default_factory=list)
    error: str | None = None
    glb_path: str | None = None
    stl_path: str | None = None
    step_path: str | None = None


class ExportItem(BaseModel):
    model_config = StrictModel
    instance_name: str
    part_id: str
    spec: PartSpec
    position_mm: Vec3
    rotation_deg: Vec3
    color_hex: str | None = None
    #: The CadQuery source that produced this part (LLM code or the
    #: deterministic fallback). Optional so an assembly can be rebuilt from
    #: per-part STEP files when the source is not available.
    code: str | None = None
    step_path: str | None = None


class ExportRequest(BaseModel):
    model_config = StrictModel
    project_id: str
    items: list[ExportItem] = Field(min_length=1, max_length=48)


class PerPartArtifact(BaseModel):
    model_config = StrictModel
    instance_name: str
    step_path: str | None = None
    glb_path: str | None = None


class ExportResponse(BaseModel):
    model_config = StrictModel
    ok: bool
    step_path: str | None = None
    glb_path: str | None = None
    stl_path: str | None = None
    fcstd_path: str | None = None
    per_part: list[PerPartArtifact] = Field(default_factory=list)
    assembly_bbox_mm: Bbox | None = None
    skipped: list[str] = Field(default_factory=list)
    error: str | None = None


class HealthResponse(BaseModel):
    model_config = StrictModel
    ok: bool
    cadquery_version: str
    freecad: bool
    version: str


def bbox_error_lines(comparison: BboxComparison) -> list[str]:
    """Human/LLM-readable diff lines for a failed bbox comparison."""
    out: list[str] = []
    for axis in ("x", "y", "z"):
        exp = getattr(comparison.expected, axis)
        act = getattr(comparison.actual, axis)
        delta = getattr(comparison.delta_mm, axis)
        if axis in comparison.failing_axes:
            out.append(
                f"bbox.{axis}: expected {exp:.3f} mm, got {act:.3f} mm "
                f"(delta {delta:+.3f} mm, tolerance ±{max(0.3, abs(exp) * 0.02):.3f} mm)"
            )
    return out


def spec_as_dict(spec: PartSpec) -> dict[str, Any]:
    return spec.model_dump()
