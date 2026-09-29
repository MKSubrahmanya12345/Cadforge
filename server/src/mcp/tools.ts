/**
 * MCP (Model Context Protocol) tool surface for CADForge.
 *
 * An agent driving this server gets the same guarantees the web UI does:
 * dimensions always come from a validated PartSpec, every part reports its
 * sources and confidence, and nothing is called "done" until the pipeline
 * actually finished.
 *
 * Authentication is a single bearer token (MCP_API_KEY). CADForge has no user
 * accounts, so there is no per-user ownership to resolve — the key grants
 * access to the whole instance, which is why it is rate limited.
 */

export type McpErrorKind = 'validation' | 'not_found' | 'conflict' | 'refused' | 'upstream';

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  error?: { kind: McpErrorKind; message: string; fields?: Array<{ path: string; message: string }> };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<McpToolResult>;
}

function failed(text: string, kind: McpErrorKind = 'refused'): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    error: { kind, message: text },
  };
}

function ok(text: string, structured?: Record<string, unknown>): McpToolResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

// -----------------------------------------------------------------------------
// Argument helpers
// -----------------------------------------------------------------------------

interface FieldIssue {
  path: string;
  message: string;
}

class ArgReader {
  readonly issues: FieldIssue[] = [];

  constructor(private readonly input: Record<string, unknown>) {}

  str(name: string, opts: { min?: number; max?: number; required?: boolean; pattern?: RegExp } = {}): string | undefined {
    const raw = this.input[name];
    if (raw === undefined || raw === null || raw === '') {
      if (opts.required) this.fail(name, 'is required');
      return undefined;
    }
    if (typeof raw !== 'string') {
      this.fail(name, 'must be a string');
      return undefined;
    }
    const min = opts.min ?? 1;
    const max = opts.max ?? 10_000;
    if (raw.length < min) {
      this.fail(name, `must be at least ${min} character(s)`);
      return undefined;
    }
    if (raw.length > max) {
      this.fail(name, `must be at most ${max} characters`);
      return undefined;
    }
    if (opts.pattern && !opts.pattern.test(raw)) {
      this.fail(name, `must match ${opts.pattern}`);
      return undefined;
    }
    return raw;
  }

  num(name: string, opts: { min?: number; max?: number; required?: boolean; int?: boolean } = {}): number | undefined {
    const raw = this.input[name];
    if (raw === undefined || raw === null || raw === '') {
      if (opts.required) this.fail(name, 'is required');
      return undefined;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      this.fail(name, 'must be a number');
      return undefined;
    }
    if (opts.int && !Number.isInteger(n)) {
      this.fail(name, 'must be a whole number');
      return undefined;
    }
    if (opts.min !== undefined && n < opts.min) {
      this.fail(name, `must be >= ${opts.min}`);
      return undefined;
    }
    if (opts.max !== undefined && n > opts.max) {
      this.fail(name, `must be <= ${opts.max}`);
      return undefined;
    }
    return n;
  }

  bool(name: string, fallback?: boolean): boolean | undefined {
    const raw = this.input[name];
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    this.fail(name, 'must be true or false');
    return undefined;
  }

  strArray(name: string, opts: { max?: number } = {}): string[] {
    const raw = this.input[name];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      this.fail(name, 'must be an array of strings');
      return [];
    }
    const max = opts.max ?? 20;
    if (raw.length > max) {
      this.fail(name, `must have at most ${max} entries`);
      return [];
    }
    const out: string[] = [];
    for (const [i, v] of raw.entries()) {
      if (typeof v !== 'string') {
        this.fail(`${name}[${i}]`, 'must be a string');
        continue;
      }
      out.push(v);
    }
    return out;
  }

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  refuse(headline: string): McpToolResult {
    const lines = this.issues.map((i) => `  - ${i.path} ${i.message}`);
    const message = `${headline}\n${lines.join('\n')}`;
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
      error: { kind: 'validation', message, fields: this.issues },
    };
  }
}

const OBJECT_ID = /^[a-f\d]{24}$/i;

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function dims(d: { x: number; y: number; z: number }): string {
  return `${d.x.toFixed(2)} × ${d.y.toFixed(2)} × ${d.z.toFixed(2)} mm`;
}

function confidenceBadge(c: number): string {
  if (c >= 0.9) return 'HIGH';
  if (c >= 0.7) return 'MEDIUM';
  if (c >= 0.5) return 'LOW';
  return 'VERY LOW';
}

