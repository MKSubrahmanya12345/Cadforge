# CADForge — Setup Guide

Everything you need to go from a fresh machine to a working, true-scale CAD generator.

**Time required:** 30–60 minutes, most of it installing Python 3.11 and CadQuery.

**What CADForge does:** you type a description ("Arduino Uno with a 5mm LED on pin 13"), it
researches real dimensions from manufacturer datasheets, generates parametric CAD, and exports
STEP + GLB + STL you can open in any CAD tool. The guarantee that makes it worth using: **a 5mm
LED is actually 5mm next to a 53.34mm-wide board.** The LLM never invents a dimension; it only
ever uses values from a validated, sourced spec.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [API keys](#2-api-keys)
3. [Environment variables](#3-environment-variables)
4. [CadQuery install (the fiddly part)](#4-cadquery-install-the-fiddly-part)
5. [Install, seed, and run](#5-install-seed-and-run)
6. [First run walkthrough](#6-first-run-walkthrough)
7. [Using the MCP server](#7-using-the-mcp-server)
8. [Troubleshooting](#8-troubleshooting)
9. [Manual tasks for you](#9-manual-tasks-for-you)

---

## 1. Prerequisites

### 1.1 Bun (required)

Bun runs the TypeScript server and the tests.

| Platform | Install |
| --- | --- |
| Windows | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| macOS / Linux | `curl -fsSL https://bun.sh/install \| bash` |

Verify:

```bash
bun --version     # needs 1.1.0 or newer
```

### 1.2 Node.js (only needed for Vite tooling)

```bash
# Windows (winget)
winget install OpenJS.NodeJS.LTS
# macOS (homebrew)
brew install node
# Ubuntu/Debian
sudo apt install nodejs npm
```

Verify: `node --version` → v20 or newer.

### 1.3 Python 3.11 (required for the CAD worker)

**You need exactly 3.11.** CadQuery 2.4 has no wheels for 3.12+, so `pip install cadquery`
fails on a newer Python. If you already have 3.14 installed, that is fine — it just cannot be
used here. Install 3.11 alongside it.

| Platform | Install |
| --- | --- |
| Windows | Download the **3.11.x** installer from <https://www.python.org/downloads/release/python-3119/> → tick **"Add python.exe to PATH"** |
| macOS (Homebrew) | `brew install python@3.11` then use `python3.11` explicitly |
| macOS (python.org) | Download from <https://www.python.org/downloads/release/python-3119/> |
| Ubuntu/Debian | `sudo apt install python3.11 python3.11-venv` (may need the deadsnakes PPA) |
| Fedora | `sudo dnf install python3.11` |

Verify (**use the versioned name on macOS/Linux**):

```bash
python3.11 --version    # Windows: py -3.11 --version
# macOS/Linux: python3.11 --version
```

### 1.4 MongoDB

You need **either** a MongoDB Atlas free-tier cluster (recommended — nothing to install) **or** a
local MongoDB.

**Option A — Atlas free tier (no install, works immediately):**

1. Go to <https://www.mongodb.com/atlas/register> and create a free account.
2. Create a free **M0** cluster (choose any cloud and region).
3. Under **Database Access**, add a user:
   - Authentication method: **Password**
   - Username: e.g. `cadforge`
   - Password: click the "eye" icon and use **Autogenerate Secure Password** — copy it
4. Under **Network Access**, click **Add IP Address** and choose **Allow access from anywhere**
   (`0.0.0.0/0`). This is fine for a local dev tool; tighten it later if you deploy.
5. Click **Connect** → **Drivers** → copy the **mongodb+srv://** connection string. It looks like:

   ```
   mongodb+srv://cadforge:<password>@cadforge-cluster.abcde.mongodb.net/?retryWrites=true&w=majority
   ```

   Replace `<password>` with the one you copied. Keep the database name at the end:

   ```
   mongodb+srv://cadforge:<password>@cadforge-cluster.abcde.mongodb.net/cadforge?retryWrites=true&w=majority
   ```

**Option B — local MongoDB:**

- **Docker:** `docker compose up -d` from the repo root (the compose file is already written for
  you — it only starts MongoDB on port 27017).
- **Native Windows:** download the MSI from
  <https://www.mongodb.com/try/download/community> and install it, making sure to tick
  "Install MongoDB as a Service".
- **macOS:** `brew install mongodb-community && brew services start mongodb-community`

Either way your connection string is `mongodb://127.0.0.1:27017/cadforge`.

### 1.5 FreeCAD — OPTIONAL

Only needed if you want `.FCStd` exports. Without it CADForge still produces STEP, GLB, and STL.

CADForge shells out to the `freecadcmd` binary, so that is what has to be on your `PATH`:

- **Windows:** install from <https://www.freecad.org/downloads.php> (the 7z portable version
  works and needs no installer), then add the `bin` folder to your `PATH`:
  `C:\Program Files\FreeCAD 0.21\bin`
- **macOS:** `brew install --cask freecad`, then
  `sudo ln -sfn /Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd /usr/local/bin/freecadcmd`
- **Ubuntu/Debian:** `sudo apt install freecad-python3`, then
  `sudo ln -sfn /usr/bin/freecadcmd /usr/local/bin/freecadcmd`

Verify (on Windows you may need a new terminal to pick up the `PATH` change):

```bash
freecadcmd --version
```

If this command is not found, FCStd export is skipped silently — everything else still works.

---

## 2. API keys

You need two. Both have free tiers.

### 2.1 Anthropic (the LLM)

1. Sign up at <https://console.anthropic.com/>.
2. Go to **API Keys**: <https://console.anthropic.com/settings/keys>.
3. Click **Create Key**, name it `cadforge`, and copy the value. It starts with `sk-ant-` and is
   shown **only once**.
4. Add credit at **Billing** (<https://console.anthropic.com/settings/plans>) — the API is not
   usable on the free chat plan.

### 2.2 Tavily (web search for datasheets)

1. Sign up at <https://app.tavily.com/home>.
2. Your API key is on the dashboard under **API Keys**, or click **API Keys** in the sidebar.
   It starts with `tvly-`.
3. The free tier is 1000 searches/month, which is plenty for evaluating CADForge.

### 2.3 Where to paste them

Both go in **one file**: `.env` in the CADForge repo root. See section 3.

---

## 3. Environment variables

### 3.1 Create your `.env`

From the repo root:

```bash
# Windows (PowerShell)
copy .env.example .env
# macOS / Linux
cp .env.example .env
```

### 3.2 Fill in the four required values

Open `.env` in any text editor and set:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...          # from section 2.1
ANTHROPIC_MODEL=claude-sonnet-4-5     # any current Claude model works
TAVILY_API_KEY=tvly-...               # from section 2.2
MONGODB_URI=mongodb+srv://...         # from section 1.4
```

That is genuinely all you must change. Everything else has a working default.

### 3.3 Full annotated `.env.example`

```dotenv
# =============================================================================
# CADForge — environment template
# Copy to `.env` in this folder:  cp .env.example .env   (Windows: copy .env.example .env)
# Fill in the four values marked REQUIRED below. Everything else has a sane default.
# The server loads this file automatically. Never commit your real .env.
# =============================================================================

# ---------------------------------------------------------------- REQUIRED ---
# 1) Anthropic API key — https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME

# 2) Anthropic model id. Any current Claude model works.
ANTHROPIC_MODEL=claude-sonnet-4-5

# 3) Tavily API key — https://app.tavily.com/home (sign up, key is under "API Keys")
TAVILY_API_KEY=tvly-REPLACE_ME

# 4) MongoDB connection string.
#    Local docker-compose:      mongodb://127.0.0.1:27017/cadforge
#    MongoDB Atlas free tier:   mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/cadforge?retryWrites=true&w=majority
MONGODB_URI=mongodb://127.0.0.1:27017/cadforge

# ------------------------------------------------------------------ SERVER ---
NODE_ENV=development
PORT=4000
# Comma-separated list of allowed browser origins (CORS)
CLIENT_ORIGIN=http://localhost:5173
# Where generated CAD files are written, and where /files is served from.
# Relative paths resolve against the repo root.
STORAGE_DIR=./storage
LOG_LEVEL=info
# Simple in-memory rate limit: max requests per window, per IP, on /api
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
# Max bytes accepted for a fetched datasheet/PDF/HTML page during RESEARCH
MAX_FETCH_BYTES=8388608
# LLM JSON parse retries (PLAN / RESEARCH / ASSEMBLE)
LLM_MAX_RETRIES=3
# CadQuery subprocess timeout in the worker
CODE_TIMEOUT_S=30
# How many times the server re-prompts the LLM when the worker reports a
# bbox/feature mismatch before it falls back to the deterministic builder
VALIDATE_MAX_RETRIES=4
# CAD worker (Python) base URL
CAD_WORKER_URL=http://127.0.0.1:8000
# Hard ceiling on generations per project (protects your API budget)
MAX_PARTS_PER_PROJECT=12

# ------------------------------------------------------------------ CLIENT ---
# Vite reads this from client/.env (see client/.env.example).
VITE_API_URL=http://localhost:4000

# --------------------------------------------------------------- CAD-WORKER ---
# Optional. The Python worker has correct defaults; override only if needed.
CADFORGE_CODE_TIMEOUT_S=30
CADFORGE_MAX_CODE_BYTES=200000
# If "true", /health reports fcstd export as required instead of optional
CADFORGE_FREECAD_REQUIRED=false
```

### 3.4 Client `.env` — you probably do not need this

In development, Vite proxies `/api`, `/files`, and `/mcp` to the server, so the browser sees one
origin and there is no CORS. Only create `client/.env` if you are serving the built client from a
different origin than the API:

```dotenv
VITE_API_URL=https://your-api-host.example.com
```

### 3.5 The worker `.env`

The Python worker reads three optional variables directly from the environment. You do not need a
separate file — set them in your shell if you want to override the defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADFORGE_CODE_TIMEOUT_S` | `30` | Hard timeout for one generated-code execution |
| `CADFORGE_MAX_CODE_BYTES` | `200000` | Reject generated code larger than this |
| `CADFORGE_FREECAD_REQUIRED` | `false` | If `true`, `/health` fails when `freecadcmd` is missing |
| `CADFORGE_STORAGE_ROOT` | `../storage` | Where the worker writes artifacts |

---

## 4. CadQuery install (the fiddly part)

This is where most people get stuck. CadQuery bundles the OpenCascade geometry kernel, which ships
as compiled wheels — and wheels are built per Python version and per platform.

### 4.1 The rule

**Python 3.11, always.** CadQuery 2.4.0 publishes wheels for 3.9–3.11. On 3.12+ pip will either
fail outright or try to build from source, which needs a C++ toolchain and takes an hour.

Check what you have before you start:

```bash
python --version        # or python3.11 --version
```

If that says 3.12, 3.13, or 3.14, **stop and install 3.11** (section 1.3).

### 4.2 Option A — conda (recommended)

conda gives you a clean, isolated Python 3.11 and sidesteps every "wrong Python on PATH" problem.

```bash
# Install Miniconda if needed: https://docs.conda.io/en/latest/miniconda.html
conda create -n cadforge python=3.11 -y
conda activate cadforge

cd cad-worker
pip install -r requirements.txt
```

### 4.3 Option B — plain venv

Fine, as long as the venv really is 3.11.

```bash
# macOS / Linux
python3.11 -m venv ~/venvs/cadforge
source ~/venvs/cadforge/bin/activate

# Windows PowerShell
py -3.11 -m venv %USERPROFILE%\venvs\cadforge
%USERPROFILE%\venvs\cadforge\Scripts\Activate.ps1

cd cad-worker
pip install --upgrade pip
pip install -r requirements.txt
```

### 4.4 Known pitfalls

**"No matching distribution found for cadquery"**
Your Python is not 3.11. `python --version` will tell you. This is the #1 cause.

**Apple Silicon (M1/M2/M3)**
cadquery 2.4.0 has no arm64 macOS wheel, so pip tries to build from source. Options, in order of
preference:
1. Run the worker under Rosetta with an x86 Python: `arch -x86_64 python3.11 -m venv ...`
2. Use Docker for the worker (see 4.6)
3. Accept a from-source build and install a compiler first: `xcode-select --install`

The `cadquery-conda` channel has arm64 builds if you go the conda route.

**Windows: "ImportError: DLL load failed" on `import cadquery`**
Usually a Visual C++ redistributable is missing. Install the
[VC++ 2015-2022 redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe) and retry.

**Windows: antivirus quarantines the OpenCascade DLL**
Add the venv to your antivirus exclusions, or use conda instead.

**Windows: file paths with spaces break OpenCascade**
Avoid spaces in the checkout path. If your repo lives under `C:\My Projects\`, move it.

**`trimesh` or `manifold3d` fail to build**
Both have wheels for 3.11 on all platforms. If pip is building them from source, your pip is too
old: `pip install --upgrade pip setuptools wheel`.

### 4.5 Verify the install

```bash
# Activate your env first, then:
cd cad-worker
python -c "import cadquery; print('CadQuery', cadquery.__version__)"
python -c "import fastapi, trimesh, numpy; print('deps ok')"
```

You want `CadQuery 2.4.0` (or close) and `deps ok`.

Then run the worker's own test suite:

```bash
python -m pytest tests -q
```

If CadQuery is not installed yet you can still check the worker's pure logic (unit conversion,
bbox validation, sandbox prefilter) with the standard library alone:

```bash
python tests/run_without_cadquery.py
```

### 4.6 Running the worker in Docker instead (optional escape hatch)

If CadQuery will not install natively, run the worker in a container:

```bash
cd cad-worker
docker build -t cadforge-worker .
docker run --rm -p 8000:8000 -v "$(pwd)/../storage:/app/storage" cadforge-worker
```

Then leave `CAD_WORKER_URL=http://127.0.0.1:8000` in your `.env` and use `bun run dev:no-worker`
so the local Python process is not started as well.

---

## 5. Install, seed, and run

### 5.1 Install JavaScript dependencies

From the repo root:

```bash
bun install
```

This installs the root tooling plus the `shared`, `server`, and `client` workspaces.

### 5.2 Verify everything compiles

```bash
bun run typecheck
```

No output means clean. Run the tests too:

```bash
bun test shared/src server/src
```

You should see 128 passing.

### 5.3 (Optional) Copy the STEP loader WASM into `client/public`

The client already resolves the OpenCascade WASM through Vite's `?url` import, so this is
**not required**. It exists only as a fallback if your bundler cannot serve the hashed asset. To
set it up:

```bash
mkdir -p client/public
cp node_modules/.bun/occt-import-js@*/node_modules/occt-import-js/dist/occt-import-js.wasm client/public/
```

### 5.4 Seed the parts library

The seed loads 10 verified parts (Arduino Uno R3, 5mm and 3mm LEDs, 2.54mm pin header, 1/4W axial
resistor, half-size breadboard, 6x6 tactile switch, SG90 servo, HC-SR04, Raspberry Pi 4B) with their
datasheet sources. **This is what makes the first run instant and correct** — without it CADForge
would research the Uno over the web on every run.

```bash
bun run seed
```

Expected output (abbreviated):

```
inserted arduino-uno-r3 — Arduino Uno R3 (68.58×53.34×1.6 mm, confidence 0.9)
inserted led-5mm — 5mm LED (5.8×5.8×8.6 mm, confidence 0.8)
...
seed complete: 10 inserted, 0 updated
```

Re-running is safe: it upserts, so you can re-seed after editing `server/src/seed/parts.ts`.

### 5.5 Start everything

From the repo root:

```bash
bun run dev
```

That single command starts all three processes with interleaved, colour-coded output:

| Process | Port | What it is |
| --- | --- | --- |
| `server` | 4000 | Express API, pipeline orchestrator, MCP endpoint |
| `client` | 5173 | Vite dev server (the browser UI) |
| `worker` | 8000 | Python FastAPI + CadQuery |

If you are not running the Python worker (for example, you are still installing CadQuery), use:

```bash
bun run dev:no-worker
```

### 5.6 Open it

<http://localhost:5173>

The top status bar shows live health: `mongo`, `worker` (with the CadQuery version), `llm`, and
`search`. All four should be green.

### 5.7 Production build (optional)

```bash
bun run build     # typechecks and builds the client into client/dist
bun run preview   # serves the built client
```

---

## 6. First run walkthrough

### 6.1 The prompt

Type this into the sidebar and press Enter (or click **Generate**):

```
Arduino Uno with a 5mm LED on pin 13
```

### 6.2 What should happen

The pipeline runs eight stages. Watch the stage chips and the live log in the sidebar — the log is
where the real information is, including every search query and every sourced dimension.

| # | Stage | What it does | Expected time |
| --- | --- | --- | --- |
| 1 | **Plan** | LLM turns your sentence into a part list. Expect `1x Arduino Uno R3`, `1x 5mm LED`, and the relation "LED legs straddle the D13 header pin". | 2–5 s |
| 2 | **Resolve** | Both parts hit the seeded library, so **no web research happens**. | instant |
| 3 | **Research** | Skipped — this is the whole point of seeding. | — |
| 4 | **Assemble** | LLM picks anchors; the server resolves them to world coordinates deterministically. Expect the LED seated on `D13_pin`. | 2–5 s |
| 5 | **Generate** | LLM writes CadQuery code per part with named millimetre constants. | 5–20 s |
| 6 | **Validate** | The worker builds the solid, measures its bbox and holes, and compares to the spec within 0.3 mm or 2 %. Expect `OK`. | 2–10 s |
| 7 | **Export** | STEP + GLB + STL written to `storage/<projectId>/`. | 2–10 s |
| 8 | **Verify** | Ratio and fit checks. Expect every line `OK`. | 1–2 s |

Total: roughly **20–60 seconds**, and it costs one small LLM call because nothing needs researching.

### 6.3 What correct output looks like

**The 3D viewport** shows the Uno with a small red LED standing on the header near the back edge.
Click **Real scale** to lock the camera 1:1, then use the blue 10 mm ruler as a reference. The LED
dome is 5.0 mm — about half the ruler's length. If the LED looked board-sized, something is wrong;
check the log.

**The log** should contain lines like these (yours will differ in wording, not in substance):

```
plan        2x part resolved: 1x Arduino Uno R3 (main board)
resolve     library hit for "Arduino Uno R3" -> arduino-uno-r3 (confidence 0.9, verified)
assemble    base part: Arduino Uno R3 (arduino_uno_r3_1)
assemble    place led_5mm_1 (5mm LED) at (58.42, 48.26, 1.60) mm
validate    arduino_uno_r3_1 validated on attempt 1
validate      bbox 68.580×53.340×1.600 mm vs spec 68.580×53.340×1.600 mm
validate      4/4 spec features present
verify      OK smallest part width / assembly width: ...
verify      OK Arduino Uno R3 (arduino-uno-r3) fits the assembly bbox
export      STEP written: <projectId>/assembly.step
export      GLB written: <projectId>/assembly.glb
export      STL written: <projectId>/assembly.stl
```

**The right panel** (select a part) shows:

- Size: `5.80 × 5.80 × 8.60 mm` for the LED, `68.58 × 53.34 × 1.60 mm` for the Uno
- A confidence badge: `0.80 · medium` for the LED, `0.90 · high` for the Uno
- A `verified` badge — seeded parts never get re-researched
- 4 features for the Uno, including the four 3.2 mm mounting holes at
  (13.97, 2.54), (15.24, 50.8), (66.04, 7.62), (66.04, 35.56)
- **Sources** with clickable links and the exact value extracted from each, e.g.
  `bbox_mm.x = 68.58 mm (2.70 in)`

**The scale verification** section should be all `OK`.

### 6.4 Check the numbers yourself

```bash
# Find the newest project directory
ls -t storage | head -1     # macOS/Linux
```

Or in PowerShell:

```powershell
Get-ChildItem storage -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

Then:

- **Uno width must be 53.34 mm** — open the STEP in any CAD tool and measure it
- **LED dome must be 5.0 mm**
- The assembly should be 68.58 × 54.06 × 10.2 mm. The 54.06 mm depth is correct: the LED sits on
  the D13 pin at y=48.26 and is 5.8 mm across, so it overhangs the 53.34 mm board edge by 0.72 mm.
  That is real hardware behaviour, not a bug.

### 6.5 Test the measure tool

Click **Measure**, then click two points on the model. The readout shows the distance in
millimetres plus the per-axis deltas. Click across the Uno and you should get 68.58 mm; click the
LED dome and you should get 5.0 mm.

### 6.6 Try a part that is NOT in the library

```
Arduino Uno with a WS2812B NeoPixel module and a 100uF electrolytic capacitor
```

Now stage 3 actually runs: you will see 2–3 generated search queries, several fetched pages
(datasheet PDFs are text-extracted), and a low-to-medium confidence spec with real source URLs.
This costs 3–6 LLM calls and 30–90 seconds. Check the **Sources** section in the right panel
before trusting the model.

---

## 7. Using the MCP server

CADForge exposes its tools over the Model Context Protocol. The endpoint is public and rate limited;
no key or Authorization header is required. Full detail is in `plugin/cadforge-mcp/README.md`.

**1. Verify the tools work:**

```bash
bun run --cwd server test:mcp
```

**2. Point a client at it.** For a local server:

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

`plugin/cadforge-mcp/mcp.json` is the ready-made manifest for a hosted deployment.

**3. Typical agent flow:**

```
cadforge_health
  -> list_parts { q: "5mm led" }
  -> create_cad_project { prompt: "Arduino Uno with a 5mm LED on pin 13" }
  -> wait_for_cad_project { projectId, timeoutSeconds: 300 }
  -> get_cad_artifacts { projectId }
```

There are 11 tools: `create_cad_project`, `get_cad_project`, `wait_for_cad_project`,
`list_cad_projects`, `get_cad_artifacts`, `list_parts`, `get_part`, `verify_part`, `delete_part`,
`delete_cad_project`, `cadforge_health`.

---

## 8. Troubleshooting

### Downloads 404 on a deployed host, but the pipeline reports success

**Symptom:** projects complete, the log says `STEP written: <id>/assembly.step`, but the viewport is
empty and every download 404s.

**Cause:** the API is looking for artifact bytes on its own disk, but the worker wrote them on a
*different* host.

**Fix:** the API proxies `/files` through the worker when `CAD_WORKER_URL` is remote. Check:

1. `CAD_WORKER_URL` on the API service is the worker's **public** URL, not
   `http://localhost:8000` and not a Docker-internal hostname.
2. The worker service is awake and reachable. In a browser, open the worker URL and `/health`.
3. The startup log says which mode was chosen — it prints either
   `serving artifacts by proxying the cad-worker` or
   `serving artifacts from local disk`. If it says local disk while the worker is remote, the URL
   is wrong.

**This used to be unfixable without a shared volume.** If you see it, the API is older than the
proxy change; redeploy.

### "cad-worker unreachable"

**Symptom:** status bar shows `worker` red; the log says
`cad-worker unreachable at http://127.0.0.1:8000/generate`.

**Cause:** the Python worker is not running, or CadQuery is not installed so it crashed on startup.

**Fix:**

```bash
# Is it running?
curl http://127.0.0.1:8000/health

# Start it manually to see the real error
cd cad-worker
python -m uvicorn app.main:app --reload --port 8000
```

If it fails to import, CadQuery is not installed — go back to section 4. If it binds to a different
port, update `CAD_WORKER_URL` in `.env`. If you intentionally do not want the worker, use
`bun run dev:no-worker` and expect every project to fail at the generate stage.

### "STEP not loading in the viewer"

**Symptom:** the GLB tab shows a model, the STEP tab shows "No viewable format" or nothing. Nothing
red in the UI — a failed format is hidden on purpose, and the reason is in the **browser console**.

**Cause, in order of likelihood:**

1. The 2 MB+ OpenCascade WASM failed to load. Check the console for a 404 on
   `occt-import-js*.wasm`. Fix: do step 5.3.
2. The STEP file is genuinely unreadable (rare — the worker wrote it). Look at the download; if
   FreeCAD or another CAD tool opens it, the file is fine and this is the viewer.
3. The export stage failed and no STEP was written. Check the log and
   `ls storage/<projectId>/`.

**Workaround:** use the GLB tab or the ↓ STEP download button; both work independently of the
in-browser loader.

### "The model is 1000x too big / too small"

**Symptom:** a part fills the entire viewport when it should be 5 mm, or is invisible.

**Where to look, in order:**

1. **The right panel's Size field.** If it says `5000 × …` for an LED, the *spec* is wrong — a
   research or LLM error. The Sources section will show the bad URL. Delete the part
   (`DELETE /api/parts/:id`), fix the spec, re-run.
2. **The STL console warning.** The client logs
   `is implausibly large` when an STL's bounding box exceeds 10 m. That means the model was built
   in metres.
3. **The scale verification section.** If it shows `FAIL`, the pipeline already caught it. Check
   which part.

**Where it comes from:** the worker's validator compares the built solid's bbox against the spec
with a 0.3 mm / 2 % tolerance and retries up to `VALIDATE_MAX_RETRIES` times. If it still fails,
the deterministic builder produces a model that is exact by construction — so a 1000x error in the
*output* should be impossible. If you see one, it is almost certainly a coordinate-frame
disagreement, and it is worth a bug report with the project id.

### "Tavily rate limit hit (429)"

**Symptom:** log line `Tavily rate limit hit (429)`, project fails during Research.

**Cause:** more than 1000 searches/month on the free tier, or a burst from several runs at once.

**Fix:** upgrade at <https://app.tavily.com/home>, wait for the monthly reset, or reduce the
pressure — seed more parts so research runs less often (`bun run seed` after adding to
`server/src/seed/parts.ts`). Each researched part costs 2–3 searches; library hits cost zero.

### "MongoDB connection failed"

**Symptom:** status bar `mongo` red; server log shows
`MongoDB server selection timed out after 10000 ms`.

**Fix, in order:**

1. **Check your connection string.** Atlas URIs must include the database name:
   `mongodb+srv://user:pass@cluster.mongodb.net/cadforge?retryWrites=true&w=majority`.
2. **Special characters in the Atlas password must be URL-encoded.** If you used the
   autogenerated password, it contains characters like `#` and `?` that break the URI. Either
   create a simpler password (letters and digits only) or percent-encode them (`#` → `%23`).
3. **Atlas network access.** Under Network Access you must have added an IP allowlist entry.
   `0.0.0.0/0` allows anywhere.
4. **Atlas user exists** and has read/write on the `cadforge` database.
5. **Local Docker:** `docker compose ps` and `docker compose logs mongo`. First boot can take 20 s
   to initialise.
6. **Nothing is listening on 27017?** Check with `netstat -ano | findstr 27017` (Windows) or
   `lsof -i :27017` (macOS/Linux).

### "EnvValidationError: Invalid environment configuration"

**Symptom:** the server exits immediately listing every missing key.

**Fix:** you skipped section 3.2. Create `.env` from `.env.example` and fill in the four required
values. The error lists exactly what is missing, so you can fix everything in one pass.

### "bun: command not found" (Windows)

Close and reopen your terminal, or add `%USERPROFILE%\.bun\bin` to your `PATH`. Verify with
`where bun`.

### The model renders black / unlit

The default lights assume a model tens of millimetres across. If the model is tiny relative to the
scene, move the camera in. Use **Fit** to reframe, or switch to **Ortho** for flat lighting.

### "GLB looks like it is lying on its side"

A frame disagreement: glTF is Y-up, CAD is Z-up. The client applies `rotation-x={-π/2}` and scales
by 1000. If you changed the exporter, check both. The STEP and STL paths are already in the CAD
frame, so compare against one of those.

### Port already in use

`PORT=4000` is taken. Change it in `.env`. Also change the Vite proxy target in
`client/vite.config.ts` to match, and `CLIENT_ORIGIN` if you move the client port.

### Everything is slow

Each project makes 3–6 LLM calls plus 2–3 web searches. `LOG_LEVEL=debug` shows per-stage timing.
If the log stalls at **Research**, it is network-bound on datasheet fetching. If it stalls at
**Generate**, it is the LLM.

---

## 9. Manual tasks for you

A checklist of the things that need human judgement. None of them are required to run CADForge.

### 9.1 Verify the seed dimensions against real datasheets

The seed library is a starting point, and every entry carries a confidence score reflecting how
much its sources agree. These are the ones worth checking against parts on your desk:

- [ ] **Arduino Uno R3** — `server/src/seed/parts.ts`, confidence 0.9. The PCB outline
      (68.58 × 53.34 × 1.6 mm) and the four mounting holes are from the official mechanical
      drawing and should be exact. **The `usb_b_block` (12 × 16 × 11 mm) is explicitly marked
      approximate.** Measure a real board with calipers and correct it.
- [ ] **5mm LED** — confidence 0.8. Dome 5.0, flange 5.8, 2.54 mm lead pitch are standard across
      manufacturers, but the **25 mm lead length is a typical straight-lead value**; yours may be
      trimmed. Check your stock.
- [ ] **1/4W axial resistor** — 6.3 × 2.3 mm body, 0.6 mm leads is the standard package. The
      **57 mm total length reflects untrimmed leads.**
- [ ] **Half-size breadboard** — 82.6 × 55 × 8.5 mm. The 82.6 mm is derived from the 0.1 in grid,
      not from a drawing. Measure yours.
- [ ] **HC-SR04** — **can height and total height vary by a couple of mm between manufacturers.**
- [ ] **SG90 servo** — **mounting hole positions are approximate across clones.**

After editing, re-seed and restart:

```bash
bun run seed && bun run dev
```

### 9.2 Add more parts to the library

Adding a part to the library is the highest-leverage thing you can do: it makes that part instant
and never re-researched. Edit `server/src/seed/parts.ts`, add a `PartSpec`, and re-seed.

Every entry needs:

- `bbox_mm` in millimetres — the real overall size, not a corner position
- `features` — every hole, cylinder, pin, pad, and cutout, with **absolute** millimetre positions
  from the part's lower-left origin
- `anchors` — every point another part could attach to. Name them consistently (`mount_hole_1`,
  `D13_pin`, `lead_1`, `top_center`) because the assembly stage picks anchor names from this list
- `sources` — at least one URL, with `extracted_fields` naming the field and the value
- `confidence` — honest. 0.9+ only for a manufacturer drawing; 0.7 for two agreeing secondary
  sources; 0.5 for one. **Anything you are unsure of gets a lower score, not a guess.**

Then run `bun test shared/src server/src` — the seed integrity test will check the schema, unique
ids, sourcing, and that no part claims a confidence it has not earned.

### 9.3 Tune the tolerances

| Knob | Where | Default | Raise it if… | Lower it if… |
| --- | --- | --- | --- | --- |
| Geometry tolerance | `shared/src/units.ts` + `cad-worker/app/units.py` (`tolerance_for`) | 0.3 mm / 2 % | the LLM retries too often on legitimately rounded values | wrong models are slipping through |
| LLM retries on JSON errors | `LLM_MAX_RETRIES` in `.env` | 3 | the model is being cut off mid-JSON | you are burning tokens on retries |
| Codegen retries | `VALIDATE_MAX_RETRIES` in `.env` | 4 | parts keep falling back | you are hitting API limits |

**Change the tolerance in both places** — TypeScript and Python — or the server and worker will
disagree about what "valid" means. Both files are small and the function is three lines.

### 9.4 Deployment

CADForge is two services and a database:

| Piece | What it is | Where it can run |
| --- | --- | --- |
| **API + client + MCP** | Express, the pipeline, the built UI, `POST /mcp` | One Node/Bun service |
| **CadQuery worker** | Python 3.11 + CadQuery, builds and exports geometry | One container service |
| **MongoDB** | Atlas free tier is fine | Managed |

**MCP needs no service of its own.** It is `POST /mcp` on the API service, so whatever host runs
the API is your MCP URL. There is nothing extra to deploy for it.

**The one hard constraint:** the API needs a reachable worker. No worker means no project can
generate geometry — the pipeline fails at the *Generate* stage. The worker in turn needs Python 3.11
and CadQuery, so it wants a container, not a bare Bun service.

#### Option A — both services on Render (the blueprint)

`render.yaml` at the repo root defines both. In the Render dashboard: **New → Blueprint** → point
at the repo.

1. Deploy once. Render builds both services and shows you two URLs.
2. Copy the worker's URL into the API service's `CAD_WORKER_URL` (it defaults to
   `https://cadforge-worker.onrender.com`) and redeploy the API.
3. Set `CLIENT_ORIGIN` to the API's own URL. The image serves the built client from the same
   origin, so CORS is not in the request path.
4. `MONGODB_URI`, `ANTHROPIC_API_KEY`, and `TAVILY_API_KEY` are prompted for on first deploy.

**No shared disk is required.** The worker writes the artifacts and the API proxies its `/files`
mount through the worker (`isWorkerLocal()` in `server/src/app.ts` picks between proxying and
serving from local disk). If you want finished models to outlive a deploy, attach a persistent disk
to the **worker** at `/app/storage`.

**Costs:** both services are CPU-bound and need a `starter` plan to stay awake; Render's free plan
sleeps after 15 minutes of inactivity, and a cold CadQuery import takes far longer than the 30 s
a free instance allows to boot. Start on `starter`.

#### Option B — API on Render, worker elsewhere

Delete the `cadforge-worker` block from `render.yaml`, run the worker wherever you like (another
Render service, a VPS, your own machine, `docker run`), and point the API at it:

```dotenv
CAD_WORKER_URL=https://wherever-your-worker-is
```

That is the only variable that changes. The API proxies `/files` through it, so the two do not need
to share a filesystem.

To run the worker locally while the API is on Render:

```bash
cd cad-worker && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

…and tunnel it (cloudflared, ngrok, Tailscale) so Render can reach it. Fine for development, not
for anything you care about.

#### Building the images yourself

```bash
# API (context must be the repo ROOT, not server/)
docker build -f server/Dockerfile -t cadforge-api .

# Worker (context is cad-worker/)
docker build -f cad-worker/Dockerfile -t cadforge-worker ./cad-worker
```

If you host the client separately instead of letting the API serve it, set `VITE_API_URL` to the
API's origin at build time. The API then skips its static mount — it logs
`no client build found` — and CORS is handled by `CLIENT_ORIGIN`.

### 9.5 Deployment notes

- [ ] MCP is publicly reachable and rate limited by client IP
- [ ] `CLIENT_ORIGIN` lists only your real client origins
- [ ] MongoDB Atlas network access is tightened from `0.0.0.0/0` to your host IPs if you can
- [ ] The storage directory is not inside the web root; CADForge serves it read-only at `/files`
- [ ] Consider `RATE_LIMIT_MAX` tightening — 120 requests/minute is generous for local use

### 9.6 Things you may want to build next

- **Part library UI** — a page for browsing and editing PartSpecs without going through the API
- **Assembly export to a CAD format that keeps part identity** (3MF or XDE) so parts stay separate
- **Diff two generations** — generate the same prompt twice and compare
- **Cost tracking** — the pipeline knows how many LLM calls it made; surface it
- **More seeded parts** — the library is the main lever on speed and accuracy

---

## Quick reference

```bash
# Setup, once
bun install
cp .env.example .env          # then edit it
python -m venv .venv && .venv/bin/activate    # or conda create -n cadforge python=3.11
pip install -r cad-worker/requirements.txt

# Daily use
bun run seed                  # load the verified parts library
bun run dev                   # start server + client + worker

# Verify
bun run typecheck
bun test shared/src server/src
cd cad-worker && python -m pytest tests -q
cd .. && bun run --cwd server test:mcp
```

| URL | What |
| --- | --- |
| <http://localhost:5173> | The UI |
| <http://localhost:4000/api/health> | Health check (mongo, worker, llm, search) |
| <http://localhost:8000/health> | CadQuery worker health |
| <http://localhost:4000/mcp> | Public MCP endpoint (rate limited) |
| <http://localhost:4000/files/> | Generated artifacts |

## Deployed (Render)

| URL | What |
| --- | --- |
| `https://<api-host>/` | The UI, served by the API from the same origin |
| `https://<api-host>/api/health` | Health check |
| `https://<api-host>/mcp` | **Your MCP endpoint** — same service, nothing extra to deploy |
| `https://<worker-host>/health` | CadQuery worker health |

`plugin/cadforge-mcp/mcp.json` already points at `https://cadforge.onrender.com/mcp`; change the
`url` to your actual API host.
