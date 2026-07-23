import { parentPort, workerData } from "node:worker_threads";

import { runHeadlessTournament } from "../src/headless.js";
import { createSandboxAgent } from "./sandbox-agent.mjs";

const TICK_RATE = 60;
const ROUND_TRANSITION_BUDGET_FRAMES = 600;

try {
  const request = validateRequest(workerData);
  const runtime = {
    recordReplay: request.recordReplay,
    matchIdForMatch: () => request.matchId,
    runnerOptions: {
      invalidActionPolicy: "disable",
      exceptionPolicy: "disable",
      timeoutPolicy: "disable",
    },
    createAgent(participant, context) {
      const code = participant === "A" ? request.codeA : request.codeB;
      if (!code) return undefined;
      return createSandboxAgent({
        code,
        filename: `${participant.toLowerCase()}-${request.matchId}.js`,
        seed: context.seed,
        compileTimeoutMs: request.compileTimeoutMs,
        callTimeoutMs: request.callTimeoutMs,
      });
    },
  };
  const summary = runHeadlessTournament({
    matches: 1,
    agentA: "balanced",
    agentB: request.opponentPreset,
    templateA: request.templateA,
    templateB: request.templateB,
    difficulty: request.difficulty,
    delay: request.delay,
    seed: request.seed,
    roundSeconds: request.roundSeconds,
    bestOf: request.bestOf,
    swapSides: false,
    maxFramesPerMatch: request.maxFramesPerMatch,
  }, runtime);
  parentPort.postMessage({ ok: true, summary });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
    },
  });
}

function validateRequest(value) {
  if (!value || typeof value !== "object") throw new TypeError("match request must be an object");
  if (typeof value.codeA !== "string") throw new TypeError("match request requires codeA");
  if (value.codeB !== null && value.codeB !== undefined && typeof value.codeB !== "string") {
    throw new TypeError("codeB must be a string or null");
  }
  const roundSeconds = integer(value.roundSeconds, 10, 300, 30);
  const bestOf = oddInteger(value.bestOf, 1, 9, 3);
  // Mirror the headless engine's safety budget instead of imposing a fixed
  // 36,000F cap. Long legal formats must have room for every configured round,
  // while an explicit cap remains available for short validation matches.
  const derivedFrameLimit = Math.max(
    roundSeconds * TICK_RATE * bestOf * 4,
    (roundSeconds * TICK_RATE + ROUND_TRANSITION_BUDGET_FRAMES) * (bestOf * 2 + 4),
  );
  return {
    matchId: text(value.matchId, "sandbox-match"),
    codeA: value.codeA,
    codeB: value.codeB ?? null,
    opponentPreset: enumValue(value.opponentPreset, ["balanced", "pressure", "zoner"], "balanced"),
    templateA: enumValue(value.templateA, ["vanguard", "ember"], "vanguard"),
    templateB: enumValue(value.templateB, ["vanguard", "ember"], "ember"),
    difficulty: enumValue(value.difficulty, ["easy", "normal", "hard", "expert"], "normal"),
    delay: integer(value.delay, 0, 120, 12),
    seed: integer(value.seed, 0, 0xffffffff, 1),
    roundSeconds,
    bestOf,
    maxFramesPerMatch: integer(
      value.maxFramesPerMatch,
      60,
      100_000_000,
      derivedFrameLimit,
    ),
    compileTimeoutMs: integer(value.compileTimeoutMs, 1, 1_000, 50),
    callTimeoutMs: integer(value.callTimeoutMs, 1, 1_000, 10),
    recordReplay: value.recordReplay !== false,
  };
}

function text(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, 120) : fallback;
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? fallback).toLowerCase();
  if (!allowed.includes(normalized)) throw new TypeError(`expected ${allowed.join("|")}`);
  return normalized;
}

function integer(value, minimum, maximum, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`expected integer ${minimum}-${maximum}`);
  }
  return number;
}

function oddInteger(value, minimum, maximum, fallback) {
  const number = integer(value, minimum, maximum, fallback);
  if (number % 2 === 0) throw new TypeError("bestOf must be odd");
  return number;
}
