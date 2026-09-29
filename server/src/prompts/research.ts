/**
 * RESEARCH stage system prompt.
 *
 * The text below is used VERBATIM as the system prompt for this stage, per the
 * CADForge spec. Do not edit the wording — the extraction rules are the
 * contract that keeps the LLM from inventing dimensions.
 */
export const RESEARCH_SYSTEM = `You are a mechanical-data extraction agent. Goal: produce a PartSpec in millimetres for the named part using ONLY numbers found in the provided search results and datasheet text. Rules: (1) Never estimate silently. If a value isn't in the sources, omit it and lower confidence. (2) Convert every unit to mm (mils/1000*25.4, inches*25.4). (3) Prefer manufacturer datasheets/mechanical drawings over retailers over forums. (4) Cross-check at least two sources for bbox and hole positions; if they disagree by more than 5%, use the manufacturer value and record the conflict in sources[].extracted_fields. (5) Define anchors for every point another part may attach to (pins, holes, faces). (6) Output ONLY JSON matching the PartSpec schema, no prose. Include source urls for every field group. Confidence: 0.9+ manufacturer drawing, 0.7 two agreeing secondary sources, 0.5 single secondary source, below 0.5 = flag as low-confidence.`;

/** User-side scaffolding around the verbatim system prompt. */
export function researchUserPrompt(input: {
  partName: string;
  role: string;
  searchResults: Array<{ title: string; url: string; snippet: string }>;
  pageTexts: Array<{ url: string; title: string; text: string; truncated: boolean }>;
  existingCandidates: Array<{ id: string; name: string; confidence: number; verified: boolean }>;
}): string {
  const results = input.searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 600)}`)
    .join('\n');

  const pages = input.pageTexts
    .map((p) =>
      [
        `--- PAGE ${p.url} ---`,
        `title: ${p.title}`,
        p.truncated ? '(content truncated at the size cap)' : '',
        p.text.slice(0, 24_000),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  const existing = input.existingCandidates.length
    ? input.existingCandidates
        .map((c) => `- ${c.id} "${c.name}" confidence=${c.confidence} verified=${c.verified}`)
        .join('\n')
    : '(none)';

  return `PART TO EXTRACT: ${input.partName}
Its role in the assembly: ${input.role || '(not specified)'}

Existing CADForge entries for this part (do not silently copy unverified values; you may reuse a verified entry verbatim if the sources agree):
${existing}

=== SEARCH RESULTS ===
${results || '(no search results)'}

=== FETCHED PAGE TEXT ===
${pages || '(no pages could be fetched — if this is empty you MUST return a spec with confidence <= 0.2 and most numeric fields omitted)'}

=== OUTPUT SCHEMA ===
Return ONLY this JSON object:
{
  "id": "<stable-kebab-case-id>",
  "name": "<canonical part name>",
  "category": "board|led|resistor|capacitor|header|connector|module|sensor|actuator|mechanical|fastener|wire|display|ic|other",
  "aliases": ["<other names a user might type>"],
  "bbox_mm": { "x": <mm>, "y": <mm>, "z": <mm> },
  "features": [
    { "type": "hole|cylinder|box|pin|pad|cutout", "name": "<snake_case>", "position_mm": { "x": <mm>, "y": <mm>, "z": <mm> }, "dims_mm": { "diameter": <mm>, "depth": <mm>, "height": <mm>, "length": <mm>, "x": <mm>, "y": <mm>, "z": <mm> }, "note": "<optional>" }
  ],
  "anchors": [ { "name": "<snake_case>", "position_mm": { "x": <mm>, "y": <mm>, "z": <mm> }, "normal": { "x": 0, "y": 0, "z": 1 } } ],
  "pitch_mm": <mm or omit>,
  "material": "<optional string>",
  "color_hex": "#rrggbb",
  "sources": [
    { "url": "<source url>", "title": "<page title>", "extracted_fields": [ { "field": "bbox_mm.x", "value": "68.58 mm", "source_url": "<url>", "conflict": "<if two sources disagreed by more than 5%, record the losing value here>" } ] }
  ],
  "confidence": <0..1>,
  "notes": "<what is uncertain and why>"
}

Coordinate convention, non-negotiable: millimetres, X right, Y forward, Z up, origin at the lower-left corner of the part. bbox_mm is the overall size, not a corner position. Feature positions are absolute millimetres from that origin.

Remember: omit what you cannot source. A smaller honest spec beats a fabricated one.`;
}

/** Query-generation prompt: 2-3 targeted searches for the part. */
export function searchQueryPrompt(partName: string, role: string): string {
  return `PART: ${partName}
ROLE: ${role || '(unspecified)'}

Write 2 to 3 web search queries that will find this part's REAL mechanical dimensions. Prefer queries that surface the manufacturer datasheet or mechanical drawing. Reply with ONLY a JSON array of strings, e.g. ["arduino uno r3 mechanical drawing dimensions", "uno r3 datasheet pdf"]`;
}
