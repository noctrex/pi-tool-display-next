import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import { getToolDisplayConfigPath, normalizeToolDisplayConfig } from "./config-store.js";
import {
	detectToolDisplayPreset,
	getToolDisplayPresetConfig,
	parseToolDisplayPreset,
	TOOL_DISPLAY_PRESETS,
	type ToolDisplayPreset,
} from "./presets.js";
import { shortenPath } from "./render-utils.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import { type ToolDisplayConfig, BUILT_IN_TOOL_OVERRIDE_NAMES } from "./types.js";

interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	setConfig(next: ToolDisplayConfig, ctx: ExtensionCommandContext): void;
	getCapabilities(): ToolDisplayCapabilities;
}

interface ModalOverlayOptions {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
}

const PREVIEW_LINE_VALUES = ["4", "8", "12", "20", "40"] as const;
const BASH_PREVIEW_LINE_VALUES = ["0", "5", "10", "20", "40"] as const;
const BASH_COMMAND_MAX_CHARS_VALUES = ["0", "120", "200", "400", "800", "2000"] as const;
const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["0", "500", "1000", "2000", "4000", "8000", "20000"] as const;
const DIFF_SPLIT_MIN_WIDTH_VALUES = ["70", "90", "120", "160", "200", "240"] as const;
const DIFF_COLLAPSED_LINES_VALUES = ["4", "8", "12", "24", "48", "96", "240"] as const;
const PRESET_COMMAND_HINT = TOOL_DISPLAY_PRESETS.join("|");

function toOnOff(value: boolean): string {
	return value ? "on" : "off";
}

function toolOwnershipSummary(config: ToolDisplayConfig): string {
	const overrides = config.registerToolOverrides;
	return `read:${toOnOff(overrides.read)},grep:${toOnOff(overrides.grep)},find:${toOnOff(overrides.find)},ls:${toOnOff(overrides.ls)},bash:${toOnOff(overrides.bash)},edit:${toOnOff(overrides.edit)},write:${toOnOff(overrides.write)}`;
}

function summarizeConfig(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): string {
	const preset = detectToolDisplayPreset(config);
	const parts = [
		`preset=${preset}`,
		`owners={${toolOwnershipSummary(config)}}`,
		`userBox=${toOnOff(config.enableNativeUserMessageBox)}`,
		`read=${config.readOutputMode}`,
		`search=${config.searchOutputMode}`,
		`codemode=${config.codemodeOutputMode}`,
		`preview=${config.previewLines}`,
		`expandedMax=${config.expandedPreviewMaxLines}`,
		`bash=${config.bashOutputMode}`,
		`bashLines=${config.bashCollapsedLines}`,
		`diff=${config.diffViewMode}/${config.diffIndicatorMode}@${config.diffSplitMinWidth}`,
		`diffLines=${config.diffCollapsedLines}`,
		`diffWrap=${toOnOff(config.diffWordWrap)}`,
	];

	if (capabilities.hasMcpTooling) {
		parts.push(`mcp=${config.mcpOutputMode}`);
	} else {
		parts.push("mcp=auto-hidden");
	}

	if (capabilities.hasRtkOptimizer) {
		parts.push(`rtkHints=${toOnOff(config.showRtkCompactionHints)}`);
	} else {
		parts.push("rtkHints=auto-off");
	}

	return parts.join(", ");
}

