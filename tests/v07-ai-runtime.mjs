import assert from "node:assert/strict";

import { createScriptAI } from "../src/ai.js";
import { MOVESETS } from "../src/engine.js";
import { runHeadlessTournament } from "../src/headless.js";
import { defineMoveset } from "../src/move-data.js";

const runtimeMoveset = defineMoveset({
  id: "vanguard",
  name: "Runtime Test",
  moves: {
    jab: {
      name: "Jab",
      category: "normal",
      command: { buttons: ["lp"], label: "LP" },
      startup: 4,
      active: 3,
      recovery: 7,
      damage: 50,
      tags: ["fast", "poke", "frameTrap", "meaty", "combo"],
      hitboxes: [{ start: 4, end: 6, offsetX: 42, offsetY: -70, width: 32, height: 20 }],
    },
    sweep: {
      name: "Sweep",
      category: "normal",
      command: { direction: "down", buttons: ["hk"], label: "2HK" },
      startup: 9,
      active: 3,
      recovery: 20,
      damage: 90,
      tags: ["poke", "longRange", "whiffPunish"],
      hitboxes: [{ start: 9, end: 11, offsetX: 68, offsetY: -22, width: 55, height: 22 }],
    },
    fireball: {
      name: "Fireball",
      category: "special",
      command: { motion: "qcf", buttons: ["lp"], label: "236LP" },
      startup: 12,
      active: 3,
      recovery: 24,
      damage: 70,
      tags: ["projectile", "spaceControl"],
    },
    comboSpecial: {
      name: "Combo Special",
      category: "special",
      command: { motion: "qcf", buttons: ["hp"], label: "236HP" },
      startup: 7,
      active: 4,
      recovery: 18,
      damage: 120,
      tags: ["combo", "special"],
    },
    super: {
      name: "Confirmed Super",
      category: "super",
      command: { motion: "qcfQcf", buttons: ["hp"], label: "236236HP" },
      startup: 7,
      active: 6,
      recovery: 30,
      damage: 480,
      resourceCost: { super: 100 },
      tags: ["super", "combo"],
    },
    airKick: {
      name: "Air Kick",
      category: "normal",
      stance: "air",
      strength: "heavy",
      command: { buttons: ["hk"], air: true, label: "j.HK" },
      startup: 7,
      active: 5,
      recovery: 0,
      damage: 80,
      tags: ["combo"],
    },
    throw: {
      name: "Throw",
      category: "throw",
      command: { buttons: ["throw"], label: "LP+LK" },
      startup: 5,
      active: 3,
      recovery: 20,
      damage: 120,
      tags: ["throw"],
    },
  },
});

const injectedMovesets = { vanguard: runtimeMoveset };

function fighter(overrides = {}) {
  return {
    id: 0,
    templateId: "vanguard",
    x: 420,
    y: 590,
    facing: 1,
    health: 1000,
    maxHealth: 1000,
    onGround: true,
    action: "idle",
    superMeter: 100,
    maxSuperMeter: 300,
    drive: 600,
    maxDrive: 600,
    guardGauge: 100,
    ...overrides,
  };
}

function mockGame(self, opponent, frame = 0) {
  return {
    frame,
    phase: "fighting",
    arena: { width: 1280, height: 720, floorY: 590 },
    fighters: [self, opponent],
    projectiles: [],
    combatEvents: [],
  };
}

function assertDualController(input) {
  const legacyKeys = ["left", "right", "up", "down", "light", "heavy", "special", "guard"];
  assert.deepEqual(Object.keys(input).sort(), legacyKeys.sort(), "legacy eight-key surface must remain enumerable");
  for (const key of ["lp", "mp", "hp", "lk", "mk", "hk", "throw", "system1", "system2"]) {
    assert.equal(typeof input[key], "boolean", `canonical ${key} must remain directly readable`);
  }
}

// A live hit contact must interrupt ordinary move recovery with a real motion
// for a legal combo/super cancel, not a probability-selected standalone move.
{
  const self = fighter({
    action: "jab",
    currentMove: runtimeMoveset.moves.jab,
    movePhase: "active",
    lastContact: { outcome: "hit", frame: 100, moveId: "jab" },
  });
  const opponent = fighter({ id: 1, x: 485, facing: -1, action: "hit" });
  const game = mockGame(self, opponent, 103);
  const ai = createScriptAI({
    preset: "balanced",
    difficulty: "hard",
    observationDelayFrames: 0,
    seed: 17,
    movesets: injectedMovesets,
  });

  const trace = [];
  for (let frame = 103; frame < 113; frame += 1) {
    game.frame = frame;
    const input = ai.decide(game, 0);
    assertDualController(input);
    trace.push(input);
  }
  assert(
    ["comboRoute", "superConfirm"].includes(ai.getDebugState().lastPlan.intent),
    "confirmed contact must choose a combo conversion intent",
  );
  assert(trace.some((input) => input.down), "confirmed cancel must execute motion directions");
  assert(trace.some((input) => input.hp && input.heavy), "canonical HP must retain legacy heavy compatibility");
  assert.equal(self.aiIntent, ai.getDebugState().lastPlan.intent, "intent must be exposed on the fighter for spectators");
  assert(self.aiReason.length > 0, "spectators must receive an explainable tactical reason");
}

