import assert from "node:assert/strict";

import {
  EMPTY_COMBAT_INPUT,
  directionMatches,
  inputAlternativeButtons,
  isAirStance,
  normalizeCombatInput,
  normalizeCombatStance,
  relativeDirection,
} from "../src/input-schema.js";
import {
  commandMatches,
  commandInputCandidates,
  hasCommandInput,
  matchCommandInput,
  matchMotion,
  recordDirection,
} from "../src/command-resolver.js";
import { VANGUARD_MOVESET } from "../src/movesets/vanguard.js";
import { createGame, stepGame } from "../src/engine.js";

function historyOf(directions, firstFrame = 1) {
  const history = [];
  directions.forEach((direction, index) => {
    recordDirection(history, direction, firstFrame + index);
  });
  return history;
}

// Existing input and motion APIs remain valid.
const legacy = normalizeCombatInput({ light: true, heavy: true, special: true });
assert(legacy.lp && legacy.hp && legacy.throw);
assert.equal(relativeDirection({ left: true, down: true }, -1), "downForward");
assert(matchMotion(historyOf(["down", "downForward", "forward"]), "qcf", 3));

// Authored `down` includes either lower diagonal for crouch normals and lenient
// motion steps, while other cardinal requirements remain exact.
assert(directionMatches("downBack", "down"));
assert(directionMatches("downForward", "down"));
assert(!directionMatches("upBack", "down"));
assert(!directionMatches("downForward", "forward"));
assert(matchMotion(historyOf(["downBack", "forward"], 10), "qcf", 11));
const repeatedQcf = historyOf([
  "down", "forward", "neutral", "down", "downForward", "forward",
], 100);
assert.equal(matchMotion(repeatedQcf, "qcf", 105).completedFrame, 105,
  "a fresh motion must win over an older still-buffered motion");

const crouchCommand = { buttons: ["lp"], direction: "down", label: "2LP" };
assert(matchCommandInput(crouchCommand, {
  input: { left: true, down: true, lp: true },
  previousInput: { left: true, down: true },
  facing: 1,
  frame: 20,
  stance: "crouch",
}), "down-back must activate a command authored as down");
assert(matchCommandInput(crouchCommand, {
  input: { right: true, down: true, lp: true },
  previousInput: { right: true, down: true },
  facing: 1,
  frame: 21,
  stance: "crouch",
}), "down-forward must activate a command authored as down");
for (const horizontal of ["left", "right"]) {
  const crouchIntegrationGame = createGame({
    roundTimeSeconds: 10,
    playerTemplate: "vanguard",
    aiTemplate: "ember",
  });
  stepGame(crouchIntegrationGame, {
    p1: { down: true, [horizontal]: true, lp: true },
    p2: {},
  });
  assert.equal(crouchIntegrationGame.fighters[0].currentMove?.id, "crouchLightPunch",
    `engine integration must treat down+${horizontal} as down for crouch commands`);
}

// Air legality is fighter state, not whether Up happens to be held this frame.
assert(isAirStance("jump"));
assert(isAirStance({ onGround: false, jumpType: "hop" }));
assert.equal(normalizeCombatStance({ onGround: true, action: "crouch" }), "crouch");

const airNormal = {
  id: "jumpHeavy",
  stance: "air",
  command: { buttons: ["hk"], air: true, label: "j.HK" },
};
assert(matchCommandInput(airNormal, {
  input: { up: true, right: true, hk: true },
  previousInput: { up: true, right: true },
  facing: 1,
  frame: 30,
  stance: "jump",
}), "an up-forward jump must accept an air normal");
assert(matchCommandInput(airNormal, {
  input: { right: true, hk: true },
  previousInput: { right: true },
  facing: 1,
  frame: 31,
  fighter: { onGround: false, jumpType: "normal", action: "jump" },
}), "an airborne fighter must retain air inputs after releasing Up");
assert.equal(matchCommandInput(airNormal, {
  input: { up: true, right: true, hk: true },
  previousInput: { up: true, right: true },
  facing: 1,
  frame: 32,
  stance: "ground",
}), null, "holding Up must not make a grounded fighter pass an air command");
assert.equal(matchCommandInput(airNormal, {
  input: { hk: true },
  previousInput: EMPTY_COMBAT_INPUT,
  frame: 32,
}), null, "air commands require explicit fighter/stance state instead of inferring from buttons");

