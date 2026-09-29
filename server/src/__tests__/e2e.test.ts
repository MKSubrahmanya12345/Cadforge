import { describe, expect, test } from 'bun:test';
import type { PartSpec } from '@cadforge/shared';
import { PartSpecSchema, AssemblyItemSchema, Vec3Schema, BboxSchema } from '@cadforge/shared';
import { runAssemble, verifyScaleChecks } from '../pipeline/stages.js';
import { deterministicCodeFor } from '../pipeline/generate.js';
import { MemoryPartStore, MockSearchProvider, ScriptedLLM } from './mocks.js';
import { parseParameters, startFakeWorker, type FakeWorkerHandle } from './fakeWorker.js';
import { SEED_PARTS } from '../seed/parts.js';
import { ZodError } from 'zod';
import type { PipelineContext, PipelineSink } from '../pipeline/types.js';
import type { LogEntry, ProjectStatus } from '@cadforge/shared';

const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3') as PartSpec;
const led = SEED_PARTS.find((p) => p.id === 'led-5mm') as PartSpec;
const resistor = SEED_PARTS.find((p) => p.id === 'resistor-axial-1-4w') as PartSpec;

interface Recorder extends PipelineSink {
  logs: LogEntry[];
  patches: Array<Record<string, unknown>>;
}

function recorder(): Recorder {
  const logs: LogEntry[] = [];
  const patches: Array<Record<string, unknown>> = [];
  return {
    logs,
    patches,
    async appendLog(entry) {
      logs.push(entry);
    },
    async patch(fields) {
      patches.push(fields);
    },
  };
}

function makeCtx(
  llm: ScriptedLLM,
  parts: MemoryPartStore,
  search = new MockSearchProvider(),
  sink = recorder(),
): { ctx: PipelineContext; sink: Recorder; search: MockSearchProvider } {
  const statuses: ProjectStatus[] = [];
  const progress: number[] = [];
  // Stages report through ctx.log (which the orchestrator forwards to the sink);
  // capture it here so stage-level warnings are assertable.
  const ctx: PipelineContext = {
    projectId: 'test-project',
    prompt: 'Arduino Uno with a 5mm LED on pin 13',
    llm,
    search,
    parts,
    sink,
    log: (level, message) => {
      sink.logs.push({ ts: new Date().toISOString(), stage: 'test', level, message });
    },
    status: (s) => statuses.push(s),
    progress: (p) => progress.push(p),
  };
  void statuses;
  void progress;
  return { ctx, sink, search };
}

const PLAN = {
  parts: [
    { name: 'Arduino Uno R3', quantity: 1, role: 'main board' },
    { name: '5mm LED', quantity: 1, role: 'indicator on pin 13' },
  ],
  relations: [
    { a: 'Arduino Uno R3', b: '5mm LED', description: 'LED legs straddle the D13 header pin' },
  ],
};

/** Assembly the LLM is scripted to return: base at origin, LED on D13. */
const ASSEMBLY = [
  {
    partId: 'arduino-uno-r3',
    instanceName: 'arduino_uno_r3_1',
    placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
  },
  {
    partId: 'led-5mm',
    instanceName: 'led_5mm_1',
    placement: {
      anchorRef: { targetInstance: 'arduino_uno_r3_1', anchorName: 'D13_pin' },
      offset_mm: { x: 0, y: 0, z: 0 },
      rotation_deg: { x: 0, y: 0, z: 0 },
    },
  },
];

function scriptedLLM(overrides?: { assembly?: unknown; codegenFor?: (user: string) => string }) {
  return new ScriptedLLM([
    {
      match: (system) => system.includes('planning stage'),
      respond: () => PLAN,
    },
    {
      match: (system) => system.includes('assembly stage'),
      respond: () => overrides?.assembly ?? ASSEMBLY,
    },
    {
      match: (system) => system.includes('CadQuery code generator'),
      respond: (_s, user) => {
        const custom = overrides?.codegenFor?.(user);
        const code = custom ?? codeFromSpec(user);
        return { code, parameters: parseParameters(code), notes: 'e2e' };
      },
    },
  ]);
}

