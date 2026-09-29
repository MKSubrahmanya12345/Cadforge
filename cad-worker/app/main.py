"""CADForge worker HTTP API.

Endpoints
---------
GET  /health                     worker + CadQuery + FreeCAD availability
POST /generate                   run LLM code for each part, measure, validate
POST /validate                   validate already-known measurements
POST /fallback                   build the deterministic model for a part
POST /export                     assemble, export STEP/GLB/STL/(FCStd)
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app import __version__
from app.export import export_assembly, freecad_available
from app.generate import generate_and_validate, generate_fallback
from app.sandbox import SandboxError
from app.schemas import (
    ExportItem,
    ExportRequest,
    ExportResponse,
    GenerateRequest,
    GenerateResponse,
    HealthResponse,
    PartSpec,
    Vec3,
)
from app.validate import validate_measurement

logging.basicConfig(
    level=os.environ.get("CADFORGE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("cadforge.worker")

app = FastAPI(
    title="CADForge cad-worker",
    version=__version__,
    description="Sandboxed CadQuery execution, validation, and export",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

#: Where artifacts are written. The server passes an explicit directory per
#: project; this is the fallback root.
STORAGE_ROOT = Path(os.environ.get("CADFORGE_STORAGE_ROOT", "../storage")).resolve()
FREECAD_REQUIRED = os.environ.get("CADFORGE_FREECAD_REQUIRED", "false").lower() == "true"


class ValidateRequest(BaseModel):
    spec: PartSpec
    measurement: dict[str, Any] = Field(default_factory=dict)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        import cadquery

        cq_version = getattr(cadquery, "__version__", "unknown")
    except Exception:  # noqa: BLE001
        log.exception("cadquery import failed")
        return HealthResponse(
            ok=False, cadquery_version="missing", freecad=freecad_available(), version=__version__
        )
    has_fc = freecad_available()
    ok = has_fc or not FREECAD_REQUIRED
    return HealthResponse(
        ok=ok, cadquery_version=str(cq_version), freecad=has_fc, version=__version__
    )


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    """First LLM attempt for every part in the request.

    Returns one response per part. The server decides whether to retry with a
    diff or fall back; this endpoint never loops.
    """
    if len(req.parts) == 1:
        part = req.parts[0]
        try:
            return generate_and_validate(part.instance_name, part.spec, part.code)
        except SandboxError as exc:
            return GenerateResponse(
                ok=False, instance_name=part.instance_name, valid=False, error=str(exc)
            )

    # Multi-part: run sequentially and aggregate. The server calls this once per
    # part in practice; the batch form exists for the e2e test.
    out = GenerateResponse(
        ok=True, instance_name=f"batch_{int(time.time()*1000)}", valid=True, attempts=1
    )
    failures: list[str] = []
    fallbacks: list[str] = []
    for part in req.parts:
        r = generate_and_validate(part.instance_name, part.spec, part.code)
        if not r.ok:
            failures.append(f"{part.instance_name}: {r.error}")
        if r.fallback:
            fallbacks.append(part.instance_name)
        if not r.valid:
            failures.append(f"{part.instance_name}: {r.error}")
    out.ok = not failures
    out.valid = not failures
    out.error = "; ".join(failures) if failures else None
    del fallbacks
    return out


class FallbackRequest(BaseModel):
    instance_name: str
    spec: PartSpec


@app.post("/fallback/part", response_model=GenerateResponse)
def fallback_part(req: FallbackRequest) -> GenerateResponse:
    """Deterministic builder from the spec. Always attempted last."""
    return generate_fallback(req.instance_name, req.spec)


@app.post("/validate")
def validate(req: ValidateRequest) -> dict[str, Any]:
    ok, comparison, features, diff = validate_measurement(req.spec, req.measurement)
    return {
        "ok": ok,
        "bbox": comparison.model_dump(),
        "features": [f.model_dump() for f in features],
        "diff": diff,
    }


class PartExport(BaseModel):
    instance_name: str
    part_id: str
    spec: PartSpec
    code: str
    out_dir: str | None = None
    with_fcstd: bool | None = None


class ExportBatchRequest(BaseModel):
    parts: list[PartExport] = Field(min_length=1, max_length=48)
    out_dir: str | None = None
    with_fcstd: bool | None = None


def _resolve_out_dir(explicit: str | None, fallback_name: str) -> Path:
    """Resolve an output directory, sanitising the name.

    Paths coming from the server are trusted (it owns the storage root), but a
    traversal attempt must never escape the storage root.
    """
    if explicit:
        candidate = Path(explicit).resolve()
    else:
        candidate = (STORAGE_ROOT / fallback_name).resolve()
    root = STORAGE_ROOT
    if not str(candidate).startswith(str(root)):
        candidate = root / "unsafe-redirected"
        log.warning("out_dir %s escaped the storage root; redirecting", explicit)
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate


def _safe_artifact(relative: str) -> Path:
    """Resolve a caller-supplied artifact path inside the storage root.

    The worker owns its storage, and in a split deployment it is the only host
    that has the files — the API server proxies downloads through here. That
    makes this the single place a path from a request touches the filesystem, so
    it is where traversal has to be stopped.
    """
    root = STORAGE_ROOT.resolve()
    candidate = (root / relative).resolve()
    if not str(candidate).startswith(str(root) + os.sep) and candidate != root:
        raise HTTPException(status_code=400, detail="path escapes the storage root")
    return candidate


@app.get("/files/{artifact_path:path}")
def get_artifact(artifact_path: str) -> Response:
    """Serve a generated artifact.

    The API server proxies its own /files mount here, so this endpoint is what
    makes a split deployment (API on one host, CadQuery worker on another) able
    to download a model at all. Without it the server would look for bytes on a
    disk it does not have.
    """
    target = _safe_artifact(artifact_path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")

    media = {
        ".step": "model/step",
        ".stl": "model/stl",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".fcstd": "application/octet-stream",
    }.get(target.suffix.lower(), "application/octet-stream")

    # Content-Length lets the browser show download progress for large STEP files.
    return FileResponse(
        target,
        media_type=media,
        headers={
            "Content-Disposition": f'inline; filename="{target.name}"',
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "private, max-age=3600",
        },
    )


@app.post("/export", response_model=ExportResponse)
def export(req: ExportRequest) -> ExportResponse:
    out_dir = _resolve_out_dir(None, req.project_id)
    items = [ExportItem(**item.model_dump()) for item in req.items]
    try:
        result = export_assembly(items, out_dir)
    except Exception as exc:  # noqa: BLE001
        log.exception("assembly export failed")
        return ExportResponse(ok=False, error=f"{type(exc).__name__}: {exc}")
    return ExportResponse(ok=True, **result)


@app.post("/export/batch", response_model=ExportResponse)
def export_batch(req: ExportBatchRequest) -> ExportResponse:
    """Per-part export driven by code, assembled into one set of artifacts."""
    out_dir = _resolve_out_dir(req.out_dir, "batch")
    items = [
        ExportItem(
            instance_name=p.instance_name,
            part_id=p.part_id,
            spec=p.spec,
            position_mm=Vec3(x=0, y=0, z=0),
            rotation_deg=Vec3(x=0, y=0, z=0),
            color_hex=p.spec.color_hex,
            code=p.code,
        )
        for p in req.parts
    ]
    try:
        result = export_assembly(items, out_dir, with_fcstd=req.with_fcstd)
    except Exception as exc:  # noqa: BLE001
        log.exception("batch export failed")
        return ExportResponse(ok=False, error=f"{type(exc).__name__}: {exc}")
    return ExportResponse(ok=True, **result)
