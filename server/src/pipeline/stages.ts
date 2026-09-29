import type { AssemblyItem, PartSpec, Plan, PlanPart, RatioExpectation, Vec3 } from '@cadforge/shared';
import {
  AssemblyItemSchema,
  PartSpecSchema,
  PlanSchema,
  assertValidSpec,
  compareRatio,
  findAnchor,
  formatRatio,
  matchPart,
  requireAnchor,
  rotatedExtent,
} from '@cadforge/shared';
import { z } from 'zod';
import { env } from '../env.js';
import { ASSEMBLE_SYSTEM, assembleUserPrompt } from '../prompts/assemble.js';
import { PLAN_SYSTEM, planUserPrompt } from '../prompts/plan.js';
import { RESEARCH_SYSTEM, researchUserPrompt, searchQueryPrompt } from '../prompts/research.js';
import { fetchPageText } from '../providers/search.js';
import type { PipelineContext } from './types.js';

const SearchQueriesSchema = z.array(z.string().min(2).max(300)).min(1).max(5);

// -----------------------------------------------------------------------------
// 1. PLAN
// -----------------------------------------------------------------------------

export async function runPlan(ctx: PipelineContext): Promise<Plan> {
  const libraryNames = (await ctx.parts.listLibraryNames()).slice(0, 120);
  const plan = await ctx.llm.json(
    {
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: planUserPrompt(ctx.prompt, libraryNames) }],
      maxTokens: 4000,
    },
    (raw) => PlanSchema.parse(raw),
    env.LLM_MAX_RETRIES,
  );

  if (plan.parts.length > env.MAX_PARTS_PER_PROJECT) {
    ctx.log('warn', `plan has ${plan.parts.length} parts, trimming to ${env.MAX_PARTS_PER_PROJECT}`);
    plan.parts = plan.parts.slice(0, env.MAX_PARTS_PER_PROJECT);
  }
  ctx.log('info', `planned ${plan.parts.length} parts`);
  for (const p of plan.parts) {
    ctx.log('info', `  - ${p.quantity}x ${p.name}${p.role ? ` (${p.role})` : ''}`);
  }
  return plan;
}

// -----------------------------------------------------------------------------
// 2. RESOLVE + 3. RESEARCH
// -----------------------------------------------------------------------------

export interface ResolvedPart {
  part: PartSpec;
  quantity: number;
  source: 'library' | 'research';
  searchQueries: string[];
}

export async function resolvePart(ctx: PipelineContext, requested: PlanPart): Promise<ResolvedPart> {
  // Library first. A verified part is never re-researched.
  const libraryHit = await ctx.parts.findByName(requested.name);
  if (libraryHit) {
    ctx.log(
      'info',
      `library hit for "${requested.name}" -> ${libraryHit.id} (confidence ${libraryHit.confidence}${
        libraryHit.verified ? ', verified' : ''
      })`,
    );
    return { part: libraryHit, quantity: requested.quantity, source: 'library', searchQueries: [] };
  }

  // A cached research entry is a valid hit, but prefer a verified one.
  const fuzzy = matchPart(
    requested.name,
    await ctx.parts.listAll(),
  );
  if (fuzzy && fuzzy.verified) {
    ctx.log('info', `fuzzy library hit for "${requested.name}" -> ${fuzzy.id} (verified)`);
    return { part: fuzzy, quantity: requested.quantity, source: 'library', searchQueries: [] };
  }
  if (fuzzy) {
    ctx.log('info', `library candidate ${fuzzy.id} for "${requested.name}" is unverified; re-researching`);
  }

  return { part: await researchPart(ctx, requested), quantity: requested.quantity, source: 'research', searchQueries: [] };
}

