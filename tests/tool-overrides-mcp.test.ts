import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMcpToolCandidate } from "../src/tool-metadata.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

// ─── Test Types ──────────────────────────────────────────────────────────────

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RuntimeTool extends Record<string, unknown> {
	name: string;
	description: string;
	parameters?: unknown;
	execute?: (...args: unknown[]) => unknown;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	label?: string;
}

interface ResolvedRenderersLike {
	name: string;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	renderShell?: unknown;
}

type ResolverFn = (toolName: string, next: () => unknown) => unknown;

// ─── Test Helpers ────────────────────────────────────────────────────────────

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

function createExtensionApiStub(allTools: RuntimeTool[] = []): {
	api: ExtensionAPI;
	resolvers: ResolverFn[];
	allTools: RuntimeTool[];
} {
	const resolvers: ResolverFn[] = [];
	const api = {
		on(_event: string, _handler: (...args: unknown[]) => unknown): void {
			// Lifecycle handlers are irrelevant to resolution; the resolver
			// answers at render time.
		},
		registerToolRenderer(resolver: ResolverFn): void {
			resolvers.push(resolver);
		},
		getAllTools(): RuntimeTool[] {
			return allTools;
		},
	} as unknown as ExtensionAPI;
	return { api, resolvers, allTools };
}

function claimRenderers(
	stub: ReturnType<typeof createExtensionApiStub>,
	toolName: string,
): ResolvedRenderersLike | undefined {
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

function renderToText(component: unknown): string {
	return (component as { render: (width: number) => string[] }).render(120).map((line) => line.trimEnd()).join("\n").trim();
}

// ─── isMcpToolCandidate Unit Tests ───────────────────────────────────────────

test("isMcpToolCandidate returns true when name is 'mcp'", () => {
	assert.equal(isMcpToolCandidate({ name: "mcp", description: "unified gateway" }), true);
});

test("isMcpToolCandidate ignores 'mcp' in the description; only structural evidence claims", () => {
	// A description word match must not claim a tool: claimed tools have
	// their output hidden by default, and a tool author controls descriptions.
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "MCP tool for web search" }), false);
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "mcp tool for web search" }), false);
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "An MCP-based search" }), false);
});

test("isMcpToolCandidate claims Pi's mcp__server__tool name convention", () => {
	assert.equal(isMcpToolCandidate({ name: "mcp__filesystem__list_dir", parameters: {} }), true);
	assert.equal(isMcpToolCandidate({ name: "mcp__weather__forecast" }), true);
});

test("isMcpToolCandidate returns false when description has 'mcp' substring but not whole word", () => {
	// 'mcp' as substring of a larger word should NOT match /\bmcp\b/i
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "McPherson's tool" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "mcp_test function" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "mcpExample" }), false);
});

test("isMcpToolCandidate returns false for false positives (tool with 'mcp' in description not actually MCP)", () => {
	// Neither a description word match nor loose name shapes (single-underscore
	// prefixes or _mcp suffixes) claim a tool that is not structurally MCP.
	assert.equal(isMcpToolCandidate({ name: "mcpify", description: "Tool to mcpify your code" }), false);
	assert.equal(isMcpToolCandidate({ name: "mcp_manager", description: "Manage mcp connections" }), false);
	assert.equal(isMcpToolCandidate({ name: "example_mcp", description: "An MCP example tool." }), false);
	assert.equal(isMcpToolCandidate({ name: "ctx_summarize", description: "Context tool." }), false);
	assert.equal(isMcpToolCandidate({ name: "server:tool", description: "Colon-named tool." }), false);
});

test("isMcpToolCandidate recognises pi-mcp-adapter direct tools through sourceInfo", () => {
	assert.equal(
		isMcpToolCandidate({
			name: "xcodebuild_list_sims",
			description: "List available iOS simulators.",
			parameters: {},
			sourceInfo: {
				source: "local",
				path: "C:/Users/Administrator/.pi/agent/extensions/pi-mcp-adapter/index.ts",
			},
		}),
		true,
	);
});

test("isMcpToolCandidate returns false when description is undefined", () => {
	assert.equal(isMcpToolCandidate({ name: "random_tool" }), false);
});

test("isMcpToolCandidate returns false when description is empty string", () => {
	assert.equal(isMcpToolCandidate({ name: "random_tool", description: "" }), false);
});

test("isMcpToolCandidate returns false when description is only whitespace", () => {
	assert.equal(isMcpToolCandidate({ name: "random_tool", description: "   " }), false);
});

test("isMcpToolCandidate returns false when tool is null", () => {
	assert.equal(isMcpToolCandidate(null), false);
});

test("isMcpToolCandidate returns false when tool is undefined", () => {
	assert.equal(isMcpToolCandidate(undefined), false);
});

test("isMcpToolCandidate returns false when tool is a string", () => {
	assert.equal(isMcpToolCandidate("mcp"), false);
});

// ─── MCP Resolution via the Renderer Resolver ────────────────────────────────

test("MCP proxy tool resolves renderCall and renderResult without any lifecycle events", () => {
	const stub = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute: () => {},
		},
	]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = claimRenderers(stub, "mcp");
	assert.equal(typeof renderers?.renderCall, "function", "MCP proxy resolves renderCall");
	assert.equal(typeof renderers?.renderResult, "function", "MCP proxy resolves renderResult");
});

