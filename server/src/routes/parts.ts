import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PartCategorySchema, validateSpecGeometry } from '@cadforge/shared';
import { asyncRoute, notFound } from '../middleware/error.js';
import {
  deletePart,
  findPartById,
  listParts,
  setVerified,
  upsertPart,
} from '../models/part.js';

export const partsRouter: Router = Router();

const QuerySchema = z.object({
  category: PartCategorySchema.optional(),
  verified: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const VerifyBodySchema = z.object({
  verified: z.boolean().default(true),
});

// GET /parts
partsRouter.get(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const query = QuerySchema.parse(req.query);
    const parts = await listParts({
      ...(query.category ? { category: query.category } : {}),
      ...(query.verified !== undefined ? { verified: query.verified } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
    res.json(parts.slice(0, query.limit));
  }),
);

// GET /parts/:id
partsRouter.get(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const id = z.string().min(1).max(200).parse(req.params['id']);
    const part = await findPartById(id);
    if (!part) throw notFound(`No part with id ${id}`);
    // Surface sanity issues so the UI can warn about a hand-edited spec.
    const issues = validateSpecGeometry(part);
    res.json({ ...part, issues });
  }),
);

// POST /parts  (create or update a spec by hand)
const UpsertBodySchema = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  category: PartCategorySchema.default('other'),
  aliases: z.array(z.string()).default([]),
  bbox_mm: z.object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() }),
  features: z.unknown().default([]),
  anchors: z.unknown().default([]),
  pitch_mm: z.number().positive().optional(),
  material: z.string().max(80).optional(),
  color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sources: z.unknown().default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  verified: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

partsRouter.post(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const body = UpsertBodySchema.parse(req.body);
    const id = body.id ?? slugify(body.name);
    const spec = {
      id,
      name: body.name,
      category: body.category,
      aliases: body.aliases,
      bbox_mm: body.bbox_mm,
      features: body.features,
      anchors: body.anchors,
      pitch_mm: body.pitch_mm,
      material: body.material,
      color_hex: body.color_hex,
      sources: body.sources,
      confidence: body.confidence,
      verified: body.verified,
      origin: body.verified ? ('human' as const) : ('research' as const),
      notes: body.notes,
    };
    const { PartSpecSchema, assertValidSpec } = await import('@cadforge/shared');
    const parsed = assertValidSpec(PartSpecSchema.parse(spec));
    await upsertPart(parsed);
    res.status(201).json(parsed);
  }),
);

// POST /parts/:id/verify
partsRouter.post(
  '/:id/verify',
  asyncRoute(async (req: Request, res: Response) => {
    const id = z.string().min(1).max(200).parse(req.params['id']);
    const body = VerifyBodySchema.parse(req.body ?? {});
    const existing = await findPartById(id);
    if (!existing) throw notFound(`No part with id ${id}`);
    const updated = await setVerified(id, body.verified);
    res.json(updated);
  }),
);

// DELETE /parts/:id
partsRouter.delete(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const id = z.string().min(1).max(200).parse(req.params['id']);
    const ok = await deletePart(id);
    if (!ok) throw notFound(`No part with id ${id}`);
    res.status(204).end();
  }),
);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}