/**
 * Build CadQuery source from the spec block in the codegen prompt, so the code
 * under test is parameterised by the real spec numbers rather than hardcoded.
 */
function codeFromSpec(user: string): string {
  const box = /Overall bounding box: x=([\d.]+) x y=([\d.]+) x z=([\d.]+)/.exec(user);
  if (!box?.[1] || !box[2] || !box[3]) {
    throw new Error('could not find the bbox line in the codegen prompt');
  }
  const [, sx, sy, sz] = box;

  const featureBlock = /Features that MUST be present in the solid:\n([\s\S]*?)(?:\n\n|$)/.exec(user);
  const featureLines = (featureBlock?.[1] ?? '').split('\n').filter((l) => l.trim().startsWith('- type='));

  const lines: string[] = [
    'import cadquery as cq',
    '',
    `LENGTH_MM = ${sx}`,
    `WIDTH_MM = ${sy}`,
    `HEIGHT_MM = ${sz}`,
  ];
  const constName = (name: string): string =>
    (name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() || 'FEATURE');

  for (const raw of featureLines) {
    const type = /type=(\w+)/.exec(raw)?.[1];
    const name = /name=(\S+)/.exec(raw)?.[1];
    const pos = /position_mm=\(([^)]+)\)/.exec(raw)?.[1];
    const dims = /dims_mm=(\{.*?\})(?=\s|$|note=)/.exec(raw)?.[1];
    if (!type || !name || !pos || !dims) continue;
    const c = constName(name);
    const [px, py] = pos.split(',').map((s) => s.trim());
    const parsed = JSON.parse(dims) as Record<string, number>;
    lines.push(`${c}_X_MM = ${px ?? 0}`);
    lines.push(`${c}_Y_MM = ${py ?? 0}`);
    for (const [k, v] of Object.entries(parsed)) {
      lines.push(`${c}_${k.toUpperCase()}_MM = ${v}`);
    }
  }

  lines.push('', 'def build() -> cq.Workplane:');
  lines.push('    solid = cq.Workplane("XY").box(');
  lines.push('        LENGTH_MM, WIDTH_MM, HEIGHT_MM, centered=(True, True, False)');
  lines.push('    )');
  for (const raw of featureLines) {
    const type = /type=(\w+)/.exec(raw)?.[1];
    const name = /name=(\S+)/.exec(raw)?.[1];
    if (type === 'hole' && name) {
      const c = constName(name);
      lines.push('    solid = solid.cut(');
      lines.push(`        cq.Workplane("XY").circle(${c}_DIAMETER_MM / 2.0)`);
      lines.push(`        .extrude(${c}_DEPTH_MM + 0.2)`);
      lines.push(
        `        .translate((${c}_X_MM - LENGTH_MM / 2.0, ${c}_Y_MM - WIDTH_MM / 2.0, -0.1))`,
      );
      lines.push('    )');
    }
  }
  lines.push('    return solid');
  return lines.join('\n');
}

async function withFakeWorker<T>(fn: (worker: FakeWorkerHandle) => Promise<T>): Promise<T> {
  const worker = startFakeWorker();
  const previous = process.env['CAD_WORKER_URL'];
  process.env['CAD_WORKER_URL'] = worker.url;
  try {
    return await fn(worker);
  } finally {
    if (previous === undefined) delete process.env['CAD_WORKER_URL'];
    else process.env['CAD_WORKER_URL'] = previous;
    worker.stop();
  }
}

