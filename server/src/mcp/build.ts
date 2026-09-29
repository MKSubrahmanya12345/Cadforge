/**
 * Build geometry from parts an agent has already specified.
 *
 * This is the LLM-free core of CADForge. The caller states real millimetre
 * dimensions; we validate them, build real solids at exactly that scale through
 * the CadQuery worker, measure what came back, and export. There is no planning
 * and no research here, because the calling model already did both.
 *
 * Every step is deterministic and every number is traceable to the input, so a
 * dimension the caller got wrong produces a model that is wrong in a way they can
 * see and fix — rather than a plausible-looking one nobody can audit.
 */
import {
  AssemblyItemSchema,
  PartSpecSchema,
  assertValidSpec,
  rotatedExtent,
  validateSpecGeometry,
  type AssemblyItem,
  type PartSpec,
} from '@cadforge/shared';
import { z } from 'zod';
import { deterministicCodeFor } from '../pipeline/generate.js';
import { resolveAssembly } from '../pipeline/stages.js';
import { createProject, updateProject } from '../models/project.js';
import { workerExport } from '../worker.js';

const PartInputSchema = PartSpecSchema.partial({
  aliases: true,
  sources: true,
  confidence: true,
  verified: true,
  origin: true,
  notes: true,
  material: true,
  pitch_mm: true,
}).extend({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  bbox_mm: z.object({
    x: z.number().positive(),
    y: z.number().positive(),
    z: z.number().positive(),
  }),
  features: z.unknown().optional(),
  anchors: z.unknown().optional(),
  aliases: z.array(z.string()).optional(),
});

const PlacementInputSchema = z.object({
  partId: z.string().min(1).max(200),
  anchorRef: z
    .object({
      targetInstance: z.string().min(1).max(200),
      anchorName: z.string().min(1).max(80),
    })
    .optional(),
  offset_mm: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
  rotation_deg: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
});

export interface BuildResult {
  error: string | null;
  errorKind?: 'validation' | 'not_found' | 'upstream' | 'refused';
  name: string;
  parts: Array<{ partId: string; bbox: { x: number; y: number; z: number } }>;
  bbox: { x: number; y: number; z: number };
  checks: Array<{ ok: boolean; detail: string }>;
  urls: Record<string, string | null>;
  notes: string[];
  structured: Record<string, unknown>;
}

