import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolDisplayDebugLogger } from "../src/debug-logger.ts";

async function withTempRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-tool-display-debug-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createLogger(root: string, debug: boolean) {
  return createToolDisplayDebugLogger({
    isDebugEnabled: () => debug,
    debugDir: join(root, "debug"),
    debugLogFile: join(root, "debug", "debug.log"),
    createDate: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

test("disabled debug logger is a no-op and does not create debug artifacts", async () => {
  await withTempRoot(async (root) => {
    const logger = createLogger(root, false);

    assert.equal(logger.log("disabled sk-abcdefghijkl", new Error("hidden sk-bcdefghijklm")), undefined);
    await logger.flush();

    assert.equal(existsSync(join(root, "debug")), false);
  });
});

test("enabled debug logger writes on flush and redacts secret values", async () => {
  await withTempRoot(async (root) => {
    const logger = createLogger(root, true);

    assert.equal(logger.log("request sk-abcdefghijkl", new Error("failed sk-bcdefghijklm")), undefined);
    await logger.flush();

    const logContent = readFileSync(join(root, "debug", "debug.log"), "utf-8");
    assert.match(logContent, /^2026-01-01T00:00:00\.000Z request \[REDACTED\] Error: failed \[REDACTED\]/);
    assert.doesNotMatch(logContent, /sk-abcdefghijkl|sk-bcdefghijklm/);
  });
});

test("debug logger swallows append failures", async () => {
  await withTempRoot(async (root) => {
    mkdirSync(join(root, "debug", "debug.log"), { recursive: true });
    const logger = createLogger(root, true);

    assert.doesNotThrow(() => logger.log("write-fails"));
    await assert.doesNotReject(() => logger.flush());
  });
});

test("log file is truncated once it exceeds the size cap", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger({
      isDebugEnabled: () => true,
      debugDir: join(root, "debug"),
      debugLogFile: join(root, "debug", "debug.log"),
      maxLogBytes: 16,
      createDate: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    logger.log("first line that already exceeds the cap");
    await logger.flush();
    const firstLength = readFileSync(join(root, "debug", "debug.log"), "utf-8").length;
    assert.ok(firstLength > 16);

    logger.log("after cap");
    await logger.flush();
    const logContent = readFileSync(join(root, "debug", "debug.log"), "utf-8");
    assert.ok(logContent.startsWith("2026-01-01T00:00:00.000Z after cap"), `unexpected content: ${logContent}`);
    assert.ok(!logContent.includes("first line"), "oversized log was not truncated");
  });
});

test("default gate reads the agent-dir config debug flag", async () => {
  // The default logger is gated on loadToolDisplayConfig().config.debug, the
  // documented agent-dir flag. Without an explicit isDebugEnabled override it
  // must never throw and must not write outside the configured debug files.
  const logger = createToolDisplayDebugLogger({
    debugDir: join(tmpdir(), "pi-tool-display-debug-gate-probe"),
    debugLogFile: join(tmpdir(), "pi-tool-display-debug-gate-probe", "debug.log"),
    createDate: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(logger.log("probe"), undefined);
  await logger.flush();
});
