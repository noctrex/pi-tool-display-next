<div align="center">

# pi-tool-display-next

Actively maintained fork of [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display), modernized for **Pi 1.x**. Compact tool call rendering, diff visualization, and output truncation for the Pi coding agent.

Requires Pi >= 1.0. Install as a Pi package: `pi install npm:pi-tool-display-next`.

[![npm version](https://img.shields.io/npm/v/pi-tool-display-next?style=for-the-badge)](https://www.npmjs.com/package/pi-tool-display-next)
[![License](https://img.shields.io/github/license/noctrex/pi-tool-display-next?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y01PSSVR)

OpenCode-style tool rendering for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-tool-display-next` keeps tool calls compact by default, adds richer diff rendering for file edits, and improves a few core chat UI details such as thinking labels and the native user prompt box. Rendering goes through Pi's official `pi.registerToolRenderer` resolver API, so MCP tools, codemode calls, and late-registered extension tools all render without touching the tool objects themselves. Requires Pi >= 1.0.

<img width="1360" height="752" alt="image" src="https://github.com/user-attachments/assets/777944a2-18b2-4642-b035-2c703a5abb1b" />

<img width="978" height="670" alt="image" src="https://github.com/user-attachments/assets/122b69ce-6c99-4aaa-ba93-236f97a1d8b4" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/7d5e36d3-cbe1-4d54-8bed-ae3dbdef870c" />
<img width="1919" height="566" alt="image" src="https://github.com/user-attachments/assets/68a1619b-62da-480f-8de3-2af441ccf6ff" />
<img width="1919" height="550" alt="image" src="https://github.com/user-attachments/assets/1d3f0b38-a5b5-47fc-b54b-8b55cc2bfaf1" />

</div>

## This fork vs the old tool

This fork replaces the upstream rendering engine. Upstream `pi-tool-display` (v0.5.0 and earlier) wraps tool objects through `pi.registerTool` interception and discovers tool ownership with `getAllTools()` sweeps during `before_agent_start`. That machinery is inert or harmful on Pi 1.x and is fully removed here. This fork renders through the official `pi.registerToolRenderer` resolver API, stores config at `<agent-dir>/pi-tool-display-next.json`, and requires Pi >= 1.0.

The sections below document THIS fork. Beware when reading the upstream project's README, its older releases, or any inherited text that mentions tool wrapping, decoration, ownership discovery, or the bare `pi-tool-display` package name: that content describes the OLD tool only and does not apply to this fork. In particular, `pi install npm:pi-tool-display` installs the outdated upstream package, not this one.

## Features

- **Compact built-in tool rendering** for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- **MCP-aware rendering** with hidden, summary, and preview modes
- **Opt-in custom tool overrides** for noisy extension tools, defaulting to generic rendering unless `kind: "mcp"` is selected
- **Adaptive edit/write diffs** with split or unified layouts, syntax highlighting, inline emphasis, and narrow-pane width clamping
- **Workspace-scoped projected pending edit/write previews** that show `pending edit`, `pending overwrite`, and `pending create` diffs while partial tool calls are still streaming
- **Progressive collapsed diff hints** that shorten automatically on small terminal widths instead of overflowing
- **Hashline-anchor diff gutters** that preserve `LINE#HASH` labels from anchored read/edit output when those lines are rendered in diffs
- **Three presets**: `opencode`, `balanced`, and `verbose`
- **Thinking labels** during streaming and final message rendering, with context sanitization to avoid leaking presentation labels back into future model turns
- **Optional native user message box** with markdown-aware rendering and safer ANSI/background handling
- **Per-tool claim toggles** so this extension can coexist with other renderer extensions; unclaimed tools fall through to `next()` untouched
- **Capability-aware settings** that keep MCP and RTK-specific controls aligned with the current environment
- **Adapter API for renderer consumers** through the `pi-tool-display-next/tool-display-api-consumer` subpath export

## Installation

### npm package

```bash
pi install npm:pi-tool-display-next
```

Do NOT install `npm:pi-tool-display` - that is the unmaintained upstream package targeting Pi 0.8x.

### Git repository

```bash
pi install git:github.com/noctrex/pi-tool-display-next
```

### Local checkout (development)

```bash
pi --extension /path/to/pi-tool-display-next/index.ts
```

## Usage

### Interactive settings

Open the settings modal:

```text
/tool-display
```

The modal exposes the day-to-day controls most people change regularly:

- preset profile
- read output mode
- grep/find/ls output mode
- MCP output mode (when MCP is available)
- preview line count
- bash collapsed line count
- diff layout mode
- native user message box toggle

Advanced options remain in `pi-tool-display-next.json`.

### Direct commands

```text
/tool-display show                    # Show the effective config summary
/tool-display reset                   # Reset to the default opencode preset
/tool-display preset opencode         # Apply opencode preset
/tool-display preset balanced         # Apply balanced preset
/tool-display preset verbose          # Apply verbose preset
```

### Tool display adapter API

Other extensions can opt into rendering without depending on this extension's load order by importing the consumer helper:

```ts
import { decorateToolForDisplay, decorateMcpToolForDisplay } from "pi-tool-display-next/tool-display-api-consumer";
```

`decorateToolForDisplay(tool, adapter)` registers a render adapter keyed by the tool's name and returns the tool unchanged; Pi draws the tool through this extension's `registerToolRenderer` resolver regardless of which extension loaded first. If the API is not available yet, the call queues until the API appears. Use adapter options such as `kind: "read" | "edit" | "mcp" | "generic"` to select the renderer family; `decorateMcpToolForDisplay(tool)` is the shortcut for MCP-style tools. The tool object itself is never modified, so `outputSchema` and structured results pass through untouched.

## Presets

| Preset | Read Output | Search Output | MCP Output | Bash Output | Preview Lines | Bash Lines |
|--------|-------------|---------------|------------|--------------|---------------|------------|
| `opencode` | hidden | hidden | hidden | opencode | 8 | 10 |
| `balanced` | summary | count | summary | summary | 8 | 10 |
| `verbose` | preview | preview | preview | preview | 12 | 20 |

- **`opencode`** (default): minimal inline-only display; tool results stay collapsed
- **`balanced`**: compact summaries with line counts and match totals; bash shows line count only
- **`verbose`**: larger previews for read/search/MCP/bash output

### Bash Output Modes

| Mode | Behavior |
|------|----------|
| `opencode` | Classic collapsed output using `bashCollapsedLines` limit with expansion hint |
| `summary` | Shows only line count (e.g., "3 lines returned") - no output displayed |
| `preview` | Shows actual output lines using `previewLines` limit |

## Configuration

Runtime configuration is stored at:

```text
Default global path: ~/.pi/agent/pi-tool-display-next.json
Actual global path: $PI_CODING_AGENT_DIR/pi-tool-display-next.json when PI_CODING_AGENT_DIR is set
```

A starter template is included at `config/config.example.json`. On first load after upgrading from the pre-fork releases, an existing `extensions/pi-tool-display/config.json` is imported once to the new location; the old file is left in place.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `debug` | boolean | `false` | Opt-in file logging for extension diagnostics; missing values are treated as `false` |
| `enabled` | boolean | `true` | Master switch for the extension's rendering |
| `registerToolOverrides` | object | all `true` | Built-in tool rendering claim flags |
| `customToolOverrides` | object | `{}` | Explicit opt-in rendering rules for non-built-in extension tools |
| `enableNativeUserMessageBox` | boolean | `true` | Enable bordered user prompt rendering |
| `thinkingLabel` | boolean | `false` | Label thinking blocks and set Pi's collapsed thinking label (accent colored); off by default |
| `readOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `searchOutputMode` | string | `"hidden"` | `hidden`, `count`, or `preview` |
| `mcpOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `codemodeOutputMode` | string | `"calls"` | Codemode script rows: `calls` (collapsed status + call count), `summary`, or `preview` |
| `previewLines` | number | `8` | Lines shown in collapsed preview mode |
| `expandedPreviewMaxLines` | number | `4000` | Max preview lines when fully expanded |
| `bashOutputMode` | string | `"opencode"` | `opencode` (collapse), `summary` (line count), or `preview` (show lines) |
| `bashCollapsedLines` | number | `10` | Lines shown for collapsed bash output (opencode mode) |
| `bashCommandMaxChars` | number | `0` | Truncate long bash commands to this many characters before display (`0` disables) |
| `bashIntentMode` | string | `"off"` | `off`, `render` (show `# intent:` comment as a header line), or `render-and-instruct` |
| `bashIntentShowCommand` | boolean | `false` | Also show the raw command under the intent header |
| `diffViewMode` | string | `"auto"` | `auto`, `split`, or `unified` |
| `diffIndicatorMode` | string | `"bars"` | `bars` (vertical indicators), `classic` (+/- markers), or `none` |
| `diffSplitMinWidth` | number | `120` | Minimum width before auto mode prefers split diffs |
| `diffCollapsedLines` | number | `24` | Diff lines shown before collapsing |
| `diffWordWrap` | boolean | `true` | Wrap long diff lines when needed |
| `allowExternalDiffPreviews` | boolean | `false` | Allow pending edit/write diff previews for paths outside the active workspace |
| `showTruncationHints` | boolean | `false` | Show truncation indicators for compacted output |
| `showRtkCompactionHints` | boolean | `false` | Show RTK compaction hints when RTK metadata exists |

### Built-in tool claims

Use `registerToolOverrides` to control which built-in tools this extension claims for rendering:

```json
{
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  }
}
```

Set any entry to `false` to leave that tool's rendering to Pi or another renderer extension; the resolver returns `next()` for unclaimed tools.

> Changes take effect after `/reload`.

### Custom tool overrides

Use `customToolOverrides` when another extension registers a noisy top-level tool and you want `pi-tool-display-next` to render that tool's call/result output. The resolver checks these entries at render time, so tools that register after this extension resolves correctly without extra wiring. Custom overrides are explicit opt-in only: unlisted or disabled tools keep their original renderers.

```json
{
  "customToolOverrides": {
    "ide_find_symbol": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    },
    "custom_mcp_gateway": {
      "enabled": true,
      "kind": "mcp",
      "outputMode": "preview"
    }
  }
}
```

Each entry supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether `pi-tool-display-next` claims this custom tool for rendering |
| `kind` | string | `"generic"` | `generic` for plain compact output, or `mcp` for MCP-style call labels and result handling |
| `outputMode` | string | `"summary"` | `hidden`, `summary`, or `preview` for this custom tool's result output |

Boolean shorthand is also accepted:

```json
{
  "customToolOverrides": {
    "ide_find_symbol": true,
    "noisy_tool_to_leave_alone": false
  }
}
```

Notes:

- Built-in tool names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) are ignored here; use `registerToolOverrides` for those.
- `generic` call rendering shows the tool name and argument count, then compacts the result according to `outputMode`.
- `mcp` call rendering understands MCP proxy-style arguments such as `tool`, `server`, `search`, `describe`, and `connect`.
- Changes to the config file take effect after `/reload`; tool registration order no longer matters because resolution happens at render time.

### Example config

```json
{
  "debug": false,
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  },
  "customToolOverrides": {
    "ide_find_symbol": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    },
    "custom_mcp_gateway": {
      "enabled": true,
      "kind": "mcp",
      "outputMode": "preview"
    }
  },
  "enableNativeUserMessageBox": true,
  "thinkingLabel": false,
  "readOutputMode": "summary",
  "searchOutputMode": "count",
  "mcpOutputMode": "summary",
  "codemodeOutputMode": "calls",
  "previewLines": 12,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 15,
  "bashCommandMaxChars": 0,
  "bashIntentMode": "off",
  "bashIntentShowCommand": false,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "allowExternalDiffPreviews": false,
  "showTruncationHints": false,
  "showRtkCompactionHints": false
}
```

### Debug logging

Debug logging is disabled by default. Set `debug` to `true` in the runtime config file (`~/.pi/agent/pi-tool-display-next.json`) only when collecting diagnostics; missing or non-`true` values are treated as `false`. When enabled, diagnostics are appended to `debug/debug.log` under a runtime-created `debug/` directory, and no debug output is written to the terminal.

## Rendering notes

### Edit and write diffs

`edit` and `write` results use the same diff renderer. In `auto` mode the extension chooses split or unified layout based on available width. On narrow panes it clamps rendered lines and shortens collapsed hint text so the diff stays readable instead of spilling past the terminal width.

While tool arguments are still streaming, partial `edit` and `write` calls can show projected pending previews. Deterministic edits render as `pending edit` diffs against current file contents, writes render as `pending overwrite` or `pending create`, and unresolved projections show a clear preview notice instead of guessing. Preview file reads are scoped to the active workspace so pending previews avoid reading paths outside the current project.

When diff input includes Pi anchored read lines such as `12#AB:content`, the renderer treats the anchor as line metadata and displays the `LINE#HASH` label in the gutter while keeping the content aligned for split, unified, and compact diff layouts.

### Write summaries

When content is available, `write` call summaries include line count and byte size information inline so you can quickly see the size of the pending write before expanding the result.

### Thinking labels

Off by default. When `thinkingLabel` is enabled, thinking blocks are labeled during streaming and on final messages, and the collapsed thinking row uses Pi's `setHiddenThinkingLabel` API with an accent-colored label. Before the next model turn, the extension sanitizes those presentation labels out of the stored assistant context so they do not accumulate or pollute future prompts.

### Native user message box

When enabled, user prompts render inside a bordered box using Pi's native user message component. The renderer preserves markdown content more safely and normalizes ANSI/background handling to avoid odd nested background artifacts.

## Capability detection

The extension checks the current Pi environment and adjusts behavior automatically:

- **MCP tooling unavailable at startup**: MCP settings can be hidden from the modal, but the configured MCP output mode is preserved because MCP tools may register later
- **RTK optimizer unavailable**: RTK hint settings are hidden and RTK compaction hints are disabled

This keeps the UI aligned with the current environment while still allowing dynamically registered MCP tools to be styled when they appear.

## Troubleshooting

### Reload safety

`/reload` is fully supported. On reload, the extension cleans up all tool overrides, prototype patches, timers, and event handlers through its built-in disposal registry, then re-registers everything on the next session lifecycle event. No manual cleanup is needed.

### Renderer conflicts

If another renderer extension claims one of the built-in tools:

1. Set `registerToolOverrides.<tool>` to `false`
2. Run `/reload`
3. Use `/tool-display show` to confirm the effective claim state

Resolvers compose in extension load order: for a tool this extension does not claim, the resolver returns `next()` untouched, so the other renderer or Pi's native renderer wins. No ownership discovery runs - the old `getAllTools()` / `before_agent_start` machinery described by the upstream README does not exist in this fork.

### Config not loading

If your settings are not being applied:

1. Check that the global Pi tool-display config exists (default: `~/.pi/agent/pi-tool-display-next.json`, respects `PI_CODING_AGENT_DIR`)
2. Make sure the JSON is valid
3. Run `/tool-display show` to inspect the effective config summary

### MCP or custom tool rendering not appearing

MCP tools are resolved through `pi.registerToolRenderer` at render time, including tools that register after this extension loads or reappear when a session resumes. If MCP tools still appear unstyled, check that the tool's name or parameter schema matches one of the supported MCP detection heuristics (names containing `mcp`, `server:`, `ctx_`, or parameter schemas with `mcpServer`/`serverUrl`/`server_name`).

For non-MCP extension tools, or MCP-like tools that do not match the heuristics, add the exact tool name under `customToolOverrides` and run `/reload`. Use `kind: "generic"` for ordinary tools and `kind: "mcp"` for MCP proxy-style arguments.

### MCP or RTK settings missing

Those controls only appear when the corresponding capability is available in the current Pi environment.

## Project structure

```text
pi-tool-display-next/
|-- index.ts                          # Extension entrypoint
|-- tool-display-api-consumer.d.ts    # Consumer helper type declarations
|-- tool-display-api-consumer.js      # Consumer helper (adapter API)
|-- config/
|   `-- config.example.json           # Starter config template
|-- src/
|   |-- index.ts                      # Bootstrap and extension registration
|   |-- agent-dir.ts                  # PI_CODING_AGENT_DIR resolution
|   |-- ansi-utils.ts                 # ANSI helpers (wrapping, stripping)
|   |-- bash-display.ts               # Bash output modes, truncation
|   |-- bash-intent.ts                # `# intent:` header parsing and rendering
|   |-- capabilities.ts               # MCP/RTK capability detection
|   |-- codemode-display.ts           # Codemode row rendering
|   |-- config-modal.ts               # /tool-display settings UI and command handling
|   |-- config-store.ts               # Config load/save, normalization, legacy import
|   |-- debug-logger.ts               # Opt-in debug logging
|   |-- diff-presentation.ts          # Diff presentation helpers
|   |-- diff-renderer.ts              # Edit/write diff rendering engine
|   |-- disposable.ts                 # Reload-safe cleanup registry
|   |-- extension-lifecycle.ts        # Session lifecycle wiring
|   |-- line-width-safety.ts          # Width clamping helpers for narrow panes
|   |-- modal-icons.ts                # Modal icon assets
|   |-- pending-diff-preview.ts       # Partial edit/write preview projection
|   |-- presets.ts                    # Preset definitions and matching
|   |-- render-utils.ts               # Shared rendering helpers
|   |-- settings-inspector-modal.ts   # Settings inspector UI
|   |-- thinking-label.ts             # Thinking label gating and sanitization
|   |-- tool-metadata.ts              # MCP candidate detection helpers
|   |-- tool-overrides.ts             # registerToolRenderer resolver and render adapters
|   |-- types.ts                      # Shared config and type definitions
|   |-- user-message-box-*.ts         # Native user message box (patch, render, markdown, utils)
|   |-- write-display-utils.ts        # Write summary helpers
|   `-- zellij-modal.ts               # Modal UI primitives
`-- tests/                            # 38 node:test suites run by `npm run test`
```

## Development

```bash
# Type check
npm run build

# Run tests
npm run test

# Full verification
npm run check
```

## Related Pi Extensions

- [pi-image-tools](https://github.com/MasuRii/pi-image-tools) - Image attachment and inline preview for the Pi TUI
- [pi-hide-messages](https://github.com/MasuRii/pi-hide-messages) - Hide older chat messages without losing context
- [pi-startup-redraw-fix](https://github.com/MasuRii/pi-startup-redraw-fix) - Fix terminal redraw glitches on startup
- [pi-permission-system](https://github.com/MasuRii/pi-permission-system) - Permission enforcement for tool and command access

## License

[MIT](LICENSE)