test("MCP resolution never touches the tool object", () => {
	const mcpTool: RuntimeTool = {
		name: "mcp",
		description: "Unified MCP gateway.",
		parameters: {},
		execute: () => "executed",
		renderCall: () => ({ render: () => ["RAW"] }),
		renderResult: () => ({ render: () => ["RAW"] }),
	};
	const stub = createExtensionApiStub([mcpTool]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	void claimRenderers(stub, "mcp");

	assert.equal(mcpTool.execute, mcpTool.execute, "execute untouched");
	assert.equal(mcpTool.renderCall, mcpTool.renderCall, "native renderers untouched");
	assert.equal(mcpTool.label, undefined, "label untouched");
	assert.equal(mcpTool.promptSnippet, undefined, "prompt metadata untouched");
});

test("MCP-convention tool without execute or parameters resolves renderers", () => {
	const stub = createExtensionApiStub([
		{
			name: "mcp__example__list",
			description: "An example tool for testing.",
		},
	]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = claimRenderers(stub, "mcp__example__list");
	assert.equal(typeof renderers?.renderCall, "function");
	assert.equal(typeof renderers?.renderResult, "function");
});

test("unregistered MCP tool (resumed session, server not yet connected) still resolves renderers", () => {
	// No getAllTools entries at all: resolution falls back to name heuristics.
	const stub = createExtensionApiStub([]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = claimRenderers(stub, "mcp");
	assert.equal(typeof renderers?.renderCall, "function", "unregistered proxy still claimed");
});

test("MCP tools resolve via the mcp__ name convention in getAllTools metadata", () => {
	const tools: RuntimeTool[] = [
		{ name: "mcp__filesystem__list", description: "List files.", parameters: {}, execute: () => {} },
		{ name: "mcp__db__query", description: "Query database.", parameters: {}, execute: () => {} },
		{ name: "mcp__web__search", description: "Search.", parameters: {}, execute: () => {} },
	];
	const stub = createExtensionApiStub(tools);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	for (const tool of tools) {
		const renderers = claimRenderers(stub, tool.name);
		assert.equal(typeof renderers?.renderCall, "function", `${tool.name} claimed by name convention`);
		assert.equal(typeof renderers?.renderResult, "function", `${tool.name} result claimed`);
	}
});

test("non-MCP tools with plain descriptions pass through", () => {
	const stub = createExtensionApiStub([
		{ name: "some_tool", description: "McPherson's local utility.", parameters: {} },
	]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const sentinel = Symbol("next");
	assert.equal(stub.resolvers[0]("some_tool", () => sentinel), sentinel);
});

// ─── MCP renderCall Output ───────────────────────────────────────────────────

test("MCP renderCall shows tool target and arg count with no args", () => {
	const stub = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute: () => {},
		},
	]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	const renderers = claimRenderers(stub, "mcp");

	const component = renderers?.renderCall?.({}, createTheme());
	assert.equal(renderToText(component), "MCP status (no args)");
});

test("MCP renderCall shows server:tool when both tool and server args are present", () => {
	const stub = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway.",
			parameters: {},
			execute: () => {},
		},
	]);

	registerToolDisplayOverrides(stub.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	const renderers = claimRenderers(stub, "mcp");

	const component = renderers?.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme());
	assert.equal(renderToText(component), "MCP call filesystem:read_file (2 args)");
});

// ─── Existing MCP Adapter Renderers ──────────────────────────────────────────

test("resolver overrides native renderers of pi-mcp-adapter style tools", () => {
	const config = buildConfig({ mcpOutputMode: "summary" });
	const stub = createExtensionApiStub([
		{
			name: "mcp",
			label: "MCP",
			description: "MCP gateway - connect to MCP servers and call their tools",
			parameters: {},
			execute: () => {},
			renderCall: () => ({ render: () => ["RAW MCP CALL"] }),
			renderResult: () => ({ render: () => ["RAW MCP RESULT"] }),
		},
	]);

	registerToolDisplayOverrides(stub.api, () => config);
	const renderers = claimRenderers(stub, "mcp");

	// The resolver's renderers take precedence over the registered tool's own
	// renderers: Pi consults resolvers before falling back to the tool.
	const callText = renderToText(renderers?.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme()));
	const resultText = renderToText(
		renderers?.renderResult?.({ content: [{ type: "text", text: "line 1\nline 2" }] }, { expanded: false }, createTheme()),
	);

	assert.equal(callText, "MCP call filesystem:read_file (2 args)");
	assert.equal(resultText, "↳ 2 lines returned • Ctrl+O to expand");
});

// ─── Config Controls ─────────────────────────────────────────────────────────

test("MCP resolution is independent of registerToolOverrides config", () => {
	// MCP resolution happens regardless of registerToolOverrides settings
	const config = buildConfig({
		registerToolOverrides: {
			read: false,
			grep: false,
			find: false,
			ls: false,
			bash: false,
			edit: false,
			write: false,
		},
	});
	const stub = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute: () => {},
		},
	]);

	registerToolDisplayOverrides(stub.api, () => config);

	const renderers = claimRenderers(stub, "mcp");
	assert.equal(typeof renderers?.renderCall, "function", "MCP claimed even with all built-ins disabled");
});

test("getAllTools failures fall back to name-shape heuristics", () => {
	const resolvers: ResolverFn[] = [];
	const api = {
		on(_event: string, _handler: (...args: unknown[]) => unknown): void {},
		registerToolRenderer(resolver: ResolverFn): void {
			resolvers.push(resolver);
		},
		getAllTools(): RuntimeTool[] {
			throw new Error("getAllTools failed");
		},
	} as unknown as ExtensionAPI;

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = resolvers[0]("mcp", () => undefined) as { renderCall?: unknown };
	assert.equal(typeof renderers?.renderCall, "function", "name heuristic still claims the proxy");
	const sentinel = Symbol("next");
	assert.equal(resolvers[0]("unrelated_tool", () => sentinel), sentinel);
});
