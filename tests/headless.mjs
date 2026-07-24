import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { formatHeadlessText, parseHeadlessArgs, runHeadlessTournament } from "../src/headless.js";

const ATTACK_ACTIONS = new Set([
  "highLight",
  "highHeavy",
  "midLight",
  "midHeavy",
  "lowLight",
  "lowHeavy",
  "fireballLight",
  "fireballHeavy",
  "dragonPunch",
  "throw",
  "airLight",
  "airHeavy",
  "airTatsu",
]);

const tournamentOptions = Object.freeze({
  matches: 8,
  agentA: "pressure",
  agentB: "zoner",
  difficulty: "normal",
  seed: 20260720,
  roundSeconds: 10,
  bestOf: 3,
  // Deliberately omit swapSides: alternating sides must be the default.
  maxFramesPerMatch: 4_000,
});

function withoutTiming(value) {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = key.toLowerCase().replaceAll("_", "");
        return !normalized.startsWith("walltime") && normalized !== "fps";
      })
      .map(([key, child]) => [key, withoutTiming(child)]),
  );
}

function assertActionStats(actions) {
  assert(actions && typeof actions === "object", "summary.actions must be an object");
  for (const participant of ["A", "B"]) {
    assert(
      actions[participant] && typeof actions[participant] === "object",
      `summary.actions.${participant} must contain participant-attributed counts`,
    );
    for (const action of ATTACK_ACTIONS) {
      assert(
        Object.hasOwn(actions[participant], action),
        `summary.actions.${participant} must include ${action}`,
      );
    }
    for (const [action, count] of Object.entries(actions[participant])) {
      assert(Number.isInteger(count) && count >= 0, `${participant}.${action} count must be non-negative`);
    }
  }

  const realAttackCount = ["A", "B"].reduce(
    (total, participant) => total + Object.entries(actions[participant]).reduce(
      (subtotal, [action, count]) => subtotal + (ATTACK_ACTIONS.has(action) ? count : 0),
      0,
    ),
    0,
  );
  assert(realAttackCount > 0, "action statistics must include an authored attack action");
}

function assertSingleCharacterActions(summary) {
  assert(
    summary.actions.A.airTatsu + summary.actions.B.airTatsu > 0,
    "the 苍流 mirror batch must exercise its authored air special",
  );
  for (const participant of ["A", "B"]) {
    assert.equal(Object.hasOwn(summary.actions[participant], "airHammer"), false);
    assert.equal(Object.hasOwn(summary.actions[participant], "rekkaLight"), false);
    assert.equal(Object.hasOwn(summary.actions[participant], "rekkaHeavy"), false);
  }
}

function assertSummary(summary, elapsedMs) {
  assert(summary && typeof summary === "object", "headless runner must return a summary object");
  assert.equal(summary.matches, tournamentOptions.matches, "summary.matches must equal the requested batch size");
  assert(summary.wins && typeof summary.wins === "object", "summary.wins must exist");

  const outcomeTotal = summary.wins.A + summary.wins.B + summary.wins.draw;
  assert.equal(outcomeTotal, summary.matches, "A wins + B wins + draws must equal matches");
  for (const outcome of ["A", "B", "draw"]) {
    assert(Number.isInteger(summary.wins[outcome]) && summary.wins[outcome] >= 0, `wins.${outcome} must be valid`);
  }

  assert(Number.isInteger(summary.totalFrames) && summary.totalFrames > 0, "totalFrames must be positive");
  assert(
    summary.totalFrames <= tournamentOptions.matches * tournamentOptions.maxFramesPerMatch,
    "totalFrames must stay within the configured per-match cap",
  );
  assert(elapsedMs < 10_000, `small headless batch took too long (${elapsedMs.toFixed(1)} ms)`);

  assert(Array.isArray(summary.results), "summary.results must be an array");
  assert.equal(summary.results.length, summary.matches, "results must contain one entry per match");
  assert.deepEqual(
    summary.templates,
    { A: "vanguard", B: "vanguard" },
    "top-level templates must report the fixed single character",
  );
  assert.equal(Object.hasOwn(summary.settings, "templateA"), false, "template A is no longer configurable");
  assert.equal(Object.hasOwn(summary.settings, "templateB"), false, "template B is no longer configurable");
  assert.equal(Object.hasOwn(summary.settings, "delay"), false, "settings must not expose the removed delay rule");
  assert.equal(summary.participants.A.template, "vanguard", "participant A must use 苍流");
  assert.equal(summary.participants.B.template, "vanguard", "participant B must use 苍流");

  const resultWins = { A: 0, B: 0, draw: 0 };
  let resultFrames = 0;
  summary.results.forEach((result, index) => {
    assert.equal(result.match, index + 1, "results must retain deterministic match ordering");
    const expectedLeft = index % 2 === 0 ? "A" : "B";
    const expectedRight = index % 2 === 0 ? "B" : "A";
    assert.equal(result.left, expectedLeft, "default tournament must alternate the left participant");
    assert.equal(result.right, expectedRight, "default tournament must alternate the right participant");
    assert.equal(result.templates.A, "vanguard", "participant A must use 苍流");
    assert.equal(result.templates.B, "vanguard", "participant B must use 苍流");
    assert.equal(result.templates.left, "vanguard", "the left side must use 苍流");
    assert.equal(result.templates.right, "vanguard", "the right side must use 苍流");
    assert(["A", "B", "draw"].includes(result.winner), "winner must be attributed to A/B, not side index");
    assert(Number.isInteger(result.frames) && result.frames > 0, "each result must report positive frames");
    assert(
      result.frames <= tournamentOptions.maxFramesPerMatch,
      "a result must not exceed maxFramesPerMatch",
    );
    resultWins[result.winner] += 1;
    resultFrames += result.frames;
  });

  assert.deepEqual(summary.wins, resultWins, "summary wins must agree with participant-attributed results");
  assert.equal(summary.totalFrames, resultFrames, "summary.totalFrames must equal result frame totals");
  assertActionStats(summary.actions);
  assertSingleCharacterActions(summary);

  const serialized = JSON.stringify(summary);
  assert(serialized.length > 2, "summary must serialize to non-empty JSON");
  assert.doesNotThrow(() => JSON.parse(serialized), "serialized summary must be valid JSON");
  assert(serialized.includes('"templates":{"A":"vanguard","B":"vanguard"}'), "JSON summary must include the fixed character");
  assert.equal(serialized.includes("ember"), false, "JSON summary must not expose the removed character");

  const text = formatHeadlessText(summary);
  assert(text.includes("vanguard"), "text summary must include the fixed character id");
  assert.equal(text.includes("ember"), false, "text summary must not expose the removed character");
  assert(text.includes("实时观测"), "text summary must state that observations are realtime");
}

