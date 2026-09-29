# CADForge MCP server

CADForge exposes its whole pipeline over the [Model Context Protocol](https://modelcontextprotocol.io)
so an agent (ChatGPT connector, Claude, Cursor, Zed, anything MCP) can generate
real-scale CAD and get STEP/GLB/STL back.

## How it works

`POST /mcp` — streamable HTTP, **stateless**. Every request builds a fresh MCP
server and transport bound to the authenticated caller, so there is no session
to expire and nothing shared between requests. That is what lets you deploy it
behind a CDN or on a platform that runs many instances.

Auth is a single bearer token (`MCP_API_KEY`). CADForge has no user accounts, so
there is no per-user ownership to resolve; the key is instance-wide, which is
why the rate limit is not optional (120 reads/min, 30 writes/min).

## Point a client at it

**Local**, from `server/.env` (or the repo root `.env`):

```json
{
  "mcpServers": {
    "cadforge": {
      "type": "streamable-http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}
```

**Hosted** — `plugin/cadforge-mcp/mcp.json` is the agent-plugins manifest, already
pointed at the Render deployment. Change the `url` to your own host.

## Tools

| Tool | What it does |
| --- | --- |
| `create_cad_project` | Start a project from a description. Returns a `projectId` immediately. |
| `wait_for_cad_project` | Block until it completes or fails. Use this instead of polling. |
| `get_cad_project` | Status, plan, assembly with world placements, scale checks, log tail. |
| `get_cad_artifacts` | Download URLs for STEP / GLB / STL / FCStd. |
| `list_cad_projects` | Recent projects. |
| `list_parts` | Search the parts library. Every entry is a sourced PartSpec. |
| `get_part` | One PartSpec in full: dimensions, features, anchors, source URLs, confidence. |
| `verify_part` | Mark a PartSpec human-verified so it is never re-researched. |
| `delete_part` / `delete_cad_project` | Remove a spec or a project record. |
| `cadforge_health` | Mongo, CadQuery worker, LLM key, search key. |

## Typical agent flow

```
cadforge_health
  -> list_parts { q: "5mm led" }        # confirm the part exists and is sourced
  -> create_cad_project { prompt: "Arduino Uno with a 5mm LED on pin 13" }
  -> wait_for_cad_project { projectId, timeoutSeconds: 300 }
  -> get_cad_artifacts { projectId }    # download URLs
```

`get_part` is the audit trail: if an agent claims a dimension, that dimension is
in the PartSpec with the URL it came from and a confidence score.

## Verify it works

```bash
# in-process, no server needed
bun run --cwd server test:mcp

# against a running server (proves auth + Express wiring)
bun run --cwd server test:mcp -- --http http://localhost:4000/mcp
```

`test:mcp` checks that every tool is advertised with a schema, that bad input is
refused with a readable message rather than a stack trace, that an unknown tool
name is refused, and that a wrong bearer key is rejected.

## Units

Every tool reports millimetres unless it says otherwise. GLB is metres and Y-up
(glTF convention); STEP and STL are millimetres and Z-up, with the origin at the
lower-left corner of the base part.