function partSummary(p: {
  id: string;
  name: string;
  category: string;
  bbox_mm: { x: number; y: number; z: number };
  confidence: number;
  verified: boolean;
  features: unknown[];
  anchors: unknown[];
  sources: Array<{ url: string }>;
}): string {
  return [
    `${p.name} (${p.id})`,
    `  category:  ${p.category}`,
    `  size:      ${dims(p.bbox_mm)}`,
    `  features:  ${p.features.length}`,
    `  anchors:   ${p.anchors.length}`,
    `  confidence: ${p.confidence.toFixed(2)} [${confidenceBadge(p.confidence)}]${p.verified ? ' VERIFIED' : ''}`,
    `  sources:   ${p.sources.length}`,
  ].join('\n');
}

function projectSummary(p: {
  _id: string;
  prompt: string;
  status: string;
  progress: number;
  artifacts: Record<string, string | null>;
  error: string | null;
}): string {
  const formats = Object.entries(p.artifacts)
    .filter(([, v]) => v !== null)
    .map(([k]) => k.toUpperCase())
    .join(', ');
  return [
    `project ${p._id}`,
    `  prompt:  ${p.prompt}`,
    `  status:  ${p.status} (${p.progress}%)`,
    `  formats: ${formats === '' ? 'none yet' : formats}`,
    ...(p.error ? [`  error:   ${p.error}`] : []),
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

const createProject: McpTool = {
  name: 'create_cad_project',
  description:
    'Start a CADForge project from a natural-language description ("Arduino Uno with a 5mm LED on pin 13"). ' +
    'Returns immediately with a projectId; the pipeline runs in the background. ' +
    'Follow up with get_cad_project or wait_for_cad_project to see the result. ' +
    'Real dimensions are researched from datasheets — the model will be true-scale, so a 5mm LED is LED-sized next to a 53.34mm-wide board.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        minLength: 3,
        maxLength: 2000,
        description:
          'What to build. Name the parts and any values that matter ("5mm LED", "220 ohm 1/4W resistor", "on pin 13").',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const prompt = r.str('prompt', { min: 3, max: 2000, required: true });
    if (!r.ok) return r.refuse('create_cad_project could not use these arguments.');

    const { createProject: create, startPipelineFor } = await import('./bridge.js');
    const projectId = await create(prompt!);
    await startPipelineFor(projectId);
    return ok(
      `Started project ${projectId}.\n` +
        'The pipeline is running. Use wait_for_cad_project to block until it finishes, ' +
        'or get_cad_project to poll. Events are also streamed at GET /api/projects/<id>/events.',
      { projectId },
    );
  },
};

const getProject: McpTool = {
  name: 'get_cad_project',
  description:
    'Read a project: status, progress, the plan, the resolved assembly with each part\'s world placement, ' +
    'the scale-verification results, the log tail, and which artifact formats were produced.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', pattern: OBJECT_ID.source, description: 'Project id from create_cad_project.' },
      logLimit: { type: 'integer', minimum: 0, maximum: 200, default: 30, description: 'How many recent log lines to include.' },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const projectId = r.str('projectId', { required: true, pattern: OBJECT_ID });
    const logLimit = r.num('logLimit', { min: 0, max: 200, int: true }) ?? 30;
    if (!r.ok) return r.refuse('get_cad_project could not use these arguments.');

    const { readProject } = await import('./bridge.js');
    const doc = await readProject(projectId!);
    if (!doc) return failed(`No project with id ${projectId}.`, 'not_found');

    const logs = doc.logs.slice(-logLimit);
    const checks = doc.scaleChecks ?? [];
    const lines = [
      projectSummary(doc),
      doc.plan
        ? `  plan:     ${doc.plan.parts.map((p) => `${p.quantity}x ${p.name}`).join(', ')}`
        : '  plan:     (not planned yet)',
      `  assembly:  ${doc.assembly.length} instance(s)`,
    ];
    for (const item of doc.assembly) {
      const pos = item.resolvedPosition_mm ?? { x: 0, y: 0, z: 0 };
      lines.push(
        `    - ${item.instanceName} (${item.partId}) at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) mm`,
      );
    }
    if (checks.length > 0) {
      lines.push('  scale checks:');
      for (const c of checks) {
        lines.push(`    ${c.ok ? 'OK  ' : 'FAIL'} ${c.label}: ${c.detail}`);
      }
    }
    if (logs.length > 0) {
      lines.push('  recent log:');
      for (const l of logs) {
        lines.push(`    [${l.level}] ${l.stage}: ${l.message}`);
      }
    }

    return ok(lines.join('\n'), {
      projectId: doc._id,
      status: doc.status,
      progress: doc.progress,
      prompt: doc.prompt,
      plan: doc.plan,
      assembly: doc.assembly,
      scaleChecks: checks,
      artifacts: doc.artifacts,
      logs,
      error: doc.error,
      createdAt: doc.createdAt,
    });
  },
};