function assertArgumentParsing() {
  const parsed = parseHeadlessArgs([
    "--matches", "7",
    "--agent-a", "pressure",
    "--agent-b", "zoner",
    "--no-swap",
    "--format", "json",
  ]);

  assert.equal(parsed.matches, 7, "--matches must parse as a number");
  assert.equal(parsed.agentA, "pressure", "--agent-a must select participant A");
  assert.equal(parsed.agentB, "zoner", "--agent-b must select participant B");
  assert.equal(Object.hasOwn(parsed, "templateA"), false, "template A must no longer be configurable");
  assert.equal(Object.hasOwn(parsed, "templateB"), false, "template B must no longer be configurable");
  assert.equal(Object.hasOwn(parsed, "delay"), false, "parsed options must not expose a removed delay setting");
  assert.equal(parsed.swapSides, false, "--no-swap must disable side alternation");
  assert.equal(parsed.format, "json", "--format json must be retained");

  const defaults = parseHeadlessArgs([]);
  assert.equal(Object.hasOwn(defaults, "templateA"), false);
  assert.equal(Object.hasOwn(defaults, "templateB"), false);

  const invalidCases = [
    ["--matches", "0"],
    ["--matches", "many"],
    ["--agent-a", "unknown-agent"],
    ["--agent-b", "unknown-agent"],
    ["--template-a", "vanguard"],
    ["--template-b", "vanguard"],
    ["--delay", "0"],
    ["--delay", "6"],
    ["--format", "xml"],
  ];
  for (const args of invalidCases) {
    assert.throws(
      () => parseHeadlessArgs(args),
      undefined,
      `invalid arguments must throw: ${args.join(" ")}`,
    );
  }
}

assertArgumentParsing();
for (const delay of [0, 1]) {
  assert.throws(
    () => runHeadlessTournament({ ...tournamentOptions, matches: 1, delay }),
    /取消|removed/i,
    "programmatic delay must fail with an explicit migration error",
  );
}

const firstStart = performance.now();
const first = await runHeadlessTournament(tournamentOptions);
const firstElapsed = performance.now() - firstStart;
assertSummary(first, firstElapsed);

const second = await runHeadlessTournament(tournamentOptions);
assert.deepEqual(
  withoutTiming(second),
  withoutTiming(first),
  "same seed/options must reproduce every non-performance field",
);

const fixedSides = await runHeadlessTournament({
  ...tournamentOptions,
  matches: 2,
  swapSides: false,
});
for (const result of fixedSides.results) {
  assert.equal(result.left, "A", "swapSides=false must keep A on the left");
  assert.equal(result.right, "B", "swapSides=false must keep B on the right");
  assert.equal(result.templates.left, "vanguard", "A must use 苍流");
  assert.equal(result.templates.right, "vanguard", "B must use 苍流");
}

process.stdout.write(
  `headless ok · matches=${first.matches}`
  + ` · wins=${first.wins.A}-${first.wins.B}-${first.wins.draw}`
  + ` · frames=${first.totalFrames}`
  + ` · wall=${firstElapsed.toFixed(1)}ms\n`,
);
