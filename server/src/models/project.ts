import type { AssemblyItem, Artifacts, LogEntry, Plan, ProjectStatus } from '@cadforge/shared';
import mongoose, { Schema } from 'mongoose';

export interface ScaleCheckDoc {
  label: string;
  expected: number;
  actual: number;
  ok: boolean;
  detail: string;
}

export interface ProjectDoc {
  _id: mongoose.Types.ObjectId;
  prompt: string;
  status: ProjectStatus;
  plan: Plan | null;
  assembly: AssemblyItem[];
  artifacts: Artifacts;
  logs: LogEntry[];
  scaleChecks: ScaleCheckDoc[];
  progress: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const Vec3Schema = {
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  z: { type: Number, default: 0 },
};

const PlacementSchema = new Schema(
  {
    anchorRef: {
      targetInstance: { type: String },
      anchorName: { type: String },
    },
    offset_mm: { type: Vec3Schema, default: () => ({ x: 0, y: 0, z: 0 }) },
    rotation_deg: { type: Vec3Schema, default: () => ({ x: 0, y: 0, z: 0 }) },
  },
  { _id: false },
);

const AssemblyItemSchema = new Schema(
  {
    partId: { type: String, required: true },
    instanceName: { type: String, required: true },
    placement: { type: PlacementSchema, required: true, default: () => ({}) },
    quantity_note: String,
    resolvedPosition_mm: { type: Vec3Schema, default: () => ({ x: 0, y: 0, z: 0 }) },
  },
  { _id: false },
);

const LogSchema = new Schema(
  {
    ts: { type: String, required: true },
    stage: { type: String, required: true },
    level: { type: String, enum: ['info', 'warn', 'error', 'success'], required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const PlanSchema = new Schema(
  {
    parts: {
      type: [
        new Schema(
          { name: String, quantity: Number, role: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    relations: {
      type: [
        new Schema({ a: String, b: String, description: String }, { _id: false }),
      ],
      default: [],
    },
  },
  { _id: false },
);

const ArtifactsSchema = new Schema(
  {
    step: { type: String, default: null },
    glb: { type: String, default: null },
    stl: { type: String, default: null },
    fcstd: { type: String, default: null },
  },
  { _id: false },
);

const ScaleCheckSchema = new Schema(
  {
    label: { type: String, required: true },
    expected: { type: Number, required: true },
    actual: { type: Number, required: true },
    ok: { type: Boolean, required: true },
    detail: { type: String, required: true },
  },
  { _id: false },
);

const ProjectSchemaM = new Schema<ProjectDoc>(
  {
    prompt: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'queued', 'planning', 'resolving', 'researching', 'assembling',
        'generating', 'validating', 'exporting', 'verifying', 'complete', 'failed',
      ],
      default: 'queued',
      index: true,
    },
    plan: { type: PlanSchema, default: null },
    assembly: { type: [AssemblyItemSchema], default: [] },
    artifacts: { type: ArtifactsSchema, default: () => ({}) },
    logs: { type: [LogSchema], default: [] },
    scaleChecks: { type: [ScaleCheckSchema], default: [] },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

export const ProjectModel =
  (mongoose.models['Project'] as mongoose.Model<ProjectDoc> | undefined) ??
  mongoose.model<ProjectDoc>('Project', ProjectSchemaM);

export async function createProject(prompt: string): Promise<ProjectDoc> {
  const doc = await ProjectModel.create({ prompt, status: 'queued' });
  return doc;
}

export async function getProject(id: string): Promise<ProjectDoc | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return ProjectModel.findById(id).lean<ProjectDoc>().exec();
}

export async function listProjects(limit = 50): Promise<ProjectDoc[]> {
  return ProjectModel.find({}).sort({ createdAt: -1 }).limit(limit).lean<ProjectDoc[]>().exec();
}

export async function updateProject(id: string, patch: Partial<ProjectDoc>): Promise<void> {
  await ProjectModel.updateOne({ _id: id }, { $set: patch }).exec();
}

export async function appendLog(
  id: string,
  entry: LogEntry,
): Promise<void> {
  await ProjectModel.updateOne({ _id: id }, { $push: { logs: entry } }).exec();
}

export async function deleteProject(id: string): Promise<boolean> {
  const res = await ProjectModel.deleteOne({ _id: id }).exec();
  return res.deletedCount > 0;
}
