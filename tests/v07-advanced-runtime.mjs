import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";

const step = (game, p1 = {}, p2 = {}) => stepGame(game, { p1, p2 });

function vanguardGame() {
  const game = createGame({
    bestOf: 1,
    players: [
      { templateId: "vanguard", startingSuperMeter: 300 },
      { templateId: "ember", startingSuperMeter: 0 },
    ],
  });
  game.fighters[0].x = 500;
  game.fighters[1].x = 560;
  return game;
}

function emberGame() {
  return createGame({
    bestOf: 1,
    players: [
      { templateId: "ember", startingSuperMeter: 500 },
      { templateId: "vanguard", startingSuperMeter: 0 },
    ],
  });
}

function qcbQcb(game, buttons = { hp: true }) {
  for (const input of [
    { down: true },
    { down: true, left: true },
    { left: true },
    { down: true },
    { down: true, left: true },
    { left: true },
    { left: true, ...buttons },
  ]) step(game, input);
}

function qcbHcf(game, buttons = { hp: true }) {
  for (const input of [
    { down: true },
    { down: true, left: true },
    { left: true },
    { down: true, left: true },
    { down: true },
    { down: true, right: true },
    { right: true },
    { right: true, ...buttons },
  ]) step(game, input);
}

function moveStarts(game, moveId) {
  return game.combatEvents.filter((event) => event.type === "moveStart" && (!moveId || event.moveId === moveId));
}

// SA2 starts one charge action, spends two stocks exactly once, and chooses
// the authored release row instead of resolving charged rows as separate moves.
{
  const level1 = vanguardGame();
  qcbQcb(level1, { lp: true });
  assert.equal(level1.fighters[0].currentMoveId, "superArt2Level1", "P alternatives must start SA2 charge");
  assert.equal(level1.fighters[0].superMeter, 100);
  step(level1);
  assert.equal(level1.fighters[0].currentMoveId, "superArt2Level1");
  assert.equal(level1.fighters[0].superMeter, 100, "tap release must not spend SA2 twice");

  const level2 = vanguardGame();
  qcbQcb(level2);
  const level2ChargeFrame = level2.combatEvents.find((event) => event.type === "chargeStart").frame;
  for (let index = 0; index < 10; index += 1) step(level2, { hp: true });
  const level2InvulnBeforeRelease = level2.fighters[0].invulnFrames;
  step(level2);
  assert.equal(level2.fighters[0].currentMoveId, "superArt2Level2");
  assert.equal(level2.fighters[0].superMeter, 100);
  assert.equal(moveStarts(level2).length, 1, "charge start and release must count as one super move");
  assert(
    level2.fighters[0].invulnFrames <= level2InvulnBeforeRelease,
    "releasing SA2 must not grant a second invulnerability window",
  );
  for (let index = 0; index < 30 && !level2.combatEvents.some((event) => event.type === "contact" && event.moveId === "superArt2Level2"); index += 1) step(level2);
  const level2Contact = level2.combatEvents.find((event) => event.type === "contact" && event.moveId === "superArt2Level2");
  assert(level2Contact, "Level 2 SA2 must reach its active frame");
  assert.equal(level2Contact.frame - level2ChargeFrame, 19, "Level 2 startup must be one continuous 20F timeline including charge");

  const level2Boundary = vanguardGame();
  qcbQcb(level2Boundary);
  for (let index = 0; index < 39; index += 1) step(level2Boundary, { hp: true });
  assert.equal(level2Boundary.fighters[0].currentMoveId, "superArt2Level1", "39 held frames must remain in the charge action");
  step(level2Boundary);
  assert.equal(level2Boundary.fighters[0].currentMoveId, "superArt2Level2", "exactly 39 held frames belong to Level 2");

  const level3 = vanguardGame();
  qcbQcb(level3);
  const level3ChargeFrame = level3.combatEvents.find((event) => event.type === "chargeStart").frame;
  for (let index = 0; index < 40; index += 1) step(level3, { hp: true });
  assert.equal(level3.fighters[0].currentMoveId, "superArt2Level3");
  assert.equal(level3.fighters[0].superMeter, 100);
  assert.equal(level3.combatEvents.filter((event) => event.type === "chargeRelease").at(-1)?.level, 3);
  assert.equal(level3.fighters[0].invulnFrames, 0, "a fully charged release must not restart expired invulnerability");
  for (let index = 0; index < 80 && !level3.combatEvents.some((event) => event.type === "contact" && event.moveId === "superArt2Level3"); index += 1) step(level3);
  const level3Contact = level3.combatEvents.find((event) => event.type === "contact" && event.moveId === "superArt2Level3");
  assert(level3Contact, "Level 3 SA2 must reach its active frame");
  assert.equal(level3Contact.frame - level3ChargeFrame, 69, "Level 3 startup must be one continuous 70F timeline including charge");

  const denjin = vanguardGame();
  denjin.fighters[0].denjinStock = 1;
  qcbQcb(denjin);
  for (let index = 0; index < 10; index += 1) step(denjin, { hp: true });
  step(denjin);
  assert.equal(denjin.fighters[0].currentMoveId, "superArt2Level2Denjin");
  assert.equal(denjin.fighters[0].denjinStock, 0, "Denjin stock must be consumed once at charge start");
  assert.equal(denjin.fighters[0].superMeter, 100);
}

