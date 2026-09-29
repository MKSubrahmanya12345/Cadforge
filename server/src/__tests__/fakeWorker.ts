/**
 * An in-process stand-in for the Python cad-worker.
 *
 * It speaks the same HTTP contract as cad-worker/app/main.py, but instead of
 * running CadQuery it parses the named parameters out of the generated code and
 * computes the resulting world bounding box itself. That makes it a real
 * geometric check rather than a rubber stamp: if the LLM codegen emitted
 * `LENGTH_MM = 68580` the bbox here would be 1000x too big and the test would
 * fail, exactly as the real validator would.
 *
 * The real CadQuery/STEP path is covered by cad-worker/tests.
 */
import type { PartSpec } from '@cadforge/shared';
import {
  BboxSchema,
  PartSpecSchema,
  Vec3Schema,
  rotatedExtent,
} from '@cadforge/shared';
import { z } from 'zod';

interface Placement {
  instance_name: string;
  part_id: string;
  spec: PartSpec;
  position_mm: { x: number; y: number; z: number };
  rotation_deg: { x: number; y: number; z: number };
  code?: string;
}

const ParamPattern = /^([A-Z][A-Z0-9_]*)\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)$/;

/**
 * Parse `NAME = <number>` constants out of generated CadQuery source.
 *
 * The full name is kept (so `LENGTH_MM` is the key, not `LENGTH`), because the
 * assertions read them back the way the prompt names them.
 */
export function parseParameters(code: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of code.split('\n')) {
    const m = ParamPattern.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) {
      out[m[1]] = Number(m[2]);
    }
  }
  return out;
}

/** Count how many `solid.cut(` hole operations the code performs. */
export function countHoleOps(code: string): number {
  return (code.match(/solid\.cut\(/g) ?? []).length;
}

/**
 * The dimensions the CODE declares, not the ones the spec says.
 *
 * This is the whole point of the fake: it reads the generated constants, so a
 * model that is 1000x wrong produces a 1000x bbox and fails validation exactly
 * as the real CadQuery validator would. Missing constants fall back to the spec
 * value, which is the correct behaviour for code that legitimately omits them.
 */
function codeBbox(code: string, spec: PartSpec): { x: number; y: number; z: number } {
  const params = parseParameters(code);
  return {
    x: params['LENGTH_MM'] ?? spec.bbox_mm.x,
    y: params['WIDTH_MM'] ?? spec.bbox_mm.y,
    z: params['HEIGHT_MM'] ?? spec.bbox_mm.z,
  };
}

function toleranceFor(expected: number): number {
  return Math.max(0.3, Math.abs(expected) * 0.02);
}

function compareBbox(expected: { x: number; y: number; z: number }, actual: { x: number; y: number; z: number }) {
  const failing: Array<'x' | 'y' | 'z'> = [];
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(actual[axis] - expected[axis]) > toleranceFor(expected[axis])) failing.push(axis);
  }
  return {
    expected,
    actual,
    delta_mm: {
      x: actual.x - expected.x,
      y: actual.y - expected.y,
      z: actual.z - expected.z,
    },
    ok: failing.length === 0,
    failing_axes: failing,
  };
}

const GenerateRequestSchema = z.object({
  parts: z.array(
    z.object({
      instance_name: z.string(),
      part_id: z.string(),
      code: z.string(),
      spec: PartSpecSchema,
    }),
  ),
});

const FallbackRequestSchema = z.object({
  instance_name: z.string(),
  spec: PartSpecSchema,
});

/**
 * Mirrors server/src/worker.ts WorkerItemSchema exactly. It is written out here
 * rather than imported so the fake stays an independent check of the contract:
 * if the server's payload and this ever disagree, the e2e test fails.
 */
const ExportRequestSchema = z.object({
  project_id: z.string(),
  items: z.array(
    z.object({
      instance_name: z.string(),
      part_id: z.string(),
      spec: PartSpecSchema,
      position_mm: Vec3Schema,
      rotation_deg: Vec3Schema,
      color_hex: z.string().optional(),
      code: z.string().optional(),
      step_path: z.string().optional(),
    }),
  ),
});

export interface FakeWorkerHandle {
  url: string;
  stop: () => void;
  /** Every /export body received, for assertions. */
  exports: Array<{ project_id: string; items: Placement[] }>;
  /** Every /generate body received. */
  generates: Array<{ instance_name: string; part_id: string; spec: PartSpec }>;
  fallbacks: Array<{ instance_name: string; spec: PartSpec }>;
}