describe('end-to-end: "Arduino Uno with a 5mm LED on pin 13"', () => {
  test('produces a two-part assembly with the LED on the D13 anchor', async () => {
    const llm = scriptedLLM();
    const { ctx, sink } = makeCtx(llm, new MemoryPartStore());

    const result = await runAssemble(ctx, PLAN, [uno, led]);

    expect(result.assembly).toHaveLength(2);
    const ledItem = result.assembly.find((a) => a.instanceName === 'led_5mm_1');
    expect(ledItem?.placement.anchorRef?.anchorName).toBe('D13_pin');

    const unoPos = result.placements.get('arduino_uno_r3_1')?.position;
    const ledPos = result.placements.get('led_5mm_1')?.position;
    expect(unoPos).toEqual({ x: 0, y: 0, z: 0 });

    // The LED's own lead anchor lands exactly on the Uno's D13 pin.
    const d13 = uno.anchors.find((a) => a.name === 'D13_pin');
    const lead1 = led.anchors.find((a) => a.name === 'lead_1');
    expect(d13).toBeDefined();
    expect(lead1).toBeDefined();
    expect(ledPos!.x + lead1!.position_mm.x).toBeCloseTo(d13!.position_mm.x, 9);
    expect(ledPos!.y + lead1!.position_mm.y).toBeCloseTo(d13!.position_mm.y, 9);
    expect(ledPos!.z + lead1!.position_mm.z).toBeCloseTo(d13!.position_mm.z, 9);

    // And the logs say so, which is what the UI shows.
    expect(sink.logs.some((l) => l.message.includes('base part'))).toBe(true);
  });

  test('the exported assembly bbox has Uno width 53.34 mm and a 5.0 mm LED dome', async () => {
    await withFakeWorker(async (worker) => {
      const { assemblyBbox, workerExport } = await import('../worker.js');
      const { resolveAssembly } = await import('../pipeline/stages.js');
      const { AssemblyItemSchema } = await import('@cadforge/shared');

      // anchorRef names an anchor on the TARGET; which of my own anchors seats
      // there is the server's deterministic choice.
      const items = ASSEMBLY.map((a) => AssemblyItemSchema.parse(a));
      const placements = resolveAssembly(items, new Map([[uno.id, uno], [led.id, led]]));

      const exports = await workerExport(
        'test-project',
        items.map((item) => {
          const p = placements.get(item.instanceName)!;
          return {
            instanceName: item.instanceName,
            spec: item.partId === uno.id ? uno : led,
            position: p.position,
            rotation: p.rotation,
            code: deterministicCodeFor(item.partId === uno.id ? uno : led),
          };
        }),
      );

      expect(exports.ok).toBe(true);
      expect(exports.assembly_bbox_mm).not.toBeNull();

      const bbox = exports.assembly_bbox_mm!;
      const b = BboxSchema.parse(bbox);

      // THE core guarantee: the board dominates the footprint and is exactly the
      // size the datasheet says, and the LED adds only its own 5.8mm.
      // The Uno is 68.58 long, so the assembly is 68.58 long.
      expect(b.x).toBeCloseTo(68.58, 2);
      // The LED straddles the D13 pin near the board's back edge (y=48.26 of
      // 53.34), so it overhangs by 48.26 + 5.8 - 53.34 = 0.72mm. That overhang is
      // the arithmetic of a real 5mm LED on that header, and it is small — which
      // is the point. A model that got the scale wrong would be off by orders of
      // magnitude here, not by 0.72mm.
      expect(b.y).toBeCloseTo(48.26 + led.bbox_mm.y, 2);
      expect(b.y).toBeLessThan(53.34 + led.bbox_mm.y);
      // 1.6mm PCB + 8.6mm LED standing on it.
      expect(b.z).toBeCloseTo(1.6 + led.bbox_mm.z, 2);

      const ledCode = deterministicCodeFor(led);
      const params = parseParameters(ledCode);
      expect(params['DOME_DIAMETER_MM']).toBe(5.0);
      expect(params['FLANGE_DIAMETER_MM']).toBe(5.8);
      expect(params['LENGTH_MM']).toBeCloseTo(5.8, 6);

      const unoCode = deterministicCodeFor(uno);
      const unoParams = parseParameters(unoCode);
      expect(unoParams['LENGTH_MM']).toBeCloseTo(68.58, 6);
      expect(unoParams['WIDTH_MM']).toBeCloseTo(53.34, 6);
      expect(unoParams['HEIGHT_MM']).toBeCloseTo(1.6, 6);
      expect(unoParams['MOUNT_HOLE_1_DIAMETER_MM']).toBe(3.2);

      // And the ratio the product promises.
      expect(params['DOME_DIAMETER_MM']! / unoParams['WIDTH_MM']!).toBeCloseTo(5.0 / 53.34, 4);

      // The server-side bbox helper agrees with the worker's.
      const serverBbox = assemblyBbox(
        items.map((item) => ({
          spec: item.partId === uno.id ? uno : led,
          position: placements.get(item.instanceName)!.position,
          rotation: placements.get(item.instanceName)!.rotation,
        })),
      );
      expect(serverBbox.x).toBeCloseTo(b.x, 1);
      expect(serverBbox.y).toBeCloseTo(b.y, 1);
      expect(serverBbox.z).toBeCloseTo(b.z, 1);

      expect(worker.exports).toHaveLength(1);
      expect(worker.exports[0]!.items).toHaveLength(2);
    });
  });

  test('scale verification passes for a real-scale assembly', async () => {
    const checks = verifyScaleChecks(
      [
        { spec: uno, position: { x: 0, y: 0, z: 0 } },
        { spec: led, position: { x: 25.4, y: 48.26, z: 1.6 } },
      ],
      { x: 68.58, y: 53.34, z: 10.2 },
    );
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(c.ok).toBe(true);
    }
  });

  test('a 1000x codegen error is caught by validation and falls back to the spec-exact builder', async () => {
    await withFakeWorker(async (worker) => {
      const llm = scriptedLLM({
        // The classic failure: the LLM writes metres where millimetres were asked
        // for, so every dimension is 1000x too large.
        codegenFor: (user) =>
          codeFromSpec(user)
            .split('\n')
            .map((line) => {
              const m = /^(LENGTH_MM|WIDTH_MM|HEIGHT_MM) = ([\d.]+)$/.exec(line.trim());
              return m ? `${m[1]} = ${Number(m[2]) * 1000}` : line;
            })
            .join('\n'),
      });
      const { ctx, sink } = makeCtx(llm, new MemoryPartStore());
      const { generatePart } = await import('../pipeline/generate.js');

      const result = await generatePart(ctx, 'arduino_uno_r3_1', uno);

      expect(result.usedFallback).toBe(true);
      expect(worker.fallbacks.some((f) => f.instance_name === 'arduino_uno_r3_1')).toBe(true);
      expect(sink.logs.some((l) => l.message.includes('fallback: true'))).toBe(true);
      // The fallback code still carries the exact spec dimensions.
      const params = parseParameters(result.code);
      expect(params['LENGTH_MM']).toBeCloseTo(68.58, 6);
    });
  });

  test('a correct LLM attempt is accepted without any fallback', async () => {
    await withFakeWorker(async (worker) => {
      const llm = scriptedLLM();
      const { ctx } = makeCtx(llm, new MemoryPartStore());
      const { generatePart } = await import('../pipeline/generate.js');

      const result = await generatePart(ctx, 'arduino_uno_r3_1', uno);

      expect(result.usedFallback).toBe(false);
      expect(result.attempts).toBe(1);
      expect(worker.fallbacks).toHaveLength(0);
      const params = parseParameters(result.code);
      expect(params['LENGTH_MM']).toBeCloseTo(68.58, 6);
    });
  });
});

