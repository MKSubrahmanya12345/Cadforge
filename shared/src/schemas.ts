import { z } from 'zod';

const finite = z.number().finite();

export const Vec3Schema = z.object({
  x: finite,
  y: finite,
  z: finite,
});

export const BboxSchema = z.object({
  x: finite.positive(),
  y: finite.positive(),
  z: finite.positive(),
});
export type Bbox = z.infer<typeof BboxSchema>;

/** 2D footprint coordinates in millimetres, measured from the part's XY origin. */
export const ProfilePointSchema = z.object({
  x: finite,
  y: finite,
});
export type ProfilePoint = z.infer<typeof ProfilePointSchema>;

/**
 * dims_mm is intentionally open (a dict of named millimetre dimensions) so a
 * spec can carry `diameter`, `pitch`, `width`, ... without the schema knowing
 * the part type. The feature `type` decides which keys are meaningful, and
 * `requiredDimsForFeature` below documents/enforces the minimum set.
 */
export const FeatureDimsSchema = z.record(finite);

export const FEATURE_TYPES = ['hole', 'cylinder', 'box', 'rounded_box', 'pin', 'pad', 'cutout'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const FeatureSchema = z.object({
  type: z.enum(FEATURE_TYPES),
  name: z.string().min(1).max(120),
  position_mm: Vec3Schema,
  dims_mm: FeatureDimsSchema,
  note: z.string().max(400).optional(),
});

export type Feature = z.infer<typeof FeatureSchema>;

export const AnchorSchema = z.object({
  name: z.string().min(1).max(80),
  position_mm: Vec3Schema,
  normal: Vec3Schema.optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const SourceFieldSchema = z.object({
  field: z.string().min(1),
  value: z.string().min(1),
  source_url: z.string().url().optional(),
  conflict: z.string().max(400).optional(),
});

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(300),
  extracted_fields: z.array(SourceFieldSchema).default([]),
});
export type Source = z.infer<typeof SourceSchema>;

export const PartCategorySchema = z.enum([
  'board',
  'led',
  'resistor',
  'capacitor',
  'header',
  'connector',
  'module',
  'sensor',
  'actuator',
  'mechanical',
  'fastener',
  'wire',
  'display',
  'ic',
  'other',
]);
export type PartCategory = z.infer<typeof PartCategorySchema>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const PartSpecSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  category: PartCategorySchema,
  aliases: z.array(z.string().min(1).max(200)).default([]),
  bbox_mm: BboxSchema,
  /** Thickness of the primary/base body when bbox_mm includes components mounted above it. */
  base_thickness_mm: finite.positive().optional(),
  /** Optional exact 2D base footprint. When omitted, the base is a rectangle matching bbox_mm.x/y. */
  profile_mm: z.array(ProfilePointSchema).min(3).optional(),
  features: z.array(FeatureSchema).default([]),
  anchors: z.array(AnchorSchema).default([]),
  pitch_mm: finite.positive().optional(),
  material: z.string().max(80).optional(),
  color_hex: z.string().regex(HEX_COLOR).optional(),
  sources: z.array(SourceSchema).default([]),
  confidence: finite.min(0).max(1),
  verified: z.boolean().default(false),
  /** Provenance: seeded library, cached web research, or human confirmed. */
  origin: z.enum(['seed', 'research', 'human']).default('research'),
  notes: z.string().max(2000).optional(),
});

export type PartSpec = z.infer<typeof PartSpecSchema>;

// -----------------------------------------------------------------------------
// Project / assembly
// -----------------------------------------------------------------------------

export const AnchorRefSchema = z.object({
  targetInstance: z.string().min(1).max(200),
  anchorName: z.string().min(1).max(80),
});
export type AnchorRef = z.infer<typeof AnchorRefSchema>;

export const PlacementSchema = z.object({
  anchorRef: AnchorRefSchema.optional(),
  offset_mm: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
  rotation_deg: Vec3Schema.default({ x: 0, y: 0, z: 0 }),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const AssemblyItemSchema = z.object({
  partId: z.string().min(1).max(200),
  instanceName: z.string().min(1).max(200),
  /** A part with no explicit placement lands at the world origin, unrotated. */
  placement: PlacementSchema.default({ offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } }),
  quantity_note: z.string().max(200).optional(),
  /** Filled in by the orchestrator once anchors resolve to world coordinates. */
  resolvedPosition_mm: Vec3Schema.optional(),
});
export type AssemblyItem = z.infer<typeof AssemblyItemSchema>;

export const PROJECT_STATUS_SCHEMA = z.enum([
  'queued',
  'planning',
  'resolving',
  'researching',
  'assembling',
  'generating',
  'validating',
  'exporting',
  'verifying',
  'complete',
  'failed',
]);
export const PROJECT_STATUSES = PROJECT_STATUS_SCHEMA.options;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PlanRelationSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  description: z.string().min(1).max(500),
});