// Block contact creates a frame-trap/throw-tech-bait decision; recovery creates
// a whiff-punish decision. Both are deterministic consequences of state.
{
  const self = fighter({
    action: "jab",
    currentMove: runtimeMoveset.moves.jab,
    movePhase: "active",
    lastContact: { outcome: "block", frame: 50, moveId: "jab" },
  });
  const opponent = fighter({ id: 1, x: 480, facing: -1, action: "block", blockstunFrames: 4 });
  const game = mockGame(self, opponent, 52);
  const ai = createScriptAI({
    preset: "pressure",
    difficulty: "expert",
    observationDelayFrames: 0,
    seed: 3,
    movesets: injectedMovesets,
  });
  ai.decide(game, 0);
  const plan = ai.getDebugState().lastPlan;
  assert(["frameTrap", "shimmy"].includes(plan.intent), "blocked pressure must trap or back away to bait a response");
}

{
  const self = fighter({ x: 420 });
  const opponent = fighter({
    id: 1,
    x: 510,
    facing: -1,
    action: "sweep",
    currentMove: runtimeMoveset.moves.sweep,
    movePhase: "recovery",
  });
  const game = mockGame(self, opponent, 80);
  const ai = createScriptAI({
    preset: "balanced",
    difficulty: "expert",
    observationDelayFrames: 0,
    seed: 5,
    movesets: injectedMovesets,
  });
  ai.decide(game, 0);
  assert.equal(ai.getDebugState().lastPlan.intent, "whiffPunish", "visible recovery must trigger whiff punishment");
}

// Observation delay applies to opponent state while self-owned hit confirms
// remain immediate.
{
  const self = fighter();
  const opponent = fighter({ id: 1, x: 900, facing: -1 });
  const game = mockGame(self, opponent, 0);
  const ai = createScriptAI({
    preset: "zoner",
    difficulty: "normal",
    observationDelayFrames: 3,
    seed: 9,
    movesets: injectedMovesets,
  });
  ai.decide(game, 0);
  opponent.x = 470;
  for (let frame = 1; frame <= 3; frame += 1) {
    game.frame = frame;
    ai.decide(game, 0);
  }
  assert.equal(ai.getDebugState().observedFrame, 0, "3F delay must still expose frame 0 at live frame 3");
  game.frame = 4;
  ai.decide(game, 0);
  assert.equal(ai.getDebugState().observedFrame, 1, "delayed observation must advance one frame at a time");
}

// The real runner builds action columns from MOVESETS and always emits the new
// tactical/route telemetry fields, even when the legacy engine has no combos.
{
  const summary = runHeadlessTournament({
    matches: 1,
    agentA: "pressure",
    agentB: "zoner",
    templateA: "vanguard",
    templateB: "ember",
    difficulty: "hard",
    delay: 4,
    seed: 71,
    roundSeconds: 10,
    bestOf: 1,
    maxFramesPerMatch: 1800,
  });
  const expectedMoves = new Set(Object.values(MOVESETS).flatMap((moveset) => [
    ...Object.keys(moveset.moves ?? moveset).filter((key) => {
      const move = (moveset.moves ?? moveset)[key];
      return move && typeof move === "object" && Number.isFinite(move.startup);
    }),
    ...Object.entries(moveset)
      .filter(([, move]) => move && typeof move === "object" && Number.isFinite(move.startup))
      .map(([id]) => id),
  ]));
  assert.deepEqual(new Set(Object.keys(summary.actions.A)), expectedMoves, "headless actions must follow the live MOVESETS catalogue");
  for (const participant of ["A", "B"]) {
    const stats = summary.telemetry[participant];
    assert(stats.intents && Object.values(stats.intents).some((count) => count > 0), "headless must count tactical intents");
    for (const field of ["maxComboHits", "maxComboDamage", "tod", "supers", "odEx", "punishCounter", "whiffPunish", "baits"]) {
      assert(Number.isFinite(stats[field]) && stats[field] >= 0, `headless telemetry.${field} must be a non-negative number`);
    }
  }
}

process.stdout.write("v0.7 ai runtime ok · planner/executor + delayed reads + dynamic headless telemetry\n");
