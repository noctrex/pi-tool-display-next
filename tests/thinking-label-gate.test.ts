import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;

function captureWithConfig(
  handlers: Map<string, CapturedHandler>,
  thinkingLabel: boolean,
): void {
  registerThinkingLabeling(
    {
      on(eventName: string, handler: CapturedHandler): void {
        handlers.set(eventName, handler);
      },
    } as never,
    () => ({ thinkingLabel }),
  );
}

function thinkingEvent(): { message: { role: string; api: string; content: unknown[] } } {
  return {
    message: {
      role: "assistant",
      api: "anthropic-messages",
      content: [{ type: "thinking", thinking: "checking options" }],
    },
  };
}

const themedCtx = {
  ui: { theme: { fg: (color: string, text: string) => `[${color}]${text}` } },
};

test("gate off: message_update leaves thinking content untouched", async () => {
  const handlers = new Map<string, CapturedHandler>();
  captureWithConfig(handlers, false);
  const event = thinkingEvent();

  await handlers.get("message_update")?.(event, themedCtx);

  assert.deepEqual(event.message.content, [{ type: "thinking", thinking: "checking options" }]);
});

test("gate off: message_end leaves thinking content untouched", async () => {
  const handlers = new Map<string, CapturedHandler>();
  captureWithConfig(handlers, false);
  const event = thinkingEvent();

  await handlers.get("message_end")?.(event, themedCtx);

  assert.deepEqual(event.message.content, [{ type: "thinking", thinking: "checking options" }]);
});

test("gate off: context sanitization is skipped", async () => {
  const handlers = new Map<string, CapturedHandler>();
  captureWithConfig(handlers, false);
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
  const handlers = new Map<string, CapturedHandler>();
  captureWithConfig(handlers, false);
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

test("gate on: message_update prefixes the thinking label", async () => {
  const handlers = new Map<string, CapturedHandler>();
  captureWithConfig(handlers, true);
  const event = thinkingEvent();

  await handlers.get("message_update")?.(event, themedCtx);

  assert.deepEqual(event.message.content, [
    { type: "thinking", thinking: "[accent]Thinking: [thinkingText]checking options" },
  ]);
});