function parseNumber(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function buildAdvancedNotes(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
	extra: readonly string[],
): string[] {
	const notes = [
		...extra,
		"customToolOverrides stays a manual JSON edit: it maps arbitrary tool names to per-tool claim and output settings.",
		`Tool ownership is currently ${toolOwnershipSummary(config)} and still applies after /reload.`,
		`Truncation hints are ${toOnOff(config.showTruncationHints)}${capabilities.hasRtkOptimizer ? `; RTK hints are ${toOnOff(config.showRtkCompactionHints)}.` : "."}`,
	];
	return notes;
}

export function buildInspectorSettings(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
): InspectorSettingItem[] {
	const configPath = shortenPath(getToolDisplayConfigPath());
	const items: InspectorSettingItem[] = [
		{
			id: "preset",
			label: "Preset profile",
			currentValue: detectToolDisplayPreset(config),
			values: TOOL_DISPLAY_PRESETS,
			inspectorTitle: "Preset Profile",
			inspectorSummary: [
				"Determines the overall verbosity and layout of the agent's tool output.",
				"Choosing a preset applies a coherent profile across the output modes and line budgets. All other settings are preserved.",
			],
			inspectorOptions: [
				"opencode — strict inline-only tool output",
				"balanced — compact summaries with counts",
				"verbose — larger line previews and more visible bash output",
				"custom — shown automatically when manual overrides no longer match a preset",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Presets reset multiple fields together, so manual JSON tuning is the right place for durable custom combinations.",
			]),
			inspectorPath: configPath,
			searchTerms: ["verbosity", "profile", "layout", "custom", ...TOOL_DISPLAY_PRESETS],
		},
		{
			id: "enabled",
			label: "Tool display",
			currentValue: toOnOff(config.enabled),
			values: ["on", "off"],
			inspectorTitle: "Tool Display",
			inspectorSummary: [
				"Master switch for the extension's renderers.",
				"Turning it off hands every tool back to Pi's native rendering without unregistering the extension.",
			],
			inspectorOptions: [
				"on — extension renderers draw claimed tools",
				"off — Pi's native renderers draw everything",
			],
			inspectorPath: configPath,
			searchTerms: ["enable", "disable", "master", "switch", "extension"],
		},
		...BUILT_IN_TOOL_OVERRIDE_NAMES.map(
			(tool): InspectorSettingItem => ({
				id: `registerToolOverrides.${tool}`,
				label: `Claim ${tool} tool`,
				currentValue: toOnOff(config.registerToolOverrides[tool]),
				values: ["on", "off"],
				inspectorTitle: `Claim ${tool} Tool`,
				inspectorSummary: [
					"Controls whether this extension replaces Pi's native renderer for the tool.",
					"Off restores stock Pi rendering for that tool only; the tool itself keeps working either way.",
				],
				inspectorOptions: [
					"on — this extension draws the tool",
					"off — stock Pi draws the tool",
				],
				inspectorPath: configPath,
				searchTerms: ["claim", "override", "native", "renderer", tool],
			}),
		),
		{
			id: "readOutputMode",
			label: "Read tool output",
			currentValue: config.readOutputMode,
			values: ["hidden", "summary", "preview"],
			inspectorTitle: "Read Tool Output",
			inspectorSummary: [
				"Controls how read results appear inline after the tool call header.",
				"Use hidden for the cleanest transcript, summary for file metrics, or preview when seeing source lines matters in-context.",
			],
			inspectorOptions: [
				"hidden — path and status only",
				"summary — adds compact file metrics",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"expandedPreviewMaxLines bounds how many lines can appear after expanding a preview-heavy read result.",
			]),
			inspectorPath: configPath,
			searchTerms: ["file", "source", "preview", "summary", "hidden"],
		},
		{
			id: "searchOutputMode",
			label: "Grep/Find/Ls output",
			currentValue: config.searchOutputMode,
			values: ["hidden", "count", "preview"],
			inspectorTitle: "Grep / Find / Ls Output",
			inspectorSummary: [
				"Controls how search-style tools compress their result sets inside the transcript.",
				"Count mode keeps discovery actions readable while still surfacing how much data the tool matched.",
			],
			inspectorOptions: [
				"hidden — call header only",
				"count — totals only for matches or entries",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Preview-heavy search output is most effective when paired with larger previewLines values in custom configurations.",
			]),
			inspectorPath: configPath,
			searchTerms: ["grep", "find", "ls", "matches", "count", "results"],
		},
	];

	if (capabilities.hasMcpTooling) {
		items.push({
			id: "mcpOutputMode",
			label: "MCP tool output",
			currentValue: config.mcpOutputMode,
			values: ["hidden", "summary", "preview"],
			inspectorTitle: "MCP Tool Output",
			inspectorSummary: [
				"Controls how proxied MCP tool results are compacted when they return text output.",
				"Summary mode is the safest default when you want awareness without flooding the chat pane.",
			],
			inspectorOptions: [
				"hidden — call metadata only",
				"summary — compact line-count summary",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This control appears only when MCP tooling is available in the current Pi session.",
			]),
			inspectorPath: configPath,
			searchTerms: ["mcp", "proxy", "server", "summary", "preview"],
		});
	}

	items.push({
		id: "codemodeOutputMode",
		label: "Native codemode output",
		currentValue: config.codemodeOutputMode,
		values: ["summary", "calls", "preview"],
		inspectorTitle: "Native codemode output",
		inspectorSummary: [
			"Controls the collapsed view of Pi's native codemode tool.",
			"Expand a tool to see its full script, call trace, and output.",
		],
		inspectorOptions: [
			"summary: script status and call counts only",
			"calls: status summary and nested-call trace",
			"preview: call trace plus output limited by Preview lines",
		],
		inspectorAdvanced: [
			"Preview lines counts terminal rows after wrapping codemode output.",
			"Selections are saved automatically.",
		],
		inspectorPath: configPath,
		searchTerms: ["codemode", "script", "calls", "trace", "summary", "preview"],
	});

	items.push(
		{
			id: "previewLines",
			label: "Preview lines",
			currentValue: String(config.previewLines),
			values: PREVIEW_LINE_VALUES,
			inspectorTitle: "Preview Lines",
			inspectorSummary: [
				"Sets how many lines appear when read, search, MCP, or bash preview modes are collapsed inline.",
				"Accepted manual range: 1 to 80 lines. The quick selector cycles through a curated set for fast tuning.",
			],
			inspectorOptions: [
				"Lower values keep transcripts dense and skimmable",
				"Higher values surface more source context before expansion",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Pair this with expandedPreviewMaxLines when you want larger expanded previews without making collapsed output noisy.",
			]),
			inspectorPath: configPath,
			searchTerms: ["preview", "lines", "range", "collapsed", "read", "grep", "mcp", "bash"],
		},
		{
			id: "bashOutputMode",
			label: "Bash tool output",
			currentValue: config.bashOutputMode,
			values: ["opencode", "summary", "preview"],
			inspectorTitle: "Bash Tool Output",
			inspectorSummary: [
				"Controls how shell command output is rendered when the command finishes successfully.",
				"The opencode mode keeps command output recognizable while still compressing walls of stdout.",
			],
			inspectorOptions: [
				"opencode — Pi/OpenCode-style collapsed bash view",
				"summary — output count only",
				"preview — uses the shared previewLines setting",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Quiet commands still collapse aggressively, so mode selection matters most on verbose build, test, and script output.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "shell", "stdout", "command", "opencode"],
		},
		{
			id: "bashCollapsedLines",
			label: "Bash collapsed lines",
			currentValue: String(config.bashCollapsedLines),
			values: BASH_PREVIEW_LINE_VALUES,
			inspectorTitle: "Bash Collapsed Lines",
			inspectorSummary: [
				"Sets the inline line budget used specifically by opencode bash mode before expansion.",
				"Accepted manual range: 0 to 80 lines. Setting 0 hides collapsed bash output entirely while keeping the command visible.",
			],
			inspectorOptions: [
				"0 — hide collapsed bash output",
				"5/10/20/40 — progressively larger inline command previews",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This setting only changes the opencode bash renderer; preview mode continues to use previewLines instead.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "collapsed", "lines", "stdout", "zero"],
		},
		{
			id: "diffViewMode",
			label: "Edit diff layout",
			currentValue: config.diffViewMode,
			values: ["auto", "split", "unified"],
			inspectorTitle: "Edit Diff Layout",
			inspectorSummary: [
				"Controls how edit and write diffs are arranged when the extension renders code changes.",
				"Auto mode adapts to terminal width so wide panes get side-by-side diffs while narrow panes stay readable.",
			],
			inspectorOptions: [
				"auto — adaptive layout based on available width",
				"split — force side-by-side diff columns",
				"unified — force a single-column diff",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"diffSplitMinWidth, diffCollapsedLines, and diffWordWrap have their own entries in this settings list for more aggressive diff control.",
			]),
			inspectorPath: configPath,
			searchTerms: ["diff", "edit", "write", "split", "unified", "auto"],
		},
		{
			id: "diffIndicatorMode",
			label: "Diff indicators",
			currentValue: config.diffIndicatorMode,
			values: ["bars", "classic", "none"],
			inspectorTitle: "Diff Indicators",
			inspectorSummary: [
				"Controls whether changed diff lines use vertical bars, classic +/- markers, or no indicators at all.",
				"Bars continue across wrapped changed rows, classic markers appear only on the first wrapped row, and none removes the indicator column styling.",
			],
			inspectorOptions: [
				"bars — persistent vertical indicators for changed rows",
				"classic — + / - markers on the first visual row only",
				"none — no diff indicator marker",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Use config.json when you want this indicator preference to remain explicit alongside other diff rendering overrides.",
			]),
			inspectorPath: configPath,
			searchTerms: ["diff", "indicator", "bars", "classic", "none", "marker"],
		},
		{
			id: "enableNativeUserMessageBox",
			label: "Native user message box",
			currentValue: toOnOff(config.enableNativeUserMessageBox),
			values: ["on", "off"],
			inspectorTitle: "Native User Message Box",
			inspectorSummary: [
				"Toggles the bordered native renderer used for user prompts inside the Pi transcript.",
				"Keep it on when you want clearer message separation, or turn it off to fall back to Pi's default user message rendering.",
			],
			inspectorOptions: [
				"on — bordered native user prompt box",
				"off — default Pi prompt rendering",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This switch only affects presentation. It does not change stored prompts, markdown handling, or tool behavior.",
			]),
			inspectorPath: configPath,
			searchTerms: ["user", "message", "box", "prompt", "native"],
		},
		{
			id: "thinkingLabel",
			label: "Thinking label",
			currentValue: toOnOff(config.thinkingLabel),
			values: ["on", "off"],
			inspectorTitle: "Thinking Label",
			inspectorSummary: [
				"Prefixes thinking blocks with a visible label in the transcript.",
				"The label is applied at render time only; stored messages and model context keep clean content.",
			],
			inspectorOptions: [
				"on — thinking blocks render with a Thinking: prefix",
				"off — thinking blocks render as the model wrote them",
			],
			inspectorPath: configPath,
			searchTerms: ["thinking", "label", "reasoning", "prefix"],
		},
		{
			id: "strictAnsiSanitization",
			label: "Strict ANSI sanitization",
			currentValue: toOnOff(config.strictAnsiSanitization),
			values: ["on", "off"],
			inspectorTitle: "Strict ANSI Sanitization",
			inspectorSummary: [
				"Controls how untrusted tool arguments and output are sanitized before rendering.",
				"Off keeps foreground colors from external programs for a richer display; on strips every escape sequence and control byte, matching stock Pi.",
			],
			inspectorOptions: [
				"off — color-rich rendering; escape sequences other than background colors pass through (accepted risk)",
				"on — full escape and control-character strip; external tool colors are removed",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Terminal effects such as title changes, clipboard writes, or cursor movement cannot be caused by tool content while strict mode is on.",
			]),
			inspectorPath: configPath,
			searchTerms: ["ansi", "escape", "sanitize", "security", "colors", "strict", "clipboard"],
		},
		{
			id: "allowExternalDiffPreviews",
			label: "External diff previews",
			currentValue: toOnOff(config.allowExternalDiffPreviews),
			values: ["on", "off"],
			inspectorTitle: "External Diff Previews",
			inspectorSummary: [
				"Allows pending-edit diff previews for paths outside the current workspace.",
				"Preview reads are canonicalized through realpath and capped at 1 MB regardless of this setting.",
			],
			inspectorOptions: [
				"off — previews only for files inside the workspace",
				"on — previews also for absolute paths outside the workspace",
			],
			inspectorPath: configPath,
			searchTerms: ["diff", "preview", "external", "workspace", "path"],
		},
		{
			id: "bashIntentMode",
			label: "Bash intent header",
			currentValue: config.bashIntentMode,
			values: ["off", "render", "render-and-instruct"],
			inspectorTitle: "Bash Intent Header",
			inspectorSummary: [
				"Renders leading '# intent:' / '# tool:' comments as the bash call header.",
				"Render-and-instruct also asks the model to write those comments through the system prompt.",
			],
			inspectorOptions: [
				"off — no intent header",
				"render — show the header when the command carries intent comments",
				"render-and-instruct — show the header and instruct the model to use it",
			],
			inspectorPath: configPath,
			searchTerms: ["bash", "intent", "header", "comment", "tool"],
		},
		{
			id: "bashIntentShowCommand",
			label: "Bash intent command",
			currentValue: toOnOff(config.bashIntentShowCommand),
			values: ["on", "off"],
			inspectorTitle: "Bash Intent Command",
			inspectorSummary: [
				"Appends a one-line command summary to the bash intent header when it is collapsed.",
				"Only applies when the bash intent header is enabled.",
			],
			inspectorOptions: [
				"on — intent header carries the command suffix",
				"off — intent header shows the label only",
			],
			inspectorPath: configPath,
			searchTerms: ["bash", "intent", "command", "suffix", "collapsed"],
		},
		{
			id: "bashCommandMaxChars",
			label: "Bash command max chars",
			currentValue: String(config.bashCommandMaxChars),
			values: BASH_COMMAND_MAX_CHARS_VALUES,
			inspectorTitle: "Bash Command Max Chars",
			inspectorSummary: [
				"Truncates the displayed bash command to this many characters on one line.",
				"Accepted manual range: 0 to 2000. 0 disables truncation.",
			],
			inspectorOptions: [
				"0 — show the full command",
				"120 to 2000 — truncate long commands with an ellipsis",
			],
			inspectorPath: configPath,
			searchTerms: ["bash", "command", "chars", "truncate", "length"],
		},
		{
			id: "expandedPreviewMaxLines",
			label: "Expanded preview cap",
			currentValue: String(config.expandedPreviewMaxLines),
			values: EXPANDED_PREVIEW_MAX_LINES_VALUES,
			inspectorTitle: "Expanded Preview Cap",
			inspectorSummary: [
				"Bounds how many lines an expanded preview can show across read, search, MCP, bash, and codemode output.",
				"Accepted manual range: 0 to 20000. 0 disables the cap.",
			],
			inspectorOptions: [
				"0 — no cap when expanded",
				"500 to 20000 — cap expanded previews at this many lines",
			],
			inspectorPath: configPath,
			searchTerms: ["expanded", "preview", "cap", "lines", "limit"],
		},
		{
			id: "diffSplitMinWidth",
			label: "Diff split min width",
			currentValue: String(config.diffSplitMinWidth),
			values: DIFF_SPLIT_MIN_WIDTH_VALUES,
			inspectorTitle: "Diff Split Min Width",
			inspectorSummary: [
				"Minimum terminal width before the auto diff layout prefers side-by-side split columns.",
				"Accepted manual range: 70 to 240 columns.",
			],
			inspectorOptions: [
				"Lower values switch to split earlier",
				"Higher values keep single-column diffs until the pane is wider",
			],
			inspectorPath: configPath,
			searchTerms: ["diff", "split", "width", "auto", "columns"],
		},
		{
			id: "diffCollapsedLines",
			label: "Diff collapsed lines",
			currentValue: String(config.diffCollapsedLines),
			values: DIFF_COLLAPSED_LINES_VALUES,
			inspectorTitle: "Diff Collapsed Lines",
			inspectorSummary: [
				"How many diff body lines render before the diff collapses behind its frame.",
				"Accepted manual range: 4 to 240 lines.",
			],
			inspectorOptions: [
				"Lower values keep diffs compact",
				"Higher values show more of large diffs inline",
			],
			inspectorPath: configPath,
			searchTerms: ["diff", "collapsed", "lines", "frame"],
		},
		{
			id: "diffWordWrap",
			label: "Diff word wrap",
			currentValue: toOnOff(config.diffWordWrap),
			values: ["on", "off"],
			inspectorTitle: "Diff Word Wrap",
			inspectorSummary: [
				"Wraps long diff lines at the pane width instead of truncating them.",
				"Wrapped continuation rows keep the line's change indicator styling.",
			],
			inspectorOptions: [
				"on — wrap long diff lines",
				"off — truncate long diff lines at the pane width",
			],
			inspectorPath: configPath,
			searchTerms: ["diff", "wrap", "word", "truncate", "long"],
		},
		{
			id: "showTruncationHints",
			label: "Truncation hints",
			currentValue: toOnOff(config.showTruncationHints),
			values: ["on", "off"],
			inspectorTitle: "Truncation Hints",
			inspectorSummary: [
				"Shows truncation indicators on compacted output so you can tell when content was cut.",
			],
			inspectorOptions: [
				"on — append truncated markers to compacted summaries",
				"off — keep summaries clean without truncation markers",
			],
			inspectorPath: configPath,
			searchTerms: ["truncation", "hints", "markers", "compacted"],
		},
	);

	if (capabilities.hasRtkOptimizer) {
		items.push({
			id: "showRtkCompactionHints",
			label: "RTK compaction hints",
			currentValue: toOnOff(config.showRtkCompactionHints),
			values: ["on", "off"],
			inspectorTitle: "RTK Compaction Hints",
			inspectorSummary: [
				"Shows which compaction techniques the RTK optimizer applied to tool output.",
				"This entry appears only when RTK is detected in the current Pi session.",
			],
			inspectorOptions: [
				"on — annotate summaries with RTK compaction details",
				"off — no RTK annotations",
			],
			inspectorPath: configPath,
			searchTerms: ["rtk", "compaction", "hints", "optimizer"],
		});
	}

	return items;
}

