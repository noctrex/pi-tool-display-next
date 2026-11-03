import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { codemodeRenderers } from "../src/codemode-display.ts";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";

initTheme("dark", false);

const script = "const value = await tools.read({ path: 'example.ts' });\nreturn value;";
const output = "RESULT_ONE\nRESULT_TWO\nRESULT_THREE";

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const nativeRenderers = {
	renderCall: (() => new Text(script, 0, 0)) as unknown as (args: unknown, theme: unknown, context: unknown) => unknown,
	renderResult: ((result: { content?: Array<{ type: string; text?: string }> }) =>
		new Text(
			["NATIVE CALL TRACE", ...result.content.flatMap((block) => (block.type === "text" ? [block.text] : []))].join("\n"),
			0,
			0,
		)) as unknown as (
		result: unknown, options: unknown, theme: unknown, context: unknown,
	) => unknown,
};

function renderersFor(configOverrides: Record<string, unknown> = {}) {
	const config = normalizeToolDisplayConfig({ codemodeOutputMode: "calls", ...configOverrides });
	return codemodeRenderers(() => config, nativeRenderers);
}

function result(statuses: string[], isError = false) {
	return {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: output },
		],
		details: { calls: statuses.map((status) => ({ name: "read", args: "{}", status })) },
		isError,
	};
}

function toText(component: unknown, width = 80): string {
	const render = (component as { render?: unknown })?.render;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as { render: (width: number) => string[] })
		.render(width)
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
		.join("\n")
		.trim();
}

test("codemode collapsed call shows only the tool title", () => {
	const renderers = renderersFor();
	const call = renderers.renderCall({ code: script }, THEME, { expanded: false });
	assert.equal(toText(call), "codemode");
	assert.doesNotMatch(toText(call), /example\.ts/);
});

test("codemode expanded call defers to the native renderer", () => {
	const renderers = renderersFor();
	const call = renderers.renderCall({ code: script }, THEME, { expanded: true });
	assert.equal(toText(call), script);
});

test("calls mode renders status summary plus the native call trace without output", () => {
	const renderers = renderersFor({ codemodeOutputMode: "calls" });
	const text = toText(renderers.renderResult(result(["ok", "ok", "ok"]), { isPartial: false, expanded: false }, THEME, { isError: false }));

	assert.match(text, /completed · 3 calls/);
	assert.match(text, /NATIVE CALL TRACE/);
	assert.doesNotMatch(text, /RESULT_ONE/);
	assert.doesNotMatch(text, /example\.ts/);
});

test("summary mode renders the status line only", () => {
	const renderers = renderersFor({ codemodeOutputMode: "summary" });
	const text = toText(renderers.renderResult(result(["ok", "ok"]), { isPartial: false, expanded: false }, THEME, { isError: false }));

	assert.match(text, /completed · 2 calls/);
	assert.doesNotMatch(text, /NATIVE CALL TRACE/);
	assert.doesNotMatch(text, /RESULT_ONE/);
});

test("preview mode appends a limited output preview after the trace", () => {
	const renderers = renderersFor({ codemodeOutputMode: "preview", previewLines: 2 });
	const text = toText(renderers.renderResult(result(["ok"]), { isPartial: false, expanded: false }, THEME, { isError: false }));

	assert.match(text, /completed · 1 call/);
	assert.match(text, /RESULT_ONE/);
	assert.match(text, /RESULT_TWO/);
	assert.doesNotMatch(text, /RESULT_THREE/);
	assert.match(text, /1 more line/);
});

test("failed script reports error counts and error coloring input", () => {
	const renderers = renderersFor();
	const text = toText(renderers.renderResult(result(["ok", "error", "cancelled"]), { isPartial: false, expanded: false }, THEME, { isError: false }));

	assert.match(text, /1 failed/);
	assert.match(text, /1 cancelled/);
});

test("running scripts report the running status", () => {
	const renderers = renderersFor({ codemodeOutputMode: "summary" });
	const text = toText(renderers.renderResult(result(["running", "ok"]), { isPartial: true, expanded: false }, THEME, { isError: false }));

	assert.match(text, /running · 2 calls/);
});

test("expanded result defers to the native renderer with full output", () => {
	const renderers = renderersFor({ codemodeOutputMode: "summary" });
	const text = toText(renderers.renderResult(result(["ok"]), { isPartial: false, expanded: true }, THEME, { isError: false }));

	assert.match(text, /NATIVE CALL TRACE/);
	assert.match(text, /RESULT_ONE/);
});

test("malformed call details defer to the native renderer", () => {
	const renderers = renderersFor();
	const text = toText(renderers.renderResult(
		{ content: [{ type: "text", text: "out" }], details: { calls: "not-an-array" } },
		{ isPartial: false, expanded: false },
		THEME,
		{ isError: false },
	));

	assert.match(text, /out/, "native fallback still renders");
});

test("script header line is excluded from the preview but kept in expanded output", () => {
	const renderers = renderersFor({ codemodeOutputMode: "preview", previewLines: 5 });
	const text = toText(renderers.renderResult(result(["ok"]), { isPartial: false, expanded: false }, THEME, { isError: false }));

	assert.ok(text.includes("RESULT_ONE"), "preview shows output lines");
	assert.ok(!text.includes("Wall time 0.1 seconds\nRESULT_ONE") || text.indexOf("Wall time") === -1 || text.indexOf("RESULT_ONE") < text.indexOf("Wall time"), "header excluded from preview");
});

test("result data object is not mutated by rendering", () => {
	const renderers = renderersFor();
	const data = result(["ok"]) as Record<string, unknown> & { content: unknown[] };
	const snapshot = structuredClone(data);
	renderers.renderResult(data as never, { isPartial: false, expanded: false }, THEME, { isError: false });
	renderers.renderResult(data as never, { isPartial: false, expanded: true }, THEME, { isError: false });

	assert.deepEqual(data, snapshot);
});

test("codemodeOutputMode normalization is tolerant and defaults to calls", () => {
	assert.equal(normalizeToolDisplayConfig({}).codemodeOutputMode, "calls");
	assert.equal(normalizeToolDisplayConfig({ codemodeOutputMode: "preview" }).codemodeOutputMode, "preview");
	assert.equal(normalizeToolDisplayConfig({ codemodeOutputMode: "bogus" }).codemodeOutputMode, "calls");
});
