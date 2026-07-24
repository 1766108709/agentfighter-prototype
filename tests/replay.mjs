import assert from "node:assert/strict";

import { createScriptAI } from "../src/ai.js";
import { createGame } from "../src/engine.js";
import {
  REPLAY_FORMAT,
  REPLAY_SCHEMA,
  REPLAY_VERSION,
  ReplayDivergenceError,
  ReplayValidationError,
  createReplayPlayer,
  createReplayRecorder,
  replayStateHash,
  summarizeReplayGame,
  validateReplayV1,
} from "../src/replay.js";
import { recordCombatEvent } from "../src/telemetry.js";

const jsonRoundTrip = (value) => JSON.parse(JSON.stringify(value));

function keyOutcome(game) {
  return {
    frame: game.frame,
    roundFrame: game.roundFrame,
    phase: game.phase,
    roundNumber: game.roundNumber,
    score: [...game.score],
    roundWinner: game.roundWinner,
    roundReason: game.roundReason,
    matchWinner: game.matchWinner,
    fighters: game.fighters.map((fighter) => ({
      health: fighter.health,
      x: fighter.x,
      y: fighter.y,
      action: fighter.action,
      currentMoveId: fighter.currentMoveId,
      superMeter: fighter.superMeter,
      drive: fighter.drive,
    })),
    projectiles: game.projectiles.map((projectile) => ({
      id: projectile.id,
      owner: projectile.owner,
      x: projectile.x,
      y: projectile.y,
      vx: projectile.vx,
    })),
    combatEvents: jsonRoundTrip(game.combatEvents),
    telemetry: jsonRoundTrip(game.telemetry),
  };
}

const game = createGame({
  bestOf: 3,
  roundSeconds: 10,
  maxHealth: 300,
  playerTemplate: "vanguard",
  aiTemplate: "ember",
});
const leftAI = createScriptAI({
  preset: "pressure",
  difficulty: "hard",
  seed: 0x11111111,
});
const rightAI = createScriptAI({
  preset: "zoner",
  difficulty: "normal",
  seed: 0x22222222,
});
const recorder = createReplayRecorder(game, {
  seed: 0xdecafbad,
  rules: { mode: "determinism-test" },
  metadata: { title: "ReplayV1 determinism fixture" },
});

let injectedDecisionEvent = false;
for (let safety = 0; safety < 4_000 && game.phase !== "matchOver"; safety += 1) {
  if (game.phase === "roundOver") {
    recorder.advanceRound();
    leftAI.reset({ preserveAdaptation: true });
    rightAI.reset({ preserveAdaptation: true });
  }

  const p1 = leftAI.decide(game, 0);
  const p2 = rightAI.decide(game, 1);
  if (!injectedDecisionEvent) {
    // Agent-side telemetry can be emitted between simulation frames. ReplayV1
    // records it as preStep and deterministically injects it during playback.
    recordCombatEvent(game, "intent", {
      fighterId: 0,
      intent: "approach",
      reason: "replay-test",
    });
    injectedDecisionEvent = true;
  }
  recorder.recordFrame(
    { p1, p2 },
    {
      decisions: {
        p1: { intent: game.fighters[0].aiIntent, reason: game.fighters[0].aiReason },
        p2: { intent: game.fighters[1].aiIntent, reason: game.fighters[1].aiReason },
      },
    },
  );
}

assert.equal(game.phase, "matchOver", "recorded fixture must reach a complete match result");
assert(recorder.frameCount > 0, "recorder must store simulation frames");
assert(recorder.eventCount > 0, "recorder must store key combat events");

const originalOutcome = keyOutcome(game);
const originalSummary = summarizeReplayGame(game);
const replay = recorder.finish({ termination: "matchOver" });

assert.equal(replay.format, REPLAY_FORMAT);
assert.equal(replay.schema, REPLAY_SCHEMA);
assert.equal(replay.version, REPLAY_VERSION);
assert.equal(replay.initial.seed, 0xdecafbad);
assert.equal(replay.end.completed, true);
assert.equal(replay.end.totalFrames, replay.frames.length);
assert.equal(replay.end.eventCount, replay.events.length);
assert(replay.frames.some((frame) => frame.advanceRound), "multi-round replay must retain round transitions");
assert(replay.frames.every((frame) => frame.decisions?.p1 && frame.decisions?.p2));
assert(replay.events.some((record) => record.timing === "preStep" && record.event.type === "intent"));
assert(replay.events.some((record) => record.event.type === "moveStart"));
assert.equal(validateReplayV1(replay), true);

