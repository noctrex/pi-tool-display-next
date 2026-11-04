import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
type CapturedTransformer = (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string;

function captureWithConfig(
  thinkingLabel: boolean,
): { handlers: Map<string, CapturedHandler>; transformer: CapturedTransformer | undefined } {
  const handlers = new Map<string, CapturedHandler>();
  let transformer: CapturedTransformer | undefined;
  registerThinkingLabeling(
    {
      on(eventName: string, handler: CapturedHandler): void {
        handlers.set(eventName, handler);
      },
      registerMarkdownTransformer(captured: CapturedTransformer): void {
        transformer = captured;
      },
    } as never,
    () => ({ thinkingLabel }),
  );
  return { handlers, transformer: transformer as CapturedTransformer | undefined };
}

const themedCtx = {
  ui: { theme: { fg: (color: string, text: string) => `[${color}]${text}` } },
};

test("gate off: transformer leaves thinking markdown untouched", () => {
  const { transformer } = captureWithConfig(false);
  assert.ok(transformer, "markdown transformer registered");
  const result = transformer("checking options", {
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 120,
  });
  assert.equal(result, "checking options");
});

test("gate off: context sanitization is skipped", async () => {
  const { handlers } = captureWithConfig(false);
  // Content that a prior enabled session would have labeled; the sanitizer
  // would strip the prefix, and the gate must leave it exactly as-is here.
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Thinking: checking options" }],
      },
    ],
  };

  await handlers.get("context")?.(event, themedCtx);

  assert.deepEqual(event.messages[0].content, [
    { type: "thinking", thinking: "Thinking: checking options" },
  ]);
});

test("gate off: session_start does not set the hidden thinking label", async () => {
  const { handlers } = captureWithConfig(false);
  const labels: (string | undefined)[] = [];
  const ui = {
    setHiddenThinkingLabel: (label?: string) => {
      labels.push(label);
    },
    theme: { fg: (color: string, text: string) => `[${color}]${text}` },
  };

  await handlers.get("session_start")?.({}, { ui });

  assert.deepEqual(labels, [], "no label applied while the feature is gated off");
});

test("gate on: transformer prefixes the thinking label", () => {
  const { transformer } = captureWithConfig(true);
  assert.ok(transformer, "markdown transformer registered");
  const result = transformer("checking options", {
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 120,
  });
  assert.equal(result, "Thinking: checking options");
});

test("gate on: session_start sets the themed hidden thinking label", async () => {
  const { handlers } = captureWithConfig(true);
  const labels: (string | undefined)[] = [];
  const ui = {
    setHiddenThinkingLabel: (label?: string) => {
      labels.push(label);
    },
    theme: { fg: (color: string, text: string) => `[${color}]${text}` },
  };

  await handlers.get("session_start")?.({}, { ui });

  assert.deepEqual(labels, ["[accent]Thinking..."]);
});