const waitForProject: McpTool = {
  name: 'wait_for_cad_project',
  description:
    'Block until a project reaches "complete" or "failed", then return the same payload as get_cad_project. ' +
    'Use this after create_cad_project instead of polling, so you do not burn turns on status checks. ' +
    'Times out cleanly rather than hanging: increase timeoutSeconds for a first run, which researches the web.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', pattern: OBJECT_ID.source },
      timeoutSeconds: { type: 'integer', minimum: 5, maximum: 600, default: 300 },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const projectId = r.str('projectId', { required: true, pattern: OBJECT_ID });
    const timeoutSeconds = r.num('timeoutSeconds', { min: 5, max: 600, int: true }) ?? 300;
    if (!r.ok) return r.refuse('wait_for_cad_project could not use these arguments.');

    const { readProject, waitForCompletion } = await import('./bridge.js');
    const outcome = await waitForCompletion(projectId!, timeoutSeconds * 1000);
    if (outcome.timedOut) {
      const current = await readProject(projectId!);
      return failed(
        `Still ${current?.status ?? 'unknown'} after ${timeoutSeconds}s (progress ${current?.progress ?? 0}%). ` +
          'Call wait_for_cad_project again with a larger timeoutSeconds, or get_cad_project to inspect the log.',
        'upstream',
      );
    }
    if (outcome.status === 'failed') {
      const doc = await readProject(projectId!);
      return failed(
        `Project ${projectId} failed: ${doc?.error ?? 'unknown error'}\n` +
          (doc?.logs.slice(-10).map((l) => `  [${l.level}] ${l.stage}: ${l.message}`).join('\n') ?? ''),
        'upstream',
      );
    }

    const doc = await readProject(projectId!);
    if (!doc) return failed(`No project with id ${projectId}.`, 'not_found');
    const formats = Object.entries(doc.artifacts)
      .filter(([, v]) => v !== null)
      .map(([k]) => k.toUpperCase())
      .join(', ');
    const fallbackNote = doc.logs.some((l) => l.message.includes('fallback: true'))
      ? '\n  NOTE: at least one part used the deterministic fallback builder. The dimensions are still spec-exact, but the geometry is simpler than the LLM\'s.'
      : '';
    return ok(
      `Project ${projectId} complete.\n${projectSummary(doc)}\n  formats: ${formats}${fallbackNote}`,
      {
        projectId: doc._id,
        status: doc.status,
        artifacts: doc.artifacts,
        assembly: doc.assembly,
        scaleChecks: doc.scaleChecks ?? [],
        logs: doc.logs.slice(-20),
      },
    );
  },
};

const listProjects: McpTool = {
  name: 'list_cad_projects',
  description: 'List recent projects, newest first, with status, progress, and available artifact formats.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const limit = r.num('limit', { min: 1, max: 100, int: true }) ?? 20;
    if (!r.ok) return r.refuse('list_cad_projects could not use these arguments.');

    const { listRecent } = await import('./bridge.js');
    const docs = await listRecent(limit!);
    if (docs.length === 0) return ok('No projects yet.');
    return ok(
      docs.map((d) => projectSummary(d)).join('\n\n'),
      { projects: docs },
    );
  },
};

const getArtifacts: McpTool = {
  name: 'get_cad_artifacts',
  description:
    'List the export formats available for a project and the URLs to download them. ' +
    'STEP is the source of truth and is always present on success. GLB is metres and Y-up for web viewers; ' +
    'STL and STEP are millimetres and Z-up. FCStd only exists if FreeCAD was on the worker\'s PATH.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', pattern: OBJECT_ID.source },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const projectId = r.str('projectId', { required: true, pattern: OBJECT_ID });
    if (!r.ok) return r.refuse('get_cad_artifacts could not use these arguments.');

    const { readProject, artifactUrls } = await import('./bridge.js');
    const doc = await readProject(projectId!);
    if (!doc) return failed(`No project with id ${projectId}.`, 'not_found');

    const urls = artifactUrls(doc);
    const available = Object.entries(urls).filter(([, v]) => v !== null);
    if (available.length === 0) {
      return failed(
        `No artifacts yet. Project status is "${doc.status}" (${doc.progress}%). Wait for it to complete.`,
        'upstream',
      );
    }

    const lines = available.map(([format, url]) => `  ${format.toUpperCase().padEnd(6)} ${url}`);
    const missing = Object.keys(urls).filter((k) => urls[k as keyof typeof urls] === null);
    if (missing.length > 0) {
      lines.push(`  (not produced: ${missing.join(', ')})`);
    }
    return ok(
      `Artifacts for project ${projectId}:\n${lines.join('\n')}\n\n` +
        'Units: STEP and STL are millimetres, Z-up, origin at the lower-left of the base part. ' +
        'GLB is metres, Y-up, ready for a web viewer.',
      { projectId, artifacts: urls },
    );
  },
};