export const PlanPartSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(50).default(1),
  role: z.string().max(300).default(''),
});

export const PlanSchema = z.object({
  parts: z.array(PlanPartSchema).min(1).max(24),
  relations: z.array(PlanRelationSchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanPart = z.infer<typeof PlanPartSchema>;
export type PlanRelation = z.infer<typeof PlanRelationSchema>;

export const ArtifactsSchema = z.object({
  step: z.string().nullable().default(null),
  glb: z.string().nullable().default(null),
  stl: z.string().nullable().default(null),
  fcstd: z.string().nullable().default(null),
});
export type Artifacts = z.infer<typeof ArtifactsSchema>;

export const LogEntrySchema = z.object({
  ts: z.string(),
  stage: z.string(),
  level: z.enum(['info', 'warn', 'error', 'success']),
  message: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const ProjectSchema = z.object({
  _id: z.string(),
  prompt: z.string(),
  status: PROJECT_STATUS_SCHEMA,
  plan: PlanSchema.nullable(),
  assembly: z.array(AssemblyItemSchema).default([]),
  artifacts: ArtifactsSchema,
  logs: z.array(LogEntrySchema).default([]),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// -----------------------------------------------------------------------------
// cad-worker HTTP contracts (server <-> cad-worker)
// -----------------------------------------------------------------------------

export const WorkerPartRequestSchema = z.object({
  instance_name: z.string().min(1).max(200),
  part_id: z.string().min(1).max(200),
  code: z.string().min(1).max(400000),
  spec: PartSpecSchema,
});

export const WorkerGenerateRequestSchema = z.object({
  parts: z.array(WorkerPartRequestSchema).min(1).max(48),
});

export const MeasuredFeatureSchema = z.object({
  name: z.string(),
  type: z.string(),
  position_mm: Vec3Schema,
  diameter_mm: finite.nullable().default(null),
  depth_mm: finite.nullable().default(null),
  matched: z.boolean(),
  delta_mm: finite.nullable().default(null),
});

export const BboxComparisonSchema = z.object({
  expected: BboxSchema,
  actual: BboxSchema,
  delta_mm: Vec3Schema,
  ok: z.boolean(),
  /** Which axis failed and the allowed tolerance in mm. */
  failing_axes: z.array(z.enum(['x', 'y', 'z'])),
});

export const WorkerGenerateResponseSchema = z.object({
  ok: z.boolean(),
  instance_name: z.string(),
  /** True when the deterministic builder was used instead of LLM code. */
  fallback: z.boolean(),
  valid: z.boolean(),
  attempts: z.number().int().min(1),
  bbox: BboxComparisonSchema.nullable(),
  features: z.array(MeasuredFeatureSchema),
  /** Populated when the generated code raised. */
  error: z.string().nullable().default(null),
  glb_path: z.string().nullable().default(null),
  stl_path: z.string().nullable().default(null),
  step_path: z.string().nullable().default(null),
});
export type WorkerGenerateResponse = z.infer<typeof WorkerGenerateResponseSchema>;

export const WorkerItemSchema = z.object({
  instance_name: z.string().min(1).max(200),
  part_id: z.string().min(1).max(200),
  spec: PartSpecSchema,
  position_mm: Vec3Schema,
  rotation_deg: Vec3Schema,
  color_hex: z.string().regex(HEX_COLOR).optional(),
});

export const WorkerExportRequestSchema = z.object({
  project_id: z.string().min(1).max(200),
  items: z.array(WorkerItemSchema).min(1).max(48),
});

export const WorkerExportResponseSchema = z.object({
  ok: z.boolean(),
  step_path: z.string().nullable().default(null),
  glb_path: z.string().nullable().default(null),
  stl_path: z.string().nullable().default(null),
  fcstd_path: z.string().nullable().default(null),
  per_part: z
    .array(
      z.object({
        instance_name: z.string(),
        step_path: z.string().nullable().default(null),
        glb_path: z.string().nullable().default(null),
      }),
    )
    .default([]),
  assembly_bbox_mm: BboxSchema.nullable().default(null),
  skipped: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});
export type WorkerExportResponse = z.infer<typeof WorkerExportResponseSchema>;

export const WorkerHealthSchema = z.object({
  ok: z.boolean(),
  cadquery_version: z.string(),
  freecad: z.boolean(),
  version: z.string(),
});
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

/** LLM codegen output envelope. */
export const CodegenResponseSchema = z.object({
  code: z.string().min(1),
  parameters: z.record(finite).default({}),
  notes: z.string().max(2000).default(''),
});
export type CodegenResponse = z.infer<typeof CodegenResponseSchema>;