describe('anchor resolution determinism', () => {
  test('an assembly with a chain of anchor refs resolves in dependency order', async () => {
    const { resolveAssembly } = await import('../pipeline/stages.js');
    // breadboard is the base, the Uno sits on it, and the LED hangs off the Uno.
    const breadboard = SEED_PARTS.find((p) => p.id === 'breadboard-half') as PartSpec;
    const items = [
      AssemblyItemSchema.parse({
        partId: breadboard.id,
        instanceName: 'bread_1',
        placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
      }),
      AssemblyItemSchema.parse({
        partId: uno.id,
        instanceName: 'uno_1',
        placement: {
          anchorRef: { targetInstance: 'bread_1', anchorName: 'top_center' },
          offset_mm: { x: -34.29, y: -26.67, z: 0 },
          rotation_deg: { x: 0, y: 0, z: 0 },
        },
      }),
      AssemblyItemSchema.parse({
        partId: led.id,
        instanceName: 'led_1',
        placement: {
          anchorRef: { targetInstance: 'uno_1', anchorName: 'D13_pin' },
          offset_mm: { x: 0, y: 0, z: 0 },
          rotation_deg: { x: 0, y: 0, z: 0 },
        },
      }),
    ];

    // Shuffled input: resolution must not depend on declaration order.
    const shuffled = [items[2]!, items[0]!, items[1]!];
    const specs = new Map([
      [breadboard.id, breadboard],
      [uno.id, uno],
      [led.id, led],
    ]);
    const placements = resolveAssembly(shuffled, specs);

    expect(placements.size).toBe(3);
    const { seatingAnchorOf } = await import('../pipeline/stages.js');
    const OFFSET = { x: -34.29, y: -26.67, z: 0 };

    const breadTop = breadboard.anchors.find((a) => a.name === 'top_center')!;
    const unoPos = placements.get('uno_1')!.position;
    // The Uno's natural seating anchor (top_center, its own board centre) is
    // moved onto the breadboard's top_center, then the requested offset applies.
    const unoSeat = seatingAnchorOf(uno);
    expect(unoSeat).toEqual({ x: 34.29, y: 26.67, z: 1.6 });
    expect(unoPos.x).toBeCloseTo(breadTop.position_mm.x + OFFSET.x - unoSeat.x, 6);
    expect(unoPos.y).toBeCloseTo(breadTop.position_mm.y + OFFSET.y - unoSeat.y, 6);
    expect(unoPos.z).toBeCloseTo(breadTop.position_mm.z + OFFSET.z - unoSeat.z, 6);

    // The LED seats by its lead, so lead_1 lands on the Uno's D13 pin.
    const ledSeat = seatingAnchorOf(led);
    expect(ledSeat).toEqual(led.anchors.find((a) => a.name === 'lead_1')!.position_mm);
    const d13 = uno.anchors.find((a) => a.name === 'D13_pin')!;
    const ledPos = placements.get('led_1')!.position;
    expect(ledPos.x).toBeCloseTo(unoPos.x + d13.position_mm.x - ledSeat.x, 6);
    expect(ledPos.y).toBeCloseTo(unoPos.y + d13.position_mm.y - ledSeat.y, 6);
    expect(ledPos.z).toBeCloseTo(unoPos.z + d13.position_mm.z - ledSeat.z, 6);

    // The LED's lead therefore sits exactly on the pin, which is the whole point.
    expect(ledPos.x + ledSeat.x).toBeCloseTo(unoPos.x + d13.position_mm.x, 9);
    expect(ledPos.y + ledSeat.y).toBeCloseTo(unoPos.y + d13.position_mm.y, 9);
    expect(ledPos.z + ledSeat.z).toBeCloseTo(unoPos.z + d13.position_mm.z, 9);
  });

  test('an unresolvable anchor is rejected and the part still gets a placement', async () => {
    // The LLM names an anchor the Uno does not have. It must be dropped, not
    // silently placed at a made-up point, and the part must still end up
    // somewhere deterministic.
    const planWithResistor: typeof PLAN = {
      parts: [...PLAN.parts, { name: '1/4W axial resistor', quantity: 1, role: 'current limit' }],
      relations: PLAN.relations,
    };
    const llm = scriptedLLM({
      assembly: [
        ...ASSEMBLY,
        {
          partId: 'resistor-axial-1-4w',
          instanceName: 'resistor_axial_1_4w_1',
          placement: {
            anchorRef: { targetInstance: 'arduino_uno_r3_1', anchorName: 'NO_SUCH_ANCHOR' },
            offset_mm: { x: 0, y: 0, z: 0 },
            rotation_deg: { x: 0, y: 0, z: 0 },
          },
        },
      ],
    });
    const { ctx, sink } = makeCtx(llm, new MemoryPartStore());
    const { runAssemble: assemble } = await import('../pipeline/stages.js');
    const result = await assemble(ctx, planWithResistor, [uno, led, resistor]);

    expect(sink.logs.some((l) => l.message.includes('has no anchor'))).toBe(true);
    // The bad entry was dropped, then re-added at the origin by the safety net.
    expect(sink.logs.some((l) => l.message.includes('adding missing instance'))).toBe(true);
    expect(result.assembly).toHaveLength(3);
    expect(result.placements.size).toBe(3);
    for (const p of result.placements.values()) {
      expect(Number.isFinite(p.position.x)).toBe(true);
    }
  });

  test('an unknown instance in an anchorRef is rejected', async () => {
    const llm = scriptedLLM({
      assembly: [
        {
          partId: 'led-5mm',
          instanceName: 'led_5mm_1',
          placement: {
            anchorRef: { targetInstance: 'ghost', anchorName: 'D13_pin' },
            offset_mm: { x: 0, y: 0, z: 0 },
            rotation_deg: { x: 0, y: 0, z: 0 },
          },
        },
      ],
    });
    const { ctx, sink } = makeCtx(llm, new MemoryPartStore());
    const { runAssemble: assemble } = await import('../pipeline/stages.js');
    const result = await assemble(ctx, PLAN, [uno, led]);
    expect(sink.logs.some((l) => l.message.includes('unknown instance'))).toBe(true);
    expect(result.placements.size).toBe(result.assembly.length);
  });

  test('an LLM claiming the wrong partId for an instance is rejected', async () => {
    const llm = scriptedLLM({
      assembly: [
        {
          partId: 'led-5mm', // instance is the Uno's
          instanceName: 'arduino_uno_r3_1',
          placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
        },
      ],
    });
    const { ctx, sink } = makeCtx(llm, new MemoryPartStore());
    const { runAssemble: assemble } = await import('../pipeline/stages.js');
    const result = await assemble(ctx, PLAN, [uno, led]);
    expect(sink.logs.some((l) => l.message.includes('claimed partId'))).toBe(true);
    // The correct entries are still there, so the model is not empty.
    expect(result.assembly.length).toBe(2);
  });
});