const authoredJumpHeavy = VANGUARD_MOVESET.moves.jumpHeavyPunch;
const diagonalJumpHeavy = matchCommandInput(authoredJumpHeavy, {
  input: { up: true, right: true, hp: true },
  previousInput: { up: true, right: true },
  facing: 1,
  frame: 32,
  fighter: { onGround: false, jumpType: "normal", action: "jump" },
});
assert(diagonalJumpHeavy, "authored direction:up is notation and must accept up-forward in air stance");
assert.equal(diagonalJumpHeavy.ignoredAirDirectionNotation, true);
assert(matchCommandInput(authoredJumpHeavy, {
  input: { right: true, hp: true },
  previousInput: { right: true },
  facing: 1,
  frame: 33,
  fighter: { onGround: false, jumpType: "normal", action: "jump" },
}), "authored direction:up must not require Up after the fighter is airborne");
assert.equal(matchCommandInput(authoredJumpHeavy, {
  input: { up: true, hp: true },
  previousInput: { up: true },
  facing: 1,
  frame: 34,
  fighter: { onGround: true, action: "idle" },
}), null, "Up input alone must not make a grounded fighter legal for an air move");
const airIntegrationGame = createGame({
  roundTimeSeconds: 10,
  playerTemplate: "vanguard",
  aiTemplate: "ember",
});
stepGame(airIntegrationGame, { p1: { up: true, right: true }, p2: {} });
assert.equal(airIntegrationGame.fighters[0].onGround, false);
stepGame(airIntegrationGame, { p1: { right: true, hp: true }, p2: {} });
assert.equal(airIntegrationGame.fighters[0].currentMove?.id, "jumpHeavyPunch",
  "engine integration must resolve an air normal after Up is released");

const jumpOnly = {
  stance: "air",
  command: { buttons: ["hp"], air: true, stance: "jump", label: "j.HP" },
};
assert.equal(matchCommandInput(jumpOnly, {
  input: { hp: true },
  previousInput: EMPTY_COMBAT_INPUT,
  frame: 33,
  stance: "hop",
  jumpType: "hop",
}), null, "jump-only data must remain distinct from hop data when jumpType is known");

// Top-level move.inputAlternatives are canonicalized and matched as real button
// candidates, not treated as display-only labels.
assert.deepEqual(inputAlternativeButtons("236LP+HP"), ["lp", "hp"]);
const odMove = {
  id: "hadokenOD",
  stance: "ground",
  command: { motion: "qcf", buttons: ["lp", "mp"], chord: true, label: "236PP" },
  inputAlternatives: ["LP+MP", "LP+HP", "MP+HP"],
};
const qcfHistory = historyOf(["down", "downForward", "forward"], 40);
const alternativeMatch = matchCommandInput(odMove, {
  input: { right: true, lp: true, hp: true },
  previousInput: { right: true },
  facing: 1,
  frame: 42,
  stance: "ground",
  directionHistory: qcfHistory,
});
assert(alternativeMatch);
assert.deepEqual(alternativeMatch.matchedButtons, ["lp", "hp"]);
assert.equal(alternativeMatch.inputAlternative, "LP+HP");
assert.equal(alternativeMatch.usedHeldChord, false);
assert(commandInputCandidates(odMove).some((candidate) =>
  candidate.buttons.join("+") === "mp+hp"));
assert(commandInputCandidates(VANGUARD_MOVESET.moves.hadokenOD).every(
  (candidate) => candidate.buttons.length === 2,
), "OD alternatives must retain their real two-button chords");
const legacyLightQcf = {
  input: { right: true, light: true },
  previousInput: { right: true },
  facing: 1,
  frame: 42,
  fighter: { onGround: true, action: "idle" },
  directionHistory: qcfHistory,
};
assert.equal(matchCommandInput(VANGUARD_MOVESET.moves.hadokenOD, legacyLightQcf), null,
  "legacy light:true must never expand into an OD two-punch chord");
assert(matchCommandInput(VANGUARD_MOVESET.moves.hadokenLight, legacyLightQcf),
  "legacy light:true must still retain its single-button Hadoken compatibility");
const compatibleChordFacade = { right: true, light: true };
Object.defineProperties(compatibleChordFacade, {
  lp: { value: true, enumerable: false },
  mp: { value: true, enumerable: false },
});
assert(!Object.keys(compatibleChordFacade).includes("mp"));
assert(matchCommandInput(VANGUARD_MOVESET.moves.hadokenOD, {
  ...legacyLightQcf,
  input: compatibleChordFacade,
}), "AI's hidden canonical LP+MP descriptors must remain a deliberate OD chord");
const alternativeIntegrationGame = createGame({
  roundTimeSeconds: 10,
  playerTemplate: "vanguard",
  aiTemplate: "ember",
});
for (const p1 of [
  { down: true },
  { down: true, right: true },
  { right: true, lp: true, hp: true },
]) {
  stepGame(alternativeIntegrationGame, { p1, p2: {} });
}
assert.equal(alternativeIntegrationGame.fighters[0].currentMove?.id, "hadokenOD",
  "engine integration must accept LP+HP as the authored OD alternative");

