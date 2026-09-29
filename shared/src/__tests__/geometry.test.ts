import { describe, expect, test } from 'bun:test';
import {
  add,
  applyMatrix,
  bboxFromPoints,
  compareRatio,
  cross,
  dot,
  eulerToMatrix,
  formatRatio,
  length,
  normalize,
  rotate,
  rotatedExtent,
  scale,
  sizeOf,
  sub,
  toleranceFor,
  unionBbox,
  vec,
} from '../geometry.js';
import { PartSpecSchema, type PartSpec } from '../schemas.js';

describe('vector math', () => {
  test('add/sub/scale', () => {
    expect(add(vec(1, 2, 3), vec(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(vec(4, 5, 6), vec(1, 2, 3))).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(vec(1, 2, 3), 2)).toEqual({ x: 2, y: 4, z: 6 });
  });

  test('length / normalize / dot / cross', () => {
    expect(length(vec(3, 4, 0))).toBe(5);
    expect(normalize(vec(0, 5, 0))).toEqual({ x: 0, y: 1, z: 0 });
    expect(normalize(vec(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
    expect(dot(vec(1, 0, 0), vec(0, 1, 0))).toBe(0);
    expect(cross(vec(1, 0, 0), vec(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('rotation', () => {
  test('90 degrees about Z maps +X to +Y', () => {
    const out = rotate({ x: 0, y: 0, z: 90 }, vec(1, 0, 0));
    expect(out.x).toBeCloseTo(0, 10);
    expect(out.y).toBeCloseTo(1, 10);
    expect(out.z).toBeCloseTo(0, 10);
  });

  test('zero rotation is identity', () => {
    const m = eulerToMatrix({ x: 0, y: 0, z: 0 });
    const p = vec(7, -2, 5);
    expect(applyMatrix(m, p).x).toBeCloseTo(7, 10);
    expect(applyMatrix(m, p).y).toBeCloseTo(-2, 10);
    expect(applyMatrix(m, p).z).toBeCloseTo(5, 10);
  });

  test('rotatedExtent of a square plate at 45 degrees about Z', () => {
    const e = rotatedExtent({ x: 10, y: 10, z: 2 }, { x: 0, y: 0, z: 45 });
    expect(e.z).toBeCloseTo(2, 6);
    expect(e.x).toBeCloseTo(Math.sqrt(200), 6);
    expect(e.y).toBeCloseTo(Math.sqrt(200), 6);
  });
});

describe('bounding boxes', () => {
  test('bboxFromPoints and sizeOf', () => {
    const b = bboxFromPoints([vec(0, 0, 0), vec(68.58, 53.34, 1.6), vec(10, 5, -2)]);
    expect(b).not.toBeNull();
    expect(b!.min).toEqual({ x: 0, y: 0, z: -2 });
    expect(b!.max).toEqual({ x: 68.58, y: 53.34, z: 1.6 });
    expect(sizeOf(b!)).toEqual({ x: 68.58, y: 53.34, z: 3.6 });
  });

  test('bboxFromPoints of nothing is null', () => {
    expect(bboxFromPoints([])).toBeNull();
  });

  test('unionBbox merges and tolerates nulls', () => {
    const a = { min: vec(0, 0, 0), max: vec(1, 1, 1) };
    const b = { min: vec(-1, 0, 0), max: vec(0.5, 2, 1) };
    const u = unionBbox(a, b)!;
    expect(u.min).toEqual({ x: -1, y: 0, z: 0 });
    expect(u.max).toEqual({ x: 1, y: 2, z: 1 });
    expect(unionBbox(null, b)).toEqual(b);
    expect(unionBbox(a, null)).toEqual(a);
    expect(unionBbox(null, null)).toBeNull();
  });
});

describe('validation tolerance', () => {
  test('0.3mm or 2% whichever is larger', () => {
    expect(toleranceFor(1)).toBeCloseTo(0.3, 10);
    expect(toleranceFor(50)).toBeCloseTo(1.0, 10);
    expect(toleranceFor(100)).toBeCloseTo(2.0, 10);
  });
});

describe('scale ratio checks', () => {
  test('LED dome / Uno width', () => {
    const r = compareRatio(
      {
        label: 'LED dome dia / Uno width',
        numerator: { instance: 'led' },
        denominator: { instance: 'uno' },
        expected: 5.0 / 53.34,
      },
      5.0,
      53.34,
      10,
    );
    expect(r.ok).toBe(true);
    expect(r.actual).toBeCloseTo(5.0 / 53.34, 12);
    expect(formatRatio(r)).toContain('OK');
  });

  test('a 10x error is caught', () => {
    const r = compareRatio(
      {
        label: 'LED dome dia / Uno width',
        numerator: { instance: 'led' },
        denominator: { instance: 'uno' },
        expected: 5.0 / 53.34,
      },
      50,
      53.34,
      10,
    );
    expect(r.ok).toBe(false);
    expect(formatRatio(r)).toContain('FAIL');
  });

  test('zero denominator does not produce Infinity', () => {
    const r = compareRatio(
      {
        label: 'x',
        numerator: { instance: 'a' },
        denominator: { instance: 'b' },
        expected: 1,
      },
      1,
      0,
    );
    expect(Number.isNaN(r.actual)).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe('real-scale integration: Uno + LED assembly bbox', () => {
  const uno: PartSpec = PartSpecSchema.parse({
    id: 'uno',
    name: 'Arduino Uno R3',
    category: 'board',
    bbox_mm: { x: 68.58, y: 53.34, z: 1.6 },
    features: [],
    anchors: [],
    confidence: 1,
    verified: true,
  });
  const led: PartSpec = PartSpecSchema.parse({
    id: 'led5',
    name: '5mm LED',
    category: 'led',
    bbox_mm: { x: 5.8, y: 5.8, z: 8.6 },
    features: [],
    anchors: [],
    confidence: 1,
    verified: true,
  });

  test('an LED on a 68mm board produces a 68.58mm-wide assembly', () => {
    const unoBox = { min: vec(0, 0, 0), max: vec(68.58, 53.34, 1.6) };
    const ledBox = { min: vec(60, 45, 1.6), max: vec(65.8, 50.8, 10.2) };
    const total = unionBbox(unoBox, ledBox)!;
    expect(sizeOf(total).x).toBeCloseTo(68.58, 6);
    expect(sizeOf(total).z).toBeCloseTo(10.2, 6);
  });

  test('part bboxes stay in the expected order of magnitude', () => {
    expect(uno.bbox_mm.x).toBeGreaterThan(led.bbox_mm.x);
    expect(led.bbox_mm.z).toBeGreaterThan(uno.bbox_mm.z);
  });
});
