# Verification handoff: pi-tool-display-next against the official Pi architecture

You are verifying a forked Pi extension that was just modernized for Pi 1.x. Work in `R:/repositories/MasuRii--pi-tool-display`. Your job is to VERIFY, not to re-implement. Report findings honestly; fix only what the failure protocol below allows.

## Context

- The repo is `noctrex/pi-tool-display-next`, a fork of `MasuRii/pi-tool-display` (upstream), modernized for Pi 1.x and released as v0.6.0 (tag `v0.6.0`).
- The modernization plan and its execution state live in `PLAN-pi-1x-modernization.md` at the repo root. Read it first: `read PLAN-pi-1x-modernization.md`.
- Last known state: 9 commits ahead of the upstream base, `npm run check` green locally (779 tests), CI green on GitHub with Node 22, one deferred task (row 34: upstream PR #27 project-level config) and one blocked step (npm publish - no registry credentials).

## Environment ground truth

- Installed Pi release (the authoritative architecture): `C:/Users/noctrex/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/` - docs in `docs/`, compiled API in `dist/`.
- The extension's devDependency resolves Pi 1.5.0; installed release is 1.4.0. Verify against the 1.4.0 docs AND confirm no API drift between 1.4.0 and the installed 1.5.0 dist (`rg "registerToolRenderer|setHiddenThinkingLabel" <pkg>/dist/core/extensions/types.d.ts`).
- Node must be >= 22.19.0 (Pi 1.5 requires it; it imports `fs.globSync`). Check `node --version` before anything else and report it.
- Per-session tool rules: no codebase-memory MCP; use direct file tools; never filter long-running command output - run once with `set -o pipefail; <cmd> 2>&1 | tee R:/Temp/<name>.log` and search the log afterward; scratch files go to `R:/Temp`, never `C:`.

## V1 - Repo and release state

1. `git status --short && git log --oneline -10 && git remote -v` - expect clean tree, `origin -> noctrex/pi-tool-display-next`, `upstream -> MasuRii/pi-tool-display`, HEAD at or after `a256563`.
1. `gh run list --repo noctrex/pi-tool-display-next --limit 3` - expect the latest runs green.
1. `git describe --tags` - expect `v0.6.0`.

## V2 - API conformance audit (the core check)

For each row, open the official declaration and the extension call site and confirm they match. Record pass/fail per row with the evidence line.

| #   | Official API (where to verify)                                                                                                                                            | Extension call site                                                               | What must hold                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pi.registerToolRenderer(resolver)` - `dist/core/extensions/types.d.ts` ~line 1256; `ToolRenderers` ~521; `ToolRendererResolver` ~526                                     | `src/tool-overrides.ts` - search `registerToolRenderer`                           | Exactly one resolver; claims return `renderCall`/`renderResult` (optionally `renderShell`); unclaimed tools return `next()` untouched             |
| 2   | `setHiddenThinkingLabel(label?)` - `types.d.ts` ~line 99                                                                                                                  | `src/thinking-label.ts` - session_start handler                                   | Called only when `thinkingLabel` config is on; guarded for missing UI                                                                             |
| 3   | `ToolCallEvent.toolCallId` + `ToolRenderContext.toolCallId` stability - `types.d.ts` ~938 / ~352                                                                          | `src/tool-overrides.ts` - the `tool_call` handler and `getWriteExecutionMeta`     | Pre-write capture keyed by the same id the renderer receives                                                                                      |
| 4   | `initTheme` export - `dist/index.d.ts` ~line 38                                                                                                                           | `tests/user-message-box-real-component.test.ts`, `tests/codemode-display.test.ts` | Tests initialize the theme before native component use                                                                                            |
| 5   | Peer dependency guidance - installed `docs/packages.md` (~line 88: host packages declare `"*"`, not bundled)                                                              | `package.json` peerDependencies                                                   | Both Pi packages are `"*"`; engines `>=22.19.0` matches Pi's own engines                                                                          |
| 6   | Config location - installed `docs/configuration.md` (agent dir table; `extensions/` is code only) and `docs/environment-variables.md` (~line 81: `PI_CODING_AGENT_DIR`)   | `src/config-store.ts` - `CONFIG_FILE` and `maybeImportLegacyConfig`               | Config at `<agent-dir>/pi-tool-display-next.json`; no per-extension dir under `extensions/`; `PI_CODING_AGENT_DIR` honored via `src/agent-dir.ts` |
| 7   | User message component - `dist/index.d.ts` ~line 37 exports `UserMessageComponent`; `dist/modes/interactive/components/user-message.js` emits OSC 133 zones in `render()` | `src/user-message-box-renderer.ts` - patch version 9, `OSC133_ZONE_*` constants   | Patch re-emits zone markers around the bordered output; fallback cannot throw (`safeOriginalRender`)                                              |
| 8   | `pi.getSettings()` - `types.d.ts` ~1286                                                                                                                                   | n/a - must NOT be used for extension config                                       | Confirm the extension does not store config in Pi settings.json                                                                                   |

Also audit for leftover dead machinery that Pi 1.x made inert: `rg -n "registerTool =|getAllTools\\(\\).*renderCall|installMcpRegistrationInterceptor|wrappedMcpToolNames" src/` should return no hits.

## V3 - Test gate

1. `set -o pipefail; npm run check 2>&1 | tee R:/Temp/verify-check.log` - expect 0 lint errors and 779+ tests passing, 0 failing.
1. Spot-run the resolver contract suites individually and confirm each is green: `npx tsx --test tests/tool-overrides-registration.test.ts tests/tool-overrides-mcp.test.ts tests/custom-tool-overrides.test.ts tests/codemode-display.test.ts tests/preview-line-flood.test.ts tests/user-message-box-real-component.test.ts`.

## V4 - Live smoke test (the one gate not yet run)

This is the pending manual gate from the plan (Phase 5). Run a real session and record observations.

1. Launch: `pi --extension R:/repositories/MasuRii--pi-tool-display/index.ts` in a scratch directory under `R:/Temp/pi-verify/` (never `C:`).
1. `/tool-display` - the config command opens; confirm the summary line includes `codemode=calls`.
1. Ask the agent to read a file - expect the compact read rendering (summary/hidden per config), not the verbose native block.
1. Ask for an edit of a scratch file - expect the fork's diff rendering.
1. Set `bashIntentMode: "render"` in the config file first, then run a bash command prefixed with `# intent: verify header rendering` - expect the intent header with the tool icon instead of the raw command line.
1. Run a codemode script that calls a tool - expect the collapsed codemode row (status + call count); expand with Ctrl+O - expect the native script/trace/output view.
1. From a codemode script, call `describeTool` on an MCP tool with an `outputSchema` and confirm the schema is still present (the #51 regression: wrapping used to drop it). If no MCP server is configured, verify structurally instead: `rg -n "structuredContent|outputSchema" src/tool-overrides.ts` must show the extension never touches tool objects (the "rendering claims preserve native tool objects" test is the regression guard).
1. Check `~/.pi/agent/pi-tool-display-next.json` is created after a config save, and that a legacy `~/.pi/agent/extensions/pi-tool-display/config.json`, if present, was imported once and left in place.
1. `/reload` - after reload, tool rendering must still be active (fresh resolver per runtime; the reload tests assert this - confirm visually).
1. Thinking label: with the default config (`thinkingLabel: false`), thinking blocks render without the injected `Thinking: ` prefix; then set it true, `/reload`, and confirm the prefix appears and the collapsed label is accent colored.

## V5 - Deferred and blocked items

1. Row 34 (upstream PR #27, project-level config) is deferred by design - confirm the plan says so and do not implement it.
1. `npm whoami` - expect an auth error (publish blocked on credentials). Report, do not attempt to fix.

## Failure protocol

- A failing check in V1-V3: root-cause it, apply the minimal fix, run `npm run check`, and commit with a conventional message (`fix: ...`). One commit per concern. Push only after the gate is green.
- A failing check in V4 (live smoke): capture the exact reproduction (command, config, rendered output), diagnose against the official dist source, and prefer the smallest fix in the extension over any workaround. If the fix is larger than a focused patch, STOP and report instead of half-fixing.
- Any check that contradicts this handoff (for example the installed Pi version differs): trust the installed docs/source over this document, report the discrepancy, and adapt the checklist.

## Report format

End with a table: check id, pass/fail, evidence (file:line or command output excerpt), and a short verdict section listing anything deferred, newly discovered, or fixed during verification.