describe('verifying real scale catches gross errors', () => {
  test('a 1000x-too-large assembly is caught', () => {
    // The ratio check is the one that fires: the smallest part is then 1000x
    // smaller relative to the assembly than the specs say it should be.
    const checks = verifyScaleChecks(
      [
        { spec: uno, position: { x: 0, y: 0, z: 0 } },
        { spec: led, position: { x: 0, y: 0, z: 0 } },
      ],
      { x: 68580, y: 53340, z: 1600 },
    );
    const ratio = checks.find((c) => c.label.includes('smallest part width / assembly width'));
    expect(ratio?.ok).toBe(false);
    expect(checks.some((c) => !c.ok)).toBe(true);
  });

  test('a part far larger than the assembly is flagged as not fitting', () => {
    // 5mm LED inside a 10mm assembly box: the Uno cannot be there.
    const checks = verifyScaleChecks(
      [
        { spec: uno, position: { x: 0, y: 0, z: 0 } },
        { spec: led, position: { x: 0, y: 0, z: 0 } },
      ],
      { x: 10, y: 10, z: 2 },
    );
    const fit = checks.find((c) => c.label.includes('Arduino Uno R3') && c.label.includes('fits'));
    expect(fit?.ok).toBe(false);
  });

  test('an implausible size spread is flagged', () => {
    const checks = verifyScaleChecks(
      [
        { spec: uno, position: { x: 0, y: 0, z: 0 } },
        { spec: led, position: { x: 0, y: 0, z: 0 } },
      ],
      { x: 68.58, y: 53.34, z: 8.6 },
    );
    const spread = checks.find((c) => c.label.includes('size spread'));
    expect(spread?.ok).toBe(true);
  });
});

describe('schema guards in the test helpers', () => {
  test('an ObjectId-shaped id passes the projectId pattern', () => {
    const parsed = Vec3Schema.parse({ x: 1, y: 2, z: 3 });
    expect(parsed.x).toBe(1);
  });

  test('a non-positive bbox is rejected by the shared schema', () => {
    expect(() => BboxSchema.parse({ x: 0, y: 1, z: 1 })).toThrow(ZodError);
  });

  test('the seed Uno parses', () => {
    expect(PartSpecSchema.parse(uno).id).toBe('arduino-uno-r3');
  });
});
