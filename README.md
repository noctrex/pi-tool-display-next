<div align="center">

# pi-tool-display-next

Compact, OpenCode-style tool rendering for the [Pi coding agent](https://github.com/mariozechner/pi). Fork of [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display), rebuilt for Pi >= 1.0 on the official `pi.registerToolRenderer` API.

[![License](https://img.shields.io/github/license/noctrex/pi-tool-display-next?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

</div>

## Install

From git (works today):

```bash
pi install git:github.com/noctrex/pi-tool-display-next
```

For local development:

```bash
pi --extension /path/to/pi-tool-display-next/index.ts
```

Not on npm yet - do not look for it there. Do NOT install `npm:pi-tool-display` either; that is the unmaintained upstream package for Pi 0.8x.

> Upstream's README and releases describe the old tool. Any text that mentions tool wrapping, decoration, ownership discovery, or the bare `pi-tool-display` package name applies to the old tool only, not this fork.

## What it does

- Claims the built-in tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) for rendering; unclaimed tools fall through to `next()` untouched, so other renderer extensions keep working
- MCP-aware rendering, including tools that register late or reappear on resume
- Adaptive edit/write diffs: split or unified layout, syntax highlighting, narrow-width clamping, streaming `pending edit` / `pending overwrite` / `pending create` previews, `LINE#HASH` gutter labels
- Collapsed codemode rows (status + call count), expandable
- Bash output modes, `# intent:` comment headers, command truncation
- Opt-in thinking labels; bordered native user message box
- `/tool-display` settings modal, three presets, adapter API for other extensions

## Usage

```text
/tool-display                  # open the settings modal
/tool-display show             # print the effective config summary
/tool-display reset            # back to the opencode preset
/tool-display preset <name>    # opencode | balanced | verbose
```

Modal controls: preset, read / search / MCP / codemode output modes, preview line count, bash output mode and collapsed lines, diff layout and indicator mode, native user message box toggle. MCP and RTK controls only appear when the environment supports them.

## Presets

| Preset | Read | Search | MCP | Bash | Preview lines | Bash lines |
|--------|------|--------|-----|------|---------------|------------|
| `opencode` (default) | hidden | hidden | hidden | collapsed | 8 | 10 |
| `balanced` | summary | count | summary | line count | 8 | 10 |
| `verbose` | preview | preview | preview | preview | 12 | 20 |

## Configuration

Stored at `<agent-dir>/pi-tool-display-next.json` (respects `PI_CODING_AGENT_DIR`). A pre-fork `extensions/pi-tool-display/config.json` is imported once and left in place. Starter template: `config/config.example.json`. Changes apply after `/reload`.

| Option | Default | Notes |
|--------|---------|-------|
| `enabled` | `true` | `false` exits the extension at load entirely |
| `registerToolOverrides` | all `true` | Per built-in tool rendering claims |
| `customToolOverrides` | `{}` | Opt-in rendering for named non-built-in tools |
| `enableNativeUserMessageBox` | `true` | Bordered user prompt box |
| `thinkingLabel` | `false` | Label thinking blocks; sets Pi's collapsed thinking label |
| `readOutputMode` | `hidden` | `hidden` / `summary` / `preview` |
| `searchOutputMode` | `hidden` | `hidden` / `count` / `preview` for grep, find, ls |
| `mcpOutputMode` | `hidden` | `hidden` / `summary` / `preview` |
| `codemodeOutputMode` | `calls` | `calls` (collapsed status + call count) / `summary` / `preview` |
| `previewLines` | `8` | Collapsed preview line budget |
| `expandedPreviewMaxLines` | `4000` | Cap when fully expanded |
| `bashOutputMode` | `opencode` | `opencode` (collapse) / `summary` (line count) / `preview` |
| `bashCollapsedLines` | `10` | Collapsed bash lines in opencode mode |
| `bashCommandMaxChars` | `0` | Truncate displayed bash commands (`0` = off) |
| `bashIntentMode` | `off` | `off` / `render` (intent header) / `render-and-instruct` (header + system prompt note) |
| `bashIntentShowCommand` | `false` | Show the raw command under the intent header |
| `diffViewMode` | `auto` | `auto` / `split` / `unified` |
| `diffIndicatorMode` | `bars` | `bars` / `classic` / `none` |
| `diffSplitMinWidth` | `120` | Min width before `auto` prefers split diffs |
| `diffCollapsedLines` | `24` | Diff lines shown before collapsing |
| `diffWordWrap` | `true` | Wrap long diff lines |
| `allowExternalDiffPreviews` | `false` | Pending previews for paths outside the workspace |
| `strictAnsiSanitization` | `false` | Strip every escape sequence and control byte from untrusted tool content (`true` loses colors that external programs add; matches stock Pi hygiene) |
| `showTruncationHints` | `false` | Truncation indicators on compacted output |
| `showRtkCompactionHints` | `false` | RTK hints when RTK is detected |
| `debug` | `false` | Append diagnostics to `debug/debug.log` in the install directory (1 MB cap, secret-shaped tokens redacted) |

Opt in a noisy tool from another extension:

```json
{
  "customToolOverrides": {
    "custom_mcp_gateway": { "enabled": true, "kind": "mcp", "outputMode": "preview" }
  }
}
```

Entries take `enabled` (default `true`), `kind` (`generic` or `mcp`), and `outputMode` (`hidden`, `summary`, `preview`). Resolution happens at render time, so registration order does not matter.

## Adapter API (for extension authors)

```ts
import { decorateToolForDisplay } from "pi-tool-display-next/tool-display-api-consumer";

decorateToolForDisplay(tool, { kind: "generic" });
```

Registers a render adapter under the tool's name and returns the tool unchanged. Pi renders it through this extension's resolver regardless of load order, and `outputSchema` plus structured results pass through untouched. `kind` is one of `"read"`, `"edit"`, `"mcp"`, `"generic"`.

## Troubleshooting

- Another renderer extension fights over a built-in tool: set its `registerToolOverrides` entry to `false`, then `/reload`
- Settings not applying: check the JSON parses, run `/reload`, then `/tool-display show`
- Unknown extension tool renders raw: add its name to `customToolOverrides` (`"kind": "generic"`, or `"mcp"` for MCP-style arguments)

## Development

```bash
npm install
npm run check    # typecheck + full test suite
```

## Credits

Fork of [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display). Also by the upstream author: [pi-image-tools](https://github.com/MasuRii/pi-image-tools), [pi-hide-messages](https://github.com/MasuRii/pi-hide-messages), [pi-startup-redraw-fix](https://github.com/MasuRii/pi-startup-redraw-fix), [pi-permission-system](https://github.com/MasuRii/pi-permission-system).

MIT - [LICENSE](LICENSE).
