import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "./tool-metadata.js";
import { compactOutputLines, extractTextOutput, pluralize, previewLines, sanitizeAnsiForThemedOutput, splitLines } from "./render-utils.js";
import type { ToolDisplayConfig } from "./types.js";

/**
 * Resolver-backed compact rendering for Pi's native codemode tool. The
 * collapsed views render status and call information; expanded views defer to
 * the next renderer (the native codemode renderers) via the resolver's
 * next() chain.
 */

export type CodemodeNextRenderers = {
	renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
};

interface CodemodeCallRendererArgs {
	expanded?: boolean;
}

interface CodemodeCallCounts {
	running: number;
	ok: number;
	error: number;
	cancelled: number;
}

interface CodemodeResultShape {
	content?: Array<Record<string, unknown>>;
	details?: unknown;
}

interface CodemodeRenderOptions {
	isPartial?: boolean;
	expanded?: boolean;
}

interface CodemodeRenderContext {
	isError?: boolean;
	expanded?: boolean;
}

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

function renderSummary(
	counts: CodemodeCallCounts,
	options: CodemodeRenderOptions,
	theme: ThemeLike,
	isError: boolean,
): Text {
	const total = counts.running + counts.ok + counts.error + counts.cancelled;
	const status = options.isPartial ? "running" : isError ? "failed" : "completed";
	const summary = [status, `${total} ${total === 1 ? "call" : "calls"}`];
	if (counts.error) summary.push(`${counts.error} failed`);
	if (counts.cancelled) summary.push(`${counts.cancelled} cancelled`);
	const color = isError || counts.error ? "error" : "muted";
	return new Text(
		theme.fg(color, `↳ ${summary.join(" · ")}`) + " • " + keyHint("app.tools.expand", "to expand"),
		0, 0,
	);
}

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function renderOutputPreview(
	result: CodemodeResultShape,
	limit: number,
	theme: ThemeLike,
	isError: boolean,
): Component {
	const [first, ...rest] = result.content ?? [];
	const content = first?.type === "text" && typeof first.text === "string" && SCRIPT_HEADER.test(first.text)
		? rest
		: result.content ?? [];
	const lines = compactOutputLines(splitLines(extractTextOutput({ content })), { expanded: false });
	const color = isError ? "error" : "toolOutput";
	const text = lines.map((line) => theme.fg(color, sanitizeAnsiForThemedOutput(line))).join("\n");
	const output = new Text(text, 0, 0);
	return {
		render(width) {
			if (!text) return [];
			// Wrap before limiting so one-line JSON respects previewLines.
			const { shown, remaining } = previewLines(output.render(width), limit);
			if (remaining > 0) {
				const hint = theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")})`);
				shown.push(...new Text(hint, 0, 0).render(width));
			}
			return ["", ...shown];
		},
		invalidate() { output.invalidate(); },
	};
}

function countCodemodeCalls(details: unknown): CodemodeCallCounts {
	const counts: CodemodeCallCounts = { running: 0, ok: 0, error: 0, cancelled: 0 };
	if (details === undefined) {
		return counts;
	}
	if (!isRecord(details) || !Array.isArray(details.calls)) {
		throw new Error("Invalid codemode call details");
	}
	for (const call of details.calls) {
		const status: unknown = isRecord(call) ? call.status : undefined;
		switch (status) {
			case "running":
			case "ok":
			case "error":
			case "cancelled":
				counts[status]++;
				break;
			default:
				throw new Error("Invalid codemode call status");
		}
	}
	return counts;
}

export function codemodeRenderers(
	getConfig: () => Pick<ToolDisplayConfig, "codemodeOutputMode" | "previewLines">,
	next: CodemodeNextRenderers,
): {
	renderCall: (args: unknown, theme: ThemeLike, context: CodemodeCallRendererArgs) => unknown;
	renderResult: (result: CodemodeResultShape, options: CodemodeRenderOptions, theme: ThemeLike, context: CodemodeRenderContext) => unknown;
} {
	return {
		renderCall(args, theme, context) {
			if (context?.expanded) {
				return next.renderCall?.(args, theme, context);
			}
			return new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0);
		},
		renderResult(result, options, theme, context) {
			// Expanded views defer to the native renderers; clear the cached
			// component because our collapsed Container is not reusable there.
			const nativeContext = { ...context, lastComponent: undefined };
			if (options?.expanded) {
				return next.renderResult?.(result, options, theme, nativeContext);
			}

			let counts: CodemodeCallCounts;
			try {
				counts = countCodemodeCalls(result?.details);
			} catch {
				// Malformed details defer to the native renderer rather than
				// hiding the real result behind an error.
				return next.renderResult?.(result, options, theme, nativeContext);
			}

			const summary = renderSummary(counts, options, theme, context?.isError === true);
			const config = getConfig();
			if (config.codemodeOutputMode === "summary") return summary;
			const container = new Container();
			container.addChild(summary);
			container.addChild(
				(next.renderResult?.({ ...result, content: [] }, options, theme, nativeContext) ?? new Text("", 0, 0)) as never,
			);
			if (config.codemodeOutputMode === "preview" && !options?.isPartial) {
				container.addChild(renderOutputPreview(result, config.previewLines, theme, context?.isError === true));
			}
			return container;
		},
	};
}
