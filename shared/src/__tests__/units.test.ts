import { describe, expect, test } from 'bun:test';
import {
  GLTF_SCALE,
  MM_PER_INCH,
  MM_PER_MIL,
  MM_PER_CM,
  cadToGltfPoint,
  formatMm,
  metersToMm,
  mmToInches,
  mmToMeters,
  mmToMils,
  toMillimetres,
  transformPoint,
  Y_UP_TO_Z_UP,
  Z_UP_TO_Y_UP,
  IDENTITY_MAT4,
} from '../units.js';

describe('unit conversion', () => {
  test('inches and mils', () => {
    expect(MM_PER_INCH).toBe(25.4);
    expect(MM_PER_MIL).toBeCloseTo(0.0254, 10);
    expect(toMillimetres(1, 'in')).toBeCloseTo(25.4, 10);
    expect(toMillimetres(1000, 'mil')).toBeCloseTo(25.4, 10);
    expect(toMillimetres(1, 'inch')).toBeCloseTo(25.4, 10);
    expect(toMillimetres(2.54, 'cm')).toBeCloseTo(25.4, 10);
  });

  test('round trips mm <-> inches/mils', () => {
    expect(mmToInches(25.4)).toBeCloseTo(1, 10);
    expect(mmToMils(25.4)).toBeCloseTo(1000, 6);
    expect(toMillimetres(mmToMils(53.34), 'mil')).toBeCloseTo(53.34, 9);
  });

  test('glTF scale is exactly 0.001', () => {
    expect(GLTF_SCALE).toBe(0.001);
    expect(mmToMeters(1000)).toBeCloseTo(1, 12);
    expect(metersToMm(1)).toBeCloseTo(1000, 9);
    expect(metersToMm(mmToMeters(53.34))).toBeCloseTo(53.34, 9);
  });

  test('unknown unit throws', () => {
    expect(() => toMillimetres(1, 'furlong')).toThrow(/Unknown unit/);
  });

  test('mm helper constant', () => {
    expect(MM_PER_CM).toBe(10);
  });
});

describe('coordinate frames', () => {
  test('Z-up to Y-up maps +Z to +Y and +Y to -Z', () => {
    const p = transformPoint(Z_UP_TO_Y_UP, { x: 1, y: 2, z: 3 });
    expect(p.x).toBeCloseTo(1, 10);
    expect(p.y).toBeCloseTo(3, 10);
    expect(p.z).toBeCloseTo(-2, 10);
  });

  test('Y-up back to Z-up is the inverse', () => {
    const original = { x: 12.5, y: -3.25, z: 7 };
    const there = transformPoint(Z_UP_TO_Y_UP, original);
    const back = transformPoint(Y_UP_TO_Z_UP, there);
    expect(back.x).toBeCloseTo(original.x, 10);
    expect(back.y).toBeCloseTo(original.y, 10);
    expect(back.z).toBeCloseTo(original.z, 10);
  });

  test('identity matrix leaves points alone', () => {
    const p = { x: -4, y: 9, z: 0.5 };
    const out = transformPoint(IDENTITY_MAT4, p);
    expect(out).toEqual(p);
  });

  test('cadToGltfPoint applies both scale and rotation', () => {
    const out = cadToGltfPoint({ x: 1000, y: 2000, z: 3000 });
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(3, 12);
    expect(out.z).toBeCloseTo(-2, 12);
  });
});

describe('formatMm', () => {
  test('trims float noise and negative zero', () => {
    expect(formatMm(53.34)).toBe('53.34');
    expect(formatMm(5.0000001)).toBe('5');
    expect(formatMm(-0)).toBe('0');
    expect(formatMm(6.3, 1)).toBe('6.3');
    expect(formatMm(Number.NaN)).toBe('—');
  });
});
