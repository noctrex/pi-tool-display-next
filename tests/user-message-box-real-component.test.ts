import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { unregisterUserMessageRenderPrototypePatch } from "../src/user-message-box-patch.ts";
import {
	patchNativeUserMessagePrototype,
	type UserMessageTheme,
} from "../src/user-message-box-renderer.ts";
import type { PatchableUserMessagePrototype } from "../src/user-message-box-patch.ts";

const THEME: UserMessageTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
};

const PROTOTYPE = UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;

// The native Markdown child styles through Pi's global theme; initialize it
// once so native and fallback render paths behave as they do in a live TUI.
initTheme();

function renderLines(component: UserMessageComponent, width: number): string[] {
	return component.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("patched real UserMessageComponent renders a bordered box with single-copy content", () => {
	patchNativeUserMessagePrototype(PROTOTYPE, () => THEME, () => true);
	try {
		const component = new UserMessageComponent("xylophone message");
		const lines = renderLines(component, 80);
		const joined = lines.join("\n");

		// Border box structure: top and bottom rules around the content.
		assert.ok(lines.some((line) => line.includes("─")), "top/bottom border rule present");

		// Pi 1.0.0 regression guard: the transcript once kept two full-width
		// copies of every rendered line. The patched output must carry the
		// content exactly once.
		assert.equal(countOccurrences(joined, "xylophone message"), 1);

		// Vertical structure: margin line, top border, padded body, bottom border.
		assert.ok(lines.length >= 5, `expected bordered layout, got ${lines.length} lines`);
	} finally {
		unregisterUserMessageRenderPrototypePatch(PROTOTYPE);
	}
});

test("patched real component renders markdown text from the native child", () => {
	patchNativeUserMessagePrototype(PROTOTYPE, () => THEME, () => true);
	try {
		const component = new UserMessageComponent("## Plan\n\n- first step");
		const joined = renderLines(component, 80).join("\n");

		assert.match(joined, /Plan/);
		assert.match(joined, /first step/);
	} finally {
		unregisterUserMessageRenderPrototypePatch(PROTOTYPE);
	}
});

test("disabled patch falls back to the native render output", () => {
	const reference = new UserMessageComponent("fallback check");
	const nativeOutput = renderLines(reference, 80).join("\n");

	patchNativeUserMessagePrototype(PROTOTYPE, () => THEME, () => false);
	try {
		const component = new UserMessageComponent("fallback check");
		const output = renderLines(component, 80).join("\n");

		assert.equal(output, nativeOutput, "disabled patch defers to the native renderer");
	} finally {
		unregisterUserMessageRenderPrototypePatch(PROTOTYPE);
	}
});

test("unregister restores the native prototype behavior", () => {
	const reference = new UserMessageComponent("restore check");
	const nativeOutput = renderLines(reference, 80).join("\n");

	patchNativeUserMessagePrototype(PROTOTYPE, () => THEME, () => true);
	const patched = new UserMessageComponent("restore check");
	const patchedOutput = renderLines(patched, 80).join("\n");
	assert.notEqual(patchedOutput, nativeOutput, "patch active while enabled");

	unregisterUserMessageRenderPrototypePatch(PROTOTYPE);

	const restored = new UserMessageComponent("restore check");
	assert.equal(renderLines(restored, 80).join("\n"), nativeOutput, "native render restored");
});

test("OSC 133 prompt zones survive inside the bordered body", () => {
	patchNativeUserMessagePrototype(PROTOTYPE, () => THEME, () => true);
	try {
		const component = new UserMessageComponent("zone check");
		const rawLines = component.render(80);
		const joined = rawLines.join("\n");

		assert.equal(countOccurrences(joined, "\x1b]133;A"), 1, "single prompt-zone start");
		assert.equal(countOccurrences(joined, "\x1b]133;C"), 1, "single prompt-zone final");
	} finally {
		unregisterUserMessageRenderPrototypePatch(PROTOTYPE);
	}
});
