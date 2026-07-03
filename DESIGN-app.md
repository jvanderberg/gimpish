# gimpish — app packaging & MCP plan

Status: design. Follows on from `DESIGN.md` (which covers the core engine, CLI, and
serve loop, all shipped). This doc memorializes the decisions for the next phases:
semantic selection, the document/file model, and bundling gimpish as a desktop app
with an MCP server.

---

## 1. Positioning (what we're protecting)

Findings from a landscape review (mid-2026):

- Every ingredient of gimpish exists elsewhere: JSON scene models with headless
  render (Polotno et al.), local background removal (rembg/U²-Net), MCP image
  servers in quantity, CLI-first agent tooling as a general trend.
- What does **not** exist packaged: a validated scene file that an LLM and a human
  edit **as peers** — CLI verbs, direct JSON edits, and browser direct-manipulation
  all writing the same contract, fully local, with content-based undo that doesn't
  care who wrote.
- The moat is not the code (a working clone is a day of agent-assisted work). The
  durable assets are (a) the **scene contract and verb set** — the candidate
  convention agents reach for — and (b) the design judgment encoded in it
  (semantic verbs shaped by observed LLM failure modes, e.g. `layer fit` because
  agents botch placement arithmetic).

Scope discipline, restated: gimpish is **composition, not digital art**. LLMs work
in discrete, parameterized, verifiable operations; composition is exactly that
domain ("subject fills 75%, anchored right" is checkable from a preview; brushwork
is not). GIMP-scale tool surfaces give an agent capabilities it can't use while
making the usable subset more expensive. Do not grow the verb surface toward an
art tool.

---

## 2. Semantic selection (the killer feature)

Extends the existing `layer mask` verb; no new concepts.

**Phase 1 — the LLM is the grounder.** The agent already has vision: it looks at
the preview, decides where "the red bag" is, and passes geometry to a local SAM2
(small variant, ONNX):

```bash
gimpish layer mask subject --box 420,310,280,240
gimpish layer mask subject --points 560,430
```

- Runs under onnxruntime — the runtime we already ship for U²-Net; same
  download-once model-cache pattern (`~/.u2net/`-style).
- Mask output lands in `.scene_cache/` like a cutout; the preview loop is the
  verification step (render mask overlay → agent looks → adjusts points).
- Reuses every piece of existing infrastructure; puts the semantic intelligence
  in the agent, not another bundled model. Weekend-scale.

**Phase 2 — native text prompts.** `layer mask subject --select "the red bag"`
via SAM 3 (text-prompted) or GroundingDINO+SAM2 if SAM 3 local packaging is
awkward. Arrives behind the same verb; nothing breaks.

**Design decision to make up front:** multi-instance ambiguity. "The red bag" may
match three objects. The verb must either return candidates (indexed overlay
preview for the agent to pick from) or accept a disambiguating point. This is the
only place the API shape isn't obvious.

---

## 3. File model

### 3.1 The directory is the document

A scene is not a self-contained file — it references sources, `assets/`, and
`.scene_cache/`. It is directory-shaped state, and gets the convention every
directory-shaped tool uses (git, cargo, docker-compose): **cwd is the workspace,
state at a well-known filename, no file argument**. gimpish is `cargo` for
compositions, not `vim` for compositions.

The cwd default is load-bearing for agents: a session's cwd is its ambient state;
threading `--scene` through forty commands is token overhead plus a silent
wrong-scene failure mode. `serve`'s watch loop, browser drag-drop, and the cache
dir all assume "this directory is the composition."

`scene.json` never gets renamed — it is the well-known filename *inside* the
document (like `Info.plist` inside an `.app`). The document's name is its
directory's / bundle's name.

### 3.2 Scene switching: explicit and loud, never sticky

Three places selection can live: ambient (cwd), explicit (flag), sticky (a
`gimpish use` context pointer). **Sticky context is rejected** — it's kubectl's
current-context model, error-prone precisely because the state that determines
what you're touching is invisible at the call site; worst for an agent resuming a
session with no memory of having "switched." Env vars rejected too: agent
harnesses run each shell call fresh.

Instead:

- **Directory as handle**: `gimpish -C ../banner add logo.png` (git/make-style);
  `--scene` accepts a directory and resolves `scene.json` inside it.
- **Echo the resolved scene in every command's output**
  (`added layer 'logo' → ../banner/scene.json`) — converts wrong-scene mistakes
  from silent corruption into same-turn detection. Biggest safety payoff per line
  of code in this doc.
- **Never auto-create on miss**: every verb except `init` hard-errors if no scene
  exists at the resolved location.
- **`init` scaffolds a directory** (`gimpish init card/`); bare `init` in a
  non-empty directory warns or requires `--here`.

Interleaved editing of two scenes in one command stream is intrinsically
error-prone under every model; explicit-flag-plus-echo is the mitigation, not a
comfortable multi-scene mode.

### 3.3 `.gimpish` is the file-shaped document

- **Zip at rest** (cross-platform: Windows/Linux have no macOS package concept),
  extracted **working directory as live state**. Never edit inside the zip — no
  in-place member updates; repacking 100 MB per drag-commit is a dead end. Model
  is OOXML/LibreOffice: extract on open, work in the directory, repack on
  (debounced auto)save and close.
- CLI symmetry: `gimpish open foo.gimpish` / `gimpish pack`. Bundle vs directory
  is git's archive-vs-worktree relationship.
- macOS document-package dressing (Finder shows the directory as a file) is
  deferred polish, not the model.

---

## 4. Desktop app (Electron)

### 4.1 Why Electron

