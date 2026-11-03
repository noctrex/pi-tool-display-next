import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderBashCall } from "./bash-display.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import { registerCleanup } from "./disposable.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
  readWorkspaceUtf8File,
  type PendingDiffPreviewData,
} from "./pending-diff-preview.js";
import {
  getTextField,
  isMcpToolCandidate,
  toRecord,
} from "./tool-metadata.js";
import { BUILT_IN_TOOL_OVERRIDE_NAMES } from "./types.js";
import { toCustomToolOverrideKind, toCustomToolOutputMode, normalizeCustomToolOverrideEntry } from "./config-store.js";
import type {
  BuiltInToolOverrideName,
  CustomToolOverrideConfig,
  ToolDisplayConfig,
} from "./types.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

type ConfigGetter = () => ToolDisplayConfig;

interface RuntimeToolDefinition {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  prepareArguments?: unknown;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderResult?: (result: Record<string, unknown>, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<unknown>;
  renderShell?: unknown;
  [key: string]: unknown;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

/** Shape returned by the registerToolRenderer resolver for a claimed tool. */
interface ToolRenderersLike {
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderResult?: (result: Record<string, unknown>, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderShell?: unknown;
}

export interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

const RTK_COMPACTION_LABEL = "compacted by RTK";
export const WRITE_EXECUTION_META_LIMIT = 100;
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";
const EDIT_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayWritePendingPreview";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

export type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";

export interface ToolDisplayAdapter {
  id?: string;
  toolName?: string;
  kind?: ToolDisplayKind;
  overrideExistingRenderers?: boolean;
  pathFields?: string[];
  getPath?: (args: unknown) => string | undefined;
  getEditLineCount?: (args: unknown) => number;
  renderCall?: (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => unknown;
  renderResult?: (result: unknown, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
  registerAdapter(adapter: ToolDisplayAdapter): string;
  unregisterAdapter(id: string): boolean;
}

interface PendingToolDisplayDecoration {
  tool: RuntimeToolDefinition;
  adapter?: ToolDisplayAdapter;
}

type GlobalWithToolDisplayApi = typeof globalThis & {
  [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
  [TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: PendingToolDisplayDecoration[];
};

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const existing = readWorkspaceUtf8File(cwd, rawPath);
  return {
    existed: existing.exists,
    content: existing.content,
  };
}

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: RenderTheme): string {
  if (remaining <= 0) {
    return "";
  }
  const hint = expanded ? "" : " • Ctrl+O to expand";
  return `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) {
    return theme.fg("muted", "↳ (no output)");
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  text += formatTruncationHint(remaining, expanded, theme);
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "↳ command completed (no output)");
  }
  return theme.fg("muted", "↳ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditPayloadLineCount(value: unknown): number {
  const record = toRecord(value);
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.filter((line): line is string => typeof line === "string").length;
  }
  if (typeof lines === "string") {
    return countTextLines(lines);
  }

  return countTextLines(record.newText);
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits as unknown[] : [];
  if (edits.length > 0) {
    return edits.reduce<number>((total, edit) => {
      return total + getEditPayloadLineCount(edit);
    }, 0);
  }

  return getEditPayloadLineCount(record);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function recordWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
  toolCallId: string,
  meta: WriteExecutionMeta,
): void {
  pendingMetaByToolCallId.delete(toolCallId);
  pendingMetaByToolCallId.set(toolCallId, meta);

  while (pendingMetaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
    const oldestToolCallId: string | undefined = pendingMetaByToolCallId.keys().next().value as string | undefined;
    if (oldestToolCallId === undefined) {
      return;
    }
    pendingMetaByToolCallId.delete(oldestToolCallId);
  }
}

export function clearWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): void {
  pendingMetaByToolCallId.clear();
}

export function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateRecord(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as unknown as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function getPendingDiffPreviewState(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
): PendingDiffPreviewState | undefined {
  const carrier = toStateRecord(context?.state);
  if (!carrier) {
    return undefined;
  }

  const current = carrier[stateKey];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as PendingDiffPreviewState;
  }

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) {
    return compute();
  }

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function buildPendingDiffCallComponent(
  summaryText: string,
  previewData: PendingDiffPreviewData | undefined,
  context: ToolRenderContextLike | undefined,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text | Container {
  if (!context?.isPartial || !previewData) {
    return textResult(summaryText);
  }

  const container = new Container();
  container.addChild(new Text(summaryText, 0, 0));
  container.addChild(new Spacer(1));

  if (previewData.notice || typeof previewData.nextContent !== "string") {
    container.addChild(new Text(theme.fg("warning", previewData.notice || "Preview unavailable."), 0, 0));
    return container;
  }

  container.addChild(
    renderWriteDiffResult(
      previewData.nextContent,
      {
        expanded: context.expanded === true,
        filePath: previewData.filePath,
        previousContent: previewData.previousContent,
        fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
        headerLabel: previewData.headerLabel,
      },
      config,
      theme,
      "",
    ),
  );
  return container;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function getRtkCompactionInfoIfApplied(
  details: unknown,
  config: ToolDisplayConfig,
): RtkCompactionInfo | undefined {
  if (!config.showRtkCompactionHints) {
    return undefined;
  }
  const info = getRtkCompactionInfo(details);
  return info?.applied ? info : undefined;
}

function withRtkCompactionInfo(
  params: RtkHintParams,
  handler: (info: RtkCompactionInfo) => string,
): string {
  const info = getRtkCompactionInfoIfApplied(params.details, params.config);
  return info ? handler(info) : "";
}

interface RtkHintParams {
  details: unknown;
  config: ToolDisplayConfig;
  theme: RenderTheme;
}

interface PreviewHintContext {
  lines: string[];
  config: ToolDisplayConfig;
  theme: RenderTheme;
  options: ToolRenderResultOptions;
  details: unknown;
}

interface McpPreviewHintContext extends PreviewHintContext {
  truncation: { truncated: boolean; fullOutputPath?: string };
}

function handlePartialResult(
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  message: string,
): Text | undefined {
  return options.isPartial ? partialResultText(theme, message) : undefined;
}

function renderSearchPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendPreviewHints(p, ctx), expandedOnly);
}

function renderMcpPreview(ctx: McpPreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendMcpPreviewHints(p, ctx), expandedOnly);
}

function formatRtkSummarySuffix(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const segments: string[] = [RTK_COMPACTION_LABEL];

    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      segments.push(techniqueText);
    }
    if (info.truncated) {
      segments.push("RTK removed content");
    }

    if (segments.length === 0) {
      return "";
    }

    return theme.fg("warning", ` • ${segments.join(" • ")}`);
  });
}

function getExpandedPreviewLineLimit(
  lines: string[],
  config: ToolDisplayConfig,
): number {
  const limit = Math.max(0, config.expandedPreviewMaxLines);
  if (limit === 0) {
    return lines.length;
  }
  return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  const cap = Math.max(0, config.expandedPreviewMaxLines);
  if (cap === 0 || lines.length <= cap) {
    return "";
  }

  return `\n${theme.fg("warning", `(display capped at ${cap} lines by tool-display setting)`)}`;
}

function formatRtkPreviewHint(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const hints: string[] = [];
    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
    } else {
      hints.push(`${RTK_COMPACTION_LABEL} applied`);
    }

    if (
      info.originalLineCount !== undefined &&
      info.compactedLineCount !== undefined &&
      info.originalLineCount > info.compactedLineCount
    ) {
      hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
    }

    if (info.truncated) {
      hints.push("RTK removed content");
    }

    return hints.length > 0
      ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
      : "";
  });
}

function appendRtkAndExpandedHints(preview: string, ctx: PreviewHintContext): string {
  preview += formatRtkPreviewHint(ctx);
  if (ctx.options.expanded) {
    preview += formatExpandedPreviewCapHint(ctx.lines, ctx.config, ctx.theme);
  }
  return preview;
}

function appendMcpPreviewHints(preview: string, ctx: McpPreviewHintContext): string {
  const { config, theme, details, lines, options, truncation } = ctx;
  if (config.showTruncationHints && (truncation.truncated || truncation.fullOutputPath)) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, details } = ctx;
  if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function renderPreviewText(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  appendHints: (preview: string) => string,
  expandedOnly: boolean = false,
): Text {
  const useExpanded = expandedOnly || options.expanded;
  const maxLines = useExpanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  const preview = buildPreviewText(lines, maxLines, theme, useExpanded);
  return textResult(appendHints(preview));
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function getBashPreviewLineLimit(
  lines: string[],
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): number {
  if (options.expanded) {
    return getExpandedPreviewLineLimit(lines, config);
  }

  return config.bashOutputMode === "opencode"
    ? config.bashCollapsedLines
    : config.previewLines;
}

type ToolRenderInput = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function partialResultText(theme: RenderTheme, label: string): Text {
  return textResult(theme.fg("warning", label));
}

function renderBashPreviewWithHints(
  lines: string[],
  maxLines: number,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  details: BashToolDetails | undefined,
): Text {
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return textResult(preview);
}

function prepareBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): { lines: string[]; maxLines: number } | undefined {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return undefined;
  }
  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return undefined;
  }
  return { lines, maxLines };
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const prepared = prepareBashLivePreview(rawOutput, options, config);
  if (!prepared) {
    return textResult("");
  }
  return renderBashPreviewWithHints(prepared.lines, prepared.maxLines, config, theme, options, details);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  let text = theme.fg("error", "↳ command failed");

  if (lines.length > 0) {
    const maxLines = getBashPreviewLineLimit(lines, options, config);
    if (options.expanded || maxLines > 0) {
      const { shown, remaining } = previewLines(lines, maxLines);
      text += `\n${shown
        .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
        .join("\n")}`;
      text += formatTruncationHint(remaining, options.expanded, theme);
    }
  }

  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }
  if (options.expanded && lines.length > 0) {
    text += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return textResult(text);
}

function renderSearchResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return partialResultText(theme, "running...");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return textResult("");
  }

  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatArgCountSuffix(argCount: number, theme: RenderTheme): string {
  return argCount === 0
    ? theme.fg("muted", " (no args)")
    : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
}

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): Text {
  const argCount = Object.keys(args).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(args)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;

  return new Text(
    `${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", target)}${argSuffix}`,
    0,
    0,
  );
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  const partial = handlePartialResult(options, theme, "running...");
  if (partial) {
    return partial;
  }

  if (config.mcpOutputMode === "hidden") {
    return textResult("");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);
  const truncation = getMcpTruncationDetails(result.details);
  const mcpCtx: McpPreviewHintContext = { lines, config, theme, options, details: result.details, truncation };

  if (config.mcpOutputMode === "summary") {
    if (options.expanded) {
      return renderMcpPreview(mcpCtx, true);
    }

    const lineCount = countNonEmptyLines(lines);
    let summary = theme.fg(
      "muted",
      `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderMcpPreview(mcpCtx);
}

function isBuiltInToolName(toolName: string): boolean {
  return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

function getRuntimeCustomToolOverride(
  toolName: string,
  config: ToolDisplayConfig,
): CustomToolOverrideConfig | undefined {
  if (!toolName || isBuiltInToolName(toolName)) {
    return undefined;
  }

  const overrides = toRecord((config as unknown as Record<string, unknown>).customToolOverrides);
  return normalizeCustomToolOverrideEntry(overrides[toolName]);
}

function formatGenericToolCallLine(
  toolName: string,
  args: unknown,
  theme: RenderTheme,
): Text {
  const argRecord = toRecord(args);
  const argCount = Object.keys(argRecord).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))}${argSuffix}`,
    0,
    0,
  );
}

function getSearchScope(args: Record<string, unknown>): string {
  return shortenPath((args.path as string) || ".");
}

function formatSearchCallLine(
  toolName: string,
  accent: string,
  mutedSuffix: string,
  theme: RenderTheme,
): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", accent)}${theme.fg("muted", mutedSuffix)}`,
    0,
    0,
  );
}

function renderCustomToolResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  outputMode: CustomToolOverrideConfig["outputMode"],
  theme: RenderTheme,
): Text {
  return renderMcpResult(
    result as ToolRenderInput,
    options,
    { ...config, mcpOutputMode: outputMode },
    theme,
  );
}

function getAdapterKind(tool: RuntimeToolDefinition, adapter: ToolDisplayAdapter): ToolDisplayKind {
  if (adapter.kind) {
    return adapter.kind;
  }
  if (tool.name === "read" || tool.name === "edit") {
    return tool.name;
  }
  return isMcpToolCandidate(tool) ? "mcp" : "generic";
}

function getAdapterPath(args: unknown, adapter: ToolDisplayAdapter): string | undefined {
  const explicitPath = adapter.getPath?.(args);
  if (explicitPath) {
    return explicitPath;
  }

  for (const field of adapter.pathFields ?? ["file_path", "path"]) {
    const value = getStringField(args, field);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function renderReadDisplayCall(
  args: unknown,
  theme: RenderTheme,
  adapter: ToolDisplayAdapter = {},
 ): Text {
  const path = shortenPath(getAdapterPath(args, adapter));
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  let suffix = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    suffix = to ? `:${from}-${to}` : `:${from}`;
  }
  const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
  return textResult(line);
}

function renderReadDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
 ): Text {
  if (options.isPartial) {
    return partialResultText(theme, "reading...");
  }

  if (config.readOutputMode === "hidden") {
    return textResult("");
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    const summaryLines = compactOutputLines(splitLines(rawOutput), {
      expanded: true,
    });
    let summary = formatReadSummary(
      summaryLines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function renderEditDisplayCall(
  args: unknown,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): Text | Container {
  const path = shortenPath(getAdapterPath(args, adapter));
  const lineCount = adapter.getEditLineCount?.(args) ?? getEditLineCount(args);
  const summaryText = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
  if (!context?.argsComplete || !context.isPartial) {
    return textResult(summaryText);
  }

  const previewKey = JSON.stringify({
    path: getAdapterPath(args, adapter) ?? null,
    edits: toRecord(args).edits ?? null,
    oldText: getStringField(args, "oldText") ?? null,
    newText: getStringField(args, "newText") ?? null,
  });
  const previewData = resolvePendingDiffPreview(
    context,
    EDIT_PENDING_PREVIEW_STATE_KEY,
    previewKey,
    () => buildPendingEditPreviewData(args, context.cwd),
  );
  return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
}

function renderEditDisplayResult(
  result: ToolRenderInput & { isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): unknown {
  const lineCount = adapter.getEditLineCount?.(context?.args) ?? getEditLineCount(context?.args);
  const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "editing", "Edit failed.");
  if (earlyResult) {
    return earlyResult;
  }

  const config = getConfig();
  const details = result.details as EditToolDetails | undefined;
  return renderEditDiffResult(
    details,
    { expanded: options.expanded, filePath: getAdapterPath(context?.args, adapter) },
    config,
    theme,
    fallbackText,
  );
}

function handleEditOrWriteResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  context: ToolRenderContextLike | undefined,
  theme: RenderTheme,
  lineCount: number,
  progressLabel: string,
  errorMessage: string,
): { fallbackText: string; earlyResult: Text | undefined } {
  if (options.isPartial) {
    return { fallbackText: "", earlyResult: new Text(formatInProgressLineCount(progressLabel, lineCount, theme), 0, 0) };
  }
  const fallbackText = extractTextOutput(result);
  if (isToolError(result, context)) {
    return { fallbackText, earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)) };
  }
  return { fallbackText, earlyResult: undefined };
}

interface ResolverBackedToolDisplayApi extends ToolDisplayApi {
  /** Stored adapter for a tool name, if a consumer registered one. */
  getAdapter(toolName: string): ToolDisplayAdapter | undefined;
}

function drainPendingToolDisplayAdapters(api: ResolverBackedToolDisplayApi): void {
  const globalWithApi = globalThis as GlobalWithToolDisplayApi;
  const pendingDecorations = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  if (!Array.isArray(pendingDecorations) || pendingDecorations.length === 0) {
    return;
  }

  const entries = pendingDecorations.splice(0);
  for (const entry of entries) {
    if (!entry?.adapter) {
      continue; // Bare queued tools are covered by the resolver's heuristics.
    }
    const toolName = getTextField(entry.tool, "name");
    if (toolName) {
      api.registerAdapter({ ...entry.adapter, toolName });
    }
  }
}

function installToolDisplayApi(getConfig: ConfigGetter): ResolverBackedToolDisplayApi {
  const adapters = new Map<string, ToolDisplayAdapter>();
  let nextAdapterId = 0;

  const api: ResolverBackedToolDisplayApi = {
    version: 1,
    decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T {
      // Resolver-backed decoration: the adapter is stored by tool name and
      // consulted by the registerToolRenderer resolver at render time, so
      // decoration works no matter when the tool registers. The returned
      // tool is unchanged; Pi draws it through the resolver.
      const toolName = getTextField(tool, "name");
      if (toolName && adapter) {
        adapters.set(toolName, { ...adapter, id: adapter.id || toolName });
      }
      return tool;
    },
    registerAdapter(adapter: ToolDisplayAdapter): string {
      const id = adapter.id || adapter.toolName || `adapter-${++nextAdapterId}`;
      adapters.set(id, { ...adapter, id });
      if (adapter.toolName) {
        adapters.set(adapter.toolName, { ...adapter, id });
      }
      return id;
    },
    unregisterAdapter(id: string): boolean {
      const adapter = adapters.get(id);
      const removed = adapters.delete(id);
      if (adapter?.toolName) {
        adapters.delete(adapter.toolName);
      }
      return removed;
    },
    getAdapter(toolName: string): ToolDisplayAdapter | undefined {
      return adapters.get(toolName);
    },
  };

  (globalThis as GlobalWithToolDisplayApi)[TOOL_DISPLAY_API_KEY] = api;
  drainPendingToolDisplayAdapters(api);
  return api;
}

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  const toolDisplayApi = installToolDisplayApi(getConfig);
  registerCleanup(() => {
    const globalWithApi = globalThis as GlobalWithToolDisplayApi;
    if (globalWithApi[TOOL_DISPLAY_API_KEY] === toolDisplayApi) {
      delete globalWithApi[TOOL_DISPLAY_API_KEY];
    }
  });

  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
  const mcpCandidateCache = new Map<string, { isMcp: boolean; label: string }>();

  // Capture pre-write content BEFORE execution so the write renderer can show
  // a real before/after diff. Pi's native write result carries no previous
  // content, and the renderer resolver replaces the old execute-wrapping
  // re-registration. The tool_call hook is Pi's sanctioned pre-execution point.
  pi.on("tool_call", async (event, ctx) => {
    try {
      const record = toRecord(event);
      if (record.toolName !== "write") {
        return;
      }
      const input = toRecord(record.input);
      const previous = captureExistingWriteContent(ctx?.cwd ?? process.cwd(), input.path);
      recordWriteExecutionMeta(writeExecutionMetaByToolCallId, getTextField(record, "toolCallId"), {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });
    } catch (error) {
      logToolDisplayDebug("Write pre-content capture failed.", error);
    }
  });

  pi.on("session_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    mcpCandidateCache.clear();
  });

  // One resolver answers renderer lookups for every tool, including tools that
  // are not registered yet (late extension tools, MCP tools in resumed
  // sessions). Resolution happens at render time, so registration order and
  // ownership races disappear by construction.
  const resolver = (toolName: string, next: () => unknown): unknown => {
    const mine = resolveToolRenderers(toolName, getConfig, writeExecutionMetaByToolCallId, toolDisplayApi, () =>
      lookupMcpCandidate(pi, toolName, mcpCandidateCache),
    );
    return mine ?? next();
  };

  const piWithRendererApi = pi as {
    registerToolRenderer?: (resolver: (toolName: string, next: () => unknown) => unknown) => void;
  };
  if (typeof piWithRendererApi.registerToolRenderer !== "function") {
    logToolDisplayDebug("pi.registerToolRenderer is unavailable; tool display rendering is disabled for this Pi version.");
    return;
  }
  piWithRendererApi.registerToolRenderer(resolver);
}

function resolveToolRenderers(
  toolName: string,
  getConfig: ConfigGetter,
  writeMeta: Map<string, WriteExecutionMeta>,
  api: ResolverBackedToolDisplayApi,
  lookupMcpCandidate: () => { isMcp: boolean; label: string },
): ToolRenderersLike | undefined {
  // 1. Explicit custom tool overrides from config.
  const override = getRuntimeCustomToolOverride(toolName, getConfig());
  if (override?.enabled) {
    return {
      renderCall(args, theme) {
        if (override.kind === "mcp") {
          return formatMcpCallLine("mcp", "MCP Proxy", toRecord(args), theme);
        }
        return formatGenericToolCallLine(toolName, args, theme);
      },
      renderResult(result, options, theme) {
        return renderCustomToolResult(result as ToolRenderInput, options, getConfig(), override.outputMode, theme);
      },
    };
  }

  // 2. Consumer adapters registered through the tool display API.
  const adapter = api.getAdapter(toolName);
  if (adapter) {
    return adapterRenderers(toolName, adapter, getConfig);
  }

  // 3. Built-in claims, driven by the registerToolOverrides config toggles.
  if (
    (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName) &&
    getConfig().registerToolOverrides[toolName as BuiltInToolOverrideName]
  ) {
    return builtInRenderers(toolName as BuiltInToolOverrideName, getConfig, writeMeta);
  }

  // 4. MCP heuristic, covering late-registered and resumed-session MCP tools.
  // The lookup consults the registered tool's label and description through
  // getAllTools (read-only), falling back to name-shape heuristics for tools
  // that are not registered yet.
  const mcpCandidate = lookupMcpCandidate();
  if (mcpCandidate.isMcp) {
    return {
      renderCall(args, theme) {
        return formatMcpCallLine(toolName, mcpCandidate.label, toRecord(args), theme);
      },
      renderResult(result, options, theme) {
        return renderMcpResult(result as ToolRenderInput, options, getConfig(), theme);
      },
    };
  }

  return undefined;
}

function lookupMcpCandidate(
  pi: ExtensionAPI,
  toolName: string,
  cache: Map<string, { isMcp: boolean; label: string }>,
): { isMcp: boolean; label: string } {
  const cached = cache.get(toolName);
  if (cached) {
    return cached;
  }

  let candidate: { isMcp: boolean; label: string };
  const fallbackLabel = toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`;
  try {
    const allTools = (pi as { getAllTools?: () => unknown[] }).getAllTools?.();
    const match = allTools?.find((tool) => getTextField(tool, "name") === toolName);
    if (match) {
      const label = getTextField(match, "label") || fallbackLabel;
      candidate = { isMcp: isMcpToolCandidate(match), label };
    } else {
      candidate = { isMcp: isMcpToolCandidate({ name: toolName }), label: fallbackLabel };
    }
  } catch (error) {
    logToolDisplayDebug("MCP candidate lookup failed; falling back to name heuristics.", error);
    candidate = { isMcp: isMcpToolCandidate({ name: toolName }), label: fallbackLabel };
  }

  cache.set(toolName, candidate);
  return candidate;
}

function adapterKindForName(toolName: string, adapter: ToolDisplayAdapter): ToolDisplayKind {
  if (adapter.kind) {
    return adapter.kind;
  }
  if (toolName === "read" || toolName === "edit") {
    return toolName;
  }
  return isMcpToolCandidate({ name: toolName }) ? "mcp" : "generic";
}

function adapterRenderers(
  toolName: string,
  adapter: ToolDisplayAdapter,
  getConfig: ConfigGetter,
): ToolRenderersLike {
  const kind = adapterKindForName(toolName, adapter);
  const renderers: ToolRenderersLike = {};

  if (adapter.renderCall) {
    renderers.renderCall = adapter.renderCall;
  } else if (kind === "read") {
    renderers.renderCall = (args, theme) => renderReadDisplayCall(args, theme, adapter);
  } else if (kind === "edit") {
    renderers.renderCall = (args, theme, context) => renderEditDisplayCall(args, theme, context, adapter, getConfig);
  } else if (kind === "mcp") {
    const toolLabel = getTextField({ name: toolName }, "label") ?? (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
    renderers.renderCall = (args, theme) => formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
  }

  if (adapter.renderResult) {
    renderers.renderResult = adapter.renderResult;
  } else if (kind === "read") {
    renderers.renderResult = (result, options, theme) => renderReadDisplayResult(result, options, getConfig(), theme);
  } else if (kind === "edit") {
    renderers.renderResult = (result, options, theme, context) =>
      renderEditDisplayResult(result as ToolRenderInput & { isError?: boolean }, options, theme, context, adapter, getConfig);
  } else if (kind === "mcp") {
    renderers.renderResult = (result, options, theme) => renderMcpResult(result as ToolRenderInput, options, getConfig(), theme);
  }

  if (kind === "edit") {
    renderers.renderShell = "default";
  }

  return renderers;
}

function renderSearchToolResultWithConfig(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  getConfig: ConfigGetter,
  unitLabel: string,
  pluralLabel?: string,
): Text {
  return renderSearchResult(result as never, options, getConfig(), theme, unitLabel, result.details, pluralLabel);
}

function buildSearchCallSuffix(args: Record<string, unknown>): { scope: string; limitSuffix: string } {
  return { scope: getSearchScope(args), limitSuffix: args.limit !== undefined ? ` (limit ${args.limit})` : "" };
}

function searchRenderers(toolName: "grep" | "find" | "ls", getConfig: ConfigGetter): ToolRenderersLike {
  if (toolName === "grep") {
    return {
      renderCall(args, theme) {
        const scope = getSearchScope(args);
        const globSuffix = args.glob ? ` (${args.glob})` : "";
        const limitSuffix = args.limit !== undefined ? ` limit ${args.limit}` : "";
        return formatSearchCallLine("grep", `/${args.pattern}/`, ` in ${scope}${globSuffix}${limitSuffix}`, theme);
      },
      renderResult(result, options, theme) {
        return renderSearchToolResultWithConfig(result, options, theme, getConfig, "match", "matches");
      },
    };
  }

  if (toolName === "find") {
    return {
      renderCall(args, theme) {
        const { scope, limitSuffix } = buildSearchCallSuffix(args);
        return formatSearchCallLine("find", args.pattern as string, ` in ${scope}${limitSuffix}`, theme);
      },
      renderResult(result, options, theme) {
        return renderSearchToolResultWithConfig(result, options, theme, getConfig, "result");
      },
    };
  }

  return {
    renderCall(args, theme) {
      const { scope, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine("ls", scope, limitSuffix, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResultWithConfig(result, options, theme, getConfig, "entry", "entries");
    },
  };
}

function writeRenderers(getConfig: ConfigGetter, writeMeta: Map<string, WriteExecutionMeta>): ToolRenderersLike {
  return {
    renderCall(args, theme, context) {
      const content = getToolContentArg(args);
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = shortenPath(getToolPathArg(args));
      const suffix = shouldRenderWriteCallSummary({
        hasContent: content !== undefined,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
        : "";
      const summaryText = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`;
      if (!context?.argsComplete || !context?.isPartial) {
        return textResult(summaryText);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, content: content ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        WRITE_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingWritePreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "writing", "Write failed.");
      if (earlyResult) {
        return earlyResult;
      }

      const config = getConfig();
      const executionMeta = getWriteExecutionMeta(context, writeMeta);
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        config,
        theme,
        fallbackText,
      );
    },
  };
}

function renderBashDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  getConfig: ConfigGetter,
): Text {
  const config = getConfig();
  const details = result.details as BashToolDetails | undefined;
  const rawOutput = extractTextOutput(result);

  if (options.isPartial) {
    return renderBashLivePreview(rawOutput, options, config, theme, details);
  }

  if (isToolError(result, context)) {
    return renderBashErrorResult(rawOutput, options, config, theme, details);
  }

  const lines = prepareOutputLines(rawOutput, options);

  if (lines.length === 0) {
    let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
    if (config.showTruncationHints) {
      text += formatBashTruncationHints(details, theme);
    }
    return textResult(text);
  }

  if (config.bashOutputMode === "summary") {
    if (options.expanded) {
      const maxLines = getExpandedPreviewLineLimit(lines, config);
      return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
    }

    let summary = formatBashSummary(
      lines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints) {
      summary += formatBashTruncationHints(details, theme);
    }
    return textResult(summary);
  }

  if (config.bashOutputMode === "preview") {
    const maxLines = options.expanded
      ? getExpandedPreviewLineLimit(lines, config)
      : config.previewLines;
    return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
  }

  if (!options.expanded && config.bashCollapsedLines === 0) {
    let hidden = theme.fg("muted", "↳ output hidden");
    if (config.showTruncationHints) {
      hidden += formatBashTruncationHints(details, theme);
    }
    return textResult(hidden);
  }

  const maxLines = options.expanded
    ? lines.length
    : config.bashCollapsedLines;
  let text = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }
  return textResult(text);
}

function builtInRenderers(
  toolName: BuiltInToolOverrideName,
  getConfig: ConfigGetter,
  writeMeta: Map<string, WriteExecutionMeta>,
): ToolRenderersLike {
  if (toolName === "read") {
    return {
      renderCall(args, theme) {
        return renderReadDisplayCall(args, theme);
      },
      renderResult(result, options, theme) {
        return renderReadDisplayResult(result, options, getConfig(), theme);
      },
    };
  }

  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    return searchRenderers(toolName, getConfig);
  }

  if (toolName === "edit") {
    return {
      renderShell: "default",
      renderCall(args, theme, context) {
        return renderEditDisplayCall(args, theme, context, {}, getConfig);
      },
      renderResult(result, options, theme, context) {
        return renderEditDisplayResult(result as ToolRenderInput & { isError?: boolean }, options, theme, context, {}, getConfig);
      },
    };
  }

  if (toolName === "write") {
    return writeRenderers(getConfig, writeMeta);
  }

  return {
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context as never);
    },
    renderResult(result, options, theme, context) {
      return renderBashDisplayResult(result, options, theme, context, getConfig);
    },
  };
}
