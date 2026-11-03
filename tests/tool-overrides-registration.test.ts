import assert from "node:assert/strict";
import { Box } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

type ResolverFn = (toolName: string, next: () => unknown) => unknown;

const THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const BUILT_INS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

function createExtensionApiStub(): {
	api: ExtensionAPI;
	resolvers: ResolverFn[];
	eventHandlers: Record<string, (...args: unknown[]) => unknown>;
} {
	// Deliberately no registerTool: the resolver architecture must never
	// re-register tools to install renderers.
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

function resolveFromStubs(resolvers: ResolverFn[], toolName: string): unknown {
	assert.ok(resolvers.length > 0, "expected a registerToolRenderer resolver to be installed");
	return resolvers[resolvers.length - 1](toolName, () => undefined);
}

function renderComponentLines(component: unknown, width = 80): string[] {
	const box = new Box(1, 1);
	box.addChild(component as never);
	return box.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

function stringifyComponent(component: unknown): string {
	return renderComponentLines(component).join("\n");
}

test("resolver claims every enabled built-in renderer at load time, without lifecycle events", () => {
	const { api, resolvers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	for (const name of BUILT_INS) {
		const renderers = resolveFromStubs(resolvers, name) as { renderCall?: unknown; renderResult?: unknown };
		assert.equal(typeof renderers?.renderCall, "function", `${name} renderCall resolved`);
		assert.equal(typeof renderers?.renderResult, "function", `${name} renderResult resolved`);
	}
});

test("edit claim carries renderShell default so tool backgrounds fill the row", () => {
	const { api, resolvers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = resolveFromStubs(resolvers, "edit") as { renderShell?: unknown };
	assert.equal(renderers.renderShell, "default");
});

test("disabled built-ins fall through to the next resolver", () => {
	const { api, resolvers } = createExtensionApiStub();
	const config = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			read: false,
			bash: false,
		},
	};
	registerToolDisplayOverrides(api, () => config);

	const sentinel = Symbol("next");
	assert.equal(resolvers[0]("read", () => sentinel), sentinel, "disabled read passes through");
	assert.equal(resolvers[0]("bash", () => sentinel), sentinel, "disabled bash passes through");
	assert.notEqual(resolvers[0]("grep", () => sentinel), sentinel, "enabled grep is claimed");
});

test("unknown tools pass through while MCP-named tools are claimed without any discovery sweep", () => {
	const { api, resolvers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const sentinel = Symbol("next");
	assert.equal(resolvers[0]("random-custom-tool", () => sentinel), sentinel, "unrelated tool passes through");

	const mcpRenderers = resolveFromStubs(resolvers, "mcp") as { renderCall?: unknown; renderResult?: unknown };
	assert.equal(typeof mcpRenderers?.renderCall, "function", "mcp proxy claimed");
	assert.equal(typeof mcpRenderers?.renderResult, "function", "mcp proxy result claimed");
});

test("rendering claims are config-driven and need no getAllTools ownership discovery", () => {
	const { api, resolvers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const renderers = resolveFromStubs(resolvers, "read") as { renderCall?: unknown };
	assert.equal(typeof renderers?.renderCall, "function", "read claimed without tool ownership data");
});

test("rendering claims preserve native tool objects", () => {
	const { api } = createExtensionApiStub();
	// The stub has no registerTool: if the extension tried to re-register the
	// built-ins, this call would throw and fail the test.
	assert.doesNotThrow(() => registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG));
});

test("tool_call captures pre-write content so the write renderer shows a real diff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ptd-write-capture-"));
	try {
		const filePath = join(dir, "notes.txt");
		writeFileSync(filePath, "old content\n", "utf8");

		const { api, resolvers, eventHandlers } = createExtensionApiStub();
		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

		const handler = eventHandlers.tool_call;
		assert.ok(handler, "tool_call handler registered for pre-write capture");
		await handler(
			{ toolName: "write", input: { path: filePath }, toolCallId: "call-1" },
			{ cwd: dir },
		);

		// Overwrite the file on disk; only the captured metadata can know the
		// pre-write content at render time.
		writeFileSync(filePath, "new content\n", "utf8");

		const renderers = resolveFromStubs(resolvers, "write") as {
			renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
		};
		const output = stringifyComponent(
			renderers.renderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: true, isPartial: false },
				THEME,
				{
					args: { path: filePath, content: "new content\n" },
					toolCallId: "call-1",
					cwd: dir,
					isError: false,
					isPartial: false,
					argsComplete: true,
				},
			),
		);
		assert.match(output, /old content/, "captured previous content appears in the diff");

		// A different tool call id has no capture and must not inherit it.
		const otherOutput = stringifyComponent(
			renderers.renderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: true, isPartial: false },
				THEME,
				{
					args: { path: filePath, content: "new content\n" },
					toolCallId: "call-2",
					cwd: dir,
					isError: false,
					isPartial: false,
					argsComplete: true,
				},
			),
		);
		assert.doesNotMatch(otherOutput, /old content/, "capture is scoped to its tool call id");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("non-write tool_call events do not capture anything", async () => {
	const { api, resolvers, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const handler = eventHandlers.tool_call;
	assert.ok(handler);
	await assert.doesNotReject(async () => {
		await handler({ toolName: "read", input: { path: "/tmp/x" }, toolCallId: "r1" }, { cwd: process.cwd() });
		await handler(undefined, undefined);
	});

	const renderers = resolveFromStubs(resolvers, "write") as {
		renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
	};
	const output = stringifyComponent(
		renderers.renderResult(
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: true, isPartial: false },
			THEME,
			{ args: { path: "/tmp/x", content: "text\n" }, toolCallId: "r1", isError: false, isPartial: false, argsComplete: true },
		),
	);
	assert.equal(output.length > 0, true, "write rendering stays functional without capture");
});

