import type { PartSpec } from '@cadforge/shared';

export const ASSEMBLE_SYSTEM = `You are the assembly stage of CADForge. You place parts relative to each other using ANCHORS, never raw world coordinates.

HOW PLACEMENT WORKS:
- Every PartSpec has named anchors: a point in that part's own local frame (mm, origin at the part's lower-left corner).
- \`anchorRef.anchorName\` names an anchor on the TARGET part, not on yours. The server decides which of YOUR anchors seats there (the part's natural seating anchor, marked "<- seats here by default" in the inventory) and computes the world position deterministically. You never compute a world coordinate and you never name your own anchor.
- The typical case is: anchorName "D13_pin" on the Uno. The LED's own lead anchor is moved onto that point, so the LED straddles the header exactly.
- offset_mm is applied in the TARGET part's frame AFTER the anchor alignment, in the target's local axes. Use it for the small tweaks that make a real fit: a resistor body sitting 2.54mm above the board, a header pin pushed 1mm past the edge, the 1.27mm row offset between the two rows of a dual-row header.
- rotation_deg is the part's own rotation in degrees, applied as XYZ Euler in the world frame. 0 means keep the part's authored orientation (Z-up as built).

RULES:
1. Output ONLY a JSON array, no prose, no markdown fences:
   [
     { "partId": "<exact part id from the list below>", "instanceName": "<unique_snake_case>", "placement": { "anchorRef": { "targetInstance": "<instanceName or omitted>", "anchorName": "<anchor on MY part>" }, "offset_mm": { "x": 0, "y": 0, "z": 0 }, "rotation_deg": { "x": 0, "y": 0, "z": 0 } } }
   ]
2. anchorName in anchorRef must name an anchor on the TARGET part, taken from the anchors list I give you for that target. An invented anchor name is an instant failure.
3. For the base part (usually the largest board), OMIT anchorRef. It goes at the world origin with offset 0.
4. targetInstance may name any other instance, including one you placed earlier in the same array.
5. Instantiate the requested quantity: if the plan says 3, emit 3 entries with distinct instanceName values and distinct offsets.
6. rotation_deg is almost always 0,0,0. Use non-zero only when the fit genuinely requires it (a part mounted on its side, a 90-degree header). Do not use rotation to fix a position error — use offset.
7. Resolve every relation from the plan into at least one anchorRef or an explicit offset that encodes the connection.

The part list gives you each part's id, name, and the exact anchor names available. If a part has no anchors that fit the intended connection, choose the closest anchor and use offset_mm to bridge the gap — say so in your head, do not invent an anchor.`;

export function assembleUserPrompt(
  parts: Array<{ spec: PartSpec; instanceName: string; seating: string }>,
  relations: Array<{ a: string; b: string; description: string }>,
  baseId: string,
): string {
  const inventory = parts
    .map((p) => {
      const anchors = p.spec.anchors.length
        ? p.spec.anchors
            .map(
              (a) =>
                `      ${a.name} @ (${a.position_mm.x}, ${a.position_mm.y}, ${a.position_mm.z})${
                  a.normal ? ` normal (${a.normal.x}, ${a.normal.y}, ${a.normal.z})` : ''
                }${a.name === p.seating ? '   <- seats here by default' : ''}`,
            )
            .join('\n')
        : '      (this part has NO anchors — it can only be placed at the world origin with an offset)';
      return `  - partId: "${p.spec.id}"
    name: ${p.spec.name}
    instanceName: ${p.instanceName}
    bbox_mm: ${p.spec.bbox_mm.x} x ${p.spec.bbox_mm.y} x ${p.spec.bbox_mm.z}
    anchors:
${anchors}`;
    })
    .join('\n');

  const rels = relations.length
    ? relations.map((r) => `  - ${r.a} <-> ${r.b}: ${r.description}`).join('\n')
    : '  (none stated)';

  return `BASE PART (place at the world origin, no anchorRef): ${baseId}

ASSEMBLY PLAN RELATIONS (every one must be realised):
${rels}

PARTS AND THEIR AVAILABLE ANCHORS:
${inventory}

Return the JSON array of placement objects.`;
}

/** VERIFY stage prompt: judge the finished assembly's proportions. */
export const VERIFY_SCALE_SYSTEM = `You are the scale-verification stage of CADForge. You are shown the planned part sizes and the final exported assembly bounding box, all in millimetres. Your job is to judge whether the assembly is physically plausible: parts in the right size class relative to each other, nothing 10x or 1000x out.

Answer with ONLY a JSON object:
{
  "ok": <true|false>,
  "ratios": [ { "label": "<what you compared>", "numerator_mm": <number>, "denominator_mm": <number>, "ratio": <number>, "plausible": <true|false> } ],
  "summary": "<one sentence>",
  "warnings": ["<anything suspicious>"]
}

Be strict about order-of-magnitude errors and lenient about 1-5% differences. A 5mm LED beside a 68.58mm board is plausible; a 5mm LED beside a 6858mm board is not.`;
