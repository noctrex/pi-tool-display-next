import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./tool-metadata.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import type { ToolDisplayConfig } from "./types.js";

export type ThinkingLabelConfig = Pick<ToolDisplayConfig, "thinkingLabel">;

interface MarkdownTransformContextLike {
	messageType: string;
	isStreaming: boolean;
	availableWidth: number;
}

type MarkdownTransformer = (markdown: string, context: MarkdownTransformContextLike) => string;

interface MarkdownTransformerApi {
	registerMarkdownTransformer?: (transformer: MarkdownTransformer) => void;
}

interface AssistantMessageLike {
	role?: unknown;
	content?: unknown;
}

const THINKING_CHAT_PREFIX = "Thinking: ";
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;
const MAX_THINKING_CONTENT_DEPTH = 16;

const registeredThinkingApis = new WeakSet<ExtensionAPI>();

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripLeadingAnsiFragments(text: string): string {
	let current = text;
	while (true) {
		const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
		if (next === current) {
			return current;
		}
		current = next;
	}
}

function stripThinkingPresentationArtifacts(text: string): string {
	let current = stripAnsi(text);
	let removedThinkingLabel = false;

	while (true) {
		const withoutLabel = current
			.replace(THINKING_LABEL_PREFIX_PATTERN, "")
			.trimStart();
		if (withoutLabel !== current) {
			current = withoutLabel;
			removedThinkingLabel = true;
			continue;
		}

		const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
		if (withoutAnsiFragments !== current) {
			const fragmentExposedAnotherLabel =
				withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
				withoutAnsiFragments;

			if (removedThinkingLabel || fragmentExposedAnotherLabel) {
				current = withoutAnsiFragments;
				continue;
			}
		}

		return current;
	}
}

/**
 * Render-time label. Applied through a markdown transformer, so stored
 * assistant messages and the model context are never rewritten. Sessions
 * persisted by older versions carry the label inside their thinking blocks;
 * stripping artifacts first dedupes those instead of double-labeling.
 */
function labelThinkingTextForDisplay(text: string): string {
	const normalized = stripThinkingPresentationArtifacts(text).trim();
	if (!normalized) {
		return text;
	}

	return `${THINKING_CHAT_PREFIX}${normalized}`;
}

function normalizeThinkingLineForContext(text: string): string {
	return stripThinkingPresentationArtifacts(text);
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> & {
	type: "thinking";
	thinking: string;
} {
	if (!isRecord(value)) {
		return false;
	}

	return value.type === "thinking" && typeof value.thinking === "string";
}

function mapThinkingContentArray(
	content: unknown[],
	mapThinkingText: (text: string) => string,
	depth = 0,
	seen: WeakSet<object> = new WeakSet<object>(),
): { content: unknown[]; changed: boolean } {
	if (depth > MAX_THINKING_CONTENT_DEPTH || seen.has(content)) {
		return { content, changed: false };
	}

	seen.add(content);
	let changed = false;
	const nextContent = content.map((block) => {
		if (Array.isArray(block)) {
			const nested = mapThinkingContentArray(
				block,
				mapThinkingText,
				depth + 1,
				seen,
			);
			if (nested.changed) {
				changed = true;
				return nested.content;
			}
			return block as unknown[];
		}

		if (!isThinkingBlock(block)) {
			return block;
		}

		const nextThinking = mapThinkingText(block.thinking);
		if (nextThinking === block.thinking) {
			return block;
		}

		changed = true;
		return { ...block, thinking: nextThinking };
	});

	return { content: changed ? nextContent : content, changed };
}

function sanitizeThinkingBlocksForContext(message: AssistantMessageLike): AssistantMessageLike {
	if (!Array.isArray(message.content)) {
		return message;
	}

	const mapped = mapThinkingContentArray(
		message.content,
		normalizeThinkingLineForContext,
	);

	return mapped.changed ? { ...message, content: mapped.content } : message;
}

function sanitizeContextMessages(messages: unknown): unknown {
	if (!Array.isArray(messages)) {
		return messages;
	}

	const messageList = messages as unknown[];
	let changed = false;
	const nextMessages = messageList.map((message) => {
		if (!isRecord(message) || message.role !== "assistant") {
			return message;
		}

		const sanitized = sanitizeThinkingBlocksForContext(message as AssistantMessageLike);
		if (sanitized !== message) {
			changed = true;
			return sanitized;
		}

		return message;
	});

	return changed ? nextMessages : messageList;
}

function handleThinkingContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
	try {
		if (!isRecord(event) || !Array.isArray(event.messages)) {
			return;
		}

		const sanitizedMessages = sanitizeContextMessages(event.messages);
		if (sanitizedMessages !== event.messages && Array.isArray(sanitizedMessages)) {
			event.messages.splice(0, event.messages.length, ...(sanitizedMessages as unknown[]));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		ctx?.ui?.notify(`Thinking context sanitization failed: ${message}`, "warning");
	}
}

export function registerThinkingLabeling(pi: ExtensionAPI, getConfig: () => ThinkingLabelConfig): void {
	if (registeredThinkingApis.has(pi)) {
		return;
	}
	registeredThinkingApis.add(pi);

	onReloadShutdown(pi, () => {
		registeredThinkingApis.delete(pi);
	});

	const transformerApi = pi as ExtensionAPI & MarkdownTransformerApi;
	if (typeof transformerApi.registerMarkdownTransformer === "function") {
		transformerApi.registerMarkdownTransformer((markdown, context) => {
			if (!getConfig().thinkingLabel) {
				return markdown;
			}
			if (context?.messageType !== "assistant-thinking") {
				return markdown;
			}
			return labelThinkingTextForDisplay(markdown);
		});
	} else {
		logToolDisplayDebug("registerMarkdownTransformer is unavailable; thinking label display is disabled for this Pi version.");
	}

	pi.on("context", async (event, ctx) => {
		if (!getConfig().thinkingLabel) {
			return;
		}
		// Cleanup pass for sessions persisted by older versions, which stored
		// the display label inside thinking blocks. New sessions carry clean
		// content and pass through unchanged.
		handleThinkingContextEvent(event, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!getConfig().thinkingLabel) {
			return;
		}
		// Re-applies on session_start; covers /reload where Pi resets labels
		// before re-emitting the event.
		const ui = ctx?.ui;
		if (typeof ui?.setHiddenThinkingLabel !== "function") {
			return; // Absent outside the interactive TUI; RPC ships a no-op anyway.
		}

		try {
			// theme.fg() resets only the foreground color, so the accent wrap
			// recolors Pi's italic thinkingText label without touching its styling.
			ui.setHiddenThinkingLabel(
				ui.theme ? ui.theme.fg("accent", "Thinking...") : "Thinking...",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx?.ui.notify(`Hidden thinking label formatting failed: ${message}`, "warning");
		}
	});
}
