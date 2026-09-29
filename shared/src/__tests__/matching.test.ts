import { describe, expect, test } from 'bun:test';
import {
  AnchorResolutionError,
  PartSpecSchema,
  findAnchor,
  matchPart,
  nameVariants,
  normalizeName,
  requireAnchor,
  validateSpecGeometry,
  type PartSpec,
} from '../index.js';

function spec(overrides: Record<string, unknown> = {}): PartSpec {
  return PartSpecSchema.parse({
    id: 'uno',
    name: 'Arduino Uno R3',
    category: 'board',
    aliases: ['uno', 'arduino uno'],
    bbox_mm: { x: 68.58, y: 53.34, z: 1.6 },
    features: [
      { type: 'hole', name: 'mh1', position_mm: { x: 13.97, y: 2.54, z: 0 }, dims_mm: { diameter: 3.2 } },
    ],
    anchors: [
      { name: 'D13_pin', position_mm: { x: 25.4, y: 48.26, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      { name: 'mount_hole_1', position_mm: { x: 13.97, y: 2.54, z: 0 } },
    ],
    confidence: 0.95,
    verified: true,
    ...overrides,
  });
}

describe('name normalization', () => {
  test('normalizeName strips punctuation and case', () => {
    expect(normalizeName('Arduino  Uno-R3!')).toBe('arduino uno r3');
  });

  test('nameVariants produce parenthetical and unit-stripped forms', () => {
    const v = nameVariants('5mm LED (through-hole)');
    expect(v).toContain('5mm led through hole');
    expect(v.some((s) => s === '5mm led')).toBe(true);
  });
});

describe('library matching', () => {
  const library = [spec(), spec({ id: 'led5', name: '5mm LED', aliases: ['led', '5mm led'] })];

  test('exact alias hit', () => {
    expect(matchPart('uno', library)?.id).toBe('uno');
  });

  test('substring hit', () => {
    expect(matchPart('Arduino Uno R3 board', library)?.id).toBe('uno');
  });

  test('fuzzy token overlap hit', () => {
    expect(matchPart('arduino uno', library)?.id).toBe('uno');
  });

  test('unrelated query misses', () => {
    expect(matchPart('nuclear reactor coolant pump', library)).toBeNull();
  });

  test('empty query misses', () => {
    expect(matchPart('   ', library)).toBeNull();
  });
});

describe('anchor resolution', () => {
  test('exact anchor name', () => {
    expect(findAnchor(spec(), 'D13_pin')).toEqual({ x: 25.4, y: 48.26, z: 0 });
  });

  test('case-insensitive fallback', () => {
    expect(findAnchor(spec(), 'd13_PIN')).toEqual({ x: 25.4, y: 48.26, z: 0 });
  });

  test('missing anchor returns null', () => {
    expect(findAnchor(spec(), 'D99_pin')).toBeNull();
  });

  test('requireAnchor throws with the available list attached', () => {
    try {
      requireAnchor(spec(), 'D99_pin');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AnchorResolutionError);
      const e = err as AnchorResolutionError;
      expect(e.available).toContain('D13_pin');
      expect(e.message).toContain('has no anchor "D99_pin"');
    }
  });
});

describe('spec geometry validation', () => {
  test('a good spec has no errors', () => {
    const issues = validateSpecGeometry(spec());
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('the schema refuses a non-positive bbox outright', () => {
    expect(() => PartSpecSchema.parse({ ...spec(), bbox_mm: { x: 0, y: 53.34, z: 1.6 } })).toThrow();
    expect(() => PartSpecSchema.parse({ ...spec(), bbox_mm: { x: 68.58, y: -1, z: 1.6 } })).toThrow();
  });

  test('a hand-built non-positive bbox is reported as an error by the geometry check', () => {
    // Bypasses the schema on purpose: validateSpecGeometry must be safe to call
    // on a spec that never went through Zod (research output, a hand edit).
    const broken = { ...spec(), bbox_mm: { x: 0, y: 53.34, z: 1.6 } } as PartSpec;
    const issues = validateSpecGeometry(broken);
    expect(issues.some((i) => i.severity === 'error' && i.path === 'bbox_mm')).toBe(true);
  });

  test('hole without diameter is an error', () => {
    const s = spec({
      features: [{ type: 'hole', name: 'h', position_mm: { x: 1, y: 1, z: 0 }, dims_mm: {} }],
    });
    const issues = validateSpecGeometry(s);
    expect(issues.some((i) => i.message.includes('hole needs diameter'))).toBe(true);
  });

  test('hole outside the bbox is a warning', () => {
    const s = spec({
      features: [
        { type: 'hole', name: 'h', position_mm: { x: 500, y: 1, z: 0 }, dims_mm: { diameter: 3.2 } },
      ],
    });
    const issues = validateSpecGeometry(s);
    const w = issues.find((i) => i.path.endsWith('position_mm.x'));
    expect(w?.severity).toBe('warning');
  });

  test('cylinder needs diameter and height', () => {
    const s = spec({
      features: [
        { type: 'cylinder', name: 'c', position_mm: { x: 5, y: 5, z: 0 }, dims_mm: { diameter: 3 } },
      ],
    });
    const issues = validateSpecGeometry(s);
    expect(issues.some((i) => i.message.includes('cylinder needs height'))).toBe(true);
  });

  test('pin needs diameter and length', () => {
    const s = spec({
      features: [
        { type: 'pin', name: 'p', position_mm: { x: 5, y: 5, z: 0 }, dims_mm: { diameter: 0.6 } },
      ],
    });
    const issues = validateSpecGeometry(s);
    expect(issues.some((i) => i.message.includes('pin needs length'))).toBe(true);
  });

  test('duplicate anchor names are an error', () => {
    const s = spec({
      anchors: [
        { name: 'a', position_mm: { x: 0, y: 0, z: 0 } },
        { name: 'a', position_mm: { x: 1, y: 0, z: 0 } },
      ],
    });
    expect(validateSpecGeometry(s).some((i) => i.message.includes('duplicate anchor'))).toBe(true);
  });
});

describe('schema enforcement', () => {
  test('confidence must be 0..1', () => {
    expect(() => PartSpecSchema.parse({ ...spec(), confidence: 1.5 })).toThrow();
    expect(() => PartSpecSchema.parse({ ...spec(), confidence: -0.1 })).toThrow();
  });

  test('color must be a 6-digit hex', () => {
    expect(() => PartSpecSchema.parse({ ...spec(), color_hex: 'red' })).toThrow();
    expect(PartSpecSchema.parse({ ...spec(), color_hex: '#00ff00' }).color_hex).toBe('#00ff00');
  });

  test('sources require a url', () => {
    expect(() => PartSpecSchema.parse({ ...spec(), sources: [{ url: 'not-a-url', title: 'x' }] })).toThrow();
  });

  test('defaults are applied', () => {
    const s = PartSpecSchema.parse({
      id: 'x',
      name: 'X',
      category: 'other',
      bbox_mm: { x: 1, y: 1, z: 1 },
      confidence: 0.5,
    });
    expect(s.verified).toBe(false);
    expect(s.aliases).toEqual([]);
    expect(s.features).toEqual([]);
    expect(s.anchors).toEqual([]);
    expect(s.sources).toEqual([]);
    expect(s.origin).toBe('research');
  });
});
