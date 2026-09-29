# CADForge MCP server

CADForge is a **CAD service, not an agent**. The model calling it does all the thinking; CADForge
does the geometry.

That split is deliberate. An LLM guessing a dimension is the exact failure this project exists to
prevent, so nothing here guesses one. Every millimetre value in a CADForge model arrives as a number
the caller stated, gets built into real solid geometry through CadQuery, gets measured back, and gets
compared against what was asked for. If the caller got a dimension wrong, the error is in the file
and the verification says so — instead of a plausible-looking model nobody can audit.

## Tools

| Tool | What it does |
| --- | --- |
| `build_cad_model` | **The primary one.** Takes parts with explicit `bbox_mm`, `features`, and `anchors`; builds, verifies, and exports STEP + GLB + STL. |
| `list_parts` | Search a reference library of datasheet dimensions, for checking your own research. |
| `get_part` | One reference part in full, with the source URL each dimension came from. |
| `cadforge_health` | Is the CadQuery worker up. |

An optional self-contained pipeline (`create_cad_project`, `wait_for_cad_project`, …) is advertised
**only** when the server has `ANTHROPIC_API_KEY` and `TAVILY_API_KEY`. Those tools are hidden rather
than refused, so an agent never plans its way into a dead end. They are not needed for
`build_cad_model`.

## How to use it

```
cadforge_health                      # confirm the worker is reachable
list_parts { q: "arduino uno" }      # optional: cross-check a dimension
get_part { idOrName: "arduino-uno-r3" }
build_cad_model {
  parts: [
    { id: "uno", name: "Arduino Uno R3",
      bbox_mm: { x: 68.58, y: 53.34, z: 1.6 },
      anchors: [ { name: "D13_pin", position_mm: { x: 59.69, y: 48.26, z: 1.6 } } ] },
    { id: "led", name: "5mm LED",
      bbox_mm: { x: 5.8, y: 5.8, z: 8.6 },
      anchors: [ { name: "lead_1", position_mm: { x: 1.27, y: 0, z: 0 } } ] }
  ],
  placements: [
    { partId: "uno" },
    { partId: "led", anchorRef: { targetInstance: "uno_1", anchorName: "D13_pin" } }
  ]
}
```

The response reports the assembly size **measured off the built solid**, not the numbers that were
sent, plus download URLs.

## Units and frames

- **Everything is millimetres, Z-up**, origin at the lower-left corner of the part.
- `bbox_mm` is an overall size, not a corner position. `features[].position_mm` and
  `anchors[].position_mm` are absolute, measured from that same origin.
- **STEP and STL are millimetres, Z-up.** **GLB is metres, Y-up** (the glTF convention) and is
  scaled by 0.001 for web viewers.
- Real parts are not round numbers. An Uno is 68.58 × 53.34 × 1.6 mm. Using 70 × 50 × 2 puts a 1000x
  error into the model, and nothing here will correct it for you.

## Connecting

**Local** (`http://localhost:4000/mcp`):

```json
{
  "mcpServers": {
    "cadforge": {
      "type": "streamable-http",
      "url": "http://localhost:4000/mcp"
    }
  }
}
```

**Hosted** — `mcp.json` in this folder is the agent-plugins manifest, already pointed at Render.

The MCP endpoint is public and has no authentication. Requests are rate limited by client IP.

`GET /mcp` returns 405 by design: the server is stateless, so there is no server-initiated stream to
open.

## Verify it works

```bash
# in-process, no server needed
bun run --cwd server test:mcp

# against a running server, which also proves the bearer key and Express wiring
bun run --cwd server test:mcp -- --http http://localhost:4000/mcp
```