function applyPreset(current: ToolDisplayConfig, preset: ToolDisplayPreset): ToolDisplayConfig {
	// Presets switch the verbosity profile only: the output modes and the two
	// line budgets they define. Everything else the user configured (master
	// switch, tool claims, intent, diff tuning, security posture, logging)
	// survives a preset switch; /tool-display reset restores factory defaults.
	const profile = getToolDisplayPresetConfig(preset);
	return {
		...current,
		readOutputMode: profile.readOutputMode,
		searchOutputMode: profile.searchOutputMode,
		mcpOutputMode: profile.mcpOutputMode,
		codemodeOutputMode: profile.codemodeOutputMode,
		bashOutputMode: profile.bashOutputMode,
		previewLines: profile.previewLines,
		bashCollapsedLines: profile.bashCollapsedLines,
	};
}

export function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
	switch (id) {
		case "preset": {
			const parsed = parseToolDisplayPreset(value);
			return parsed ? applyPreset(config, parsed) : config;
		}
		case "enabled":
			return {
				...config,
				enabled: value === "on",
			};
		case "enableNativeUserMessageBox":
			return {
				...config,
				enableNativeUserMessageBox: value === "on",
			};
		case "thinkingLabel":
			return {
				...config,
				thinkingLabel: value === "on",
			};
		case "strictAnsiSanitization":
			return {
				...config,
				strictAnsiSanitization: value === "on",
			};
		case "allowExternalDiffPreviews":
			return {
				...config,
				allowExternalDiffPreviews: value === "on",
			};
		case "bashIntentShowCommand":
			return {
				...config,
				bashIntentShowCommand: value === "on",
			};
		case "diffWordWrap":
			return {
				...config,
				diffWordWrap: value === "on",
			};
		case "showTruncationHints":
			return {
				...config,
				showTruncationHints: value === "on",
			};
		case "showRtkCompactionHints":
			return {
				...config,
				showRtkCompactionHints: value === "on",
			};
		case "debug":
			return {
				...config,
				debug: value === "on",
			};
		case "bashIntentMode":
			return {
				...config,
				bashIntentMode: value as ToolDisplayConfig["bashIntentMode"],
			};
		case "bashCommandMaxChars":
			return {
				...config,
				bashCommandMaxChars: parseNumber(value, config.bashCommandMaxChars),
			};
		case "expandedPreviewMaxLines":
			return {
				...config,
				expandedPreviewMaxLines: parseNumber(value, config.expandedPreviewMaxLines),
			};
		case "diffSplitMinWidth":
			return {
				...config,
				diffSplitMinWidth: parseNumber(value, config.diffSplitMinWidth),
			};
		case "diffCollapsedLines":
			return {
				...config,
				diffCollapsedLines: parseNumber(value, config.diffCollapsedLines),
			};
		case "readOutputMode":
			return {
				...config,
				readOutputMode: value as ToolDisplayConfig["readOutputMode"],
			};
		case "searchOutputMode":
			return {
				...config,
				searchOutputMode: value as ToolDisplayConfig["searchOutputMode"],
			};
		case "mcpOutputMode":
			return {
				...config,
				mcpOutputMode: value as ToolDisplayConfig["mcpOutputMode"],
			};
		case "codemodeOutputMode":
			return normalizeToolDisplayConfig({ ...config, codemodeOutputMode: value });
		case "previewLines":
			return {
				...config,
				previewLines: parseNumber(value, config.previewLines),
			};
		case "bashOutputMode":
			return {
				...config,
				bashOutputMode: value as ToolDisplayConfig["bashOutputMode"],
			};
		case "bashCollapsedLines":
			return {
				...config,
				bashCollapsedLines: parseNumber(value, config.bashCollapsedLines),
			};
		case "diffViewMode":
			return {
				...config,
				diffViewMode: value as ToolDisplayConfig["diffViewMode"],
			};
		case "diffIndicatorMode":
			return {
				...config,
				diffIndicatorMode: value as ToolDisplayConfig["diffIndicatorMode"],
			};
		default: {
			if (id.startsWith("registerToolOverrides.")) {
				const tool = id.slice("registerToolOverrides.".length);
				if ((BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(tool)) {
					return {
						...config,
						registerToolOverrides: {
							...config.registerToolOverrides,
							[tool]: value === "on",
						},
					};
				}
			}
			return config;
		}
	}
}

