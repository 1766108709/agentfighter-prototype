import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export const DEFAULT_MATCH_TIMEOUT_MS = 20_000;

export function runSandboxMatch(options = {}) {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    250,
    120_000,
    DEFAULT_MATCH_TIMEOUT_MS,
  );
  const matchId = String(options.matchId ?? `mat_${randomUUID().replaceAll("-", "")}`).slice(0, 128);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./match-worker.mjs", import.meta.url), {
      workerData: { ...options, matchId },
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await worker.terminate();
      reject(new MatchSandboxError(`match exceeded ${timeoutMs}ms wall-time limit`, "MATCH_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();

    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (message?.ok) {
        resolve({ matchId, summary: message.summary });
      } else {
        reject(new MatchSandboxError(
          message?.error?.message || "sandbox match failed",
          "AGENT_RUNTIME_ERROR",
        ));
      }
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MatchSandboxError(error.message, "WORKER_ERROR"));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MatchSandboxError(
        `sandbox worker exited before returning a result (code ${code})`,
        "WORKER_EXIT",
      ));
    });
  });
}

export class MatchSandboxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MatchSandboxError";
    this.code = code;
  }
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) return fallback;
  return number;
}
