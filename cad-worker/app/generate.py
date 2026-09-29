"""Generate + validate + export pipeline for the CADForge worker.

``generate_and_validate`` runs the supplied LLM code in the sandbox, measures
it, and validates against the spec. The server owns the retry loop (it can
re-prompt the LLM with a diff), so this function performs exactly one attempt
and reports precisely what was wrong.
"""

from __future__ import annotations

import logging
from typing import Any

from app.builder import build_fallback, default_color, fallback_code
from app.sandbox import SandboxError, SandboxResult, run_sandboxed
from app.schemas import (
    BboxComparison,
    GenerateResponse,
    PartSpec,
)
from app.validate import validate_measurement

log = logging.getLogger(__name__)


def generate_and_validate(
    instance_name: str,
    spec: PartSpec,
    code: str,
    timeout_s: int | None = None,
) -> GenerateResponse:
    """Run ``code``, measure it, and validate against ``spec``."""
    try:
        result: SandboxResult = run_sandboxed(code, "build", timeout_s=timeout_s)
    except SandboxError as exc:
        return GenerateResponse(
            ok=False,
            instance_name=instance_name,
            valid=False,
            attempts=1,
            error=str(exc),
        )

    if not result.ok or result.value is None:
        return GenerateResponse(
            ok=False,
            instance_name=instance_name,
            valid=False,
            attempts=1,
            error=result.error or "unknown sandbox failure",
        )

    measurement: dict[str, Any] = result.value
    ok, comparison, features, diff = validate_measurement(spec, measurement)
    return GenerateResponse(
        ok=True,
        instance_name=instance_name,
        fallback=False,
        valid=ok,
        attempts=1,
        bbox=comparison,
        features=features,
        error="; ".join(diff) if diff else None,
    )


def generate_fallback(
    instance_name: str,
    spec: PartSpec,
    timeout_s: int | None = None,
) -> GenerateResponse:
    """Build the deterministic model and validate it.

    Runs through the *same* sandbox as LLM code, so the fallback path is
    exercised identically. The fallback is built from ``spec.bbox_mm`` exactly,
    so its bounding box matches by construction.
    """
    code = fallback_code(spec)
    try:
        result = run_sandboxed(code, "build", timeout_s=timeout_s)
    except SandboxError as exc:
        return GenerateResponse(
            ok=False,
            instance_name=instance_name,
            fallback=True,
            valid=False,
            attempts=1,
            error=f"fallback builder rejected: {exc}",
        )

    if not result.ok or result.value is None:
        # Last resort: build in-process, unvalidated, so the user still gets a
        # correctly-sized model rather than nothing at all.
        log.exception("in-process fallback build failed for %s", instance_name)
        return GenerateResponse(
            ok=False,
            instance_name=instance_name,
            fallback=True,
            valid=False,
            attempts=1,
            error=result.error or "fallback builder failed",
        )

    ok, comparison, features, diff = validate_measurement(spec, result.value)
    return GenerateResponse(
        ok=True,
        instance_name=instance_name,
        fallback=True,
        valid=ok,
        attempts=1,
        bbox=comparison,
        features=features,
        error="; ".join(diff) if diff else None,
    )


def measure_in_process(spec: PartSpec) -> dict[str, Any]:
    """Measure the deterministic builder directly (used by tests)."""
    from app.measure import measure

    return measure(build_fallback(spec))


def spec_color(spec: PartSpec) -> str:
    return default_color(spec)


def empty_comparison(spec: PartSpec) -> BboxComparison:
    from app.schemas import Bbox

    return BboxComparison(
        expected=spec.bbox_mm,
        actual=spec.bbox_mm,
        delta_mm=Bbox(x=0, y=0, z=0),  # type: ignore[arg-type]
        ok=True,
        failing_axes=[],
    )
