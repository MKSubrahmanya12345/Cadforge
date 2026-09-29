import type { PartSpec, Plan } from '@cadforge/shared';
import { publish } from '../events.js';
import { appendLog, updateProject } from '../models/project.js';
import { VERIFY_SCALE_SYSTEM } from '../prompts/assemble.js';
import { assemblyBbox, storageRoot, workerExport, type WorkerExportResponse } from '../worker.js';
import { generatePart } from './generate.js';
import { runAssemble, runPlan, resolvePart, verifyScaleChecks } from './stages.js';
import type { GeneratedPart, PipelineContext, PipelineSink } from './types.js';
import { z } from 'zod';
import { createLogger } from '../logger.js';

const log = createLogger('pipeline:orchestrator');

const VerifySchema = z.object({
  ok: z.boolean(),
  ratios: z
    .array(
      z.object({
        label: z.string(),
        numerator_mm: z.number(),
        denominator_mm: z.number(),
        ratio: z.number(),
        plausible: z.boolean(),
      }),
    )
    .default([]),
  summary: z.string().default(''),
  warnings: z.array(z.string()).default([]),
});

/**
 * The single orchestrator. Runs every stage in order, emitting SSE progress at
 * each boundary, and persists state after every meaningful step so a client that
 * connects late still sees the full picture.
 */
