import assert from "node:assert/strict";

import { runSandboxMatch } from "../server/run-match.mjs";

const NEUTRAL_AGENT = `
function createAgent(api) {
  return {
    name: "Frame Budget Test",
    act() {
      return api.action({});
    },
  };
}
`;

const longFormat = await runSandboxMatch({
  matchId: "derived-frame-budget",
  codeA: NEUTRAL_AGENT,
  opponentPreset: "pressure",
  roundSeconds: 300,
  bestOf: 9,
  recordReplay: false,
  timeoutMs: 20_000,
});

assert.equal(
  longFormat.summary.settings.maxFramesPerMatch,
  648_000,
  "a legal 300-second best-of-9 must derive its frame budget from the format",
);
assert.notEqual(
  longFormat.summary.settings.maxFramesPerMatch,
  36_000,
  "the Worker must not retain the old fixed frame cap",
);

const explicitlyCapped = await runSandboxMatch({
  matchId: "explicit-frame-budget",
  codeA: NEUTRAL_AGENT,
  opponentPreset: "pressure",
  roundSeconds: 300,
  bestOf: 9,
  maxFramesPerMatch: 60,
  recordReplay: false,
  timeoutMs: 20_000,
});

assert.equal(
  explicitlyCapped.summary.settings.maxFramesPerMatch,
  60,
  "an explicit validation frame cap must override the derived long-match budget",
);
assert.equal(explicitlyCapped.summary.results[0].frames, 60);
assert.equal(explicitlyCapped.summary.results[0].termination, "frameLimit");
assert.deepEqual(explicitlyCapped.summary.templates, { A: "vanguard", B: "vanguard" });
await assert.rejects(
  runSandboxMatch({
    codeA: NEUTRAL_AGENT,
    templateA: "ember",
    maxFramesPerMatch: 1,
  }),
  (error) => error?.code === "REMOVED_OPTION" && /templateA\/templateB have been removed/.test(error.message),
  "the removed dual-template sandbox options must fail explicitly",
);

console.log("match worker frame-budget tests passed");
