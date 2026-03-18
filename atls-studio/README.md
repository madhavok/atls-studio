# ATLS Studio

AI-First IDE powered by ATLS - where the AI is the developer and you are the director.

## Vision

ATLS Studio is a minimal, purpose-built development environment where ATLS provides the intelligence and Claude provides the conversation. The four-panel layout gives you everything you need to understand and improve your codebase.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  ATLS Studio                                                         │
├─────────────┬─────────────────────────────┬──────────────────────────┤
│             │                             │                          │
│  FILE       │  CODE VIEWER                │  AI ASSISTANT            │
│  EXPLORER   │                             │                          │
│             │  Monaco Editor              │  Chat with Claude        │
│  Browse     │  Syntax highlighting        │  powered by ATLS         │
│  files      │  Read/Edit mode             │                          │
│             │                             │  Ask about code          │
│             ├─────────────────────────────┤  Find issues             │
│             │                             │  AI-powered fixes        │
│             │  ATLS INTELLIGENCE          │                          │
│             │                             │                          │
│             │  Issue detection            │                          │
│             │  AI fix suggestions         │                          │
│             │  Severity filtering         │                          │
└─────────────┴─────────────────────────────┴──────────────────────────┘
```

## Tech Stack

- **Tauri 2.0** - Rust-powered native shell, 10x smaller than Electron
- **React 18** - Modern UI framework
- **TypeScript** - Type-safe frontend development
- **Monaco Editor** - VS Code's editor engine
- **Tailwind CSS** - Utility-first styling
- **Zustand** - Lightweight state management
- **ATLS** - AI-native code intelligence (via StudioBridge)
- **Claude API** - AI chat integration

## Prerequisites

1. **Rust** - [Install Rust](https://www.rust-lang.org/learn/get-started)
2. **Node.js** - Version 20 or later
3. **ATLS** - The parent ATLS project

## Getting Started

### Install Dependencies

```bash
cd atls-studio
npm install
```

### Development Mode

```bash
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri window.

### Build for Production

```bash
npm run tauri build
```

Creates platform-specific installers in `src-tauri/target/release/bundle/`.

### Testing

```bash
npm run test        # Frontend tests (Vitest)
npm run test:all    # Frontend + Rust backend tests
```

HPP validation tests (parser, materialization, ref formatting) run as part of `npm run test` via `src/__tests__/hpp-validation.test.ts`. A standalone script `test-hpp-validation.ts` exists at the workspace root for manual runs (`npx tsx test-hpp-validation.ts` from repo root).

## Project Structure

```
atls-studio/
├── src/                 # React frontend
│   ├── components/
│   │   ├── FileExplorer/    # File tree browser
│   │   ├── CodeViewer/      # Monaco editor
│   │   ├── AtlsPanel/       # Issues and fixes
│   │   └── AiChat/          # Claude chat interface
│   ├── stores/          # Zustand state
│   ├── hooks/           # Custom React hooks
│   ├── App.tsx          # Main app layout
│   └── main.tsx         # Entry point
├── src-tauri/           # Rust backend
│   ├── src/
│   │   └── lib.rs       # Tauri commands
│   └── Cargo.toml       # Rust dependencies
├── tailwind.config.js   # Tailwind theme
└── package.json
```

## Features

### File Explorer
- Hierarchical tree view
- File type icons by language
- Quick search filter
- Expand/collapse folders

### Code Viewer
- Monaco editor with syntax highlighting
- Tab management for open files
- Read-only default, edit mode available
- Dark theme optimized for coding

### ATLS Intelligence Panel
- Real-time issue detection
- Severity indicators (High/Medium/Low)
- Category filtering (Security, Performance, etc.)
- AI-powered fix suggestions via chat

### AI Chat
- Natural language interface
- Context-aware responses
- Suggested action prompts
- Quick action buttons
- Conversation history

## Fixing Issues

ATLS Studio uses AI-powered fixes via `edit(line_edits)` instead of pre-defined auto-fixers. When issues are detected:

1. **Find issues** - `find_issues()` detects code issues across your project
2. **Ask AI** - Chat with Claude about the issues
3. **AI generates fix** - Claude analyzes context and generates appropriate fixes
4. **Apply via edit** - Fixes are applied through line-level edits with symbol anchors

This approach provides more contextual, intelligent fixes compared to rigid pattern-based auto-fixers.

## Tauri Commands

The Rust backend provides these commands via IPC:

```rust
// File system
get_file_tree(path: String) -> Vec<FileNode>
read_file_contents(path: String) -> String
write_file_contents(path: String, contents: String)

// ATLS bridge
scan_project(root_path: String, full_rescan: bool)
get_scan_status() -> ScanStatus
get_issue_counts() -> IssueCounts
find_issues(root_path: String, category: Option<String>, severity: Option<String>) -> Vec<Issue>
```

## Configuration

### Tailwind Theme

Custom colors in `tailwind.config.js`:

```javascript
colors: {
  studio: {
    bg: '#0d1117',      // Background
    surface: '#161b22', // Panel surfaces
    border: '#30363d',  // Borders
    text: '#c9d1d9',    // Primary text
    muted: '#8b949e',   // Secondary text
    accent: '#58a6ff',  // Accent color
    success: '#3fb950', // Success/fix
    warning: '#d29922', // Warning
    error: '#f85149',   // Error/high severity
  }
}
```

## Integration with ATLS

ATLS Studio communicates with the ATLS StudioBridge API:

```typescript
// From ATLS
import { StudioBridge } from 'atls/studio';

const bridge = new StudioBridge('/path/to/project');

bridge.on('scan:progress', (data) => {
  console.log(`Scanning: ${data.percent}%`);
});

await bridge.initialize();
const issues = await bridge.findIssues({ severity: 'high' });
```

## License

See LICENSE file in parent ATLS project.