const listParts: McpTool = {
  name: 'list_parts',
  description:
    'Search the CADForge parts library. Every entry is a validated PartSpec with real datasheet dimensions, ' +
    'a confidence score, and source URLs. Use this before researching anything: if the part is here, ' +
    'the pipeline will use it verbatim and never invent a dimension.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', maxLength: 120, description: 'Free-text search over name and aliases.' },
      category: {
        type: 'string',
        description: 'Filter by category.',
        enum: [
          'board', 'led', 'resistor', 'capacitor', 'header', 'connector', 'module',
          'sensor', 'actuator', 'mechanical', 'fastener', 'wire', 'display', 'ic', 'other',
        ],
      },
      verified: { type: 'boolean', description: 'true = curated only, false = researched only.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const q = r.str('q', { max: 120 });
    const category = r.str('category', {
      max: 40,
      pattern:
        /^(board|led|resistor|capacitor|header|connector|module|sensor|actuator|mechanical|fastener|wire|display|ic|other)$/,
    });
    const verified = r.bool('verified');
    const limit = r.num('limit', { min: 1, max: 200, int: true }) ?? 50;
    if (!r.ok) return r.refuse('list_parts could not use these arguments.');

    const { searchLibrary } = await import('./bridge.js');
    const parts = await searchLibrary({
      ...(q ? { q } : {}),
      ...(category ? { category } : {}),
      ...(verified !== undefined ? { verified } : {}),
      limit: limit!,
    });
    if (parts.length === 0) {
      return ok(
        'No parts matched. If the part is genuinely not in the library, the RESEARCH stage will ' +
          'look it up from datasheets automatically when you create a project.',
      );
    }
    return ok(parts.map((p) => partSummary(p)).join('\n\n'), { count: parts.length, parts });
  },
};

const getPart: McpTool = {
  name: 'get_part',
  description:
    'Read one PartSpec in full: exact bounding box, every feature with its position and dimensions, every ' +
    'attachment anchor, the source URLs each field came from, and the confidence score. ' +
    'This is what makes a CADForge model auditable — check a dimension here and you have checked the model.',
  inputSchema: {
    type: 'object',
    properties: {
      idOrName: { type: 'string', maxLength: 200, description: 'Part id (e.g. "led-5mm") or its name.' },
    },
    required: ['idOrName'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const idOrName = r.str('idOrName', { required: true, max: 200 });
    if (!r.ok) return r.refuse('get_part could not use these arguments.');

    const { findPartSpec } = await import('./bridge.js');
    const found = await findPartSpec(idOrName!);
    if (!found) return failed(`No part matching "${idOrName}".`, 'not_found');
    const part = found.part;

    const lines = [
      partSummary(part),
      '  features:',
      ...part.features.map(
        (f) =>
          `    - ${f.type} "${f.name}" at (${f.position_mm.x}, ${f.position_mm.y}, ${f.position_mm.z}) mm ` +
          `dims ${JSON.stringify(f.dims_mm)}${f.note ? ` // ${f.note}` : ''}`,
      ),
      '  anchors:',
      ...part.anchors.map(
        (a) =>
          `    - ${a.name} at (${a.position_mm.x}, ${a.position_mm.y}, ${a.position_mm.z}) mm` +
          (a.normal ? ` normal (${a.normal.x}, ${a.normal.y}, ${a.normal.z})` : ''),
      ),
      '  sources:',
      ...part.sources.flatMap((s) => [
        `    - ${s.title}`,
        `      ${s.url}`,
        ...s.extracted_fields.map(
          (f) => `        ${f.field} = ${f.value}${f.conflict ? ` [CONFLICT: ${f.conflict}]` : ''}`,
        ),
      ]),
      ...(part.notes ? [`  notes: ${part.notes}`] : []),
    ];
    return ok(lines.join('\n'), { part });
  },
};

const verifyPart: McpTool = {
  name: 'verify_part',
  description:
    'Mark a PartSpec as human-verified, which stops the pipeline from ever re-researching it. ' +
    'Use after you have checked a researched entry against its datasheet. Verified parts also drop the ' +
    'confidence warning in the UI.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 200 },
      verified: { type: 'boolean', default: true },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const id = r.str('id', { required: true, max: 200 });
    const verified = r.bool('verified', true) ?? true;
    if (!r.ok) return r.refuse('verify_part could not use these arguments.');

    const { setPartVerified } = await import('./bridge.js');
    const part = await setPartVerified(id!, verified);
    if (!part) return failed(`No part with id ${id}.`, 'not_found');
    return ok(
      `${part.name} (${part.id}) is now ${part.verified ? 'VERIFIED' : 'unverified'}.`,
      { part },
    );
  },
};

