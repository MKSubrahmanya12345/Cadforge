import { describe, expect, test } from 'bun:test';
import {
  AssemblyItemSchema,
  CodegenResponseSchema,
  PartSpecSchema,
  PlanSchema,
  WorkerExportResponseSchema,
  WorkerGenerateResponseSchema,
  WorkerHealthSchema,
  formatDims,
  stageLabel,
  STAGE_IDS,
  confidenceLabel,
} from '../index.js';

describe('plan schema', () => {
  test('accepts a well-formed plan and defaults quantity', () => {
    const plan = PlanSchema.parse({
      parts: [{ name: 'Arduino Uno', role: 'main board' }],
      relations: [{ a: 'Arduino Uno', b: 'LED', description: 'LED on pin 13' }],
    });
    expect(plan.parts[0]!.quantity).toBe(1);
  });

  test('rejects an empty plan', () => {
    expect(() => PlanSchema.parse({ parts: [] })).toThrow();
  });

  test('rejects a relation missing its description', () => {
    expect(() =>
      PlanSchema.parse({ parts: [{ name: 'a' }], relations: [{ a: 'a', b: 'b' }] }),
    ).toThrow();
  });
});

describe('assembly item schema', () => {
  test('placement defaults to zero offset and rotation', () => {
    const item = AssemblyItemSchema.parse({ partId: 'uno', instanceName: 'uno_1' });
    expect(item.placement.offset_mm).toEqual({ x: 0, y: 0, z: 0 });
    expect(item.placement.rotation_deg).toEqual({ x: 0, y: 0, z: 0 });
    expect(item.placement.anchorRef).toBeUndefined();
  });

  test('anchorRef requires both fields', () => {
    expect(() =>
      AssemblyItemSchema.parse({
        partId: 'led',
        instanceName: 'led_1',
        placement: { anchorRef: { targetInstance: 'uno_1' } },
      }),
    ).toThrow();
  });
});

describe('codegen response schema', () => {
  test('defaults parameters and notes', () => {
    const r = CodegenResponseSchema.parse({ code: 'import cadquery as cq' });
    expect(r.parameters).toEqual({});
    expect(r.notes).toBe('');
  });
});

describe('worker contract schemas', () => {
  test('generate response fills optional fields', () => {
    const r = WorkerGenerateResponseSchema.parse({
      ok: true,
      instance_name: 'led_1',
      fallback: false,
      valid: true,
      attempts: 1,
      bbox: null,
      features: [],
    });
    expect(r.error).toBeNull();
    expect(r.glb_path).toBeNull();
  });

  test('generate response requires bbox shape when present', () => {
    expect(() =>
      WorkerGenerateResponseSchema.parse({
        ok: true,
        instance_name: 'x',
        fallback: false,
        valid: true,
        attempts: 1,
        bbox: { expected: { x: 1, y: 1, z: 1 } },
        features: [],
      }),
    ).toThrow();
  });

  test('export response defaults per_part and skipped', () => {
    const r = WorkerExportResponseSchema.parse({
      ok: true,
      step_path: '/storage/p/a.step',
      glb_path: null,
      stl_path: null,
      fcstd_path: null,
      assembly_bbox_mm: { x: 1, y: 1, z: 1 },
    });
    expect(r.per_part).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.error).toBeNull();
  });

  test('health schema', () => {
    const h = WorkerHealthSchema.parse({
      ok: true,
      cadquery_version: '2.4',
      freecad: false,
      version: '1.0.0',
    });
    expect(h.freecad).toBe(false);
  });
});

describe('formatting helpers', () => {
  test('stageLabel covers every stage id', () => {
    for (const id of STAGE_IDS) {
      expect(stageLabel(id).length).toBeGreaterThan(0);
      expect(stageLabel(id)).not.toBe('undefined');
    }
    expect(stageLabel('nope')).toBe('nope');
  });

  test('formatDims', () => {
    expect(formatDims({ x: 68.58, y: 53.34, z: 1.6 })).toBe('68.58 × 53.34 × 1.60 mm');
  });

  test('confidenceLabel buckets', () => {
    expect(confidenceLabel(0.95)).toBe('high');
    expect(confidenceLabel(0.75)).toBe('medium');
    expect(confidenceLabel(0.55)).toBe('low');
    expect(confidenceLabel(0.2)).toBe('very low');
  });
});

describe('part spec fixture used across the e2e test', () => {
  test('parses a 5mm LED spec', () => {
    const s = PartSpecSchema.parse({
      id: 'led-5mm',
      name: '5mm LED',
      category: 'led',
      bbox_mm: { x: 5.8, y: 5.8, z: 8.6 },
      features: [],
      anchors: [{ name: 'lead_1', position_mm: { x: 1.27, y: 0, z: 0 } }],
      confidence: 0.8,
      verified: true,
    });
    expect(s.bbox_mm.x).toBe(5.8);
  });
});
