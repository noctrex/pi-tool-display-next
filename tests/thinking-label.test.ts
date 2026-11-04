import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
type CapturedTransformer = (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string;

interface CapturedLabeling {
  handlers: Map<string, CapturedHandler>;
  transformer: CapturedTransformer | undefined;
}

function captureThinkingLabeling(
  getConfig: () => { thinkingLabel: boolean } = () => ({ thinkingLabel: true }),
): CapturedLabeling {
  const handlers = new Map<string, CapturedHandler>();
  let transformer: CapturedTransformer | undefined;
  registerThinkingLabeling({
    on(eventName: string, handler: CapturedHandler): void {
      handlers.set(eventName, handler);
    },
    registerMarkdownTransformer(captured: CapturedTransformer): void {
      transformer = captured;
    },
  } as never, getConfig);
  return { handlers, transformer: transformer as CapturedTransformer | undefined };
}

function run(transformer: CapturedTransformer | undefined, markdown: string, messageType = "assistant-thinking"): string {
  assert.ok(transformer, "markdown transformer registered");
  return transformer(markdown, { messageType, isStreaming: false, availableWidth: 120 });
}

test("thinking label transformer prefixes assistant-thinking markdown for display", () => {
  const { transformer } = captureThinkingLabeling();
  assert.equal(run(transformer, "checking options"), "Thinking: checking options");
});

test("thinking label transformer leaves user and assistant message types unchanged", () => {
  const { transformer } = captureThinkingLabeling();
  assert.equal(run(transformer, "checking options", "user"), "checking options");
  assert.equal(run(transformer, "checking options", "assistant"), "checking options");
});

test("thinking label transformer dedupes labels persisted by older versions", () => {
  const { transformer } = captureThinkingLabeling();
  assert.equal(run(transformer, "Thinking: checking options"), "Thinking: checking options");
  assert.equal(run(transformer, "thinking: Thinking: checking options"), "Thinking: checking options");
});

test("stored assistant messages are never mutated by labeling", () => {
  const { handlers } = captureThinkingLabeling();
  // No message_update or message_end handlers exist: labeling is render-only.
  assert.equal(handlers.has("message_update"), false);
  assert.equal(handlers.has("message_end"), false);
});

test("thinking context sanitization removes presentation labels before model context", async () => {
  const { handlers } = captureThinkingLabeling();
  const event = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking: deep work" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  };

  await handlers.get("context")?.(event, {});

  assert.deepEqual(event.messages[0].content, [
    { type: "thinking", thinking: "deep work" },
    { type: "text", text: "answer" },
  ]);
});

test("thinking context sanitization preserves model-authored thinking text", async () => {
  const { handlers } = captureThinkingLabeling();
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "checking options" }],
      },
    ],
  };

  await handlers.get("context")?.(event, {});

  assert.deepEqual(event.messages[0].content, [
    { type: "thinking", thinking: "checking options" },
  ]);
});
