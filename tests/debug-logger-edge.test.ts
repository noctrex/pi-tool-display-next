import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createToolDisplayDebugLogger,
  type ToolDisplayDebugLoggerOptions,
} from "../src/debug-logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempRoot(
  run: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-tool-display-debug-edge-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loggerOpts(
  root: string,
  overrides: Partial<ToolDisplayDebugLoggerOptions> = {},
): ToolDisplayDebugLoggerOptions {
  return {
    isDebugEnabled: () => true,
    debugDir: join(root, "debug"),
    debugLogFile: join(root, "debug", "debug.log"),
    createDate: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function readLog(root: string): string {
  const logFile = join(root, "debug", "debug.log");
  assert.ok(existsSync(logFile), "debug.log should exist");
  return readFileSync(logFile, "utf-8");
}

// ---------------------------------------------------------------------------
// Concurrent Write Queue Behavior
// ---------------------------------------------------------------------------

test("concurrent writes are queued and flushed in order", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));

    logger.log("first");
    logger.log("second");
    logger.log("third");

    await logger.flush();

    const content = readLog(root);
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3, "all three lines written");
    assert.match(lines[0]!, /first/);
    assert.match(lines[1]!, /second/);
    assert.match(lines[2]!, /third/);
  });
});

test("concurrent writes with simulated failures still complete", async () => {
  await withTempRoot(async (root) => {
    let appendCallCount = 0;
    const appended: string[] = [];
    const failingAppend = async (
      _path: string,
      content: string,
      _enc: string,
    ): Promise<void> => {
      appendCallCount++;
      if (appendCallCount === 2) {
        throw new Error("simulated append failure");
      }
      appended.push(content);
    };

    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        fileSystem: {
          existsSync,
          mkdirSync,
          statSync,
          writeFileSync,
          appendFile: failingAppend as unknown as typeof appendFile,
        },
      }),
    );

    logger.log("first ok");
    logger.log("second fails");
    logger.log("third ok");

    await logger.flush();

    assert.ok(appendCallCount >= 3, "queue continues past a failed append");
    const content = appended.join("");
    assert.match(content, /first ok/);
    assert.match(content, /third ok/);
  });
});

test("flush waits for all queued writes", async () => {
  await withTempRoot(async (root) => {
    let releaseAppend: (() => void) | undefined;
    const gatedAppend = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
    };

    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        fileSystem: {
          existsSync,
          mkdirSync,
          statSync,
          writeFileSync,
          appendFile: gatedAppend as unknown as typeof appendFile,
        },
      }),
    );

    logger.log("held write");
    let flushResolved = false;
    const flushPromise = logger.flush().then(() => {
      flushResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushResolved, false, "flush must not resolve while a write is pending");
    releaseAppend?.();
    await flushPromise;
    assert.equal(flushResolved, true);
  });
});

// ---------------------------------------------------------------------------
// Gate Behavior
// ---------------------------------------------------------------------------

test("gate is consulted on every log call", async () => {
  await withTempRoot(async (root) => {
    let enabled = false;
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, { isDebugEnabled: () => enabled }),
    );

    logger.log("while disabled");
    enabled = true;
    logger.log("while enabled");
    enabled = false;
    logger.log("disabled again");

    await logger.flush();

    const content = readLog(root);
    assert.doesNotMatch(content, /while disabled/);
    assert.match(content, /while enabled/);
    assert.doesNotMatch(content, /disabled again/);
  });
});

test("disabled logger does not create debug directory", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, { isDebugEnabled: () => false }),
    );

    logger.log("noop");
    await logger.flush();

    assert.equal(existsSync(join(root, "debug")), false);
  });
});

test("debug directory is created only on first enabled write", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    assert.equal(existsSync(join(root, "debug")), false);
    logger.log("first");
    assert.equal(existsSync(join(root, "debug")), true);
    await logger.flush();
  });
});

// ---------------------------------------------------------------------------
// Size Cap
// ---------------------------------------------------------------------------

