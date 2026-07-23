import assert from "node:assert/strict";

import {
  EMPTY_COMBAT_INPUT,
  normalizeCombatInput,
  pressedCombatButtons,
  relativeDirection,
} from "../src/input-schema.js";
import { matchMotion, recordDirection } from "../src/command-resolver.js";
import { defineMoveset, validateMoveset } from "../src/move-data.js";
import {
  initializeFighterResources,
  canAffordMove,
  spendMoveCost,
  gainSuperMeter,
} from "../src/resources.js";
import {
  initializeCombatState,
  beginActionCombatState,
  canHitInstance,
  registerHitInstance,
  beginOrExtendCombo,
  canJuggle,
  consumeJuggle,
} from "../src/combat-state.js";
import { createTacticalPlanner } from "../src/ai-planner.js";
import { createCommandExecutor, moveCommandFrames } from "../src/ai-executor.js";

const legacy = normalizeCombatInput({ light: true, heavy: true, special: true });
assert(legacy.lp && legacy.hp && legacy.throw, "legacy v0.6 controller aliases must remain valid");
const canonical = normalizeCombatInput({ lp: true, lk: true });
assert(canonical.throw, "LP+LK must form the canonical throw chord");
assert(!canonical.hp, "canonical buttons must not inherit legacy aliases");
assert.deepEqual(pressedCombatButtons({ mp: true }, EMPTY_COMBAT_INPUT), ["mp"]);
assert.equal(relativeDirection({ left: true, down: true }, -1), "downForward");

let history = [];
let frame = 1;
for (const direction of ["down", "downForward", "forward", "neutral", "down", "downForward", "forward"]) {
  recordDirection(history, direction, frame++);
}
assert(matchMotion(history, "qcf", frame), "QCF must be recognized");
assert(matchMotion(history, "qcfQcf", frame), "double QCF must be recognized for supers");

const sampleMoveset = defineMoveset({
  id: "sample",
  name: "Sample",
  moves: {
    jab: {
      name: "Jab",
      category: "normal",
      command: { buttons: ["lp"], label: "LP" },
      startup: 4,
      active: 3,
      recovery: 7,
      damage: 50,
      hitstun: 10,
      hitboxes: [{ start: 4, end: 6, offsetX: 40, offsetY: -70, width: 40, height: 20 }],
      cancels: { start: 4, end: 6, on: ["hit", "block"], into: ["special"] },
    },
    multi: {
      name: "Multi",
      category: "special",
      command: { motion: "qcf", buttons: ["hp"], label: "236HP" },
      startup: 5,
      active: 9,
      recovery: 20,
      damage: 80,
      activeWindows: [
        { id: "first", start: 5, end: 7 },
        { id: "second", start: 10, end: 13 },
      ],
      hits: [
        { id: "first", start: 5, end: 7, damage: 40 },
        { id: "second", start: 10, end: 13, damage: 40 },
      ],
    },
    ex: {
      name: "EX",
      category: "od",
      command: { motion: "qcf", buttons: ["lp", "mp"], chord: true, label: "236LP+MP" },
      startup: 4,
      active: 4,
      recovery: 18,
      damage: 120,
      resourceCost: { drive: 200 },
      tags: ["combo"],
    },
    super: {
      name: "Super",
      category: "super",
      command: { motion: "qcfQcf", buttons: ["hp"], label: "236236HP" },
      startup: 7,
      active: 5,
      recovery: 30,
      damage: 500,
      resourceCost: { super: 100 },
      tags: ["super", "combo"],
    },
  },
});
assert.deepEqual(validateMoveset(sampleMoveset), []);
assert.equal(sampleMoveset.moves.jab.totalFrames, 13);
assert.equal(sampleMoveset.moves.multi.activeFrameCount, 7);
assert.equal(sampleMoveset.moves.multi.active, 9, "active span must retain the authored gap");

const fighter = { id: 0, templateId: "vanguard" };
initializeFighterResources(fighter, "vanguard", { superMeter: 100 });
assert(canAffordMove(fighter, sampleMoveset.moves.super));
assert(spendMoveCost(fighter, sampleMoveset.moves.super));
assert.equal(fighter.superMeter, 0);
gainSuperMeter(fighter, 150);
assert.equal(fighter.superMeter, 150);

const attacker = { id: 0 };
const defender = { id: 1, onGround: true, action: "hit", hitstunFrames: 10 };
initializeCombatState(attacker);
initializeCombatState(defender);
beginActionCombatState(attacker);
assert(canHitInstance(attacker, defender, "first"));
registerHitInstance(attacker, defender, "first");
assert(!canHitInstance(attacker, defender, "first"));
assert(canHitInstance(attacker, defender, "second"), "separate hit IDs must permit real multi-hit moves");
const firstHit = beginOrExtendCombo(attacker, defender, sampleMoveset.moves.multi, { damage: 100 });
const secondHit = beginOrExtendCombo(attacker, defender, sampleMoveset.moves.multi, { damage: 100 });
assert.equal(firstHit.count, 1);
assert.equal(secondHit.count, 2);
assert(secondHit.damage < firstHit.damage, "combo damage scaling must reduce later hits");
defender.onGround = false;
assert(canJuggle(defender, { juggleCost: 3, juggleLimit: 5 }));
consumeJuggle(defender, { juggleCost: 3 });
assert(!canJuggle(defender, { juggleCost: 3, juggleLimit: 5 }));

const commandFrames = moveCommandFrames(sampleMoveset.moves.ex, 1);
assert(commandFrames.some((input) => input.lp && input.mp), "OD commands must press both buttons on one frame");
const executor = createCommandExecutor({ difficulty: "hard" });
const self = { x: 100, facing: 1 };
const opponent = { x: 300 };
const firstCommand = executor.start({ intent: "comboRoute", moveId: "ex" }, sampleMoveset.moves.ex, self, opponent);
assert(firstCommand.down, "QCF execution must begin from down");

const plannerFighter = {
  id: 0,
  x: 500,
  onGround: true,
  action: "idle",
  superMeter: 100,
  maxSuperMeter: 300,
  drive: 600,
  maxDrive: 600,
  guardGauge: 100,
  lastContact: { outcome: "hit", frame: 100 },
};
const plannerOpponent = { id: 1, x: 570, onGround: true, action: "hit" };
const planner = createTacticalPlanner({ difficulty: "hard", seed: 7 });
const planned = planner.plan(
  { frame: 104, arena: { width: 1280 }, fighters: [plannerFighter, plannerOpponent], combatEvents: [] },
  0,
  sampleMoveset,
);
assert(["comboRoute", "superConfirm"].includes(planned.intent), "a confirmed hit must lead to a real cancel route");

process.stdout.write("v0.7 systems ok · canonical input + commands + resources + combos + tactical plans\n");
