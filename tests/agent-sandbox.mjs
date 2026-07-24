import assert from "node:assert/strict";

import { MatchSandboxError, runSandboxMatch } from "../server/run-match.mjs";

const VALID_AGENT = `
function createAgent(api) {
  return {
    name: "Sandbox Smoke",
    act(observation) {
      if (
        typeof process !== "undefined"
        || typeof require !== "undefined"
        || typeof fetch !== "undefined"
        || typeof WebSocket !== "undefined"
        || typeof Date !== "undefined"
        || typeof performance !== "undefined"
        || typeof crypto !== "undefined"
        || typeof SharedArrayBuffer !== "undefined"
        || typeof Atomics !== "undefined"
      ) throw new Error("forbidden host capability leaked");
      if (
        observation.perception.delayFrames !== 0
        || observation.perception.opponentFrame !== observation.frame
      ) throw new Error("sandbox observation is not realtime");
      const towardRight = observation.self.position.x < observation.opponent.position.x;
      return api.action({
        left: !towardRight,
        right: towardRight,
        lp: observation.frame % 18 === 0,
      });
    },
  };
}`;

for (const delay of [0, 120]) {
  await assert.rejects(
    runSandboxMatch({ codeA: VALID_AGENT, delay, timeoutMs: 2_000 }),
    (error) => (
      error instanceof MatchSandboxError
      && error.code === "REMOVED_OPTION"
      && /delay has been removed/i.test(error.message)
    ),
    "sandbox matches must reject the removed delay option instead of ignoring it",
  );
}

const first = await runSandboxMatch({
  codeA: VALID_AGENT,
  seed: 701,
  bestOf: 1,
  roundSeconds: 10,
  maxFramesPerMatch: 2_400,
  timeoutMs: 10_000,
});
assert.equal(first.summary.matches, 1);
assert.equal(first.summary.participants.A.name, "Sandbox Smoke");
assert.equal(first.summary.diagnostics.A.total, 0);
assert(first.summary.results[0].replay, "sandbox match must return ReplayV1");

const second = await runSandboxMatch({
  codeA: VALID_AGENT,
  seed: 701,
  bestOf: 1,
  roundSeconds: 10,
  maxFramesPerMatch: 2_400,
  timeoutMs: 10_000,
});
assert.equal(first.summary.wins.A, second.summary.wins.A);
assert.equal(first.summary.wins.B, second.summary.wins.B);
assert.equal(first.summary.totalFrames, second.summary.totalFrames);
assert.equal(
  first.summary.results[0].replay.finalHash,
  second.summary.results[0].replay.finalHash,
  "same seed and uploaded code must replay deterministically",
);

const loopingAct = await runSandboxMatch({
  codeA: `function createAgent(api) { return { name: "Loop", act() { while (true) {} } }; }`,
  bestOf: 1,
  roundSeconds: 10,
  maxFramesPerMatch: 1_200,
  callTimeoutMs: 5,
  timeoutMs: 10_000,
  recordReplay: false,
});
assert.equal(loopingAct.summary.diagnostics.A.byKind["act-exception"], 1);
assert.equal(loopingAct.summary.diagnostics.A.disabledMatches, 1);

await assert.rejects(
  runSandboxMatch({
    codeA: `while (true) {}\nfunction createAgent(api) { return { act() { return api.action(); } }; }`,
    compileTimeoutMs: 5,
    timeoutMs: 2_000,
  }),
  (error) => error instanceof MatchSandboxError && error.code === "AGENT_RUNTIME_ERROR",
  "non-terminating top-level code must be interrupted in its disposable Worker",
);

await assert.rejects(
  runSandboxMatch({ codeA: `function wrongEntryPoint() {}` }),
  (error) => error instanceof MatchSandboxError && error.code === "AGENT_RUNTIME_ERROR",
  "missing createAgent(api) must fail closed",
);

console.log("agent sandbox tests passed");
