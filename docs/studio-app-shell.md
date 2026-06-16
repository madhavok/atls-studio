# Studio App Shell

## What It Is

The Studio app shell is the desktop user interface for ATLS Studio. It combines a React/Vite frontend with a Tauri host window to present the code workspace, ATLS intelligence surfaces, and AI chat in a single desktop workflow.

This subsystem is the operator-facing layer of ATLS. It does not implement the cognitive runtime itself; instead, it gives users a place to drive the runtime, inspect project state, and interact with the backend services that power code intelligence and chat.

## Why It Exists

The runtime docs describe how ATLS manages memory, freshness, and prompt assembly, but users still need a practical shell for exploring files, reading and editing code, managing sessions, and running chats or swarm workflows. The Studio app shell provides that desktop control surface.

## Main Responsibilities

- Render the main multi-panel workspace: file explorer, code viewer, ATLS panel, and AI chat.
- Manage shell-level UI state such as active files, panel sizes, theme, quick actions, search, and window controls.
- Route user actions into hooks and services that talk to the Tauri backend.
- Host session selection and swarm-specific views without embedding backend logic directly in the UI.
- Surface prompt metrics in chat (compression savings, freed tokens, cumulative input savings). Compression is driven by [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) (deflation + stubbing + rolling-window eviction); see [history-compression.md](./history-compression.md). The shell only displays the outputs.
- Offer **Copy context window (last API payload)** in the chat UI ([`AiChat/index.tsx`](../atls-studio/src/components/AiChat/index.tsx)): copies the most recently assembled provider payload JSON for debugging, regression reports, or comparing what the model actually received versus the on-screen transcript.

## Key Code Locations

- `atls-studio/src/App.tsx`: top-level application layout, keyboard shortcuts, modals, panel wiring, and platform-specific window behavior.
- `atls-studio/src/components/`: panel components and UI features such as `FileExplorer`, `CodeViewer`, `AiChat`, `AtlsPanel`, `SearchPanel`, `SessionPicker`, and `SwarmPanel`.
- `atls-studio/src/stores/`: Zustand stores for app state, cost state, swarm state, terminal state, and other shell-level concerns.
- `atls-studio/src/hooks/useAtls.ts`: project open/save/scan behavior and file-system-backed ATLS interactions.
- `atls-studio/src/hooks/useChatPersistence.ts`: session and memory persistence entry point from the UI side.

## Layout Model

The app shell centers around a persistent workspace layout:

- Left: file explorer and project navigation.
- Center: the **Agent Canvas** ([`ChatGridWorkspace`](../atls-studio/src/components/ChatGridWorkspace/index.tsx)), or the code viewer when a file is focused (document mode), with the canvas docked to the right.
- Bottom: ATLS intelligence and related lower-panel tooling.
- Right: per-window chat telemetry pane, collapsible.

This separation matters because the shell keeps UI composition independent from the runtime subsystems underneath it. The same chat and memory runtime can be surfaced through different views without changing the underlying storage or orchestration model.

### Agent Canvas

The Agent Canvas is a single, flat, pannable/zoomable surface of agent windows — there is no separate orchestration cockpit tab. Every window is first-class and freely positioned:

- **Window kinds**: `primary` (a parent chat session), `standard` (delegate/independent agent sessions), `swarm` (managed swarm-task windows), and `panel` (cockpit panels — Mission Control, Telemetry, Runtime Context, Agent Terminal — rendered as draggable windows via [`OrchestrationCockpit` body exports](../atls-studio/src/components/OrchestrationCockpit/index.tsx)).
- **Project-tagged**: each window carries its own `projectPath` and shows a project badge. Windows targeting different repos can coexist on one canvas; the selected (foreground) window owns the global ATLS active root while background windows register and open their own per-repo chat DB without clobbering it.
- **Geometry + persistence**: window rect, z-index, minimized, and pinned state, plus canvas pan/zoom, are stored per project in `agentWindowStore` (localStorage + `.atls-workspace` snapshot).
- **Auto-arrange**: `Grid`, `Tidy by project` (cluster by `projectPath`), and `Cascade`. Pinned and minimized windows are left in place.
- **Drag/resize**: [`CanvasFrame`](../atls-studio/src/components/ChatGridWorkspace/CanvasFrame.tsx) handles header-drag, corner-resize, bring-to-front, pin, minimize, and close. The dock variant renders the same windows as a simple vertical stack.

### ATLS Panel tabs

The ATLS panel ([`AtlsPanel/index.tsx`](../atls-studio/src/components/AtlsPanel/index.tsx)) exposes a set of tabs over the runtime state, each driven from the relevant Zustand store or Tauri command:

| Tab | Content |
|-----|---------|
| **Issues** | Detector findings for the active workspace (from `search.issues` / `find_issues`) |
| **File** (intel) | Per-file intelligence: symbols, imports, dependents, diagnostics |
| **Patterns** | Loaded detector patterns and categories (`get_patterns`) |
| **Overview** | Codebase overview stats and subsystem map (`get_codebase_overview`) |
| **Health** | Project health, scan progress, and index state |

The panel also splits with a terminal pane for `system.exec` output when agent runs need visible shell activity.

## How It Connects To Other Subsystems

- `Tauri Backend`: the shell uses Tauri `invoke()` calls and events to reach native file, search, AI, terminal, and persistence commands.
- `Session Persistence`: the shell triggers session creation, loading, autosave, and restore through the persistence hook.
- `Swarm And Orchestration`: swarm tasks surface as `swarm` windows on the Agent Canvas, and a Mission Control panel window provides plan approval, pause/resume, and recovery controls (no dedicated cockpit editor tab).
- `Cognitive Runtime`: the UI renders and manipulates the outputs of the runtime, but the runtime logic lives mostly under `src/services/` and `src/stores/`.

```mermaid
flowchart TD
  AppShell[Studio App Shell] --> Components[React Components]
  AppShell --> Stores[Zustand Stores]
  AppShell --> Hooks[Hooks and Services]
  Hooks --> Tauri[Tauri Backend]
  Hooks --> Persistence[Session Persistence]
  Hooks --> Swarm[Swarm Orchestration]
```

## Boundaries

The app shell should own presentation, interaction, and local UI state. It should not become the place where backend policies, database schemas, or orchestration rules are defined. Those responsibilities live in the backend and service layers.

## Related Documents

- [`atls-studio/docs/ARCHITECTURE.md`](../atls-studio/docs/ARCHITECTURE.md)
- [`docs/session-persistence.md`](./session-persistence.md)
- [`docs/swarm-orchestration.md`](./swarm-orchestration.md)
- [`docs/tauri-backend.md`](./tauri-backend.md)
- [`docs/engrams.md`](./engrams.md)
- [`docs/history-compression.md`](./history-compression.md)