const deletePart: McpTool = {
  name: 'delete_part',
  description: 'Delete a PartSpec from the library. Existing projects keep their exported files.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', maxLength: 200 } },
    required: ['id'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const id = r.str('id', { required: true, max: 200 });
    if (!r.ok) return r.refuse('delete_part could not use these arguments.');
    const { removePart } = await import('./bridge.js');
    const okDeleted = await removePart(id!);
    if (!okDeleted) return failed(`No part with id ${id}.`, 'not_found');
    return ok(`Deleted part ${id}.`);
  },
};

const deleteProject: McpTool = {
  name: 'delete_cad_project',
  description:
    'Delete a project record. Files already written under the storage directory are left in place. ' +
    'Requires confirmProjectId to match, so a mistyped id cannot delete the wrong thing.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', pattern: OBJECT_ID.source },
      confirmProjectId: { type: 'string', pattern: OBJECT_ID.source, description: 'Must equal projectId.' },
    },
    required: ['projectId', 'confirmProjectId'],
    additionalProperties: false,
  },
  async run(input) {
    const r = new ArgReader(input);
    const projectId = r.str('projectId', { required: true, pattern: OBJECT_ID });
    const confirm = r.str('confirmProjectId', { required: true, pattern: OBJECT_ID });
    if (!r.ok) return r.refuse('delete_cad_project could not use these arguments.');
    if (projectId !== confirm) {
      return failed(
        `confirmProjectId ("${confirm}") does not match projectId ("${projectId}"). Nothing was deleted.`,
        'validation',
      );
    }
    const { removeProject } = await import('./bridge.js');
    const okDeleted = await removeProject(projectId!);
    if (!okDeleted) return failed(`No project with id ${projectId}.`, 'not_found');
    return ok(`Deleted project ${projectId}.`);
  },
};

const health: McpTool = {
  name: 'cadforge_health',
  description:
    'Check that the whole chain is up: MongoDB, the CadQuery worker (with its CadQuery version and ' +
    'whether FreeCAD/FCStd export is available), the Anthropic key, and the Tavily key. ' +
    'Call this first if a project fails, so you can tell a pipeline bug from a missing service.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run() {
    const { healthSnapshot } = await import('./bridge.js');
    const h = await healthSnapshot();
    const lines = [
      `status:     ${h.status}`,
      `mongo:      ${h.mongo.ok ? 'ok' : `FAILED — ${h.mongo.error}`}`,
      `cad-worker: ${h.cadWorker.ok ? `ok (CadQuery ${h.cadWorker.cadquery_version}, FCStd ${h.cadWorker.freecad ? 'available' : 'unavailable'})` : `UNREACHABLE — ${h.cadWorker.error}`}`,
      `  url:      ${h.cadWorker.url}`,
      `llm:        ${h.llm.ok ? `ok (${h.llm.model})` : 'MISSING ANTHROPIC_API_KEY'}`,
      `search:     ${h.search.ok ? 'ok (tavily)' : 'MISSING TAVILY_API_KEY'}`,
      `uptime:     ${h.uptime_s}s`,
    ];
    return ok(lines.join('\n'), h as unknown as Record<string, unknown>);
  },
};

export const MCP_TOOLS: readonly McpTool[] = [
  createProject,
  getProject,
  waitForProject,
  listProjects,
  getArtifacts,
  listParts,
  getPart,
  verifyPart,
  deletePart,
  deleteProject,
  health,
];

/** The write tools, kept separate so the rate limiter can weight them. */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_cad_project',
  'verify_part',
  'delete_part',
  'delete_cad_project',
]);

export function getMcpTool(name: string): McpTool | null {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}
