import type { Vec3 } from './units.js';

export interface Bbox3 {
  min: Vec3;
  max: Vec3;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / l);
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Euler XYZ (degrees) -> 3x3 row-major rotation matrix. */
export function eulerToMatrix(deg: Vec3): number[] {
  const rx = (deg.x * Math.PI) / 180;
  const ry = (deg.y * Math.PI) / 180;
  const rz = (deg.z * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // R = Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

export function applyMatrix(m: readonly number[], p: Vec3): Vec3 {
  return {
    x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z,
    y: m[3]! * p.x + m[4]! * p.y + m[5]! * p.z,
    z: m[6]! * p.x + m[7]! * p.y + m[8]! * p.z,
  };
}

export function rotate(deg: Vec3, p: Vec3): Vec3 {
  return applyMatrix(eulerToMatrix(deg), p);
}

/** Rotation of 8 bbox corners, returns the axis-aligned extent. */
export function rotatedExtent(size: Vec3, deg: Vec3): Vec3 {
  const m = eulerToMatrix(deg);
  const h = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  const ex = {
    x: Math.abs(m[0]!) * h.x + Math.abs(m[1]!) * h.y + Math.abs(m[2]!) * h.z,
    y: Math.abs(m[3]!) * h.x + Math.abs(m[4]!) * h.y + Math.abs(m[5]!) * h.z,
    z: Math.abs(m[6]!) * h.x + Math.abs(m[7]!) * h.y + Math.abs(m[8]!) * h.z,
  };
  return { x: ex.x * 2, y: ex.y * 2, z: ex.z * 2 };
}

export function bboxFromPoints(points: readonly Vec3[]): Bbox3 | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { min: vec(minX, minY, minZ), max: vec(maxX, maxY, maxZ) };
}

export function sizeOf(b: Bbox3): Vec3 {
  return sub(b.max, b.min);
}

export function unionBbox(a: Bbox3 | null, b: Bbox3 | null): Bbox3 | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: vec(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
    max: vec(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
  };
}

/** Comparison tolerance: 0.3mm or 2% of the expected value, whichever is larger. */
export function toleranceFor(expected: number): number {
  return Math.max(0.3, Math.abs(expected) * 0.02);
}

export interface RatioExpectation {
  label: string;
  numerator: { instance: string; feature?: string };
  denominator: { instance: string; feature?: string };
  expected: number;
}

export interface RatioResult extends RatioExpectation {
  actual: number;
  deltaPct: number;
  ok: boolean;
  tolerancePct: number;
}

export function compareRatio(
  exp: RatioExpectation,
  numerator: number,
  denominator: number,
  tolerancePct = 10,
): RatioResult {
  const actual = denominator === 0 ? Number.NaN : numerator / denominator;
  const deltaPct = Number.isFinite(actual) ? ((actual - exp.expected) / exp.expected) * 100 : Number.NaN;
  return {
    ...exp,
    actual,
    deltaPct,
    ok: Number.isFinite(deltaPct) && Math.abs(deltaPct) <= tolerancePct,
    tolerancePct,
  };
}

/** Human-readable one-liner for the verify-scale log. */
export function formatRatio(r: RatioResult): string {
  return `${r.label}: expected ${r.expected.toFixed(4)}, got ${r.actual.toFixed(4)} (${
    r.deltaPct >= 0 ? '+' : ''
  }${r.deltaPct.toFixed(1)}%, tol ±${r.tolerancePct}%) ${r.ok ? 'OK' : 'FAIL'}`;
}
