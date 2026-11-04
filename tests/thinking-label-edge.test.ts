import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;
type CapturedTransformer = (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string;

function captureThinkingLabeling(
  getConfig: () => { thinkingLabel: boolean } = () => ({ thinkingLabel: true }),
): { handlers: Map<string, CapturedHandler>; transformer: CapturedTransformer | undefined } {
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

function label(markdown: string): string {
  const { transformer } = captureThinkingLabeling();
  assert.ok(transformer, "markdown transformer registered");
  return transformer(markdown, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 120 });
}

function stripForContext(event: { messages: Array<{ role: string; content: unknown[] }> }): void {
  const { handlers } = captureThinkingLabeling();
  const handler = handlers.get("context");
  assert.ok(handler, "context handler registered");
  void handler(event, {});
}

// ─── Display label normalization (markdown transformer) ─────────────────────

test("label: single existing 'Thinking:' prefix is not duplicated", () => {
  assert.equal(label("Thinking: checking options"), "Thinking: checking options");
});

test("label: lowercase 'thinking:' prefix is normalized away", () => {
  assert.equal(label("thinking: checking options"), "Thinking: checking options");
});

test("label: uppercase 'THINKING:' prefix is normalized away", () => {
  assert.equal(label("THINKING: checking options"), "Thinking: checking options");
});

test("label: repeated 'Thinking: Thinking:' prefix is fully stripped", () => {
  assert.equal(label("Thinking: Thinking: checking options"), "Thinking: checking options");
});

test("label: interleaved case 'thinking: Thinking:' is fully stripped", () => {
  assert.equal(label("thinking: Thinking: checking options"), "Thinking: checking options");
});

test("label: triple label 'thinking: thinking: Thinking:' is fully stripped", () => {
  assert.equal(label("thinking: thinking: Thinking: checking options"), "Thinking: checking options");
});

test("label: indented label '  Thinking: content' is handled", () => {
  assert.equal(label("  Thinking: checking options"), "Thinking: checking options");
});

test("label: SGR code before thinking label is stripped", () => {
  assert.equal(label("\x1b[35mThinking: checking options\x1b[0m"), "Thinking: checking options");
});

test("label: multiple SGR codes before label are all stripped", () => {
  assert.equal(label("\x1b[35m\x1b[1mthinking: checking options"), "Thinking: checking options");
});

test("label: fragment starting with semicolon is stripped as leading artifact", () => {
  assert.equal(label(";35mThinking: checking options"), "Thinking: checking options");
});

test("label: background code before label is removed", () => {
  assert.equal(label("\x1b[44mThinking: checking options"), "Thinking: checking options");
});

test("label: exposed fragment after removing first label reveals second label", () => {
  assert.equal(label("Thinking: \x1b[35mthinking: checking options"), "Thinking: checking options");
});

test("label: non-English thinking text gets the prefix", () => {
  assert.equal(label("考察中です"), "Thinking: 考察中です");
  assert.equal(label("Analyse des options"), "Thinking: Analyse des options");
});

test("label: custom prefixes like 'Analyzing:' or 'Note:' are kept and prefixed", () => {
  assert.equal(label("Analyzing: the request"), "Thinking: Analyzing: the request");
  assert.equal(label("Note: something"), "Thinking: Note: something");
});

test("label: multi-line thinking text is prefixed once", () => {
  assert.equal(label("first line\nsecond line"), "Thinking: first line\nsecond line");
});

test("label: content that becomes empty after stripping keeps original text", () => {
  assert.equal(label("   "), "   ");
});

test("label: empty string is unchanged", () => {
  assert.equal(label(""), "");
});

test("label: label-only content keeps a single label", () => {
  assert.equal(label("Thinking:"), "Thinking:");
});

// ─── Context cleanup for sessions persisted by older versions ───────────────

test("context: strips thinking labels even with ANSI wrapping", async () => {
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "\x1b[35mThinking: deep work\x1b[0m" }],
      },
    ],
  };

  stripForContext(event);

  assert.equal(event.messages[0].content[0].thinking, "deep work");
});

test("context: preserves non-thinking blocks unchanged", async () => {
  const textBlock = { type: "text", text: "answer" };
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Thinking: deep work" }, textBlock],
      },
    ],
  };

  stripForContext(event);

  assert.equal(event.messages[0].content[1], textBlock);
});

test("context: does not modify non-assistant messages", async () => {
  const userMessage = { role: "user", content: [{ type: "text", text: "Thinking: out loud" }] };
  const event = { messages: [userMessage] };

  stripForContext(event);

  assert.equal(event.messages[0], userMessage);
});

test("context: handles events with non-array messages gracefully", async () => {
  const event = { messages: "not-an-array" };
  stripForContext(event as never);
  assert.equal(event.messages, "not-an-array");
});

test("context: handles events with missing messages property", async () => {
  const event = {} as never;
  stripForContext(event);
  assert.ok(true, "no throw");
});

test("context: strips duplicate labels", async () => {
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thinking: Thinking: deep work" }],
      },
    ],
  };

  stripForContext(event);

  assert.equal(event.messages[0].content[0].thinking, "deep work");
});

test("context: strips lowercase thinking: label", async () => {
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thinking: deep work" }],
      },
    ],
  };

  stripForContext(event);

  assert.equal(event.messages[0].content[0].thinking, "deep work");
});

test("context: mixed valid and invalid blocks only processes valid ones", async () => {
  const invalidBlock = { type: "thinking", thinking: 42 };
  const event = {
    messages: [
      {
        role: "assistant",
        content: [invalidBlock, { type: "thinking", thinking: "Thinking: deep work" }],
      },
    ],
  };

  stripForContext(event);

  assert.equal(event.messages[0].content[0], invalidBlock);
  assert.equal(event.messages[0].content[1].thinking, "deep work");
});
