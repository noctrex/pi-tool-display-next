import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RenderCallContextLike {
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	invalidate(): void;
	executionStarted: boolean;
	isPartial: boolean;
	cwd?: string;
	toolCallId?: string;
	argsComplete?: boolean;
	isError?: boolean;
}

interface ResolvedRenderersLike {
	name: string;
	renderCall?: (args: unknown, theme: RenderThemeLike, context: RenderCallContextLike) => RenderComponentLike;
	renderResult?: (result: unknown, options: unknown, theme: unknown) => RenderComponentLike;
	renderShell?: unknown;
}

type ResolverFn = (toolName: string, next: () => unknown) => unknown;

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createExtensionApiStub(): {
	api: ExtensionAPI;
	resolvers: ResolverFn[];
	eventHandlers: Record<string, (...args: unknown[]) => unknown>;
} {
	const resolvers: ResolverFn[] = [];
	const eventHandlers: Record<string, (...args: unknown[]) => unknown> = {};
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown): void {
			eventHandlers[event] = handler;
		},
		registerToolRenderer(resolver: ResolverFn): void {
			resolvers.push(resolver);
		},
	} as unknown as ExtensionAPI;
	return { api, resolvers, eventHandlers };
}

interface ExtensionStub {
	api: ExtensionAPI;
	resolvers: ResolverFn[];
	eventHandlers: Record<string, (...args: unknown[]) => unknown>;
}

function claimRenderers(stub: ExtensionStub, toolName: string): ResolvedRenderersLike | undefined {
	assert.ok(stub.resolvers.length > 0, "expected a registerToolRenderer resolver to be installed");
	const resolved = stub.resolvers[stub.resolvers.length - 1](toolName, () => undefined) as
		| Omit<ResolvedRenderersLike, "name">
		| undefined;
	if (!resolved) {
		return undefined;
	}
	return { name: toolName, ...resolved };
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(
	renderers: ResolvedRenderersLike | undefined,
	input:
		| string
		| {
				text: string;
				details?: unknown;
				expanded?: boolean;
				isPartial?: boolean;
				isError?: boolean;
		  },
): string {
	assert.ok(renderers?.renderResult, `expected renderResult for '${renderers?.name ?? "unknown"}'`);
	const payload = typeof input === "string" ? { text: input } : input;
	return normalizeRenderedText(
		renderers.renderResult(
			{
				content: [{ type: "text", text: payload.text }],
				details: payload.details ?? {},
				isError: payload.isError ?? false,
			},
			{ isPartial: payload.isPartial ?? false, expanded: payload.expanded ?? false },
			createTheme(),
		),
	);
}

function renderToolCall(
	renderers: ResolvedRenderersLike | undefined,
	args: { command: string; timeout?: number },
	contextOverrides: Partial<RenderCallContextLike> = {},
): { output: string; component: RenderComponentLike; context: RenderCallContextLike } {
	assert.ok(renderers?.renderCall, `expected renderCall for '${renderers?.name ?? "unknown"}'`);
	const context: RenderCallContextLike = {
		lastComponent: contextOverrides.lastComponent,
		state: contextOverrides.state ?? {},
		invalidate: contextOverrides.invalidate ?? (() => {}),
		executionStarted: contextOverrides.executionStarted ?? false,
		isPartial: contextOverrides.isPartial ?? false,
	};
	const component = renderers.renderCall(args, createTheme(), context);
	return {
		output: normalizeRenderedText(component),
		component,
		context,
	};
}

test("current local-style config keeps read/search/MCP output modes distinct", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);

	const read = claimRenderers(stub, "read");
	const grep = claimRenderers(stub, "grep");
	const find = claimRenderers(stub, "find");
	const ls = claimRenderers(stub, "ls");
	const bash = claimRenderers(stub, "bash");
	const edit = claimRenderers(stub, "edit");
	const write = claimRenderers(stub, "write");
	const mcp = claimRenderers(stub, "mcp");
	assert.ok(read && grep && find && ls && bash && edit && write, "all built-ins claimed");
	assert.ok(mcp?.renderResult, "mcp proxy claimed");

	assert.equal(
		renderToolResult(read, "alpha\nbeta\n"),
		"↳ loaded 2 lines • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(grep, "a.txt:1\nb.txt:2\n"),
		"↳ 2 matches returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(find, "a.txt\nb.txt\n"),
		"↳ 2 results returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(ls, "a.txt\nb.txt\n"),
		"↳ 2 entries returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(mcp, "one\ntwo\n"),
		"↳ 2 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(read, {
			text: "alpha\nbeta\n",
			expanded: true,
		}),
		"alpha\nbeta",
	);
	assert.equal(
		renderToolResult(grep, {
			text: "a.txt:1\nb.txt:2\n",
			expanded: true,
		}),
		"a.txt:1\nb.txt:2",
	);
	assert.equal(
		renderToolResult(mcp, {
			text: "one\ntwo\n",
			expanded: true,
		}),
		"one\ntwo",
	);
});