export function startFakeWorker(): FakeWorkerHandle {
  const handle: FakeWorkerHandle = {
    url: '',
    stop: () => undefined,
    exports: [],
    generates: [],
    fallbacks: [],
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url.pathname === '/health') {
        return json({ ok: true, cadquery_version: 'fake', freecad: false, version: 'fake-1.0' });
      }

      if (req.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405);
      }

      const body = (await req.json()) as unknown;

      if (url.pathname === '/generate') {
        const parsed = GenerateRequestSchema.parse(body);
        const part = parsed.parts[0];
        if (!part) return json({ error: 'no parts' }, 400);
        handle.generates.push({
          instance_name: part.instance_name,
          part_id: part.part_id,
          spec: part.spec,
        });
        const expectedHoles = part.spec.features.filter((f) => f.type === 'hole').length;
        const madeHoles = countHoleOps(part.code);
        const actual = codeBbox(part.code, part.spec);
        const bbox = compareBbox(part.spec.bbox_mm, actual);
        const features = part.spec.features.map((f) => ({
          name: f.name,
          type: f.type,
          position_mm: f.position_mm,
          diameter_mm: f.dims_mm['diameter'] ?? null,
          depth_mm: f.dims_mm['depth'] ?? null,
          matched: f.type !== 'hole' || madeHoles >= expectedHoles,
          delta_mm: null,
        }));
        const featuresOk = features.every((f) => f.matched);
        const diffs: string[] = [];
        for (const axis of bbox.failing_axes) {
          diffs.push(
            `bbox.${axis}: expected ${bbox.expected[axis].toFixed(3)} mm, got ${bbox.actual[
              axis
            ].toFixed(3)} mm`,
          );
        }
        if (!featuresOk) {
          diffs.push(`expected ${expectedHoles} hole operations, code contains ${madeHoles}`);
        }
        return json({
          ok: true,
          instance_name: part.instance_name,
          fallback: false,
          valid: bbox.ok && featuresOk,
          attempts: 1,
          bbox,
          features,
          error: diffs.length ? diffs.join('; ') : null,
          glb_path: null,
          stl_path: null,
          step_path: null,
        });
      }

      if (url.pathname === '/fallback/part') {
        const parsed = FallbackRequestSchema.parse(body);
        handle.fallbacks.push({ instance_name: parsed.instance_name, spec: parsed.spec });
        return json({
          ok: true,
          instance_name: parsed.instance_name,
          fallback: true,
          valid: true,
          attempts: 1,
          bbox: compareBbox(parsed.spec.bbox_mm, parsed.spec.bbox_mm),
          features: parsed.spec.features.map((f) => ({
            name: f.name,
            type: f.type,
            position_mm: f.position_mm,
            diameter_mm: f.dims_mm['diameter'] ?? null,
            depth_mm: f.dims_mm['depth'] ?? null,
            matched: true,
            delta_mm: null,
          })),
          error: null,
        });
      }

      if (url.pathname === '/export') {
        const parsed = ExportRequestSchema.parse(body);
        const items = parsed.items as unknown as Placement[];
        handle.exports.push({ project_id: parsed.project_id, items });

        // World bbox from the *code the pipeline generated*, not the spec, so a
        // 1000x codegen error is caught here.
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (const item of items) {
          const size = item.code ? codeBbox(item.code, item.spec) : item.spec.bbox_mm;
          const ext = rotatedExtent(size, {
            x: item.rotation_deg.x,
            y: item.rotation_deg.y,
            z: item.rotation_deg.z,
          });
          minX = Math.min(minX, item.position_mm.x);
          minY = Math.min(minY, item.position_mm.y);
          minZ = Math.min(minZ, item.position_mm.z);
          maxX = Math.max(maxX, item.position_mm.x + ext.x);
          maxY = Math.max(maxY, item.position_mm.y + ext.y);
          maxZ = Math.max(maxZ, item.position_mm.z + ext.z);
        }
        const assembly = BboxSchema.parse({
          x: Math.max(maxX - minX, 1e-6),
          y: Math.max(maxY - minY, 1e-6),
          z: Math.max(maxZ - minZ, 1e-6),
        });
        const dir = `/tmp/cadforge-test/${parsed.project_id}`;
        return json({
          ok: true,
          step_path: `${dir}/assembly.step`,
          glb_path: `${dir}/assembly.glb`,
          stl_path: `${dir}/assembly.stl`,
          fcstd_path: null,
          per_part: items.map((i) => ({
            instance_name: i.instance_name,
            step_path: `${dir}/parts/${i.instance_name}.step`,
            glb_path: `${dir}/parts/${i.instance_name}.glb`,
          })),
          assembly_bbox_mm: assembly,
          skipped: ['fcstd'],
          error: null,
        });
      }

      return json({ error: `no route ${url.pathname}` }, 404);
    },
  });

  handle.url = `http://127.0.0.1:${server.port}`;
  handle.stop = () => {
    void server.stop(true);
  };
  return handle;
}