const authoredAirAlternative = matchCommandInput(VANGUARD_MOVESET.moves.airTatsuOD, {
  input: { left: true, lk: true, hk: true },
  previousInput: { left: true },
  facing: 1,
  frame: 64,
  fighter: { onGround: false, jumpType: "normal", action: "jump" },
  directionHistory: historyOf(["down", "downBack", "back"], 62),
});
assert(authoredAirAlternative, "real roster air+alternative data must resolve after Up is released");
assert.equal(authoredAirAlternative.inputAlternative, "LK+HK");

const kickSuper = {
  command: { motion: "qcfQcf", buttons: ["hk"], label: "236236K" },
  inputAlternatives: ["236236LK", "236236MK", "236236HK"],
};
const doubleQcf = historyOf([
  "down", "downForward", "forward", "down", "downForward", "forward",
], 50);
assert(hasCommandInput(kickSuper, {
  input: { right: true, mk: true },
  previousInput: { right: true },
  frame: 55,
  stance: "ground",
  directionHistory: doubleQcf,
}), "single-button strength alternatives must resolve too");

// Drive Rush: MP+MK may already be held; completing only 66 is the activation
// edge. Existing roster data is recognized without requiring a moveset edit.
const driveRush = {
  id: "parryDriveRush",
  command: {
    motion: "forwardForward",
    buttons: ["mp", "mk"],
    chord: true,
    label: "MP+MK~66",
  },
};
const dashHistory = historyOf(["forward", "neutral", "forward"], 70);
const heldRush = matchCommandInput(driveRush, {
  input: { right: true, mp: true, mk: true },
  previousInput: { mp: true, mk: true },
  facing: 1,
  frame: 72,
  stance: "ground",
  directionHistory: dashHistory,
  directionChanged: true,
});
assert(heldRush, "held MP+MK followed only by 66 must resolve Drive Rush");
assert.equal(heldRush.usedHeldChord, true);
assert.equal(heldRush.activation, "heldChordMotion");
assert.equal(heldRush.motionMatch.completedFrame, 72);
assert(matchCommandInput(VANGUARD_MOVESET.moves.parryDriveRush, {
  input: { right: true, mp: true, mk: true },
  previousInput: { mp: true, mk: true },
  facing: 1,
  frame: 72,
  fighter: { onGround: true, action: "idle" },
  directionHistory: dashHistory,
  directionChanged: true,
}), "the normalized roster Drive Rush must expose the same held-chord behavior");
assert(commandMatches(
  {
    onGround: true,
    action: "idle",
    facing: 1,
    previousInput: { mp: true, mk: true },
    directionHistory: dashHistory,
  },
  { right: true, mp: true, mk: true },
  [],
  VANGUARD_MOVESET.moves.parryDriveRush,
  72,
  true,
), "the exported adapter must accept the engine's existing local matcher signature");
const rushIntegrationGame = createGame({
  roundTimeSeconds: 10,
  playerTemplate: "vanguard",
  aiTemplate: "ember",
});
for (const p1 of [
  { mp: true, mk: true },
  { mp: true, mk: true, right: true },
  { mp: true, mk: true },
  { mp: true, mk: true, right: true },
]) {
  stepGame(rushIntegrationGame, { p1, p2: {} });
}
assert.equal(rushIntegrationGame.fighters[0].currentMove?.id, "parryDriveRush",
  "engine integration must activate Drive Rush from held MP+MK followed only by 66");

// Held chords remain opt-in outside canonical MP+MK + 66. `heldChord: true` is
// the field for future authored commands that intentionally use the same rule.
const heldExContext = {
  input: { right: true, lp: true, mp: true },
  previousInput: { lp: true, mp: true },
  facing: 1,
  frame: 82,
  stance: "ground",
  directionHistory: historyOf(["down", "downForward", "forward"], 80),
  directionChanged: true,
};
assert.equal(matchCommandInput({
  motion: "qcf",
  buttons: ["lp", "mp"],
  chord: true,
}, heldExContext), null);
assert(matchCommandInput({
  motion: "qcf",
  buttons: ["lp", "mp"],
  chord: true,
  heldChord: true,
}, heldExContext));
assert(matchCommandInput({
  heldChord: true,
  command: {
    motion: "qcf",
    buttons: ["lp", "mp"],
    chord: true,
  },
}, heldExContext), "top-level move.heldChord must survive normalized move-data spreading");

console.log("v0.7 input resolution ok · diagonal down · stance air · alternatives · held-chord 66");
