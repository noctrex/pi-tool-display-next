# Plan: Modernize pi-tool-display for Pi 1.x (fork: pi-tool-display-next)

Status: In Progress (Phase 8 - complete except task 34, deferred, and task 39 npm publish, blocked on registry credentials)
Scope: repo `noctrex/pi-tool-display-next` (fork of `MasuRii/pi-tool-display`); `package.json`, `src/tool-overrides.ts`, `src/config-store.ts`, `src/types.ts`, `src/thinking-label.ts`, `src/user-message-box-*.ts`, `tests/*`, CI workflow, README/CHANGELOG. User-visible impact: extension renders correctly on Pi >= 1.0 under a new package identity; config storage relocates once with a legacy import; config semantics otherwise unchanged (`registerToolOverrides` toggles become resolver claims).

## Context and root cause

`pi-tool-display` v0.5.0 (2026-07-03, upstream `CHANGELOG.md:8`) targets Pi peer ranges `^0.74.0 || ... || ^0.80.0` with a devDependency pinned to `^0.80.3` (`package.json:57-66`). The installed Pi is 1.4.0, and upstream has been inactive since July. The extension achieves compact rendering through two mechanisms that Pi 1.x has both broken and replaced with official APIs. Upstream tracker references (#N) below point at `MasuRii/pi-tool-display`; the fork's own tracker starts empty.

- **Finding F1 - `pi.registerTool` interception is dead.** `src/tool-overrides.ts:2040-2068` wraps `pi.registerTool` to decorate every tool object with `renderCall`/`renderResult`. Since Pi 0.80.6, `registerTool` is per-extension, so the wrapper never sees tools registered by other extensions (MCP, custom tools). Pi 1.4.0 ships the official replacement: `pi.registerToolRenderer(resolver)` (dist `core/extensions/types.d.ts:1256`), which resolves renderers for any tool name, including tools that are not registered yet, with `next()` fallback (`types.d.ts:521-526`).
- **Finding F2 - `getAllTools()` sweep mutates throwaway clones.** `src/tool-overrides.ts:1572` reads `pi.getAllTools()` for ownership detection; 0.80.6+ returns shallow clones without render fields, so mutations are lost.
- **Finding F3 - ownership/deferral machinery is obsolete.** `registerIfOwned` (`tool-overrides.ts:1619`), the built-in registrations at `:1667-1831+`, and the `session_start`/`before_agent_start` re-registration hooks (`:2111-2116`) exist solely to avoid renderer ownership conflicts. A resolver registered via `registerToolRenderer` has no ownership conflict: it composes by load order and `next()`.
- **Finding F4 - wrapping harms current Pi.** Decorated clones drop `outputSchema`, so codemode scripts receive strings instead of structured results (upstream issue #51); wrapped built-ins are stripped from subagent children (#47); `customToolOverrides` no-op because tools are decorated after `registerTool()` on 0.84.x (#44).
- **Finding F5 - thinking label mutates message content.** `src/thinking-label.ts:281-311` rewrites `message_update`/`message_end` payloads and re-strips them in `context`, affecting other extensions (#33). Pi 1.4.0 exposes `setHiddenThinkingLabel(label?)` (`types.d.ts:99`) for the collapsed label; upstream PR #46 already uses it.
- **Finding F6 - user message box patch needs revalidation.** `src/user-message-box-native.ts:21-23` patches `UserMessageComponent.prototype.render` via `src/user-message-box-patch.ts:32-73`. `UserMessageComponent` is still exported in 1.4.0 (dist `index.d.ts:37`), but Pi 1.0.0 changed user-message transcript rendering (kept one full-width copy instead of two). The patch must be re-verified against the new renderer.
- **Finding F7 - no CI.** Upstream has only a Dependabot workflow; `npm run check` never gates pushes.
- **Finding F8 - peer range guidance changed.** Pi packages.md:88 says to declare host-provided packages in `peerDependencies` with a `"*"` range and not bundle them.
- **Finding F9 - config path assumes the legacy install layout.** `src/config-store.ts:23-24` stores config at `<agent-dir>/extensions/pi-tool-display/config.json`. Pi documents no per-extension config directory: `configuration.md` reserves `extensions/` for extension code, npm packages install "under the Pi npm directory" (packages.md:33; verified `~/.pi/agent/npm/node_modules/` on this machine), and the `Settings` schema is closed (`settings-schema.d.ts:190-228`, no index signature) with read-only `pi.getSettings()` (`types.d.ts:1286`), so settings.json cannot host it either. The path is only correct when the repo is cloned into `extensions/pi-tool-display/` (then `CONFIG_DIR` equals the repo root, which is why test 12 reads a gitignored repo-root `config.json`). Pi's own state files (`trust.json`, `models-store.json`, `run-history.jsonl`) and healthy extensions on this machine (`auto-rename.json`, `pi-atelier.json`) store flat JSON directly in `<agent-dir>/`.
- **Finding F10 - baseline test suite is not hermetic.** `tests/reload-behavior.test.ts:981` requires an untracked, gitignored repo-root `config.json`; fresh clones (and CI) fail with ENOENT. Baseline recorded 2026-11-03: 720 pass / 1 fail (this test).

Consequence today: the extension loads without crashing on 1.4.0, but MCP and custom-tool rendering silently does nothing, built-in rendering survives only until any code path touches the clone sweep, and wrapped built-ins corrupt codemode `structuredContent`.

## Fork identity decisions

- Package name `pi-tool-display-next` (npm name verified available, 2026-11-03); repository `noctrex/pi-tool-display-next`, upstream remote kept for PR porting.
- The `/tool-display` command name is kept: the fork is a drop-in replacement, and renaming commands would break user muscle memory and scripts (PoLA).
- The `./tool-display-api-consumer` subpath segment is kept; only the package name in front of it changes.
- Config storage aligns with the fork identity: user config `<agent-dir>/pi-tool-display-next.json`, project config `<cwd>/.pi/pi-tool-display-next.json` (see design note).
- First fork release is `0.6.0`, continuing the changelog lineage from 0.5.0 with a fork-provenance section.

## Modernization strategy

Replace the tool-object decoration engine with the official `pi.registerToolRenderer` resolver. One resolver maps tool names to the existing render adapters; `next()` fills in anything the extension does not claim. This deletes ~40 percent of `tool-overrides.ts` complexity (interception, ownership, deferral) and resolves upstream issues #44, #47, #51 without touching their symptoms. The diff renderer, truncation, bash display, presets, config modal, and user message box all survive as-is; they are presentation code behind `renderCall`/`renderResult` adapters.

Phases are ordered lowest-risk-first. Phases 1-4 are independently mergeable. Phase 5 is the high-blast-radius core. Phases 6-8 integrate revalidation, upstream features, and release.

## Task table

Legend: `[ ]` = not started, `[~]` = in progress, `[x]` = done (verification gate passed). A row is only marked `[x]` after the verification gate passes for its phase.

| #   | Done | Phase | Task                                                                                                                                          | File(s)                                                                      | Priority |
| --- | ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| 1   | [x]  | 1     | Fork upstream repo and rename to `noctrex/pi-tool-display-next`                                                                               | -                                                                            | High     |
| 2   | [x]  | 1     | Point `origin` at the fork; add `upstream` remote `MasuRii/pi-tool-display`                                                                   | -                                                                            | High     |
| 3   | [x]  | 1     | Rebrand `package.json` identity: `name`, `description`, `repository`, `bugs`, `homepage`, `keywords`                                          | `package.json`                                                               | High     |
| 4   | [x]  | 1     | Add GitHub Actions workflow running `npm run check` on push and PR                                                                            | `.github/workflows/check.yml`                                                | High     |
| 5   | [x]  | 1     | Record baseline before source changes (done: 720 pass / 1 env-dependent fail, see F10)                                                        | -                                                                            | High     |
| 6   | [x]  | 1     | Make test 12 hermetic: drop the gitignored repo-root `config.json` dependency, use a temp config path                                         | `tests/reload-behavior.test.ts`                                              | High     |
| 7   | [ ]  | 1     | Push Phase 1 to `origin` and confirm the CI run is green                                                                                      | -                                                                            | High     |
| 8   | [x]  | 2     | Set `peerDependencies` for both Pi packages to `"*"` per packages.md:88                                                                       | `package.json`                                                               | High     |
| 9   | [x]  | 2     | Bump devDependency `@earendil-works/pi-coding-agent` to `^1.4.0` and reinstall lockfile                                                       | `package.json`, `package-lock.json`                                          | High     |
| 10  | [x]  | 2     | Re-evaluate `overrides` and `postinstall` patch: `npm audit` the 1.4.0 tree, remove both if clean, keep with comment if not                   | `package.json`                                                               | Medium   |
| 11  | [x]  | 2     | Fix typecheck fallout against 1.4.0 exports (expected: `ToolRenderContextLike` shape, render signatures)                                      | `src/*.ts`                                                                   | High     |
| 12  | [x]  | 2     | Fix test fallout until `npm run test` is green on 1.4.0 types                                                                                 | `tests/*.ts`                                                                 | High     |
| 13  | [x]  | 3     | Move user config to `<agent-dir>/pi-tool-display-next.json`, keeping `PI_CODING_AGENT_DIR` resolution                                         | `src/config-store.ts`                                                        | High     |
| 14  | [x]  | 3     | Add one-time legacy import: read old `extensions/pi-tool-display/config.json` if present, write to the new path                               | `src/config-store.ts`                                                        | Medium   |
| 15  | [x]  | 3     | Add tests: new path resolution, legacy migration, no write to the old location after migration                                                | `tests/config-store.test.ts`, `tests/reload-behavior.test.ts`                | High     |
| 16  | [x]  | 3     | Update config modal and README to the new config locations                                                                                    | `src/config-modal.ts`, `README.md`                                           | Medium   |
| 17  | [x]  | 4     | Add `thinkingLabel` config gate, default off, controlling the content-mutation handlers                                                       | `src/types.ts`, `src/config-store.ts`, `src/thinking-label.ts`               | Medium   |
| 18  | [x]  | 4     | Wire `setHiddenThinkingLabel()` on `session_start` for the collapsed label (port upstream PR #46)                                             | `src/thinking-label.ts`                                                      | Medium   |
| 19  | [x]  | 4     | Add tests: hidden label set/clear on session lifecycle; content mutation skipped when gated off                                               | `tests/thinking-label-edge.test.ts`                                          | Medium   |
| 20  | [x]  | 5     | Extract a `toolName -> ToolRenderers` adapter map from the seven `registerIfOwned` bodies (Extract Function)                                  | `src/tool-overrides.ts`                                                      | High     |
| 21  | [x]  | 5     | Register one resolver via `pi.registerToolRenderer`: claim configured tools, `return next()` otherwise                                        | `src/tool-overrides.ts`                                                      | High     |
| 22  | [x]  | 5     | Route `customToolOverrides` and MCP candidates through the resolver so late-registered tools render (fixes #44)                               | `src/tool-overrides.ts`, `src/tool-metadata.ts`                              | High     |
| 23  | [x]  | 5     | Delete the `registerTool` interception block (`tool-overrides.ts:2040-2068`)                                                                  | `src/tool-overrides.ts`                                                      | High     |
| 24  | [x]  | 5     | Delete ownership detection and deferral: `registerIfOwned` (`:1619`), `getAllTools` sweep (`:1572`), lifecycle re-registration (`:2111-2116`) | `src/tool-overrides.ts`                                                      | High     |
| 25  | [x]  | 5     | Make `registerToolOverrides` config toggles drive resolver claims instead of registration; update modal and README wording                    | `src/types.ts`, `src/config-modal.ts`, `src/config-store.ts`, `README.md`    | Medium   |
| 26  | [x]  | 5     | Add regression test: render path preserves `outputSchema`/`structuredContent` passthrough (fixes #51)                                         | `tests/index-integration.test.ts`                                            | High     |
| 27  | [x]  | 5     | Rewrite `reload-behavior.test.ts` and `tool-overrides-registration.test.ts` to assert resolver behavior, not interception                     | `tests/reload-behavior.test.ts`, `tests/tool-overrides-registration.test.ts` | High     |
| 28  | [x]  | 6     | Re-validate the `UserMessageComponent.prototype.render` patch against Pi 1.0.0 single-copy rendering; document deltas found                   | `src/user-message-box-renderer.ts`, `src/user-message-box-patch.ts`          | High     |
| 29  | [x]  | 6     | Fix any double-render, spacing, or stale-patch artifacts surfaced by task 28; keep the stale-patch restoration guard                          | `src/user-message-box-patch.ts`, `tests/user-message-box.test.ts`            | High     |
| 30  | [x]  | 7     | Port upstream PR #50 (native codemode rendering) via `git fetch upstream pull/50/head`, rebased onto the resolver architecture                | `src/codemode-display.ts`, `tests/codemode-display.test.ts`                  | Medium   |
| 31  | [x]  | 7     | Port upstream PR #48 (`bashCommandMaxChars` truncation)                                                                                       | `src/bash-display.ts`, `tests/bash-display.test.ts`                          | Low      |
| 32  | [x]  | 7     | Port upstream PR #49 (bash `# intent:` header)                                                                                                | `src/bash-display.ts`, `src/bash-intent.ts`                                  | Low      |
| 33  | [x]  | 7     | Port upstream PR #40 (`allowExternalDiffPreviews`, closes #39)                                                                                | `src/pending-diff-preview.ts`                                                | Low      |
| 34  | [ ]  | 7     | Port upstream PR #27 (project-level config), rebased onto `.pi/pi-tool-display-next.json` and project-over-user precedence                    | `src/config-store.ts`, `src/config-modal.ts`                                 | Medium   |
| 35  | [x]  | 7     | Fix upstream issue #36: wrap long single-line tool output to terminal width before preview-line limiting                                      | `src/render-utils.ts`, `src/ansi-utils.ts`                                   | Medium   |
| 36  | [x]  | 7     | Comment on upstream PRs #31, #34, #28, #32 pointing at the fork's resolver migration; they are not merged                                     | -                                                                            | Medium   |
| 37  | [x]  | 8     | Rewrite README: fork provenance, Pi >= 1.0 requirement, rendering architecture, config reference                                              | `README.md`                                                                  | Medium   |
| 38  | [x]  | 8     | Write CHANGELOG: fork basis at 0.5.0 plus the 0.6.0 entry                                                                                     | `CHANGELOG.md`                                                               | Medium   |
| 39  | [~]  | 8     | Bump version to 0.6.0, tag, and publish to npm as `pi-tool-display-next`                                                                      | `package.json`                                                               | Medium   |

## Phase roll-up

| Phase | Done | Scope                         | Rows  |
| ----- | ---- | ----------------------------- | ----- |
| 1     | [x]  | Fork, rebrand, CI, baseline   | 1-7   |
| 2     | [x]  | Dependency modernization      | 8-12  |
| 3     | [x]  | Config storage modernization  | 13-16 |
| 4     | [x]  | Thinking label                | 17-19 |
| 5     | [x]  | Tool renderer migration       | 20-27 |
| 6     | [x]  | User message box revalidation | 28-29 |
| 7     | [x]  | Upstream feature integration  | 30-36 |
| 8     | [x]  | Release                       | 37-39 |

## Per-phase detail

### Phase 3 design note: config storage

**Problem.** Evidence in F9: the config path is tied to a source-tree layout that the documented package model no longer produces.

**Fix.** Resolve `CONFIG_FILE` as `join(resolvePiAgentDir(), "pi-tool-display-next.json")`, preserving the existing `PI_CODING_AGENT_DIR` handling from `src/agent-dir.ts:20-32` (documented at environment-variables.md:81). On load, if the legacy file `<agent-dir>/extensions/pi-tool-display/config.json` exists and the new file does not, copy its contents to the new location and leave the old file untouched. This matches Pi's own agent-dir state pattern (`trust.json`, `models-store.json`) and the observed ecosystem convention (`auto-rename.json`, `pi-atelier.json`). Project-level config lands in Phase 7 via the PR #27 port at `<cwd>/.pi/pi-tool-display-next.json`, mirroring configuration.md's project-precedes-user model.

**Tests.** Existing `tests/config-store.test.ts` expectations move to the new path; add migration coverage per task 15. Do not keep both locations authoritative; the legacy path becomes read-only-after-import.

### Phase 5 detail (core migration)

**Problem.** Evidence in F1-F4; the decoration engine is ~900 lines of interception, cloning, ownership, and deferral in `src/tool-overrides.ts` (2121 lines total) that Pi has made inert or harmful.

**Fix.** The resolver pattern, per docs/extensions.md tool-rendering section:

```typescript
pi.registerToolRenderer((toolName, next) => {
  const mine = buildRenderers(toolName, getConfig); // adapter map from task 20
  if (!mine) return next(); // unclaimed: defer to other resolvers, then registered tool
  return mine;
});
```

`buildRenderers` returns `Pick<ToolDefinition, "renderCall" | "renderResult">` (Pi 1.4.0 also offers `renderShell`; not used initially). The adapter bodies are the existing render functions already extracted at `tool-overrides.ts:1667-1831+`; the migration re-homes them, it does not rewrite rendering. `customToolOverrides` becomes a resolver lookup on names matching `isMcpToolCandidate` (`src/tool-metadata.ts`) or the explicit config map, which also fixes the "decorated after registerTool" race because resolution happens at render time, not registration time.

**Tests.** Existing diff/bash/read/edit render suites stay green unchanged (presentation code untouched). Add the #51 `structuredContent` passthrough regression and rewrite the interception-assertion tests per tasks 26-27. Do not add tests for internal helper functions that Phase 5 deletes.

### Design note: resolver semantics vs `next()`

Pi composes resolvers in extension load order; `next()` yields what later resolvers and the registered tool would produce. The extension must claim a tool only when its config enables an override for it, otherwise return `next()`. This preserves interop with other renderer extensions and removes the entire ownership-conflict class (#17, #29, #35) by construction.

## Verification gate

Run from the repo root after each phase, before marking rows `[x]`:

```bash
npm run lint        # tsc typecheck
npm run test        # tsx --test tests/*.test.ts
```

Long runs get captured once: `set -o pipefail; npm run check 2>&1 | tee R:/Temp/pi-tool-display-check.log`, then search the log with `grep`/`read`. Phase 2 adds `npm audit` evidence for task 10. Phase 3 additionally requires a manual check that the legacy file imports once and the new file is written. Phase 5 additionally requires a manual smoke test: install the extension, run a read, an edit, a codemode script, and an MCP tool call, and confirm compact rendering plus `structuredContent` reaching the script.

## Out of scope

- Issue #38 (grouping consecutive inspection calls): new UX feature, no Pi-version pressure; defer to a separate plan.
- Upstream issue #43 (repeated tool call verbosity question): likely answerable with existing `readOutputMode`/`searchOutputMode` config; answer on the upstream tracker, no code change planned.
- Rewriting the diff renderer (`src/diff-renderer.ts`, 2517 lines): presentation code that already passes its suite; only touched if Phase 6 revalidation implicates it.
- Adopting upstream PR #31's `ToolExecutionComponent` prototype patch: rendered obsolete by the resolver migration; comment and leave unmerged.
- Reconciling upstream PRs #34 and #28: both patch the deferral machinery that Phase 5 deletes; they stay unmerged with a pointer comment.
- Transferring or mirroring upstream issues into the fork tracker: upstream references stay authoritative on `MasuRii/pi-tool-display`; the fork tracker tracks fork-specific work only.
- Dropping the `tool-display-api-consumer` subpath export: no evidence of external consumers yet; revisit if the migration breaks its contract.
