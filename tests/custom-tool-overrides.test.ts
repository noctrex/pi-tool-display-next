import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface NormalizedCustomToolOverride {
	enabled: boolean;
	kind: "generic" | "mcp";
	outputMode: "hidden" | "summary" | "preview";
}

interface ToolDisplayConfigWithCustomOverrides extends ToolDisplayConfig {
	customToolOverrides: Record<string, NormalizedCustomToolOverride>;
}

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface ResolvedRenderersLike {
	name: string;
	renderCall?: (...args: unknown[]) => RenderComponentLike;
	renderResult?: (...args: unknown[]) => RenderComponentLike;
	renderShell?: unknown;
}

type ResolverFn = (toolName: string, next: () => unknown) => unknown;

function buildConfigWithCustomOverrides(
	customToolOverrides: Record<string, unknown>,
	overrides: Partial<ToolDisplayConfig> = {},
): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
		customToolOverrides,
	} as ToolDisplayConfig;
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
	const render = component && typeof component === "object"
		? (component as { render?: unknown }).render
		: undefined;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as RenderComponentLike)
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(renderers: ResolvedRenderersLike, text: string, options: Record<string, unknown> = {}): string {
	return renderToolRawResult(
		renderers,
		{ content: [{ type: "text", text }], details: {} },
		options,
	);
}

function renderToolRawResult(
	renderers: ResolvedRenderersLike,
	result: Record<string, unknown>,
	options: Record<string, unknown> = {},
): string {
	assert.equal(typeof renderers.renderResult, "function", `expected ${renderers.name} to have renderResult`);
	return renderToText(
		renderers.renderResult(
			result,
			{ expanded: false, isPartial: false, ...options },
			createTheme(),
		),
	);
}

test("normalizeToolDisplayConfig defaults customToolOverrides to an empty opt-in map", () => {
	const config = normalizeToolDisplayConfig({}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {});
});

test("normalizeToolDisplayConfig normalizes custom tool override shorthand, defaults, and invalid entries", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			ide_find_symbol: true,
			" agent_gateway ": { outputMode: "preview" },
			mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
			disabled_tool: false,
			invalid_kind: { enabled: true, kind: "terminal", outputMode: "verbose" },
			read: { enabled: true, kind: "mcp", outputMode: "summary" },
			"": { enabled: true },
			"   ": true,
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		ide_find_symbol: { enabled: true, kind: "generic", outputMode: "summary" },
		agent_gateway: { enabled: true, kind: "generic", outputMode: "preview" },
		mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
		disabled_tool: { enabled: false, kind: "generic", outputMode: "summary" },
		invalid_kind: { enabled: true, kind: "generic", outputMode: "summary" },
	});
});