const replayed = createReplayPlayer(replay);
const verification = replayed.verify();
assert.equal(verification.valid, true);
assert.equal(replayed.cursor, replayed.totalFrames);
assert.deepEqual(keyOutcome(replayed.game), originalOutcome, "original and replayed key outcome/events must match");
assert.deepEqual(verification.summary, originalSummary, "original and replayed ending summaries must match");

const midpoint = Math.floor(replay.frames.length / 2);
const sequential = createReplayPlayer(replay);
while (sequential.cursor < midpoint) sequential.step();
const midpointOutcome = keyOutcome(sequential.game);
const sought = createReplayPlayer(replay);
sought.seek(midpoint);
assert.deepEqual(keyOutcome(sought.game), midpointOutcome, "seek(midpoint) must match sequential replay state");
sought.seek(Math.floor(midpoint / 3));
sought.seek(midpoint);
assert.deepEqual(keyOutcome(sought.game), midpointOutcome, "backward then forward seek must rebuild the same state");
assert.deepEqual(sought.currentFrame, replay.frames[midpoint - 1]);
assert.deepEqual(sought.currentEvents, sought.eventsAt(midpoint));

const serialized = JSON.stringify(replay);
const parsed = JSON.parse(serialized);
assert.deepEqual(parsed, replay, "ReplayV1 must survive JSON serialization without loss");
assert.equal(createReplayPlayer(parsed).verify().valid, true, "JSON-round-tripped replay must verify");

const badVersion = jsonRoundTrip(replay);
badVersion.version = REPLAY_VERSION + 1;
assert.throws(() => validateReplayV1(badVersion), ReplayValidationError, "unknown replay versions must be rejected");

const badInput = jsonRoundTrip(replay);
badInput.frames[0].inputs.p1.left = "true";
assert.throws(() => createReplayPlayer(badInput), ReplayValidationError, "non-boolean canonical input must be rejected");

const badChecksum = jsonRoundTrip(replay);
const corruptIndex = Math.min(10, badChecksum.frames.length - 1);
badChecksum.frames[corruptIndex].stateHash = "00000000";
if (corruptIndex === badChecksum.frames.length - 1) badChecksum.end.stateHash = "00000000";
const corruptPlayer = createReplayPlayer(badChecksum);
corruptPlayer.seek(corruptIndex);
const safeCursor = corruptPlayer.cursor;
const safeGameReference = corruptPlayer.game;
const safeFrame = corruptPlayer.game.frame;
const safeHash = replayStateHash(corruptPlayer.game);
const safeOutcome = keyOutcome(corruptPlayer.game);
const safeEvents = corruptPlayer.currentEvents;
assert.throws(
  () => corruptPlayer.step(),
  ReplayDivergenceError,
  "state corruption must be detected during full playback",
);
assert.equal(corruptPlayer.cursor, safeCursor, "failed step must restore the pre-step cursor");
assert.strictEqual(corruptPlayer.game, safeGameReference, "failed step must preserve the exposed game reference");
assert.equal(corruptPlayer.game.frame, safeFrame, "failed step must restore the pre-step engine frame");
assert.equal(replayStateHash(corruptPlayer.game), safeHash, "failed step must restore the pre-step game hash");
assert.deepEqual(keyOutcome(corruptPlayer.game), safeOutcome, "failed step must restore exact key game state");
assert.deepEqual(corruptPlayer.currentEvents, safeEvents, "failed step must restore currentEvents");
assert.equal(corruptPlayer.debugStats.lastRecoveryCursor, safeCursor);
assert(corruptPlayer.debugStats.recoveryCount > 0, "failed validation must report a completed recovery");
assert.deepEqual(
  keyOutcome(corruptPlayer.seek(safeCursor).game),
  safeOutcome,
  "seek at the recovered cursor must remain consistent",
);
corruptPlayer.reset();
corruptPlayer.seek(safeCursor);
assert.deepEqual(keyOutcome(corruptPlayer.game), safeOutcome, "reset and replay to the safe cursor must remain usable");