function resolveResponsiveOverlayOptions(): ModalOverlayOptions {
	const terminalWidth =
		typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns)
			? process.stdout.columns
			: 120;
	const terminalHeight =
		typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)
			? process.stdout.rows
			: 36;

	const margin = 1;
	const availableWidth = Math.max(72, terminalWidth - margin * 2);
	const preferredWidth = terminalWidth >= 170 ? 128 : terminalWidth >= 145 ? 118 : terminalWidth >= 120 ? 106 : 92;
	const width = Math.max(72, Math.min(preferredWidth, availableWidth));

	const availableHeight = Math.max(14, terminalHeight - margin * 2);
	const preferredHeight = Math.max(14, Math.floor(terminalHeight * 0.78));
	const maxHeight = Math.min(preferredHeight, availableHeight);

	return {
		anchor: "center",
		width,
		maxHeight,
		margin,
	};
}

export async function openSettingsModal(ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): Promise<void> {
	const overlayOptions = resolveResponsiveOverlayOptions();
	const capabilities = controller.getCapabilities();

	const [{ ZellijModal }, { SplitPaneInspectorModal }] = await Promise.all([
		import("./zellij-modal.js"),
		import("./settings-inspector-modal.js"),
	]);

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const inspector = new SplitPaneInspectorModal(
				{
					getSettings: () => buildInspectorSettings(controller.getConfig(), capabilities),
					onChange: (id, newValue) => {
						const next = applySetting(controller.getConfig(), id, newValue);
						controller.setConfig(next, ctx);
					},
					onClose: () => done(),
				},
				theme,
			);

			const modal = new ZellijModal(
				inspector,
				{
					borderStyle: "square",
					padding: 0,
					titleBar: {},
					overlay: overlayOptions,
				},
				theme,
			);

			return {
				render: (width: number) => modal.renderModal(width).lines,
				invalidate: () => modal.invalidate(),
				handleInput(data: string) {
					modal.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions },
	);
}