// KOF-style held supers derive their damage tier from real held frames while
// charging and retain a single meter transaction.
{
  const game = emberGame();
  qcbHcf(game);
  for (let index = 0; index < 24; index += 1) step(game, { hp: true });
  assert.equal(game.fighters[0].movePhase, "charge");
  assert.equal(game.fighters[0].invulnFrames, 0, "full-body startup invulnerability must expire normally");
  assert(game.fighters[0].strikeInvulnFrames > 0, "authored upper-body charge invulnerability must remain active while held");
  for (let index = 24; index < 130 && game.fighters[0].currentMove; index += 1) step(game, { hp: true });
  const release = game.combatEvents.filter((event) => event.type === "chargeRelease").at(-1);
  assert(release, "held Orochinagi must emit a charge release");
  assert.equal(release.level, 4);
  assert.equal(release.damage, 270);
  assert.equal(game.fighters[0].superMeter, 400, "held super must spend one stock exactly once");
  assert.equal(moveStarts(game, "orochinagiHeavy").length, 1);
}

// Holding MP+MK and completing 66 cancels Parry into Drive Rush even though
// the chord has no second button edge.
{
  const game = createGame({
    bestOf: 1,
    players: [
      { templateId: "vanguard", startingSuperMeter: 300 },
      { templateId: "vanguard", startingSuperMeter: 0 },
    ],
  });
  step(game, { mp: true, mk: true });
  step(game, { right: true, mp: true, mk: true });
  step(game, { mp: true, mk: true });
  step(game, { right: true, mp: true, mk: true });
  assert.equal(game.fighters[0].currentMoveId, "parryDriveRush");
  assert.equal(moveStarts(game, "parryDriveRush").length, 1);
  assert(game.fighters[0].drive < 500 && game.fighters[0].drive > 490, "Parry drain plus one Drive Rush stock must be charged once");
}

// A reversal buffered during hitstop/blockstun must beat the neutral DI row
// and spend exactly two Drive stocks.
{
  const game = createGame({
    bestOf: 1,
    players: [
      { templateId: "vanguard", startingSuperMeter: 300 },
      { templateId: "vanguard", startingSuperMeter: 0 },
    ],
  });
  game.fighters[0].x = 580;
  game.fighters[1].x = 630;
  step(game, { lp: true }, { guard: true });
  for (let index = 0; index < 12 && game.fighters[1].action !== "block"; index += 1) {
    step(game, {}, { guard: true });
  }
  assert.equal(game.fighters[1].action, "block", "test setup must establish real blockstun first");
  for (let index = 0; index < 20 && game.fighters[1].currentMoveId !== "driveReversalBlock"; index += 1) {
    // P2 faces left, so world-left is the required relative 6 input.
    step(game, {}, { left: true, guard: true, system2: true });
  }
  assert.equal(game.fighters[1].currentMoveId, "driveReversalBlock");
  assert.equal(moveStarts(game, "driveReversalBlock").length, 1);
  assert.equal(game.fighters[1].drive, 382, "block Drive damage (18) plus one 200 Drive reversal cost must apply once");
}

process.stdout.write("v0.7 advanced runtime ok · charged supers + held-chord Drive Rush + contextual reversal\n");