test("read-only claim config keeps summary line counts confined to read", async () => {
	const config = buildConfig({
		registerToolOverrides: {
			read: true,
			grep: false,
			find: false,
			ls: false,
			bash: false,
			edit: false,
			write: false,
		},
		readOutputMode: "summary",
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);

	const read = claimRenderers(stub, "read");
	assert.ok(read?.renderResult, "read claimed");
	const sentinel = Symbol("next");
	assert.equal(stub.resolvers[0]("grep", () => sentinel), sentinel, "grep not claimed");
	assert.equal(
		renderToolResult(read, "single line\n"),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
});

test("showTruncationHints=false suppresses backend truncation summaries across read/search/MCP modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);

	const read = claimRenderers(stub, "read");
	const grep = claimRenderers(stub, "grep");
	const mcp = claimRenderers(stub, "mcp");

	assert.equal(
		renderToolResult(read, {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(grep, {
			text: "a.txt:1\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 match returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(mcp, {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 line returned • Ctrl+O to expand",
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for summary modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
		},
	};

	const read = claimRenderers(stub, "read");
	const grep = claimRenderers(stub, "grep");
	const mcp = claimRenderers(stub, "mcp");

	assert.match(
		renderToolResult(read, {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(grep, {
			text: "a.txt:1\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(mcp, {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for preview modes", async () => {
	const config = buildConfig({
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 1,
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
			originalLineCount: 10,
			compactedLineCount: 1,
		},
	};

	const read = claimRenderers(stub, "read");
	const grep = claimRenderers(stub, "grep");
	const mcp = claimRenderers(stub, "mcp");

	assert.match(
		renderToolResult(read, {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(grep, {
			text: "a.txt:1\nb.txt:2\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(mcp, {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
});

test("bash output modes stay distinct across opencode, summary, and preview", async () => {
	const output = "alpha\nbeta\ngamma\n";

	const opencodeConfig = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
	});
	const opencodeStub = createExtensionApiStub();
	registerToolDisplayOverrides(opencodeStub.api, () => opencodeConfig);
	assert.equal(
		renderToolResult(claimRenderers(opencodeStub, "bash"), output),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);

	const summaryConfig = buildConfig({
		bashOutputMode: "summary",
		bashCollapsedLines: 1,
	});
	const summaryStub = createExtensionApiStub();
	registerToolDisplayOverrides(summaryStub.api, () => summaryConfig);
	const bash = claimRenderers(summaryStub, "bash");
	assert.equal(
		renderToolResult(bash, output),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(bash, {
			text: output,
			expanded: true,
		}),
		"alpha\nbeta\ngamma",
	);

	const previewConfig = buildConfig({
		bashOutputMode: "preview",
		previewLines: 2,
		bashCollapsedLines: 1,
	});
	const previewStub = createExtensionApiStub();
	registerToolDisplayOverrides(previewStub.api, () => previewConfig);
	assert.equal(
		renderToolResult(claimRenderers(previewStub, "bash"), output),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash call spinner appears only while execution is active", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const bash = claimRenderers(stub, "bash");

	const idle = renderToolCall(bash, { command: "npm test" });
	assert.equal(idle.output, "$ npm test");

	let invalidateCount = 0;
	const running = renderToolCall(
		bash,
		{ command: "npm test" },
		{
			state: {},
			executionStarted: true,
			isPartial: true,
			invalidate: () => {
				invalidateCount++;
			},
		},
	);
	assert.match(running.output, /^⠋ \$ npm test · 0s$/);

	await new Promise((resolve) => setTimeout(resolve, 220));
	const animatedFrame = normalizeRenderedText(running.component);
	assert.notEqual(animatedFrame, running.output);
	assert.match(animatedFrame, /^⠙ \$ npm test · 0s$/);
	assert.ok(invalidateCount > 0);

	const complete = renderToolCall(
		bash,
		{ command: "npm test" },
		{
			state: running.context.state,
			lastComponent: running.component,
			executionStarted: true,
			isPartial: false,
		},
	);
	assert.equal(complete.output, "$ npm test");
});

test("bash render keeps the running result area empty until output exists", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const bash = claimRenderers(stub, "bash");

	assert.equal(
		renderToolResult(bash, { text: "", isPartial: true }),
		"",
	);
});

test("bash render shows live partial output once streaming begins", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const bash = claimRenderers(stub, "bash");

	assert.equal(
		renderToolResult(bash, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash live partial output respects opencode collapse settings", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		previewLines: 4,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const bash = claimRenderers(stub, "bash");

	assert.equal(
		renderToolResult(bash, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);
});

test("bash errors render with an explicit failure header and preview", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const stub = createExtensionApiStub();
	registerToolDisplayOverrides(stub.api, () => config);
	const bash = claimRenderers(stub, "bash");

	assert.equal(
		renderToolResult(bash, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\nSee npm help run-script",
	);
});