test("oversized log is truncated before the next append", async () => {
  await withTempRoot(async (root) => {
    const truncations: string[] = [];
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        maxLogBytes: 8,
        fileSystem: {
          existsSync,
          mkdirSync,
          statSync: (() => ({ size: 1_000_000 })) as unknown as typeof statSync,
          writeFileSync: ((path: string, content: string) => {
            truncations.push(content);
          }) as unknown as typeof writeFileSync,
          appendFile,
        },
      }),
    );

    logger.log("capped write");
    await logger.flush();

    assert.deepEqual(truncations, [""], "log truncated once before append");
    assert.match(readLog(root), /capped write/);
  });
});

test("statSync failure during cap check does not block the append", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        fileSystem: {
          existsSync,
          mkdirSync,
          statSync: (() => {
            throw new Error("ENOENT");
          }) as unknown as typeof statSync,
          writeFileSync,
          appendFile,
        },
      }),
    );

    logger.log("still appended");
    await logger.flush();

    assert.match(readLog(root), /still appended/);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redaction masks API-key-style tokens in messages", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("key sk-abcdefghijkl attached");
    await logger.flush();
    assert.doesNotMatch(readLog(root), /sk-abcdefghijkl/);
    assert.match(readLog(root), /\[REDACTED\]/);
  });
});

test("redaction masks JWT-style token patterns in messages", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log(
      "jwt aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccc rejected",
    );
    await logger.flush();
    assert.doesNotMatch(
      readLog(root),
      /aaaaaaaaaaaaaaaaaaaaaaaa\.bbbbbb\.cccccccccccccc/,
    );
  });
});

test("redaction does not match non-secret IDs that lack secret patterns", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("task 12345 and run 67890 stayed visible");
    await logger.flush();
    assert.match(readLog(root), /task 12345 and run 67890 stayed visible/);
  });
});

test("error messages containing secrets are redacted", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("failed request", new Error("token sk-bcdefghijklm rejected"));
    await logger.flush();
    assert.doesNotMatch(readLog(root), /sk-bcdefghijklm/);
    assert.match(readLog(root), /token \[REDACTED\] rejected/);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test("logger swallows directory creation errors", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        fileSystem: {
          existsSync,
          mkdirSync: (() => {
            throw new Error("EACCES");
          }) as unknown as typeof mkdirSync,
          statSync,
          writeFileSync,
          appendFile,
        },
      }),
    );

    assert.doesNotThrow(() => logger.log("mkdir fails"));
    await assert.doesNotReject(() => logger.flush());
  });
});

test("logger swallows individual append failures without crashing", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(
      loggerOpts(root, {
        fileSystem: {
          existsSync,
          mkdirSync,
          statSync,
          writeFileSync,
          appendFile: (async () => {
            throw new Error("append boom");
          }) as unknown as typeof appendFile,
        },
      }),
    );

    assert.doesNotThrow(() => logger.log("append fails"));
    await assert.doesNotReject(() => logger.flush());
    assert.equal(existsSync(join(root, "debug", "debug.log")), false);
  });
});

// ---------------------------------------------------------------------------
// Line Format
// ---------------------------------------------------------------------------

test("log lines include ISO timestamp prefix", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("stamped");
    await logger.flush();
    assert.match(readLog(root), /^2026-01-01T00:00:00\.000Z stamped\n$/);
  });
});

test("log lines include error details after the message", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("failed", new Error("boom"));
    await logger.flush();
    assert.match(readLog(root), /failed Error: boom/);
  });
});

test("non-Error error arguments are converted to string", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("string error", "plain-failure");
    await logger.flush();
    assert.match(readLog(root), /string error plain-failure/);
  });
});

test("multiple writes append to the same log file", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger(loggerOpts(root));
    logger.log("one");
    await logger.flush();
    logger.log("two");
    await logger.flush();
    const content = readLog(root);
    assert.match(content, /one/);
    assert.match(content, /two/);
  });
});