The engine is Node with native deps. Both native modules — **sharp and
onnxruntime-node — are N-API, therefore ABI-stable across Node and Electron**: no
electron-rebuild, no per-version binary matrix. Tauri would still need Node as a
sidecar (two runtimes to save disk). The app is a shell around the existing
serve stack.

### 4.2 Architecture

- **`packages/app`**: thin main process — run the existing Fastify engine
  in-process on a localhost port, `BrowserWindow` → `loadURL`. The web UI already
  speaks pure HTTP to `/api`, so almost no IPC: `contextIsolation` on,
  `nodeIntegration` off; Electron-specific code is menus, dialogs, dock. Main
  process is bundled with esbuild (the one build step gained — Electron's Node
  doesn't type-strip .ts).
- **CLI without requiring Node**: "Install command line tools" writes a `gimpish`
  shim exec'ing the bundled Electron binary with `ELECTRON_RUN_AS_NODE=1`
  pointing at the CLI entry (the VS Code `code` pattern). Dev `npx gimpish`
  unchanged.
- **electron-builder**: `fileAssociations` for `.gimpish`; `asarUnpack` for
  `.node` binaries and sharp/onnxruntime vendor dirs (native code cannot load
  from inside asar — the packaging gotcha that will definitely bite);
  mac signing/notarization; per-arch artifacts. U²-Net stays download-on-first-use
  — 176 MB doesn't belong in the installer.
- **Single-instance lock**, one window per document; second open focuses the
  existing window, so there is exactly one daemon per workspace.
- **Port discovery**: bind port 0, write actual port + PID to the per-workspace
  `.scene_cache/serve.json`.

### 4.3 Document lifecycle in the app

- **Working directories live under userData**
  (`~/Library/Application Support/gimpish/workspaces/<doc-id>/` and platform
  equivalents), **never OS /tmp** — the working dir is the crash-recovery story
  and must survive reboots. "Restore unsaved document" on next launch.
- **New**: asks name + canvas size, creates the working dir immediately; the
  save dialog (where the `.gimpish` lives) appears on first save. Untitled-style
  deferred saving is safe *because* saving is a repack, not a directory move —
  no watcher breakage. (In pure-CLI mode, name-and-location still comes first
  via `init <dir>`.)
- **Open Folder** remains first-class: bare-directory workspaces (a repo with
  `scene.json` at root — the current agent workflow) are fully supported.

### 4.4 Write mediation

With the app running, it is the **single writer** for its documents: the CLI
detects a live server owning the scene (via `serve.json`) and routes commands
through HTTP; otherwise it operates on files directly as today. Transparent to
the agent; kills the rembg cold start whenever the app is open (warm
onnxruntime = the resident daemon `DESIGN.md` deferred); undo history becomes
durable in the app process; file-locking questions evaporate. Until then,
atomic-rename write discipline on `scene.json`.

---

## 5. MCP server (in the app process)

The CLI surface was already designed as a small set of semantic verbs, so the MCP
tool list is a 1:1 transcription — `add_layer`, `fit_layer`, `remove_bg`,
`draw_text`, `export`, … This avoids the GIMP-MCP failure mode (50 low-level
tools orchestrating menu-clicks).

- **One endpoint for the whole app** (streamable HTTP on a **fixed** localhost
  port so the user's registered config survives restarts). Documents addressed
  *inside* the protocol: `list_documents` tool + a `document` parameter on verbs,
  defaulting to the focused window. One-server-per-document is a dead end
  (config churn on every open).
- **Inline preview images in tool responses** — the agent's edit-look-adjust loop
  becomes one tool call, no file juggling. This plus warm models is what makes
  app-hosted MCP genuinely better than CLI, not just equivalent.
- **`get_scene` / `set_scene` tools** — preserves the founding property that the
  JSON is the API (batch tweaks, same zod validation, same loud failures) even
  when the working dir is app-managed.
- A "Set up Claude Code / MCP" menu item prints or writes the client config
  snippet (one-time registration).
- **The headless path stays fully intact**: `gimpish -C dir/` with no app running
  must keep working exactly as today — CI, repo-embedded scenes, server-side
  agent sessions have no Electron. Same engine, three doors: CLI on a directory,
  app window for humans, MCP into the app when it's running.

Note "local LLMs" is a client choice, orthogonal to gimpish: any MCP client
(Claude Code included) reaches localhost. What gimpish guarantees is that tool
execution — rendering, background removal, the images themselves — stays local.

---

## 6. Sequencing

Each phase lands value on its own and nothing invalidates current work:

1. **File-model hardening** (pure CLI, no app): `-C` / directory-as-scene
   addressing, resolved-scene echo in every output, hard error on missing scene,
   `init <dir>` scaffolding, atomic-rename saves. Cheap, immediately useful.
2. **Semantic selection phase 1**: SAM2 behind `layer mask --box/--points`;
   decide the multi-instance/candidates API shape here.
3. **Bundle symmetry**: `gimpish open <bundle>` / `gimpish pack` (zip already
   exists via serve's `/api/bundle`).
4. **Daemon handshake**: `serve.json` advertisement + CLI routes through a live
   server. Pays off today (warm models under `gimpish serve`) and is the app's
   write-mediation layer.
5. **MCP server** on the serve process (before Electron — it's just routes on
   the same Fastify app, testable headless).
6. **Electron shell** (`packages/app`): window + lifecycle + file association +
   CLI shim + packaging. By this point it is, true to form, just another client.
7. **Semantic selection phase 2** (`--select "text"`) when SAM 3-class local
   packaging is mature.