test("session_start clears captured write metadata", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ptd-write-clear-"));
	try {
		const filePath = join(dir, "notes.txt");
		writeFileSync(filePath, "old content\n", "utf8");

		const { api, resolvers, eventHandlers } = createExtensionApiStub();
		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

		await eventHandlers.tool_call?.(
			{ toolName: "write", input: { path: filePath }, toolCallId: "call-1" },
			{ cwd: dir },
		);
		await eventHandlers.session_start?.({}, { cwd: dir });

		writeFileSync(filePath, "new content\n", "utf8");
		const renderers = resolveFromStubs(resolvers, "write") as {
			renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
		};
		const output = stringifyComponent(
			renderers.renderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: true, isPartial: false },
				THEME,
				{
					args: { path: filePath, content: "new content\n" },
					toolCallId: "call-1",
					cwd: dir,
					isError: false,
					isPartial: false,
					argsComplete: true,
				},
			),
		);
		assert.doesNotMatch(output, /old content/, "capture cleared after session_start");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pending display decorations register adapters for tools registered later", () => {
	type GlobalWithPendingDecorations = typeof globalThis & {
		[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: Array<{
			tool: Record<string, unknown>;
			adapter?: Record<string, unknown>;
		}>;
	};
	const globalWithPending = globalThis as GlobalWithPendingDecorations;
	const previousPending = globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
	globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = [
		{
			adapter: { kind: "mcp" },
			tool: { name: "queued-ext-tool", label: "Queued Extension Tool" },
		},
	];

	try {
		const { api, resolvers } = createExtensionApiStub();
		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

		assert.equal(globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?.length, 0, "queue drained");

		// The queued tool's name is not MCP-shaped, so only the registered
		// adapter can explain why it is claimed.
		const renderers = resolveFromStubs(resolvers, "queued-ext-tool") as { renderCall?: unknown };
		assert.equal(typeof renderers?.renderCall, "function", "queued adapter claims its tool");
	} finally {
		if (previousPending) {
			globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = previousPending;
		} else {
			delete globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
		}
	}
});
