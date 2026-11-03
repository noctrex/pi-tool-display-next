import assert from "node:assert/strict";
import test from "node:test";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

type ResolverFn = (toolName: string, next: () => unknown) => unknown;

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function createStub(): { api: Parameters<typeof registerToolDisplayOverrides>[0]; resolvers: ResolverFn[] } {
	const resolvers: ResolverFn[] = [];
	const api = {
		on(_event: string, _handler: (...args: unknown[]) => unknown): void {},
		registerToolRenderer(resolver: ResolverFn): void {
			resolvers.push(resolver);
		},
	} as unknown as Parameters<typeof registerToolDisplayOverrides>[0];
	return { api, resolvers };
}

function toText(component: unknown): string {
	const render = (component as { render?: unknown })?.render;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as { render: (width: number) => string[] })
		.render(4000)
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
		.join("\n")
		.trim();
}

function bashRenderers(overrides: Partial<ToolDisplayConfig> = {}) {
	const stub = createStub();
	const config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, ...overrides };
	registerToolDisplayOverrides(stub.api, () => config);
	const renderers = stub.resolvers[0]("bash", () => undefined) as {
		renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
	};
	return renderers;
}

test("collapsed bash preview caps extremely long single lines (issue #36)", () => {
	const renderers = bashRenderers({ bashOutputMode: "opencode", bashCollapsedLines: 5 });
	const oneHugeLine = "x".repeat(100_000);

	const output = toText(
		renderers.renderResult(
			{ content: [{ type: "text", text: oneHugeLine }], details: {} },
			{ expanded: false, isPartial: false },
			THEME,
			{ args: { command: "printf huge" }, isError: false, isPartial: false, argsComplete: true },
		),
	);

	// The 100k-character line must not reach the viewport in full.
	assert.ok(output.length < 5000, `expected a bounded preview, got ${output.length} chars`);
	assert.match(output, /chars truncated/);
});

test("expanded bash preview keeps full fidelity for explicitly requested output", () => {
	const renderers = bashRenderers({ bashOutputMode: "opencode" });
	const oneHugeLine = "x".repeat(100_000);

	const output = toText(
		renderers.renderResult(
			{ content: [{ type: "text", text: oneHugeLine }], details: {} },
			{ expanded: true, isPartial: false },
			THEME,
			{ args: { command: "printf huge" }, isError: false, isPartial: false, argsComplete: true },
		),
	);

	assert.ok(output.length >= 100_000, "expanded output is not length-capped");
});

test("collapsed multi-line previews cap only the oversized lines", () => {
	const renderers = bashRenderers({ bashOutputMode: "opencode", bashCollapsedLines: 5 });
	const text = `short line\n${"y".repeat(50_000)}\nanother short line\n`;

	const output = toText(
		renderers.renderResult(
			{ content: [{ type: "text", text }], details: {} },
			{ expanded: false, isPartial: false },
			THEME,
			{ args: { command: "printf mixed" }, isError: false, isPartial: false, argsComplete: true },
		),
	);

	assert.match(output, /short line/);
	assert.match(output, /another short line/);
	assert.match(output, /chars truncated/);
});