export async function buildFromSpec(input: {
  name?: string;
  parts: unknown[];
  placements?: unknown[];
}): Promise<BuildResult> {
  const notes: string[] = [];

  // ---- 1. Parse and validate every part ---------------------------------
  const specs: PartSpec[] = [];
  for (const [i, raw] of input.parts.entries()) {
    const parsed = PartInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        error:
          `parts[${i}]: ${issue?.path.join('.') ?? 'part'} — ${issue?.message ?? 'invalid part'}. ` +
          'Every part needs id, name, and a positive bbox_mm in millimetres.',
        errorKind: 'validation',
        name: '',
        parts: [],
        bbox: { x: 0, y: 0, z: 0 },
        checks: [],
        urls: {},
        notes,
        structured: {},
      };
    }
    const data = parsed.data;
    // An agent-stated part is the source of truth for itself; confidence is
    // not something we can infer, and marking it verified would be a lie.
    const candidate = {
      ...data,
      aliases: data.aliases ?? [],
      features: (data.features ?? []) as PartSpec['features'],
      anchors: (data.anchors ?? []) as PartSpec['anchors'],
      sources: data.sources ?? [],
      confidence: data.confidence ?? 1,
      verified: data.verified ?? false,
      origin: 'human' as const,
    };
    try {
      specs.push(assertValidSpec(PartSpecSchema.parse(candidate)));
    } catch (err) {
      return {
        error: `parts[${i}] (${data.id}): ${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'validation',
        name: '',
        parts: [],
        bbox: { x: 0, y: 0, z: 0 },
        checks: [],
        urls: {},
        notes,
        structured: {},
      };
    }
  }

  // Deduplicate ids, which would otherwise silently overwrite each other.
  const seenIds = new Set<string>();
  for (const spec of specs) {
    if (seenIds.has(spec.id)) {
      return {
        error: `Two parts share the id "${spec.id}". Ids must be unique; they are how placements refer to parts.`,
        errorKind: 'validation',
        name: '',
        parts: [],
        bbox: { x: 0, y: 0, z: 0 },
        checks: [],
        urls: {},
        notes,
        structured: {},
      };
    }
    seenIds.add(spec.id);
  }

  for (const spec of specs) {
    const geometryIssues = validateSpecGeometry(spec).filter(
      (i) => i.severity === 'error',
    );
    if (geometryIssues.length > 0) {
      return {
        error: `Part "${spec.id}" is not buildable: ${geometryIssues
          .map((i) => `${i.path}: ${i.message}`)
          .join('; ')}`,
        errorKind: 'validation',
        name: '',
        parts: [],
        bbox: { x: 0, y: 0, z: 0 },
        checks: [],
        urls: {},
        notes,
        structured: {},
      };
    }
  }

  const specsById = new Map(specs.map((s) => [s.id, s]));

  // ---- 2. Turn parts into placeable instances ----------------------------
  // The base is the largest part, which for any real assembly is the board.
  const ordered = [...specs].sort((a, b) => volume(b) - volume(a));
  const base = ordered[0];
  if (!base) {
    return {
      error: 'No parts were given.',
      errorKind: 'validation',
      name: '',
      parts: [],
      bbox: { x: 0, y: 0, z: 0 },
      checks: [],
      urls: {},
      notes,
      structured: {},
    };
  }

  // Preserve the caller's order for instances, so index i maps to parts[i].
  const instances: Array<{ spec: PartSpec; instanceName: string }> = specs.map((spec) => ({
    spec,
    instanceName: `${sanitizeId(spec.id)}_1`,
  }));
  const byInstance = new Map(instances.map((i) => [i.instanceName, i]));
  const baseInstanceName = `${sanitizeId(base.id)}_1`;

  // ---- 3. Resolve placements ---------------------------------------------
  const rawPlacements = input.placements ?? [];
  const assembly: AssemblyItem[] = [];
  const placementErrors: string[] = [];

  for (const raw of rawPlacements) {
    const parsed = PlacementInputSchema.safeParse(raw);
    if (!parsed.success) {
      placementErrors.push(
        `placements[]: ${parsed.error.issues[0]?.message ?? 'invalid placement'}`,
      );
      continue;
    }
    const data = parsed.data;
    const target = instances.find((i) => i.spec.id === data.partId);
    if (!target) {
      placementErrors.push(
        `placements[]: no part with id "${data.partId}". Known ids: ${specs.map((s) => s.id).join(', ')}`,
      );
      continue;
    }
    if (assembly.some((a) => a.instanceName === target.instanceName)) {
      placementErrors.push(
        `placements[]: part "${data.partId}" is placed more than once. Give it one placement.`,
      );
      continue;
    }

    // An anchorRef must name a real anchor on the real target. This is the check
    // that stops a model being assembled against a point nobody defined.
    if (data.anchorRef) {
      const targetInstance = byInstance.get(data.anchorRef.targetInstance);
      if (!targetInstance) {
        placementErrors.push(
          `placements[]: targetInstance "${data.anchorRef.targetInstance}" does not exist. ` +
            `Known instances: ${instances.map((i) => i.instanceName).join(', ')}`,
        );
        continue;
      }
      if (targetInstance.instanceName === target.instanceName) {
        placementErrors.push(
          `placements[]: "${target.instanceName}" cannot anchor to itself.`,
        );
        continue;
      }
      const anchorExists = targetInstance.spec.anchors.some(
        (a) => a.name === data.anchorRef!.anchorName,
      );
      if (!anchorExists) {
        placementErrors.push(
          `placements[]: part "${targetInstance.spec.id}" has no anchor named ` +
            `"${data.anchorRef.anchorName}". Available: ${
              targetInstance.spec.anchors.map((a) => a.name).join(', ') || '(none — this part defines no anchors)'
            }`,
        );
        continue;
      }
    }

    assembly.push(
      AssemblyItemSchema.parse({
        partId: target.spec.id,
        instanceName: target.instanceName,
        placement: {
          ...(data.anchorRef ? { anchorRef: data.anchorRef } : {}),
          offset_mm: data.offset_mm ?? { x: 0, y: 0, z: 0 },
          rotation_deg: data.rotation_deg ?? { x: 0, y: 0, z: 0 },
        },
      }),
    );
  }

  // The base always exists at the origin; anything the caller did not place is
  // left out rather than silently stacked at (0,0,0) on top of it.
  if (!assembly.some((a) => a.instanceName === baseInstanceName)) {
    assembly.unshift(
      AssemblyItemSchema.parse({
        partId: base.id,
        instanceName: baseInstanceName,
        placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
      }),
    );
  }
  if (assembly.length === 0) {
    return {
      error: 'Nothing was placed, because every placement was rejected.',
      errorKind: 'validation',
      name: '',
      parts: [],
      bbox: { x: 0, y: 0, z: 0 },
      checks: [],
      urls: {},
      notes,
      structured: {},
    };
  }
  for (const err of placementErrors) {
    notes.push(`rejected ${err}`);
  }

  // ---- 4. Resolve anchors to world coordinates ---------------------------
  const placements = resolveAssembly(assembly, specsById);
  for (const item of assembly) {
    if (placements.has(item.instanceName)) continue;
    notes.push(
      `${item.instanceName} could not be resolved to a world position and was placed at the origin.`,
    );
    placements.set(item.instanceName, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  }

  // ---- 5. Build through the worker --------------------------------------
  const modelName = input.name?.trim() || `cadforge-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
  // Use the same persistent project collection as the web app. This makes
  // agent-built models discoverable in the frontend and survives API restarts.
  const project = await createProject(modelName);
  const projectId = String(project._id);
  const resolvedAssembly = assembly.map((a) => ({
    ...a,
    resolvedPosition_mm: placements.get(a.instanceName)?.position ?? { x: 0, y: 0, z: 0 },
  }));
  const now = new Date().toISOString();
  await updateProject(projectId, {
    status: 'exporting',
    progress: 84,
    assembly: resolvedAssembly,
    plan: {
      parts: specs.map((spec) => ({ name: spec.name, quantity: 1, role: spec.id === base.id ? 'base board' : 'component' })),
      relations: [],
    },
    logs: [{ ts: now, stage: 'build', level: 'info', message: `Building ${modelName} from ${specs.length} specified parts` }],
  });

  let exportResponse;
  try {
    exportResponse = await workerExport(
      projectId,
      assembly.map((item) => {
        const spec = specsById.get(item.partId)!;
        const placement = placements.get(item.instanceName)!;
        return {
          instanceName: item.instanceName,
          spec,
          position: placement.position,
          rotation: placement.rotation,
          // The deterministic builder. There is no codegen step here: the point
          // of an agent-driven build is that the geometry is derived from the
          // stated numbers and nothing else.
          code: deterministicCodeFor(spec),
        };
      }),
    );
  } catch (err) {
    await updateProject(projectId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    return {
      error:
        `The CadQuery worker could not be reached: ${err instanceof Error ? err.message : String(err)}. ` +
        'Geometry cannot be built without it.',
      errorKind: 'upstream',
      name: modelName,
      parts: [],
      bbox: { x: 0, y: 0, z: 0 },
      checks: [],
      urls: {},
      notes,
      structured: { projectId },
    };
  }

  if (!exportResponse.ok) {
    await updateProject(projectId, { status: 'failed', error: exportResponse.error ?? 'unknown worker error' });
    return {
      error: `The worker failed to export: ${exportResponse.error ?? 'unknown error'}`,
      errorKind: 'upstream',
      name: modelName,
      parts: [],
      bbox: { x: 0, y: 0, z: 0 },
      checks: [],
      urls: {},
      notes,
      structured: { projectId },
    };
  }
  if (!exportResponse.step_path) {
    await updateProject(projectId, { status: 'failed', error: 'No STEP file was produced' });
    return {
      error:
        'No STEP file was produced. STEP is the source of truth for a CADForge model, so there is nothing to hand back.',
      errorKind: 'upstream',
      name: modelName,
      parts: [],
      bbox: { x: 0, y: 0, z: 0 },
      checks: [],
      urls: {},
      notes,
      structured: { projectId },
    };
  }

  // ---- 6. Verify: measure the result against what was asked for ---------
  const finalBbox = exportResponse.assembly_bbox_mm ?? { x: 0, y: 0, z: 0 };
  const checks: Array<{ ok: boolean; detail: string }> = [];

  for (const item of assembly) {
    const spec = specsById.get(item.partId)!;
    const placement = placements.get(item.instanceName)!;
    const extent = rotatedExtent(
      { x: spec.bbox_mm.x, y: spec.bbox_mm.y, z: spec.bbox_mm.z },
      placement.rotation,
    );
    const fits =
      extent.x <= finalBbox.x * 1.5 + 0.5 &&
      extent.y <= finalBbox.y * 1.5 + 0.5 &&
      extent.z <= finalBbox.z * 1.5 + 0.5;
    checks.push({
      ok: fits,
      detail:
        `${spec.name} (${spec.bbox_mm.x} x ${spec.bbox_mm.y} x ${spec.bbox_mm.z} mm) ` +
        `fits the ${finalBbox.x.toFixed(2)} x ${finalBbox.y.toFixed(2)} x ${finalBbox.z.toFixed(2)} mm assembly`,
    });
  }

  // A 1000x error is the failure this whole project exists to prevent, so it
  // gets an explicit check rather than a log line.
  const scalePlausible =
    finalBbox.x > 0 &&
    finalBbox.y > 0 &&
    finalBbox.z > 0 &&
    finalBbox.x < 10_000 &&
    finalBbox.y < 10_000 &&
    finalBbox.z < 10_000;
  checks.push({
    ok: scalePlausible,
    detail: scalePlausible
      ? `assembly measures ${finalBbox.x.toFixed(2)} x ${finalBbox.y.toFixed(2)} x ${finalBbox.z.toFixed(2)} mm, which is a physical size`
      : `assembly measures ${finalBbox.x.toFixed(2)} x ${finalBbox.y.toFixed(2)} x ${finalBbox.z.toFixed(2)} mm — that is not a physical size, so at least one bbox_mm is wrong by orders of magnitude`,
  });

  const urls: Record<string, string | null> = {};
  for (const [format, absolute] of Object.entries({
    step: exportResponse.step_path,
    glb: exportResponse.glb_path,
    stl: exportResponse.stl_path,
  })) {
    urls[format] = absolute ? artifactUrl(projectId, format) : null;
  }
  for (const skip of exportResponse.skipped) {
    notes.push(`${skip} export was skipped`);
  }

  // The worker returns its own absolute filesystem paths. The API may run in a
  // different container, so persist the shared /files route path, not that
  // worker-local path. The export endpoint writes these fixed filenames under
  // the project id directory.
  const relativePath = (absolute: string | null, filename: string): string | null =>
    absolute ? `${projectId}/${filename}` : null;
  await updateProject(projectId, {
    status: 'complete',
    progress: 100,
    error: null,
    artifacts: {
      step: relativePath(exportResponse.step_path, 'assembly.step'),
      glb: relativePath(exportResponse.glb_path, 'assembly.glb'),
      stl: relativePath(exportResponse.stl_path, 'assembly.stl'),
      fcstd: relativePath(exportResponse.fcstd_path, 'assembly.FCStd'),
    },
    scaleChecks: [],
    logs: [
      { ts: now, stage: 'build', level: 'info', message: `Built ${modelName} from ${specs.length} specified parts` },
      { ts: new Date().toISOString(), stage: 'export', level: 'success', message: `STEP, GLB, and STL artifacts exported` },
    ],
  });

  const structured: Record<string, unknown> = {
    projectId,
    name: modelName,
    parts: specs.map((s) => ({
      id: s.id,
      name: s.name,
      bbox_mm: s.bbox_mm,
      features: s.features.length,
      anchors: s.anchors.map((a) => a.name),
    })),
    assembly: assembly.map((a) => ({
      instanceName: a.instanceName,
      partId: a.partId,
      position_mm: placements.get(a.instanceName)?.position ?? { x: 0, y: 0, z: 0 },
      anchoredAt: a.placement.anchorRef ?? null,
    })),
    assembly_bbox_mm: finalBbox,
    checks,
    downloads: urls,
  };

  return {
    error: null,
    name: modelName,
    parts: specs.map((s) => ({ partId: s.id, bbox: s.bbox_mm })),
    bbox: finalBbox,
    checks,
    urls,
    notes,
    structured,
  };
}

function artifactUrl(projectId: string, format: string): string {
  const extension = format === 'step' ? '.step' : format === 'glb' ? '.glb' : '.stl';
  return `/files/${projectId}/assembly${extension}`;
}

function volume(spec: PartSpec): number {
  return spec.bbox_mm.x * spec.bbox_mm.y * spec.bbox_mm.z;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80);
}