const hashFixture = createGame({ bestOf: 1 });
const baseCombatHash = replayStateHash(hashFixture);
hashFixture.aiDebug = [{ intent: "display-only" }, {}];
hashFixture.aiIntents = ["approach", "defend"];
hashFixture.aiTelemetry = [{ confidence: 0.8 }, {}];
Object.assign(hashFixture.fighters[0], {
  aiIntent: "display-only",
  aiReason: "renderer copy",
  aiMoveId: "standLightPunch",
  aiPlanFrame: 99,
  aiPlan: { intent: "display-only" },
  aiDebug: { score: 10 },
  aiTelemetry: { confidence: 1 },
  agentDebug: { adapter: "test" },
  ai: { reason: "fallback renderer field" },
});
assert.equal(
  replayStateHash(hashFixture),
  baseCombatHash,
  "explicit presentation-only AI annotations must not affect combat hash",
);
hashFixture.fighters[0].aiArmor = 1;
assert.notEqual(
  replayStateHash(hashFixture),
  baseCombatHash,
  "future AI-prefixed combat fields must affect hash unless explicitly reviewed",
);

const invalidRecorder = createReplayRecorder(createGame({ bestOf: 1 }));
assert.throws(
  () => invalidRecorder.recordFrame({ p1: { left: 1 }, p2: {} }),
  ReplayValidationError,
  "recorder must reject non-boolean source inputs",
);
assert.throws(
  () => invalidRecorder.recordFrame({ p1: { teleport: true }, p2: {} }),
  ReplayValidationError,
  "recorder must reject unknown source inputs",
);

// Navigation performance is asserted by actual replay work, not fragile wall
// clock thresholds. A backward single-frame seek near F3000 may replay at most
// one 120F checkpoint interval instead of rebuilding all 2999 prior frames.
const longGame = createGame({ bestOf: 1, roundSeconds: 60 });
const longRecorder = createReplayRecorder(longGame, { seed: 3000 });
for (let frame = 0; frame < 3_000; frame += 1) {
  longRecorder.recordFrame({ p1: {}, p2: {} });
}
const longReplay = longRecorder.finish({ termination: "benchmarkFixture" });
const navigation = createReplayPlayer(longReplay);
const initialResetCount = navigation.debugStats.resetCount;

navigation.seek(1_400);
assert.equal(navigation.debugStats.lastSeekSteps, 1_400, "first forward seek must simulate the requested span");
navigation.seek(1_600);
assert.equal(navigation.debugStats.lastSeekSteps, 200, "forward seek must continue from the current cursor");
assert.equal(
  navigation.debugStats.resetCount,
  initialResetCount,
  "forward seek must not reset the player",
);

navigation.seek(1_599);
const state1599 = summarizeReplayGame(navigation.game);
assert(
  navigation.debugStats.lastSeekSteps < navigation.debugStats.checkpointInterval,
  "one-frame backward seek must restore a nearby checkpoint",
);
navigation.seek(1_600);
const state1600 = summarizeReplayGame(navigation.game);
assert.equal(navigation.debugStats.lastSeekSteps, 1, "forward single-step after backward seek must do one simulation step");
navigation.seek(1_599);
assert.deepEqual(summarizeReplayGame(navigation.game), state1599, "repeated backward single-step must stay exact");
navigation.seek(1_600);
assert.deepEqual(summarizeReplayGame(navigation.game), state1600, "repeated forward single-step must stay exact");

const fullTraversal = createReplayPlayer(longReplay);
fullTraversal.seek(3_000);
const fullReplaySteps = fullTraversal.debugStats.lastSeekSteps;
assert.equal(fullReplaySteps, 3_000, "fresh F3000 traversal establishes the full-replay work baseline");
fullTraversal.seek(2_999);
const backwardReplaySteps = fullTraversal.debugStats.lastSeekSteps;
assert(
  backwardReplaySteps < fullReplaySteps / 20,
  `checkpoint seek should replay far less work than frame-0 rebuild (${backwardReplaySteps}/${fullReplaySteps})`,
);
assert(
  backwardReplaySteps < fullTraversal.debugStats.checkpointInterval,
  "F3000 -> F2999 must replay less than one checkpoint interval",
);
assert(
  fullTraversal.debugStats.checkpointCount <= fullTraversal.debugStats.maxCheckpoints,
  "checkpoint cache must stay within its memory bound",
);
assert(fullTraversal.debugStats.checkpointCursors.includes(0), "cursor-0 checkpoint must always be retained");

process.stdout.write(
  `replay ok · ${replay.frames.length}F · ${replay.events.length} events · ${replay.end.stateHash} · seek ${backwardReplaySteps}/${fullReplaySteps}F\n`,
);
