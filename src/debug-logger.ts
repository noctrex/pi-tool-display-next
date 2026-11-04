import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolDisplayConfig } from "./config-store.js";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEBUG_DIR = join(EXTENSION_ROOT, "debug");
const DEFAULT_DEBUG_LOG_FILE = join(DEFAULT_DEBUG_DIR, "debug.log");
const DEFAULT_MAX_LOG_BYTES = 1_000_000;

const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,})\b/g;

interface ToolDisplayDebugLoggerFileSystem {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  statSync: typeof statSync;
  writeFileSync: typeof writeFileSync;
  appendFile: typeof appendFile;
}

export interface ToolDisplayDebugLoggerOptions {
  debugDir?: string;
  debugLogFile?: string;
  maxLogBytes?: number;
  isDebugEnabled?: () => boolean;
  createDate?: () => Date;
  fileSystem?: ToolDisplayDebugLoggerFileSystem;
}

export interface ToolDisplayDebugLogger {
  log(message: string, error?: unknown): void;
  flush(): Promise<void>;
}

const DEFAULT_FILE_SYSTEM: ToolDisplayDebugLoggerFileSystem = {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  appendFile,
};

function redactMessage(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

/**
 * The logger is gated on the agent-dir configuration file
 * (`pi-tool-display-next.json`), the same file the README documents. The
 * pre-fork gate (a `config.json` inside the install directory) is gone: it
 * silently kept logging for upgraded installs and could not be turned off
 * through the documented settings.
 */
function defaultIsDebugEnabled(): boolean {
  try {
    return loadToolDisplayConfig().config.debug === true;
  } catch {
    return false;
  }
}

export function createToolDisplayDebugLogger(options: ToolDisplayDebugLoggerOptions = {}): ToolDisplayDebugLogger {
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const debugLogFile = options.debugLogFile ?? DEFAULT_DEBUG_LOG_FILE;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const isDebugEnabled = options.isDebugEnabled ?? defaultIsDebugEnabled;
  const createDate = options.createDate ?? (() => new Date());
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;

  let debugDirectoryReady = false;
  let writeQueue: Promise<void> = Promise.resolve();

  function ensureDebugDirectory(): void {
    if (debugDirectoryReady) {
      return;
    }

    fileSystem.mkdirSync(debugDir, { recursive: true });
    debugDirectoryReady = true;
  }

  function enforceLogSizeCap(): void {
    try {
      const stats = fileSystem.statSync(debugLogFile);
      if (stats.size > maxLogBytes) {
        // Truncate in place: the log is diagnostics only, never rotated data.
        fileSystem.writeFileSync(debugLogFile, "");
      }
    } catch {
      // Missing file or stat failure: nothing to cap.
    }
  }

  function appendLine(line: string): Promise<void> {
    enforceLogSizeCap();
    return fileSystem.appendFile(debugLogFile, line, "utf8");
  }

  return {
    log(message: string, error?: unknown): void {
      if (!isDebugEnabled()) {
        return;
      }

      try {
        ensureDebugDirectory();
        const errorText = error instanceof Error
          ? `${error.name}: ${error.message}`
          : error === undefined
            ? ""
            : String(error);
        const suffix = errorText ? ` ${redactMessage(errorText)}` : "";
        const line = `${createDate().toISOString()} ${redactMessage(message)}${suffix}\n`;
        writeQueue = writeQueue.then(
          () => appendLine(line),
          () => appendLine(line),
        );
        void writeQueue.catch(() => undefined);
      } catch (logError) {
        // Debug logging must never affect extension behavior.
        void logError;
      }
    },
    flush(): Promise<void> {
      return writeQueue.catch(() => undefined);
    },
  };
}

const defaultDebugLogger = createToolDisplayDebugLogger();

export function logToolDisplayDebug(message: string, error?: unknown): void {
  defaultDebugLogger.log(message, error);
}