export function handleToolDisplayArgs(args: string, ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): boolean {
	const raw = args.trim();
	if (!raw) {
		return false;
	}

	const normalized = raw.toLowerCase();

	if (normalized === "show") {
		ctx.ui.notify(
			`tool-display: ${summarizeConfig(controller.getConfig(), controller.getCapabilities())}`,
			"info",
		);
		return true;
	}

	if (normalized === "reset") {
		controller.setConfig(getToolDisplayPresetConfig("opencode"), ctx);
		ctx.ui.notify("Tool display preset reset to opencode.", "info");
		return true;
	}

	if (normalized.startsWith("preset ")) {
		const candidate = normalized.slice("preset ".length).trim();
		const preset = parseToolDisplayPreset(candidate);
		if (!preset) {
			ctx.ui.notify(`Unknown preset. Use: /tool-display preset ${PRESET_COMMAND_HINT}`, "warning");
			return true;
		}

		controller.setConfig(applyPreset(controller.getConfig(), preset), ctx);
		ctx.ui.notify(`Tool display preset set to ${preset}.`, "info");
		return true;
	}

	ctx.ui.notify(`Usage: /tool-display [show|reset|preset ${PRESET_COMMAND_HINT}]`, "warning");
	return true;
}

export async function runToolDisplayCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<void> {
	if (handleToolDisplayArgs(args, ctx, controller)) {
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("/tool-display requires interactive TUI mode.", "warning");
		return;
	}

	await openSettingsModal(ctx, controller);
}

export function registerToolDisplayCommand(pi: ExtensionAPI, controller: ToolDisplayConfigController): void {
	pi.registerCommand("tool-display", {
		description: "Configure tool output rendering (OpenCode-style)",
		handler: async (args, ctx) => {
			await runToolDisplayCommandHandler(args, ctx, controller);
		},
	});
}