export async function runPipeline(ctx: PipelineContext): Promise<void> {
  const started = Date.now();

  // A caller may inject a sink (the MCP bridge does); otherwise write to Mongo.
  const sink: PipelineSink = ctx.sink ?? {
    appendLog: (entry) => appendLog(ctx.projectId, entry),
    patch: (fields) => updateProject(ctx.projectId, fields as never),
  };

  const persist = (fn: () => Promise<unknown>): void => {
    void fn().catch((err: unknown) => {
      log.warn('could not persist pipeline state', {
        projectId: ctx.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const recordLog = (level: 'info' | 'warn' | 'error' | 'success', stage: string, message: string) => {
    const entry = { ts: new Date().toISOString(), stage, level, message };
    publish(ctx.projectId, { type: 'log', data: entry });
    persist(() => sink.appendLog(entry));
  };

  const setStatus = (status: Parameters<PipelineContext['status']>[0]) => {
    publish(ctx.projectId, { type: 'status', data: { status } });
    persist(() => sink.patch({ status }));
  };

  const setProgress = (pct: number, stage: string) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    publish(ctx.projectId, { type: 'progress', data: { progress: clamped, stage } });
    persist(() => sink.patch({ progress: clamped }));
  };

  let currentStage = 'plan';

  // Wrap the context so every stage logs through the persisted channel.
  const stageCtx: PipelineContext = {
    ...ctx,
    log: (level, message) => recordLog(level, currentStage, message),
    status: setStatus,
    progress: setProgress,
  };

  try {
    // ---------------------------------------------------------------- PLAN --
    currentStage = 'plan';
    setStatus('planning');
    setProgress(2, 'plan');
    const plan: Plan = await runPlan(stageCtx);
    publish(ctx.projectId, { type: 'plan', data: plan });
    persist(() => sink.patch({ plan }));
    setProgress(10, 'plan');

    // ------------------------------------------------- RESOLVE + RESEARCH --
    currentStage = 'resolve';
    setStatus('resolving');
    const specs: PartSpec[] = [];
    for (const [i, requested] of plan.parts.entries()) {
      const base = 10 + (i / plan.parts.length) * 35;
      // Optimistic until resolution says otherwise: a library hit needs no
      // research, so most parts never leave the resolve stage.
      setProgress(base, 'resolve');
      const resolved = await resolvePart(stageCtx, requested);
      currentStage = resolved.source === 'library' ? 'resolve' : 'research';
      if (resolved.source === 'research') {
        setStatus('researching');
        currentStage = 'research';
      }
      specs.push(resolved.part);
      setProgress(base + 35 / plan.parts.length, 'research');
    }
    setProgress(45, 'resolve');

    // ------------------------------------------------------------ ASSEMBLE --
    currentStage = 'assemble';
    setStatus('assembling');
    setProgress(48, 'assemble');
    const { assembly, placements } = await runAssemble(stageCtx, plan, specs);
    publish(ctx.projectId, { type: 'assembly', data: { assembly } });
    await sink.patch({
      assembly: assembly.map((a) => {
        const p = placements.get(a.instanceName);
        return p
          ? { ...a, resolvedPosition_mm: p.position }
          : a;
      }),
    });

    // ------------------------------------------- GENERATE + VALIDATE (LLM) --
    const generated: GeneratedPart[] = [];
    for (const [i, item] of assembly.entries()) {
      currentStage = 'generate';
      setStatus('generating');
      const spec = specs.find((s) => s.id === item.partId);
      if (!spec) {
        recordLog('error', 'generate', `no spec for instance ${item.instanceName}`);
        continue;
      }
      setProgress(50 + (i / assembly.length) * 30, 'generate');
      const part = await generatePart(stageCtx, item.instanceName, spec);
      if (part.usedFallback) {
        recordLog('warn', 'generate', `${part.instanceName}: fallback: true (deterministic builder used)`);
      }
      generated.push(part);
      // Each part is validated on its own, so validation is per-part; log it
      // under the validate stage so the UI chips reflect what happened.
      if (part.usedFallback) {
        ctx.log(
          'warn',
          `${item.instanceName}: deterministic fallback validated against the spec`,
        );
      }
    }
    if (generated.length === 0) {
      throw new Error('no parts were generated');
    }
    setProgress(80, 'generate');

    // -------------------------------------------------------------- EXPORT --
    currentStage = 'export';
    setStatus('exporting');
    setProgress(84, 'export');
    const exportResult = await exportAssembly(ctx, generated, placements);
    const artifacts = {
      step: relativeOrNull(exportResult.step_path),
      glb: relativeOrNull(exportResult.glb_path),
      stl: relativeOrNull(exportResult.stl_path),
      fcstd: relativeOrNull(exportResult.fcstd_path),
    };
    publish(ctx.projectId, { type: 'artifacts', data: artifacts });
    await sink.patch({ artifacts });
    for (const [format, rel] of Object.entries(artifacts)) {
      if (rel) {
        recordLog('success', 'export', `${format.toUpperCase()} written: ${rel}`);
      } else {
        recordLog('warn', 'export', `${format.toUpperCase()} not produced`);
      }
    }
    for (const skip of exportResult.skipped) {
      recordLog('warn', 'export', `${skip} export skipped`);
    }
    if (exportResult.assembly_bbox_mm) {
      const b = exportResult.assembly_bbox_mm;
      recordLog('info', 'export', `assembly bbox ${b.x.toFixed(2)} × ${b.y.toFixed(2)} × ${b.z.toFixed(2)} mm`);
    }
    setProgress(92, 'export');

    // --------------------------------------------------------- VERIFY SCALE --
    currentStage = 'verify';
    setStatus('verifying');
    setProgress(94, 'verify');
    const finalBbox =
      exportResult.assembly_bbox_mm ?? assemblyBbox(
        generated.map((g) => ({
          spec: g.spec,
          position: placements.get(g.instanceName)?.position ?? { x: 0, y: 0, z: 0 },
          rotation: placements.get(g.instanceName)?.rotation ?? { x: 0, y: 0, z: 0 },
        })),
      );

    const checks = verifyScaleChecks(
      generated.map((g) => ({
        spec: g.spec,
        position: placements.get(g.instanceName)?.position ?? { x: 0, y: 0, z: 0 },
      })),
      finalBbox,
    );
    for (const check of checks) {
      recordLog(check.ok ? 'info' : 'warn', 'verify', `${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.detail}`);
    }
    await sink.patch({ scaleChecks: checks });

    // The LLM's independent opinion on plausibility, advisory only.
    try {
      const verdict = await ctx.llm.json(
        {
          system: VERIFY_SCALE_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Planned part sizes (mm):\n${generated
                .map(
                  (g) =>
                    `- ${g.instanceName} (${g.spec.name}): ${g.spec.bbox_mm.x} × ${g.spec.bbox_mm.y} × ${g.spec.bbox_mm.z}`,
                )
                .join('\n')}\n\nFinal assembly bounding box: ${finalBbox.x.toFixed(2)} × ${finalBbox.y.toFixed(
                  2,
                )} × ${finalBbox.z.toFixed(2)} mm\n\nIs this physically plausible?`,
            },
          ],
          maxTokens: 1500,
        },
        (raw) => VerifySchema.parse(raw),
        2,
      );
      recordLog(verdict.ok ? 'info' : 'warn', 'verify', `LLM verdict: ${verdict.summary}`);
      for (const warning of verdict.warnings) {
        recordLog('warn', 'verify', `LLM warning: ${warning}`);
      }
      for (const ratio of verdict.ratios) {
        recordLog(
          ratio.plausible ? 'info' : 'warn',
          'verify',
          `${ratio.label}: ${ratio.numerator_mm} / ${ratio.denominator_mm} = ${ratio.ratio.toFixed(4)}`,
        );
      }
    } catch (err) {
      recordLog('warn', 'verify', `LLM scale verdict unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ------------------------------------------------------------- DONE ----
    setProgress(100, 'verify');
    setStatus('complete');
    recordLog('success', 'verify', `pipeline finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    publish(ctx.projectId, { type: 'done', data: { ok: true, elapsedMs: Date.now() - started } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('pipeline failed', { projectId: ctx.projectId, message });
    recordLog('error', currentStage, `pipeline failed: ${message}`);
    setStatus('failed');
    persist(() => sink.patch({ error: message }));
    publish(ctx.projectId, { type: 'error', data: { message } });
  }
}

async function exportAssembly(
  ctx: PipelineContext,
  generated: GeneratedPart[],
  placements: Map<string, { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }>,
): Promise<WorkerExportResponse> {
  // The worker owns its storage layout (STORAGE_ROOT/<project_id>), and it
  // sanitises the id again on its side, so all we pass is the id.
  const items = generated.map((g) => {
    const placement = placements.get(g.instanceName) ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    return {
      instanceName: g.instanceName,
      spec: g.spec,
      position: placement.position,
      rotation: placement.rotation,
      code: g.code,
    };
  });

  const result = await workerExport(ctx.projectId, items);
  if (!result.ok) {
    throw new Error(`export failed: ${result.error ?? 'unknown worker error'}`);
  }
  if (!result.step_path) {
    throw new Error('export produced no STEP file; the STEP is the source of truth and cannot be skipped');
  }
  return result;
}

function relativeOrNull(absolute: string | null): string | null {
  if (!absolute) return null;
  const normalizedRoot = storageRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalized = absolute.replace(/\\/g, '/');
  return normalized.startsWith(normalizedRoot)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}
