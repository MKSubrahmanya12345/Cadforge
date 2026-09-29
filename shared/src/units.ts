/**
 * Unit conversion and coordinate-frame helpers.
 *
 * CADForge has exactly one internal unit: the millimetre, in a right-handed
 * frame with X right, Y forward, Z up, origin at the lower-left corner of the
 * part. glTF/GLB is metres and Y-up, so every glTF export is scaled by
 * GLTF_SCALE (0.001) and rotated Z-up -> Y-up.
 */

export const MM_PER_INCH = 25.4;
export const MM_PER_MIL = 25.4 / 1000;
export const MM_PER_CM = 10;

/** glTF is metres, our world is millimetres. */
export const GLTF_SCALE = 0.001;

export const UNIT_ALIASES = {
  mm: 1,
  millimeter: 1,
  millimetre: 1,
  millimeters: 1,
  millimetres: 1,
  cm: 10,
  centimeter: 10,
  centimetre: 10,
  m: 1000,
  meter: 1000,
  metre: 1000,
  um: 0.001,
  micron: 0.001,
  in: MM_PER_INCH,
  inch: MM_PER_INCH,
  inches: MM_PER_INCH,
  '"': MM_PER_INCH,
  mil: MM_PER_MIL,
  mils: MM_PER_MIL,
  thou: MM_PER_MIL,
} as const;

export type UnitName = keyof typeof UNIT_ALIASES;

export function isUnitName(name: string): name is UnitName {
  return Object.prototype.hasOwnProperty.call(UNIT_ALIASES, name);
}

/** Convert a numeric value expressed in `unit` to millimetres. */
export function toMillimetres(value: number, unit: string): number {
  const key = unit.trim().toLowerCase();
  const factor = UNIT_ALIASES[key as UnitName];
  if (factor === undefined) {
    throw new Error(`Unknown unit "${unit}"`);
  }
  return value * factor;
}

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH;
}

export function mmToMils(mm: number): number {
  return mm / MM_PER_MIL;
}

/** Millimetres -> glTF metres. */
export function mmToMeters(mm: number): number {
  return mm * GLTF_SCALE;
}

export function metersToMm(m: number): number {
  return m / GLTF_SCALE;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Mat4 {
  /** Column-major 16-element matrix, glTF layout. */
  m: readonly number[];
}

export const IDENTITY_MAT4: Mat4 = {
  m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

/**
 * Z-up (CAD) -> Y-up (glTF). A -90 degree rotation about X, so that
 * CAD +Z becomes glTF +Y and CAD +Y becomes glTF -Z.
 */
export const Z_UP_TO_Y_UP: Mat4 = {
  m: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
};

export const Y_UP_TO_Z_UP: Mat4 = {
  m: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
};

/** Apply a column-major 4x4 to a point (w = 1). */
export function transformPoint(mat: Mat4, p: Vec3): Vec3 {
  const m = mat.m;
  // Column-major layout: m[0..3] is column 0. The bottom row is assumed to be
  // [0, 0, 0, 1] (an affine matrix), which is true of every matrix here.
  const a = (i: number): number => m[i] ?? 0;
  return {
    x: a(0) * p.x + a(4) * p.y + a(8) * p.z + a(12),
    y: a(1) * p.x + a(5) * p.y + a(9) * p.z + a(13),
    z: a(2) * p.x + a(6) * p.y + a(10) * p.z + a(14),
  };
}

/** Convert a CAD (Z-up, mm) point to glTF space (Y-up, metres). */
export function cadToGltfPoint(p: Vec3): Vec3 {
  const r = transformPoint(Z_UP_TO_Y_UP, p);
  return { x: r.x * GLTF_SCALE, y: r.y * GLTF_SCALE, z: r.z * GLTF_SCALE };
}

/** Human-readable mm, trimming noise, e.g. 53.34 -> "53.34", 5.0000001 -> "5" */
export function formatMm(mm: number, decimals = 2): string {
  if (!Number.isFinite(mm)) return '—';
  const rounded = Number(mm.toFixed(decimals));
  if (Object.is(rounded, -0)) return '0';
  return `${rounded}`;
}
