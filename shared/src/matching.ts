import type { PartSpec } from './schemas.js';
import { PartSpecSchema } from './schemas.js';
import type { Vec3 } from './units.js';

export const NUMERIC_ANCHOR_RE =
  /^(?:mount_hole|hole|pad|pins?|pin)?_?(\d+)(?:_(x|y|z))?$/i;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Progressive simplifications of a part name, used for fuzzy library lookup.
 *
 * A query like "5mm LED (through-hole)" has to be able to reach a spec named
 * "5mm LED", so the qualifiers inside parentheses are dropped first. Then the
 * descriptive nouns are dropped, which is what lets "220 ohm resistor" match a
 * spec called "1/4W axial resistor" on the number alone.
 */
export function nameVariants(name: string): string[] {
  const out = new Set<string>();
  const base = normalizeName(name);
  if (base) out.add(base);

  // Drop parenthetical qualifiers, with or without the parens surviving
  // normalization: "5mm led through hole" -> "5mm led".
  const noParen = base
    .split(' ')
    .filter((token) => !['through', 'hole', 'smd', 'tht', 'axial', 'radial', 'type'].includes(token))
    .join(' ')
    .trim();
  if (noParen) out.add(noParen);

  // Drop the descriptive nouns, keeping the numbers and units.
  const stripped = noParen
    .replace(/\b(ohm|ohms|resistor|res|led|board|module|pin|header|connector|servo|sensor|switch|module|assembly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped) out.add(stripped);

  // Just the measurement, e.g. "5mm" or "220".
  const numbers = base.match(/\d+(?:\.\d+)?/g);
  if (numbers && numbers.length > 0) {
    out.add(numbers.join(' '));
  }

  return [...out];
}

/**
 * Fuzzy library lookup: exact alias match first, then normalized/substring
 * scoring. Returns the best candidate above `threshold`, else null.
 */
export function matchPart(
  query: string,
  library: readonly PartSpec[],
  threshold = 0.55,
): PartSpec | null {
  const q = normalizeName(query);
  if (!q) return null;
  const qVariants = nameVariants(query);

  let best: { part: PartSpec; score: number } | null = null;
  for (const part of library) {
    for (const candidate of [part.name, ...part.aliases]) {
      const c = normalizeName(candidate);
      if (!c) continue;
      let score = 0;
      if (c === q) score = 1;
      else if (q.includes(c) || c.includes(q)) score = 0.8;
      else if (qVariants.some((v) => v === c)) score = 0.9;
      else score = tokenOverlap(c, q);
      if (score > (best?.score ?? 0)) best = { part, score };
    }
  }
  return best && best.score >= threshold ? best.part : null;
}

function tokenOverlap(a: string, b: string): number {
  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let hits = 0;
  for (const t of at) if (bt.has(t)) hits += 1;
  return hits / Math.max(at.size, bt.size);
}

/** Look up an anchor by name; supports numeric fallback like `mount_hole_1` -> `mount_hole_1`. */
export function findAnchor(spec: PartSpec, anchorName: string): Vec3 | null {
  const direct = spec.anchors.find((a) => a.name === anchorName);
  if (direct) return direct.position_mm;
  const m = NUMERIC_ANCHOR_RE.exec(anchorName.trim());
  if (m) {
    const idx = Number(m[1]) - 1;
    const axis = m[3]?.toLowerCase();
    const candidates = spec.anchors.filter((a) =>
      new RegExp(`${anchorName.replace(/\d+/, '\\d+')}$`, 'i').test(a.name),
    );
    if (candidates.length > 0) {
      const hit = candidates[idx];
      if (hit && !axis) return hit.position_mm;
    }
  }
  const loose = spec.anchors.find((a) => a.name.toLowerCase() === anchorName.toLowerCase());
  return loose ? loose.position_mm : null;
}

export class AnchorResolutionError extends Error {
  constructor(
    public readonly partId: string,
    public readonly anchorName: string,
    public readonly available: string[],
  ) {
    super(
      `Part "${partId}" has no anchor "${anchorName}". Available: ${
        available.length ? available.join(', ') : '(none)'
      }`,
    );
    this.name = 'AnchorResolutionError';
  }
}

export function requireAnchor(spec: PartSpec, anchorName: string): Vec3 {
  const found = findAnchor(spec, anchorName);
  if (!found) {
    throw new AnchorResolutionError(
      spec.id,
      anchorName,
      spec.anchors.map((a) => a.name),
    );
  }
  return found;
}

/** Validate a PartSpec's internal consistency: positive dims, holes inside the bbox. */
export interface SpecIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export function validateSpecGeometry(spec: PartSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const b = spec.bbox_mm;

  if (b.x <= 0 || b.y <= 0 || b.z <= 0) {
    issues.push({ severity: 'error', path: 'bbox_mm', message: 'bbox must be positive' });
  }
  if (spec.base_thickness_mm !== undefined && spec.base_thickness_mm > b.z) {
    issues.push({ severity: 'error', path: 'base_thickness_mm', message: 'base thickness cannot exceed the full physical Z envelope' });
  }

  if (spec.profile_mm) {
    if (spec.profile_mm.length < 3) {
      issues.push({ severity: 'error', path: 'profile_mm', message: 'profile needs at least 3 points' });
    }
    spec.profile_mm.forEach((pt, i) => {
      if (pt.x < -0.05 || pt.x > b.x + 0.05 || pt.y < -0.05 || pt.y > b.y + 0.05) {
        issues.push({
          severity: 'error',
          path: `profile_mm[${i}]`,
          message: `profile point (${pt.x}, ${pt.y}) lies outside bbox ${b.x}×${b.y}`,
        });
      }
    });
  }

  spec.features.forEach((f, i) => {
    const p = `features[${i}]`;
    if (f.type === 'hole') {
      const d = f.dims_mm['diameter'];
      if (d === undefined) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.diameter`, message: 'hole needs diameter' });
      } else if (d <= 0) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.diameter`, message: 'hole diameter must be > 0' });
      }
      if (f.dims_mm['depth'] !== undefined && f.dims_mm['depth'] <= 0) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.depth`, message: 'hole depth must be > 0' });
      }
    }
    if (f.type === 'cylinder') {
      if (!(f.dims_mm['diameter'] && f.dims_mm['diameter'] > 0)) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.diameter`, message: 'cylinder needs diameter' });
      }
      if (!(f.dims_mm['height'] && f.dims_mm['height'] > 0)) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.height`, message: 'cylinder needs height' });
      }
    }
    if (f.type === 'box' || f.type === 'pad' || f.type === 'cutout') {
      for (const k of ['x', 'y', 'z'] as const) {
        const v = f.dims_mm[k];
        if (v === undefined || v <= 0) {
          issues.push({ severity: 'error', path: `${p}.dims_mm.${k}`, message: `${f.type} needs positive ${k}` });
        }
      }
    }
    if (f.type === 'pin') {
      const d = f.dims_mm['diameter'];
      if (d === undefined || d <= 0) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.diameter`, message: 'pin needs diameter' });
      }
      const len = f.dims_mm['length'];
      if (len === undefined || len <= 0) {
        issues.push({ severity: 'error', path: `${p}.dims_mm.length`, message: 'pin needs length' });
      }
    }

    // Containment: a hole/cylinder center must sit inside the bbox footprint.
    const { x, y } = f.position_mm;
    if (f.type === 'hole' || f.type === 'cylinder') {
      const d = f.dims_mm['diameter'] ?? 0;
      if (x - d / 2 < -0.05 || x + d / 2 > b.x + 0.05) {
        issues.push({
          severity: 'warning',
          path: `${p}.position_mm.x`,
          message: `feature "${f.name}" x=${x} lies outside bbox x range 0..${b.x}`,
        });
      }
      if (y - d / 2 < -0.05 || y + d / 2 > b.y + 0.05) {
        issues.push({
          severity: 'warning',
          path: `${p}.position_mm.y`,
          message: `feature "${f.name}" y=${y} lies outside bbox y range 0..${b.y}`,
        });
      }
    }
    if (f.type === 'hole' && f.position_mm.z < 0) {
      issues.push({
        severity: 'warning',
        path: `${p}.position_mm.z`,
        message: `hole "${f.name}" starts below the part origin`,
      });
    }
  });

  const names = new Set<string>();
  spec.anchors.forEach((a, i) => {
    if (names.has(a.name)) {
      issues.push({ severity: 'error', path: `anchors[${i}].name`, message: `duplicate anchor "${a.name}"` });
    }
    names.add(a.name);
  });

  return issues;
}

export function assertValidSpec(spec: PartSpec): PartSpec {
  const parsed = PartSpecSchema.parse(spec);
  const errors = validateSpecGeometry(parsed).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Invalid PartSpec ${parsed.id}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    );
  }
  return parsed;
}
