import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";

const step = (game, p1 = {}, p2 = {}) => stepGame(game, { p1, p2 });
const starts = (game, moveId) => game.combatEvents.filter(
  (event) => event.type === "moveStart" && event.moveId === moveId,
);
const contacts = (game, moveId) => game.combatEvents.filter(
  (event) => event.type === "contact" && event.fighterId === 0 && event.moveId === moveId &&
    ["hit", "block", "counter", "punishCounter"].includes(event.outcome),
);

function vanguardMirror(distance = 55) {
  const game = createGame({
    bestOf: 1,
    players: [{ templateId: "vanguard" }, { templateId: "vanguard" }],
  });
  game.fighters[0].x = 500;
  game.fighters[1].x = 500 + distance;
  game.fighters[0].facing = 1;
  game.fighters[1].facing = -1;
  return game;
}

function forwardInput(fighter) {
  return fighter.facing > 0 ? { right: true } : { left: true };
}

function blockedP1() {
  const game = vanguardMirror();
  game.fighters[0].x = 555;
  game.fighters[1].x = 500;
  game.fighters[0].facing = -1;
  game.fighters[1].facing = 1;
  step(game, { guard: true }, { lp: true });
  for (let index = 0; index < 30 && (game.fighters[0].action !== "block" || game.hitstopFrames > 0); index += 1) {
    step(game, { guard: true });
  }
  assert.equal(game.fighters[0].action, "block");
  assert(game.fighters[0].blockstunFrames > 0);
  return game;
}

// 6+HP+HK is mandatory, and the buffered reversal executes on block recovery.
{
  const withoutForward = blockedP1();
  const recovery = withoutForward.fighters[0].blockstunFrames;
  for (let frame = 0; frame < recovery; frame += 1) {
    step(withoutForward, { guard: true, hp: true, hk: true });
  }
  assert.equal(starts(withoutForward, "driveReversalBlock").length, 0);

  const withForward = blockedP1();
  const defender = withForward.fighters[0];
  const remaining = defender.blockstunFrames;
  const input = { guard: true, hp: true, hk: true, ...forwardInput(defender) };
  for (let frame = 1; frame < remaining; frame += 1) {
    step(withForward, input);
    assert.notEqual(defender.currentMoveId, "driveReversalBlock", "reversal must not erase remaining blockstun");
  }
  step(withForward, input);
  assert.equal(defender.blockstunFrames, 0);
  assert.equal(defender.currentMoveId, "driveReversalBlock");
  assert.equal(starts(withForward, "driveReversalBlock").length, 1);
}

function knockedDownP1() {
  const game = vanguardMirror();
  game.fighters[0].x = 555;
  game.fighters[1].x = 500;
  game.fighters[0].facing = -1;
  game.fighters[1].facing = 1;
  step(game, {}, { down: true, hk: true });
  for (let index = 0; index < 100 && game.fighters[0].action !== "knockdown"; index += 1) step(game);
  assert.equal(game.fighters[0].action, "knockdown");
  while (game.fighters[0].knockdownFrames > 6) step(game);
  return game;
}

// Wakeup input is buffered during the final six frames but starts only at 0F.
{
  const withoutForward = knockedDownP1();
  for (let frame = 0; frame < 6; frame += 1) step(withoutForward, { hp: true, hk: true });
  assert.equal(starts(withoutForward, "driveReversalWakeup").length, 0);

  const withForward = knockedDownP1();
  const fighter = withForward.fighters[0];
  const input = { hp: true, hk: true, ...forwardInput(fighter) };
  for (let frame = 1; frame < 6; frame += 1) {
    step(withForward, input);
    assert.notEqual(fighter.currentMoveId, "driveReversalWakeup", "wakeup reversal must not shorten knockdown");
  }
  step(withForward, input);
  assert.equal(fighter.knockdownFrames, 0);
  assert.equal(fighter.currentMoveId, "driveReversalWakeup");
}

function waitForContact(game, moveId, previousCount, guard) {
  for (let index = 0; index < 40 && contacts(game, moveId).length === previousCount; index += 1) {
    step(game, {}, guard ? { guard: true } : {});
  }
  assert.equal(contacts(game, moveId).length, previousCount + 1, `${moveId} must make real contact`);
  return guard ? game.fighters[1].blockstunFrames : game.fighters[1].hitstunFrames;
}

function rawJabStun(guard) {
  const game = vanguardMirror();
  step(game, { lp: true }, guard ? { guard: true } : {});
  return waitForContact(game, "standLightPunch", 0, guard);
}

function parryRushJabStun(guard) {
  const game = vanguardMirror(155);
  const defense = guard ? { guard: true } : {};
  for (const input of [
    { mp: true, mk: true },
    { right: true, mp: true, mk: true },
    { mp: true, mk: true },
    { right: true, mp: true, mk: true },
  ]) step(game, input, defense);
  assert.equal(game.fighters[0].currentMoveId, "parryDriveRush");
  while (game.fighters[0].actionFrame + 1 < 8) step(game, {}, defense);
  step(game, { lp: true }, defense);
  assert.equal(game.fighters[0].currentMoveId, "standLightPunch");
  return waitForContact(game, "standLightPunch", 0, guard);
}

function cancelRushJabStun(guard) {
  const game = vanguardMirror();
  const defense = guard ? { guard: true } : {};
  step(game, { mp: true }, defense);
  waitForContact(game, "standMediumPunch", 0, guard);
  while (game.hitstopFrames > 0) step(game, {}, defense);
  for (const input of [
    { right: true, mp: true, mk: true },
    { mp: true, mk: true },
    { right: true, mp: true, mk: true },
  ]) step(game, input, defense);
  assert.equal(game.fighters[0].currentMoveId, "cancelDriveRush");
  while (game.fighters[0].actionFrame + 1 < 9) step(game, {}, defense);
  const previousJabs = contacts(game, "standLightPunch").length;
  step(game, { lp: true }, defense);
  assert.equal(game.fighters[0].currentMoveId, "standLightPunch");
  return waitForContact(game, "standLightPunch", previousJabs, guard);
}

for (const guard of [false, true]) {
  const baseline = rawJabStun(guard);
  assert.equal(parryRushJabStun(guard), baseline + 4, `Parry Drive Rush must add +4 on ${guard ? "block" : "hit"}`);
  assert.equal(cancelRushJabStun(guard), baseline + 4, `Cancel Drive Rush must add +4 on ${guard ? "block" : "hit"}`);
}

process.stdout.write("v0.7 drive runtime ok · 6+reversal window · wakeup timing · Drive Rush +4\n");