async function researchPart(ctx: PipelineContext, requested: PlanPart): Promise<PartSpec> {
  ctx.log('info', `researching "${requested.name}"`);

  // (a) generate 2-3 queries
  const queries = await ctx.llm.json(
    { system: 'You write web search queries. Reply with only a JSON array of strings.', messages: [{ role: 'user', content: searchQueryPrompt(requested.name, requested.role) }], maxTokens: 300 },
    (raw) => SearchQueriesSchema.parse(raw),
    env.LLM_MAX_RETRIES,
  );
  ctx.log('info', `search queries: ${queries.join(' | ')}`);

  // (b) search
  const seen = new Set<string>();
  const results = [];
  for (const q of queries) {
    try {
      for (const r of await ctx.search.search({ query: q, maxResults: 5 })) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log('warn', `search failed for "${q}": ${msg}`);
      if (msg.includes('rate limit')) throw err;
    }
  }
  if (results.length === 0) {
    throw new Error(`web search returned no results for "${requested.name}"`);
  }
  ctx.log('info', `${results.length} search results`);

  // (c) fetch top pages / PDFs, capped in size and time
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const pageTexts: Array<{ url: string; title: string; text: string; truncated: boolean }> = [];
  const fetchBudget = env.MAX_FETCH_BYTES;
  let spent = 0;
  for (const r of ranked) {
    if (pageTexts.length >= 4) break;
    if (spent >= fetchBudget) break;
    try {
      const page = await fetchPageText(r.url, { maxBytes: Math.min(2_000_000, fetchBudget - spent) });
      spent += page.bytes;
      if (page.text.trim().length < 200) continue;
      pageTexts.push({ url: page.url, title: r.title, text: page.text, truncated: page.truncated });
    } catch (err) {
      ctx.log('warn', `could not fetch ${r.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ctx.log('info', `fetched ${pageTexts.length}/${ranked.length} pages (${(spent / 1024).toFixed(0)} KB)`);

  // (d) extract with the verbatim research system prompt
  const candidates = (await ctx.parts.listAll())
    .filter((p) => matchPart(requested.name, [p]) !== null)
    .map((p) => ({ id: p.id, name: p.name, confidence: p.confidence, verified: p.verified }));

  const raw = await ctx.llm.json(
    {
      system: RESEARCH_SYSTEM,
      messages: [
        {
          role: 'user',
          content: researchUserPrompt({
            partName: requested.name,
            role: requested.role,
            searchResults: results.slice(0, 8).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
            pageTexts,
            existingCandidates: candidates,
          }),
        },
      ],
      maxTokens: 8000,
    },
    (value) => value,
    env.LLM_MAX_RETRIES,
  );

  // (e) Zod validate + sanity checks
  const spec = assertValidSpec(PartSpecSchema.parse(raw));
  const issues = sanityCheck(spec, pageTexts);
  for (const issue of issues) ctx.log('warn', `sanity: ${issue}`);

  if (spec.confidence < 0.5) {
    ctx.log('warn', `"${spec.name}" is low-confidence (${spec.confidence}); check it before trusting the model`);
  }
  if (spec.sources.length === 0) {
    throw new Error(`research produced a spec for "${requested.name}" with no sources; refusing to cache it`);
  }

  // (f) upsert as a cached, unverified part
  await ctx.parts.upsert({ ...spec, verified: false, origin: 'research' });
  ctx.log(
    'info',
    `researched "${spec.name}" -> ${spec.id} (confidence ${spec.confidence}, ${spec.sources.length} source(s))`,
  );
  return spec;
}

/** Post-extraction sanity checks beyond Zod: plausibility and sourcing. */
export function sanityCheck(spec: PartSpec, pages: Array<{ text: string }>): string[] {
  const issues: string[] = [];
  if (spec.bbox_mm.x > 5000 || spec.bbox_mm.y > 5000 || spec.bbox_mm.z > 5000) {
    issues.push(`bbox ${spec.bbox_mm.x}x${spec.bbox_mm.y}x${spec.bbox_mm.z} mm is implausibly large (>5 m)`);
  }
  if (spec.bbox_mm.x < 0.05) {
    issues.push(`bbox x ${spec.bbox_mm.x} mm is implausibly small`);
  }
  for (const f of spec.features) {
    if (f.type === 'hole') {
      const d = f.dims_mm['diameter'] ?? 0;
      if (d > Math.min(spec.bbox_mm.x, spec.bbox_mm.y) * 1.5) {
        issues.push(`hole "${f.name}" diameter ${d} mm is larger than the part itself`);
      }
    }
  }
  if (pages.length === 0) {
    issues.push('no page text was available, so nothing could be verified');
  }
  if (spec.anchors.length === 0) {
    issues.push('no anchors defined, so this part can only be placed at the world origin');
  }
  return issues;
}

// -----------------------------------------------------------------------------
// 4. ASSEMBLE
// -----------------------------------------------------------------------------

/** Resolve anchors into concrete world positions, deterministically. */
export interface ResolvedPlacement {
  position: Vec3;
  rotation: Vec3;
}

export function resolveAssembly(
  assembly: AssemblyItem[],
  specsById: Map<string, PartSpec>,
): Map<string, ResolvedPlacement> {
  const byInstance = new Map<string, AssemblyItem>();
  for (const item of assembly) byInstance.set(item.instanceName, item);

  const resolved = new Map<string, ResolvedPlacement>();
  // Iterate to a fixed point so a part may attach to any already-placed part.
  for (let pass = 0; pass < assembly.length + 1; pass += 1) {
    let progressed = false;
    for (const item of assembly) {
      if (resolved.has(item.instanceName)) continue;
      const spec = specsById.get(item.partId);
      if (!spec) continue;

      const ref = item.placement.anchorRef;
      if (!ref) {
        resolved.set(item.instanceName, {
          position: { ...item.placement.offset_mm },
          rotation: { ...item.placement.rotation_deg },
        });
        progressed = true;
        continue;
      }

      const targetItem = byInstance.get(ref.targetInstance);
      if (!targetItem) continue;
      const targetSpec = specsById.get(targetItem.partId);
      const targetPlacement = resolved.get(ref.targetInstance);
      if (!targetSpec || !targetPlacement) continue;

      // `ref.anchorName` names an anchor on the TARGET. It becomes the point in
      // the world that my part's own seating anchor is moved onto.
      //
      // anchorRef: { targetInstance, anchorName } -> the target's anchor only.
      // Which of MY anchors seats there is decided here, deterministically, by
      // `seatingAnchorOf` — the LLM never gets to name its own anchor and never
      // emits a world coordinate.
      const targetAnchor = requireAnchor(targetSpec, ref.anchorName);
      const myAnchor = seatingAnchorOf(spec);

      const offset = item.placement.offset_mm;
      resolved.set(item.instanceName, {
        position: {
          x: targetPlacement.position.x + targetAnchor.x + offset.x - myAnchor.x,
          y: targetPlacement.position.y + targetAnchor.y + offset.y - myAnchor.y,
          z: targetPlacement.position.z + targetAnchor.z + offset.z - myAnchor.z,
        },
        rotation: { ...item.placement.rotation_deg },
      });
      progressed = true;
    }
    if (!progressed) break;
  }
  return resolved;
}

/** The anchor of a part that the LLM should attach: its own seating anchor. */
export function suggestedAnchorNames(spec: PartSpec): string[] {
  return spec.anchors.map((a) => a.name);
}

/**
 * Which of MY anchors is placed on the target's anchor.
 *
 * Preference order, most-specific first. A through-hole part straddles a header
 * at a lead; a body that sits on a surface seats on its flange or body face; a
 * part with nothing better defined uses the origin of its own bounding box.
 */
const SEATING_ANCHOR_PREFERENCE = [
  'lead_1',
  'lead_2',
  'flange_seat',
  'seat',
  'body_bottom',
  'pin_center',
  'shaft_center',
  'top_center',
  'center',
  'origin',
];

export function seatingAnchorOf(spec: PartSpec): Vec3 {
  for (const preferred of SEATING_ANCHOR_PREFERENCE) {
    const hit = findAnchor(spec, preferred);
    if (hit) return hit;
  }
  // Fall back to the lowest-Z anchor: for a part modelled with its origin at the
  // bottom face, that is the point which should touch the surface below it.
  if (spec.anchors.length > 0) {
    return [...spec.anchors].sort((a, b) => a.position_mm.z - b.position_mm.z)[0]!.position_mm;
  }
  return { x: 0, y: 0, z: 0 };
}

/** What the LLM is told about a part's seating, since it cannot choose it. */
function seatingHint(spec: PartSpec): string {
  const anchor = seatingAnchorOf(spec);
  const named = spec.anchors.find(
    (a) =>
      a.position_mm.x === anchor.x &&
      a.position_mm.y === anchor.y &&
      a.position_mm.z === anchor.z,
  );
  return named ? named.name : '(part origin 0,0,0)';
}

export async function runAssemble(
  ctx: PipelineContext,
  plan: Plan,
  specs: PartSpec[],
): Promise<{ assembly: AssemblyItem[]; placements: Map<string, ResolvedPlacement> }> {
  const specsById = new Map(specs.map((s) => [s.id, s]));

  // Expand the plan into instances.
  const instances: Array<{ spec: PartSpec; instanceName: string }> = [];
  const nameCounts = new Map<string, number>();
  for (const planned of plan.parts) {
    const spec = specs.find(
      (s) => s.name === planned.name || s.aliases.includes(planned.name) || matchPart(planned.name, [s]) !== null,
    );
    if (!spec) {
      ctx.log('warn', `no spec resolved for planned part "${planned.name}"; skipping it`);
      continue;
    }
    for (let i = 1; i <= planned.quantity; i += 1) {
      const n = (nameCounts.get(spec.id) ?? 0) + 1;
      nameCounts.set(spec.id, n);
      instances.push({ spec, instanceName: `${spec.id.replace(/[^a-z0-9_]/gi, '_')}_${i}` });
    }
  }
  if (instances.length === 0) {
    throw new Error('assembly has no instances');
  }

  // The base is the largest part by volume: the board, not the LED on it.
  const base = [...instances].sort(
    (a, b) => volume(b.spec) - volume(a.spec),
  )[0];
  if (!base) throw new Error('assembly has no base part');
  ctx.log('info', `base part: ${base.spec.name} (${base.instanceName})`);

  const rawAssembly = await ctx.llm.json(
    {
      system: ASSEMBLE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: assembleUserPrompt(
            instances.map((i) => ({ ...i, seating: seatingHint(i.spec) })),
            plan.relations,
            base.instanceName,
          ),
        },
      ],
      maxTokens: 5000,
    },
    (raw) => z.array(AssemblyItemSchema).parse(raw),
    env.LLM_MAX_RETRIES,
  );

  // Constrain the model's output to instances it was given, and validate every
  // anchor name against the real spec.
  const validInstances = new Map(instances.map((i) => [i.instanceName, i]));
  const assembly: AssemblyItem[] = [];
  const rejected: string[] = [];

  for (const proposed of rawAssembly) {
    const instance = validInstances.get(proposed.instanceName);
    if (!instance) {
      rejected.push(`unknown instance "${proposed.instanceName}"`);
      continue;
    }
    if (proposed.partId !== instance.spec.id) {
      rejected.push(`instance "${proposed.instanceName}" claimed partId ${proposed.partId}, expected ${instance.spec.id}`);
    }
    const ref = proposed.placement.anchorRef;
    if (ref) {
      const target = validInstances.get(ref.targetInstance);
      if (!target) {
        rejected.push(`"${proposed.instanceName}" targets unknown instance "${ref.targetInstance}"`);
        continue;
      }
      try {
        requireAnchor(target.spec, ref.anchorName);
      } catch (err) {
        rejected.push(err instanceof Error ? err.message : String(err));
        continue;
      }
    }
    assembly.push(proposed);
  }

  for (const r of rejected) ctx.log('warn', `assembly rejected: ${r}`);

  // Guarantee every instance exists, even if the LLM dropped one.
  for (const inst of instances) {
    if (assembly.some((a) => a.instanceName === inst.instanceName)) continue;
    ctx.log('warn', `adding missing instance ${inst.instanceName} at the origin`);
    assembly.push({
      partId: inst.spec.id,
      instanceName: inst.instanceName,
      placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
    });
  }

  const placements = resolveAssembly(assembly, specsById);
  const unresolved = assembly.filter((a) => !placements.has(a.instanceName));
  for (const u of unresolved) {
    ctx.log('warn', `could not resolve placement for ${u.instanceName}; placing at the origin`);
    placements.set(u.instanceName, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  }

  for (const item of assembly) {
    const p = placements.get(item.instanceName);
    const spec = specsById.get(item.partId);
    if (p && spec) {
      ctx.log(
        'info',
        `place ${item.instanceName} (${spec.name}) at (${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}, ${p.position.z.toFixed(2)}) mm`,
      );
    }
  }

  return { assembly, placements };
}

function volume(spec: PartSpec): number {
  return spec.bbox_mm.x * spec.bbox_mm.y * spec.bbox_mm.z;
}

// -----------------------------------------------------------------------------
// 8. VERIFY SCALE
// -----------------------------------------------------------------------------

export interface ScaleCheck {
  label: string;
  expected: number;
  actual: number;
  ok: boolean;
  detail: string;
}

/** Cross-checks that catch a 1000x or 100x scale error in the final assembly. */
export function verifyScaleChecks(
  assembly: Array<{ spec: PartSpec; position: Vec3 }>,
  finalBbox: { x: number; y: number; z: number },
): ScaleCheck[] {
  const checks: ScaleCheck[] = [];
  const smallest = [...assembly].sort((a, b) => volumeOf(a.spec) - volumeOf(b.spec))[0];
  const largest = [...assembly].sort((a, b) => volumeOf(b.spec) - volumeOf(a.spec))[0];

  if (smallest && largest && smallest.spec.id !== largest.spec.id) {
    const exp = smallest.spec.bbox_mm.x / largest.spec.bbox_mm.x;
    const act = smallest.spec.bbox_mm.x / finalBbox.x;
    const ratio = compareRatio(
      { label: 'smallest part width / assembly width', numerator: { instance: smallest.spec.id }, denominator: { instance: 'assembly' }, expected: exp },
      smallest.spec.bbox_mm.x,
      finalBbox.x,
      15,
    );
    checks.push({
      label: ratio.label,
      expected: exp,
      actual: act,
      ok: ratio.ok,
      detail: formatRatio(ratio),
    });
  }

  // Every part must fit inside the assembly bbox (with generous slack for
  // placement), otherwise something was scaled or positioned wrong.
  for (const item of assembly) {
    const fits =
      item.spec.bbox_mm.x <= finalBbox.x * 1.5 + 0.5 &&
      item.spec.bbox_mm.y <= finalBbox.y * 1.5 + 0.5 &&
      item.spec.bbox_mm.z <= finalBbox.z * 1.5 + 0.5;
    checks.push({
      label: `${item.spec.name} (${item.spec.id}) fits the assembly bbox`,
      expected: 1,
      actual: item.spec.bbox_mm.x / Math.max(finalBbox.x, 1e-6),
      ok: fits,
      detail: fits
        ? `part ${item.spec.bbox_mm.x}×${item.spec.bbox_mm.y}×${item.spec.bbox_mm.z} mm within ${finalBbox.x.toFixed(2)}×${finalBbox.y.toFixed(2)}×${finalBbox.z.toFixed(2)} mm`
        : `part ${item.spec.bbox_mm.x}×${item.spec.bbox_mm.y}×${item.spec.bbox_mm.z} mm does not fit ${finalBbox.x.toFixed(2)}×${finalBbox.y.toFixed(2)}×${finalBbox.z.toFixed(2)} mm — check for a scale or placement error`,
    });
  }

  // Order-of-magnitude guard.
  const magnitudes = assembly.map((a) => Math.log10(Math.max(volumeOf(a.spec), 1e-9)));
  const spread = Math.max(...magnitudes) - Math.min(...magnitudes);
  checks.push({
    label: 'part size spread is physically plausible',
    expected: 1,
    actual: spread,
    ok: spread < 4,
    detail:
      spread < 4
        ? `largest and smallest parts differ by ${spread.toFixed(2)} orders of magnitude`
        : `parts differ by ${spread.toFixed(2)} orders of magnitude (>4), which is not physical`,
  });

  return checks;
}

/** Ratio expectations the LLM verifier can sanity-check. */
export function ratioExpectations(
  assembly: Array<{ spec: PartSpec }>,
): RatioExpectation[] {
  const out: RatioExpectation[] = [];
  for (const a of assembly) {
    for (const b of assembly) {
      if (a.spec.id === b.spec.id) continue;
      if (a.spec.category === 'board' && b.spec.category === 'led') {
        out.push({
          label: `${b.spec.name} / ${a.spec.name}`,
          numerator: { instance: b.spec.id },
          denominator: { instance: a.spec.id },
          expected: b.spec.bbox_mm.x / a.spec.bbox_mm.x,
        });
      }
    }
  }
  return out.slice(0, 5);
}

function volumeOf(spec: PartSpec): number {
  return spec.bbox_mm.x * spec.bbox_mm.y * spec.bbox_mm.z;
}

/** Extent of a rotated part, used for the viewer's explode offset. */
export function partExtent(spec: PartSpec, rotation: Vec3): Vec3 {
  return rotatedExtent(
    { x: spec.bbox_mm.x, y: spec.bbox_mm.y, z: spec.bbox_mm.z },
    rotation,
  );
}
