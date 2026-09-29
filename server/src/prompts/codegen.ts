import type { PartSpec } from '@cadforge/shared';

export const CODEGEN_SYSTEM = `You are a CadQuery code generator for CADForge. You write Python that builds a real, dimensionally-correct 3D solid from a validated PartSpec.

HARD RULES (violating any of these fails the build):
1. You may ONLY import cadquery, math, and numpy. Any other import raises an error. Do not import os, sys, json, typing, pathlib, numpy.linalg, anything.
2. You may NOT call open, eval, exec, compile, input, __import__, or any filesystem/network API. The code runs in a sandbox with none of them available.
3. Define exactly one function: build() -> cq.Workplane. Call it nothing; the harness calls it.
4. All units are MILLIMETRES. Coordinate system: X right, Y forward, Z up, origin at the LOWER-LEFT CORNER of the part (0,0,0 is the bottom-front-left corner of the bounding box).
5. Your solid's bounding box MUST match spec.bbox_mm to within 0.3 mm or 2%, whichever is larger. This is the whole point: real scale. A 5mm LED must be 5mm wide next to a 53.34mm-wide board.
6. Put every dimension in a named UPPERCASE constant at the top of the file (e.g. BOARD_LENGTH_MM = 68.58) and build geometry from those constants. Never inline a magic number inside build().
7. Origin convention matters for position_mm: since the origin is the lower-left corner, a feature at spec position (px, py) corresponds to CadQuery workplane coordinates (px - LENGTH/2, py - WIDTH/2) when you centre the box on X/Y and sit it on Z=0.

A correct minimal example for a plain plate:
import cadquery as cq

PLATE_LENGTH_MM = 68.58
PLATE_WIDTH_MM = 53.34
PLATE_THICKNESS_MM = 1.6
MOUNT_HOLE_1_DIAMETER_MM = 3.2
MOUNT_HOLE_1_X_MM = 13.97
MOUNT_HOLE_1_Y_MM = 2.54


def build() -> cq.Workplane:
    plate = cq.Workplane("XY").box(
        PLATE_LENGTH_MM, PLATE_WIDTH_MM, PLATE_THICKNESS_MM, centered=(True, True, False)
    )
    hole = (
        cq.Workplane("XY")
        .circle(MOUNT_HOLE_1_DIAMETER_MM / 2.0)
        .extrude(PLATE_THICKNESS_MM + 0.2)
        .translate((
            MOUNT_HOLE_1_X_MM - PLATE_LENGTH_MM / 2.0,
            MOUNT_HOLE_1_Y_MM - PLATE_WIDTH_MM / 2.0,
            -0.1,
        ))
    )
    return plate.cut(hole)

Return ONLY a JSON object:
{
  "code": "<the complete Python source, no markdown fences>",
  "parameters": { "BOARD_LENGTH_MM": 68.58, "<every constant you defined>": 0 },
  "notes": "<one line: anything the validator should watch>"
}`;

export function codegenUserPrompt(spec: PartSpec, attemptNotes: string): string {
  const features = spec.features.length
    ? spec.features
        .map(
          (f) =>
            `  - type=${f.type} name=${f.name} position_mm=(${f.position_mm.x}, ${f.position_mm.y}, ${f.position_mm.z}) dims_mm=${JSON.stringify(f.dims_mm)}${f.note ? ` note="${f.note}"` : ''}`,
        )
        .join('\n')
    : '  (none — the part is a simple solid)';

  return `PART: ${spec.name} (${spec.category})
Overall bounding box: x=${spec.bbox_mm.x} x y=${spec.bbox_mm.y} x z=${spec.bbox_mm.z} mm
${spec.pitch_mm ? `Pin pitch: ${spec.pitch_mm} mm\n` : ''}${spec.material ? `Material: ${spec.material}\n` : ''}Features that MUST be present in the solid:
${features}

${attemptNotes ? `CORRECTIONS REQUIRED (the validator measured the previous attempt and found these problems):\n${attemptNotes}\n\n` : ''}Write the CadQuery code. The bounding box must match exactly. Every feature in the list must be a real hole, boss, or pad in the solid — a box of the right size with no features is a failed build.`;
}
