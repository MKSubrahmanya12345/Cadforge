import { CodegenResponseSchema, assertValidSpec, type PartSpec } from '@cadforge/shared';
import { env } from '../env.js';
import { CODEGEN_SYSTEM, codegenUserPrompt } from '../prompts/codegen.js';
import { workerFallback, workerGenerate, WorkerError } from '../worker.js';
import type { GeneratedPart, PipelineContext } from './types.js';

/**
 * GENERATE + VALIDATE for one instance.
 *
 * Loop: LLM writes code -> worker builds, measures, and validates -> if the
 * worker reports a mismatch we feed the structured diff back to the LLM and
 * retry (up to VALIDATE_MAX_RETRIES). If it still fails, fall back to the
 * deterministic primitive builder so a correctly-scaled model ALWAYS exists.
 */
export async function generatePart(
  ctx: PipelineContext,
  instanceName: string,
  spec: PartSpec,
): Promise<GeneratedPart> {
  const validated = assertValidSpec(spec);

  // Verified seed parts are canonical library geometry, not LLM design prompts.
  // Build them deterministically first so known hardware cannot regress into a
  // generic block merely because codegen produced a plausible-looking answer.
  if (validated.verified && validated.origin === 'seed') {
    ctx.log('info', instanceName + ': using canonical verified geometry');
    const canonical = await workerFallback(instanceName, validated);
    if (canonical.ok && canonical.valid) {
      ctx.log('success', instanceName + ': canonical geometry validated');
      return {
        instanceName,
        partId: validated.id,
        spec: validated,
        code: deterministicCodeFor(validated),
        usedFallback: false,
        attempts: 1,
        diff: [],
      };
    }
    ctx.log('warn', instanceName + ': canonical geometry failed validation; entering LLM repair path');
  }

  let correctionNotes = '';
  const allDiffs: string[] = [];
  const maxAttempts = env.VALIDATE_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    ctx.progress(
      Math.round(((attempt - 1) / maxAttempts) * 100),
      'generate',
    );
    ctx.log('info', `generating ${instanceName} (attempt ${attempt}/${maxAttempts})`);

    let code: string;
    try {
      const response = await ctx.llm.json(
        {
          system: CODEGEN_SYSTEM,
          messages: [
            { role: 'user', content: codegenUserPrompt(validated, correctionNotes) },
          ],
          maxTokens: 6000,
        },
        (raw) => CodegenResponseSchema.parse(raw),
        env.LLM_MAX_RETRIES,
      );
      code = response.code;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log('error', `codegen failed for ${instanceName}: ${message}`);
      allDiffs.push(`codegen failed: ${message}`);
      break;
    }

    let result;
    try {
      result = await workerGenerate(instanceName, validated, code);
    } catch (err) {
      if (err instanceof WorkerError) {
        ctx.log('error', `worker error for ${instanceName}: ${err.message}`);
        allDiffs.push(`worker error: ${err.message}`);
        // A worker error is not a code-quality problem; stop retrying.
        break;
      }
      throw err;
    }

    if (result.ok && result.valid) {
      ctx.log('success', `${instanceName} validated on attempt ${attempt}`);
      if (result.bbox) {
        ctx.log(
          'info',
          `  bbox ${result.bbox.actual.x}×${result.bbox.actual.y}×${result.bbox.actual.z} mm ` +
            `vs spec ${result.bbox.expected.x}×${result.bbox.expected.y}×${result.bbox.expected.z} mm`,
        );
      }
      const matched = result.features.filter((f) => f.matched).length;
      ctx.log('info', `  ${matched}/${result.features.length} spec features present`);
      return { instanceName, partId: validated.id, spec: validated, code, usedFallback: false, attempts: attempt, diff: allDiffs };
    }

    const diffText = result.error ?? 'unknown validation failure';
    allDiffs.push(diffText);
    for (const line of diffText.split('; ')) {
      ctx.log('warn', `  ${instanceName}: ${line}`);
    }
    correctionNotes = correctionNotes
      ? `${correctionNotes}\n${diffText}`
      : `The validator measured the previous attempt and found these problems:\n${diffText}\n\nFix exactly these. Do not change the spec.`;
  }

  // ---- deterministic fallback ----
  ctx.log('warn', `${instanceName}: falling back to the deterministic builder (fallback: true)`);
  let fallbackResult;
  try {
    fallbackResult = await workerFallback(instanceName, validated);
  } catch (err) {
    throw new Error(
      `${instanceName}: LLM generation failed AND the deterministic fallback failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  if (!fallbackResult.ok || !fallbackResult.valid) {
    throw new Error(
      `${instanceName}: deterministic fallback could not produce a spec-conformant model (${
        fallbackResult.error ?? 'unknown error'
      })`,
    );
  }

  const code = deterministicCodeFor(validated);
  ctx.log('success', `${instanceName} built from the deterministic fallback and validated`);
  return {
    instanceName,
    partId: validated.id,
    spec: validated,
    code,
    usedFallback: true,
    attempts: maxAttempts,
    diff: allDiffs,
  };
}

/**
 * The deterministic primitive builder as CadQuery source.
 *
 * Kept in sync with cad-worker/app/builder.py:fallback_code. The worker runs
 * the authoritative version during fallback; this copy is what the server sends
 * to the export stage so the exported compound is built from the same
 * parameterisation.
 */
export function deterministicCodeFor(spec: PartSpec): string {
  const { x: sx, y: sy, z: sz } = spec.bbox_mm;
  const lines: string[] = [
    '"""Deterministic CADForge geometry generated from a validated PartSpec."""',
    'import cadquery as cq',
    '',
    '# --- named parameters (mm) ---------------------------------------------',
    `LENGTH_MM = ${sx}`,
    `WIDTH_MM = ${sy}`,
    `HEIGHT_MM = ${sz}`,
    `BASE_THICKNESS_MM = ${spec.base_thickness_mm ?? sz}`,
  ];
  if (spec.profile_mm) {
    const profile = spec.profile_mm.map((pt) => [pt.x - sx / 2, pt.y - sy / 2]);
    lines.push(`PROFILE_POINTS = ${JSON.stringify(profile)}`);
  }
  const constOf = (name: string): string => {
    const c = name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    return c.length > 0 ? c : 'FEATURE';
  };

  for (const f of spec.features) {
    const c = constOf(f.name);
    for (const [k, v] of Object.entries(f.dims_mm)) {
      lines.push(`${c}_${k.toUpperCase()}_MM = ${v}`);
    }
    if (f.type === 'hole' || f.type === 'cylinder' || f.type === 'pin' || f.type === 'box' || f.type === 'rounded_box' || f.type === 'cutout') {
      lines.push(`${c}_X_MM = ${f.position_mm.x}`);
      lines.push(`${c}_Y_MM = ${f.position_mm.y}`);
      lines.push(`${c}_POS_Z_MM = ${f.position_mm.z}`);
    }
  }

  lines.push('', '', 'def build() -> cq.Workplane:');
  if (spec.profile_mm) {
    lines.push('    solid = cq.Workplane("XY").polyline(PROFILE_POINTS).close().extrude(BASE_THICKNESS_MM)');
  } else {
    lines.push('    solid = cq.Workplane("XY").box(');
    lines.push('        LENGTH_MM, WIDTH_MM, BASE_THICKNESS_MM, centered=(True, True, False)');
    lines.push('    )');
  }

  for (const f of spec.features) {
    const c = constOf(f.name);
    if (f.type === 'hole') {
      const d = f.dims_mm['diameter'];
      if (d === undefined || d <= 0) continue;
      const depth = f.dims_mm['depth'] ?? sz;
      lines.push('    solid = solid.cut(');
      lines.push(`        cq.Workplane("XY").circle(${c}_DIAMETER_MM / 2.0)`);
      lines.push(`        .extrude(${depth} + 0.2)`);
      lines.push(
        `        .translate((${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, -0.1))`,
      );
      lines.push('    )');
    } else if (f.type === 'cylinder') {
      const d = f.dims_mm['diameter'];
      const h = f.dims_mm['height'];
      if (!d || !h || d <= 0 || h <= 0) continue;
      const axis = f.axis ?? 'z';
      const operation = f.operation ?? 'add';
      lines.push(`    ${c}_AXIS = ${JSON.stringify(axis)}`);
      lines.push(`    ${c}_OPERATION = ${JSON.stringify(operation)}`);
      lines.push(`    cyl = cq.Workplane("XY", origin=(${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, ${c}_POS_Z_MM)).circle(${c}_DIAMETER_MM / 2.0).extrude(${c}_HEIGHT_MM)`);
      lines.push(`    if ${c}_AXIS == "x": cyl = cyl.rotate((0, 0, 0), (0, 1, 0), 90)`);
      lines.push(`    elif ${c}_AXIS == "y": cyl = cyl.rotate((0, 0, 0), (1, 0, 0), -90)`);
      lines.push(`    solid = solid.cut(cyl) if ${c}_OPERATION == "cut" else solid.union(cyl)`);
    } else if (f.type === 'pin') {
      const d = f.dims_mm['diameter'];
      const l = f.dims_mm['length'];
      const count = Number(f.dims_mm['count'] ?? 1);
      const pitch = Number(f.dims_mm['pitch'] ?? 0);
      if (!d || !l || d <= 0 || l <= 0) continue;
      lines.push(`    ${c}_COUNT = ${Math.max(1, Math.floor(count))}`);
      lines.push(`    ${c}_PITCH_MM = ${pitch}`);
      lines.push(`    for i in range(${c}_COUNT):`);
      lines.push(`        ${c}_OFFSET_X_MM = (i - (${c}_COUNT - 1) / 2.0) * ${c}_PITCH_MM`);
      lines.push('        solid = solid.union(');
      lines.push(
        `            cq.Workplane("XY", origin=(${c}_X_MM - LENGTH_MM / 2.0 + ${c}_OFFSET_X_MM, ${c}_Y_MM - WIDTH_MM / 2.0, ${c}_POS_Z_MM))`,
      );
      lines.push(`            .circle(${c}_DIAMETER_MM / 2.0)`);
      lines.push(`            .extrude(${c}_LENGTH_MM)`);
      lines.push('        )');
    } else if (f.type === 'box' || f.type === 'rounded_box') {
      const bx = f.dims_mm['x'];
      const by = f.dims_mm['y'];
      const bz = f.dims_mm['z'];
      if (!bx || !by || !bz || bx <= 0 || by <= 0 || bz <= 0) continue;
      lines.push(`    ${c}_BOX_X_MM = ${bx}`);
      lines.push(`    ${c}_BOX_Y_MM = ${by}`);
      lines.push(`    ${c}_BOX_Z_MM = ${bz}`);
      if (f.type === 'rounded_box') {
        const radius = Math.min(Number(f.dims_mm['radius'] ?? 0), bx / 2, by / 2, bz / 2);
        lines.push(`    ${c}_RADIUS_MM = ${radius}`);
        lines.push(`    body = cq.Workplane("XY").box(${c}_BOX_X_MM, ${c}_BOX_Y_MM, ${c}_BOX_Z_MM, centered=(True, True, False))`);
        lines.push(`    if ${c}_RADIUS_MM > 0:`);
        lines.push(`        body = body.edges().fillet(${c}_RADIUS_MM)`);
        lines.push(`    solid = solid.union(body.translate((${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, ${c}_POS_Z_MM)))`);
      } else {
        lines.push('    solid = solid.union(');
        lines.push(`        cq.Workplane("XY").box(${c}_BOX_X_MM, ${c}_BOX_Y_MM, ${c}_BOX_Z_MM, centered=(True, True, False))`);
        lines.push(`        .translate((${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, ${c}_POS_Z_MM))`);
        lines.push('    )');
      }
    } else if (f.type === 'cutout') {
      const bx = f.dims_mm['x'];
      const by = f.dims_mm['y'];
      const bz = f.dims_mm['z'];
      if (!bx || !by || !bz || bx <= 0 || by <= 0 || bz <= 0) continue;
      lines.push(`    ${c}_CUT_X_MM = ${bx}`);
      lines.push(`    ${c}_CUT_Y_MM = ${by}`);
      lines.push(`    ${c}_CUT_Z_MM = ${bz}`);
      lines.push('    solid = solid.cut(');
      lines.push(`        cq.Workplane("XY").box(${c}_CUT_X_MM, ${c}_CUT_Y_MM, ${c}_CUT_Z_MM, centered=(True, True, False))`);
      lines.push(`        .translate((${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, ${c}_POS_Z_MM))`);
      lines.push('    )');
    }
  }

  // bbox_mm is the complete physical envelope; do not clip components to it.
  lines.push('    return solid');
  return `${lines.join('\n')}\n`;
}