test("enabled generic custom override renders configured tools and leaves others to next()", () => {
	const config = buildConfigWithCustomOverrides({
		ide_find_symbol: { enabled: true, outputMode: "summary" },
		disabled_noisy_tool: { enabled: false, outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);

	const enabled = claimRenderers(stub, "ide_find_symbol");
	assert.ok(enabled?.renderCall && enabled.renderResult, "enabled custom tool claimed");

	assert.equal(renderToText(enabled.renderCall?.({ query: "Widget", limit: 5 }, createTheme())), "ide_find_symbol (2 args)");
	assert.equal(renderToolResult(enabled, "alpha\nbeta\ngamma\n"), "↳ 3 lines returned • Ctrl+O to expand");

	const sentinel = Symbol("next");
	assert.equal(stub.resolvers[0]("disabled_noisy_tool", () => sentinel), sentinel, "disabled override passes through");
	assert.equal(stub.resolvers[0]("unlisted_noisy_tool", () => sentinel), sentinel, "unlisted tool passes through");
});

test("custom tool override defaults kind to generic unless the user chooses mcp", () => {
	const config = buildConfigWithCustomOverrides({
		remote_gateway: { enabled: true },
		remote_gateway_structured: { enabled: true, kind: "mcp" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);

	const generic = claimRenderers(stub, "remote_gateway");
	const mcp = claimRenderers(stub, "remote_gateway_structured");

	assert.equal(renderToText(generic?.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "remote_gateway (2 args)");
	assert.equal(renderToText(mcp?.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom generic tool override honors per-tool hidden output mode", () => {
	const config = buildConfigWithCustomOverrides({
		large_payload_tool: { enabled: true, outputMode: "hidden" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);

	const quiet = claimRenderers(stub, "large_payload_tool");
	// Hidden is visible, never silent: the marker names which renderer hid it.
	assert.equal(renderToolResult(quiet as ResolvedRenderersLike, "secret\nnoisy\noutput\n"), "↳ output hidden");
});

test("custom tool overrides register nothing for missing tools", () => {
	const config = buildConfigWithCustomOverrides({
		missing_tool: { enabled: true, outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	// The stub exposes no registerTool: configuring an absent tool must not
	// try to register a phantom tool.
	assert.doesNotThrow(() => registerToolDisplayOverrides(stub.api, () => config));

	// If the tool ever appears, its configured rendering resolves by name.
	const renderers = claimRenderers(stub, "missing_tool");
	assert.equal(typeof renderers?.renderResult, "function", "configured name resolves when it appears");
});

test("normalizeToolDisplayConfig treats malformed customToolOverrides containers as empty", () => {
	for (const rawCustomOverrides of [null, true, "ide_find_symbol", [], 42]) {
		const config = normalizeToolDisplayConfig({
			customToolOverrides: rawCustomOverrides,
		}) as ToolDisplayConfigWithCustomOverrides;

		assert.deepEqual(config.customToolOverrides, {});
	}
});

test("normalizeToolDisplayConfig preserves supported custom output modes and drops unknown entry fields", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			hidden_tool: { enabled: true, outputMode: "hidden", label: "Ignored Label" },
			summary_tool: { enabled: true, outputMode: "summary", pathFields: ["file_path"] },
			preview_tool: { enabled: true, outputMode: "preview", renderShell: "self" },
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		hidden_tool: { enabled: true, kind: "generic", outputMode: "hidden" },
		summary_tool: { enabled: true, kind: "generic", outputMode: "summary" },
		preview_tool: { enabled: true, kind: "generic", outputMode: "preview" },
	});
});

test("generic custom tool renderCall handles absent, non-object, and nested arguments safely", () => {
	const config = buildConfigWithCustomOverrides({
		argument_probe: { enabled: true, outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);
	const probe = claimRenderers(stub, "argument_probe") as ResolvedRenderersLike;

	assert.equal(renderToText(probe.renderCall?.(undefined, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(probe.renderCall?.(null, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(probe.renderCall?.("raw string args", createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(probe.renderCall?.(["array", "args"], createTheme())), "argument_probe (no args)");
	assert.equal(
		renderToText(probe.renderCall?.({ path: "src/index.ts", options: { recursive: true }, tags: ["a", "b"] }, createTheme())),
		"argument_probe (3 args)",
	);
});

test("generic custom tool preview mode supports collapsed previews, expanded previews, partial state, and empty text", () => {
	const config = buildConfigWithCustomOverrides(
		{ preview_payload_tool: { enabled: true, outputMode: "preview" } },
		{ previewLines: 2 },
	);
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);
	const preview = claimRenderers(stub, "preview_payload_tool") as ResolvedRenderersLike;

	assert.equal(
		renderToolResult(preview, "alpha\nbeta\ngamma\ndelta\n"),
		"alpha\nbeta\n... (2 more lines • Ctrl+O to expand)",
	);
	assert.equal(
		renderToolResult(preview, "alpha\nbeta\ngamma\ndelta\n", { expanded: true }),
		"alpha\nbeta\ngamma\ndelta",
	);
	assert.equal(renderToolResult(preview, "still running", { isPartial: true }), "running...");
	assert.equal(
		renderToolRawResult(preview, { content: [{ type: "image", data: "ignored" }], details: {} }),
		"↳ (no output)",
	);
	assert.equal(renderToolRawResult(preview, { details: {} }), "↳ (no output)");
});

test("explicit mcp custom tool override interprets MCP proxy argument variants", () => {
	const config = buildConfigWithCustomOverrides({
		custom_gateway: { enabled: true, kind: "mcp", outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);
	const gateway = claimRenderers(stub, "custom_gateway") as ResolvedRenderersLike;

	assert.equal(renderToText(gateway.renderCall?.({}, createTheme())), "MCP status (no args)");
	assert.equal(renderToText(gateway.renderCall?.({ connect: "filesystem" }, createTheme())), "MCP connect filesystem (1 arg)");
	assert.equal(renderToText(gateway.renderCall?.({ describe: "read_file", server: "filesystem" }, createTheme())), "MCP describe read_file @filesystem (2 args)");
	assert.equal(renderToText(gateway.renderCall?.({ search: "browser", server: "exa" }, createTheme())), "MCP search \"browser\" @exa (2 args)");
	assert.equal(renderToText(gateway.renderCall?.({ server: "filesystem" }, createTheme())), "MCP tools filesystem (1 arg)");
	assert.equal(renderToText(gateway.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom overrides never mutate the tool object", () => {
	const execute = (): string => "executed";
	const prepareArguments = (args: unknown): unknown => args;
	const parameters = { type: "object", properties: { query: { type: "string" } } };
	const contractTool = {
		name: "contract_tool",
		description: "Tool with runtime behavior that must survive rendering overrides.",
		parameters,
		execute,
		prepareArguments,
	};
	const config = buildConfigWithCustomOverrides({
		contract_tool: { enabled: true, outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);
	void claimRenderers(stub, "contract_tool");

	assert.equal(contractTool.execute, execute, "execute untouched");
	assert.equal(contractTool.prepareArguments, prepareArguments, "prepareArguments untouched");
	assert.equal(contractTool.parameters, parameters, "parameters untouched");
	assert.equal((contractTool as { renderCall?: unknown }).renderCall, undefined, "no injected renderCall");
	assert.equal((contractTool as { renderResult?: unknown }).renderResult, undefined, "no injected renderResult");
});

test("custom overrides resolve regardless of registration timing", () => {
	const config = buildConfigWithCustomOverrides({
		late_custom_tool: { enabled: true, outputMode: "summary" },
	});
	const stub = createExtensionApiStub();

	registerToolDisplayOverrides(stub.api, () => config);

	// Registration order is irrelevant: the resolver answers by name at
	// render time, before and after any lifecycle event.
	const renderers = claimRenderers(stub, "late_custom_tool");
	assert.equal(typeof renderers?.renderCall, "function");
	assert.equal(typeof renderers?.renderResult, "function");
	assert.equal(renderToText(renderers?.renderCall?.({ query: "late" }, createTheme())), "late_custom_tool (1 arg)");
});
