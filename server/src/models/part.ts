import type { PartSpec } from '@cadforge/shared';
import { PartSpecSchema } from '@cadforge/shared';
import mongoose, { Schema } from 'mongoose';

export interface PartDoc {
  _id: string;
  id: string;
  name: string;
  category: string;
  aliases: string[];
  bbox_mm: { x: number; y: number; z: number };
  base_thickness_mm?: number;
  features: PartSpec['features'];
  anchors: PartSpec['anchors'];
  pitch_mm?: number;
  material?: string;
  color_hex?: string;
  sources: PartSpec['sources'];
  confidence: number;
  verified: boolean;
  origin: 'seed' | 'research' | 'human';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FeatureSchema = new Schema(
  {
    type: { type: String, required: true },
    name: { type: String, required: true },
    position_mm: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      z: { type: Number, required: true },
    },
    dims_mm: { type: Map, of: Number, default: {} },
    note: String,
  },
  { _id: false },
);

const AnchorSchema = new Schema(
  {
    name: { type: String, required: true },
    position_mm: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      z: { type: Number, required: true },
    },
    normal: {
      x: { type: Number },
      y: { type: Number },
      z: { type: Number },
    },
  },
  { _id: false },
);

const SourceFieldSchema = new Schema(
  {
    field: { type: String, required: true },
    value: { type: String, required: true },
    source_url: String,
    conflict: String,
  },
  { _id: false },
);

const SourceSchema = new Schema(
  {
    url: { type: String, required: true },
    title: { type: String, required: true },
    extracted_fields: { type: [SourceFieldSchema], default: [] },
  },
  { _id: false },
);

const PartSpecSchemaM = new Schema<PartDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    aliases: { type: [String], default: [] },
    bbox_mm: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      z: { type: Number, required: true },
    },
    base_thickness_mm: Number,
    features: { type: [FeatureSchema], default: [] },
    anchors: { type: [AnchorSchema], default: [] },
    pitch_mm: Number,
    material: String,
    color_hex: String,
    sources: { type: [SourceSchema], default: [] },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    verified: { type: Boolean, default: false, index: true },
    origin: { type: String, enum: ['seed', 'research', 'human'], default: 'research' },
    notes: String,
  },
  { timestamps: true, versionKey: false },
);

PartSpecSchemaM.index({ name: 'text', aliases: 'text' });

export const PartModel =
  (mongoose.models['PartSpec'] as mongoose.Model<PartDoc> | undefined) ??
  mongoose.model<PartDoc>('PartSpec', PartSpecSchemaM);

/** Mongoose docs store `dims_mm` as a Map; convert to a plain record. */
function normalizeDoc(doc: PartDoc): PartSpec {
  const features = doc.features.map((f) => ({
    type: f.type,
    name: f.name,
    position_mm: f.position_mm,
    dims_mm: f.dims_mm instanceof Map ? Object.fromEntries(f.dims_mm) : (f.dims_mm as Record<string, number>),
    ...(f.note ? { note: f.note } : {}),
  }));
  return PartSpecSchema.parse({
    id: doc.id,
    name: doc.name,
    category: doc.category,
    aliases: doc.aliases,
    bbox_mm: doc.bbox_mm,
    ...(doc.base_thickness_mm !== undefined ? { base_thickness_mm: doc.base_thickness_mm } : {}),
    features,
    anchors: doc.anchors.map((a) => ({
      name: a.name,
      position_mm: a.position_mm,
      ...(a.normal ? { normal: a.normal } : {}),
    })),
    ...(doc.pitch_mm !== undefined ? { pitch_mm: doc.pitch_mm } : {}),
    ...(doc.material ? { material: doc.material } : {}),
    ...(doc.color_hex ? { color_hex: doc.color_hex } : {}),
    sources: doc.sources.map((s) => ({
      url: s.url,
      title: s.title,
      extracted_fields: s.extracted_fields.map((f) => ({
        field: f.field,
        value: f.value,
        ...(f.source_url ? { source_url: f.source_url } : {}),
        ...(f.conflict ? { conflict: f.conflict } : {}),
      })),
    })),
    confidence: doc.confidence,
    verified: doc.verified,
    origin: doc.origin,
    ...(doc.notes ? { notes: doc.notes } : {}),
  });
}

export async function upsertPart(spec: PartSpec, opts?: { markVerified?: boolean }): Promise<void> {
  const data = { ...spec, ...(opts?.markVerified ? { verified: true } : {}) };
  await PartModel.updateOne({ id: data.id }, { $set: data }, { upsert: true }).exec();
}

export async function findPartById(id: string): Promise<PartSpec | null> {
  const doc = await PartModel.findOne({ id }).lean<PartDoc>().exec();
  return doc ? normalizeDoc(doc) : null;
}

export async function listParts(filter?: {
  category?: string;
  verified?: boolean;
  q?: string;
}): Promise<PartSpec[]> {
  const query: Record<string, unknown> = { id: { $ne: '__seed_meta__' } };
  if (filter?.category) query['category'] = filter.category;
  if (filter?.verified !== undefined) query['verified'] = filter.verified;
  if (filter?.q) {
    // $text is the right index, but Atlas free tier needs it enabled; the
    // regex fallback keeps search working if the index was never built.
    try {
      const docs = await PartModel.find({ ...query, $text: { $search: filter.q } })
        .sort({ name: 1 })
        .limit(500)
        .lean<PartDoc[]>()
        .exec();
      return docs.map(normalizeDoc);
    } catch {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const docs = await PartModel.find({
        ...query,
        $or: [{ name: { $regex: escaped, $options: 'i' } }, { aliases: { $regex: escaped, $options: 'i' } }],
      })
        .sort({ name: 1 })
        .limit(500)
        .lean<PartDoc[]>()
        .exec();
      return docs.map(normalizeDoc);
    }
  }
  const docs = await PartModel.find(query).sort({ name: 1 }).limit(500).lean<PartDoc[]>().exec();
  return docs.map(normalizeDoc);
}

export async function getLibrary(limit = 500): Promise<PartSpec[]> {
  const docs = await PartModel.find({ id: { $ne: '__seed_meta__' } })
    .sort({ verified: -1, name: 1 })
    .limit(limit)
    .lean<PartDoc[]>()
    .exec();
  return docs.map(normalizeDoc);
}

/** Name of a part by id, or null. Used for the base-part heuristic. */
export async function findPartNameById(id: string): Promise<string | null> {
  const doc = await PartModel.findOne({ id }).lean<{ name: string }>().exec();
  return doc?.name ?? null;
}

export async function setVerified(id: string, verified: boolean): Promise<PartSpec | null> {
  const doc = await PartModel.findOneAndUpdate(
    { id },
    { $set: { verified, origin: verified ? 'human' : 'research' } },
    { new: true },
  )
    .lean<PartDoc>()
    .exec();
  return doc ? normalizeDoc(doc) : null;
}

export async function deletePart(id: string): Promise<boolean> {
  const res = await PartModel.deleteOne({ id }).exec();
  return res.deletedCount > 0;
}
