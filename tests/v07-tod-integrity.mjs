import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";
import { isNaturalTodEvidence, recordComboEnd } from "../src/telemetry.js";

const NEUTRAL = Object.freeze({});
const QCB_HCF = Object.freeze(["down", "downBack", "back", "downBack", "down", "downForward", "forward"]);

function relativeInput(facing, direction, buttons = {}) {
  const input = { ...buttons };
  const normalized = String(direction).toLowerCase();
  if (normalized.includes("down")) input.down = true;
  if (normalized.includes("up")) input.up = true;
  const forward = normalized.includes("forward");
  const back = normalized.includes("back");
  if (forward || back) {
    const worldSign = (forward ? 1 : -1) * facing;
    input[worldSign > 0 ? "right" : "left"] = true;
  }
  return input;
}

function frame(game, p1 = NEUTRAL, p2 = NEUTRAL) {
  stepGame(game, { p1, p2 });
  return game;
}

function waitFor(game, predicate, maximum = 360) {
  for (let index = 0; index < maximum; index += 1) {
    if (predicate()) return true;
    if (game.phase !== "fighting") return predicate();
    frame(game);
  }
  return predicate();
}

function tap(game, buttons, direction = "neutral") {
  frame(game, relativeInput(game.fighters[0].facing, direction, buttons));
}

function combatEvents(game, type, predicate = () => true) {
  return game.combatEvents.filter((event) => event.type === type && predicate(event));
}

function runFormerPrototypeRoute({ maxHealth, startHealth = maxHealth }) {
  const right = 1177;
  const game = createGame({
    bestOf: 1,
    roundSeconds: 60,
    players: [
      { templateId: "ember", startingSuperMeter: 500 },
      { templateId: "ember", maxHealth },
    ],
  });
  game.fighters[0].x = right - 65;
  game.fighters[0].prevX = right - 65;
  game.fighters[1].x = right;
  game.fighters[1].prevX = right;
  frame(game);
  game.fighters[1].health = startHealth;

  tap(game, { hp: true });
  assert(waitFor(game, () => combatEvents(game, "contact", (event) => event.moveId === "closeC" && event.appliedDamage > 0).length === 1));

  tap(game, { hk: true }, "downForward");
  assert(waitFor(game, () => combatEvents(game, "contact", (event) => event.moveId === "shiki88Canceled" && event.comboCount >= 3).length > 0));

  tap(game, { lk: true, hp: true }, "down");
  for (const direction of QCB_HCF.slice(1)) frame(game, relativeInput(game.fighters[0].facing, direction));
  frame(game);
  assert.equal(combatEvents(game, "moveStart", (event) => event.moveId === "quickMax").length, 1);

  tap(game, { hp: true, hk: true }, "forward");
  assert.equal(combatEvents(game, "moveStart", (event) => event.moveId === "yakumo").length, 1);
  assert(waitFor(
    game,
    () => combatEvents(game, "contact", (event) => event.moveId === "yakumo" && event.appliedDamage > 0).length === 13 || game.phase !== "fighting",
    300,
  ));
  return game;
}

const validEvidence = {
  comboId: "r1-c1-p0",
  continuous: true,
  count: 16,
  maxHealth: 1000,
  startHealth: 1000,
  endHealth: 0,
  appliedDamage: 1000,
  forcedDamage: 0,
};
assert.equal(isNaturalTodEvidence(validEvidence), true, "full-life natural damage in one combo is a TOD");
assert.equal(isNaturalTodEvidence({ ...validEvidence, maxHealth: 1100, startHealth: 1100, endHealth: 100 }), false, "1100 HP control must survive fixed 1000 damage");
assert.equal(isNaturalTodEvidence({ ...validEvidence, startHealth: 900, appliedDamage: 900 }), false, "900/1000 HP starter is not a TOD even if it KOs");
assert.equal(isNaturalTodEvidence({ ...validEvidence, forcedDamage: 1 }), false, "any forced damage invalidates TOD evidence");
assert.equal(isNaturalTodEvidence({ ...validEvidence, continuous: false }), false, "a broken route is not one continuous TOD combo");

{
  const game = createGame({ bestOf: 1, maxHealth: 1000 });
  game.fighters[1].health = 0;
  const event = recordComboEnd(game, 0, { ...validEvidence, damage: 1000 });
  assert.equal(event.tod, true);
  assert.equal(game.telemetry.tods[0], 1, "verified natural TOD must increment telemetry once");
}

{
  const game = createGame({ bestOf: 1, maxHealth: 1000 });
  game.fighters[1].health = 0;
  const event = recordComboEnd(game, 0, {
    ...validEvidence,
    startHealth: 900,
    appliedDamage: 900,
    damage: 5000,
    tod: true,
  });
  assert.equal(event.tod, false, "caller-supplied TOD and an inflated damage number must not bypass the verifier");
  assert.equal(game.telemetry.tods[0], 0);
}

{
  const game = runFormerPrototypeRoute({ maxHealth: 1100 });
  const contacts = combatEvents(game, "contact", (event) => event.fighterId === 0 && event.appliedDamage > 0);
  assert.equal(contacts.length, 16);
  assert.equal(game.fighters[1].health, 100, "1100 HP negative control must retain the route's natural 100 HP remainder");
  assert.equal(new Set(contacts.map((event) => event.comboId)).size, 1);
  for (const event of contacts) {
    for (const field of ["healthBefore", "healthAfter", "appliedDamage", "scaledDamage", "damageSource", "comboScale"]) {
      assert(Object.hasOwn(event, field), `contact telemetry must include ${field}`);
    }
    assert.equal(event.healthBefore - event.healthAfter, event.appliedDamage);
    assert(event.scaledDamage >= event.appliedDamage);
    assert.equal(event.damageSource, "standard");
    assert.equal(event.forcedDamage, 0);
  }
  assert.equal(
    contacts.reduce((total, event) => total + event.appliedDamage, 0),
    1100 - game.fighters[1].health,
  );
  assert.equal(combatEvents(game, "todConfirm").length, 0);
  assert.equal(combatEvents(game, "comboEnd", (event) => event.tod).length, 0);
}

{
  const game = runFormerPrototypeRoute({ maxHealth: 1000, startHealth: 900 });
  const contacts = combatEvents(game, "contact", (event) => event.fighterId === 0 && event.appliedDamage > 0);
  assert.equal(contacts[0].comboStartHealth, 900);
  assert(contacts.every((event) => event.comboId === contacts[0].comboId));
  waitFor(game, () => combatEvents(game, "comboEnd", (event) => event.fighterId === 0).length > 0, 480);
  const comboEnd = combatEvents(game, "comboEnd", (event) => event.fighterId === 0).at(-1);
  if (comboEnd) {
    assert.equal(comboEnd.startHealth, 900);
    assert.equal(comboEnd.tod, false, "a KO or combo from 900/1000 HP must remain a non-TOD");
  }
  assert.equal(game.telemetry.tods[0], 0);
}

process.stdout.write("v0.7 TOD integrity ok · natural full-life evidence + 1100/900 HP controls\n");
