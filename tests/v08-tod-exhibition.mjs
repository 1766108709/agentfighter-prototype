import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";
import {
  createTodExhibitionDirector,
  evaluateTodExhibition,
  prepareTodExhibition,
} from "../src/tod-exhibition.js";

const NEUTRAL = Object.freeze({});

function makeShowcase(maxHealth = 1000) {
  const game = createGame({
    bestOf: 1,
    roundSeconds: 30,
    players: [
      { templateId: "ember", startingSuperMeter: 500 },
      { templateId: "ember", maxHealth },
    ],
  });
  prepareTodExhibition(game);
  return { game, director: createTodExhibitionDirector({ introFrames: 1 }) };
}

function runDirector(game, director, maximum = 480) {
  const observedYakumoCounts = [];
  for (let index = 0; index < maximum && game.phase === "fighting"; index += 1) {
    assert.match(String(director.status(game).label), /\S/, "every exhibition wait state must retain a HUD step label");
    stepGame(game, { p1: director.next(game), p2: NEUTRAL });
    const hits = Number(game.combos?.[0]?.hits ?? 0);
    if (hits >= 4 && hits <= 16 && observedYakumoCounts.at(-1) !== hits) observedYakumoCounts.push(hits);
  }
  return { ...director.status(game), observedYakumoCounts };
}

function damagingContacts(game) {
  return game.combatEvents.filter((event) =>
    event.type === "contact" && event.fighterId === 0 && Number(event.appliedDamage) > 0
  );
}

{
  const { game, director } = makeShowcase(1000);
  const state = runDirector(game, director);
  const proof = evaluateTodExhibition(game);
  const contacts = damagingContacts(game);
  const yakumo = contacts.filter((event) => event.moveId === "yakumo");

  assert.equal(game.phase, "matchOver");
  assert.equal(game.presentationMode, "tod-exhibition");
  assert.equal(game.fighters[1].health, 0);
  assert.equal(state.stage, "complete");
  assert.equal(state.success, true);
  assert.equal(proof.success, true);
  assert.equal(proof.legalResourceRoute, true);
  assert.equal(proof.authoredStarter, true);
  assert.equal(proof.hits, 16);
  assert.equal(proof.damage, 1000);
  assert.equal(contacts.length, 16);
  assert.equal(yakumo.length, 13);
  assert.deepEqual(state.observedYakumoCounts, Array.from({ length: 13 }, (_, index) => index + 4), "HUD-observable combo count must advance 4 through 16");
  assert.deepEqual(yakumo.map((event) => event.comboCount), Array.from({ length: 13 }, (_, index) => index + 4));
  assert.equal(new Set(yakumo.map((event) => event.frame)).size, 13, "all 13 cinematic contacts need distinct frames");
  assert(yakumo.slice(1).every((event, index) => event.frame > yakumo[index].frame), "cinematic frames must strictly increase");
  assert(yakumo.every((event, index) => index === 0 || event.healthBefore === yakumo[index - 1].healthAfter));
  assert(yakumo.every((event) => event.healthAfter < event.healthBefore));
  assert(yakumo.slice(0, -1).every((event) => event.healthAfter > 0), "only the terminal cinematic impact may KO");
  assert.equal(yakumo.at(-1).hitId, "scriptedHit13");
  assert.equal(yakumo.at(-1).healthAfter, 0);
  assert.equal(new Set(contacts.map((event) => event.comboId)).size, 1);
  assert(contacts.every((event) => event.damageSource === "standard" && event.forcedDamage === 0));
  assert.equal(contacts.reduce((sum, event) => sum + event.appliedDamage, 0), 1000);
  assert(contacts.slice(0, 3).every((event) => event.damageModifier === 1));
  assert(yakumo.every((event) => event.damageModifier === 2.125));
  assert.equal(proof.comboEnd.tod, true);
  assert.equal(proof.comboEnd.continuous, true);
  assert.equal(proof.comboEnd.startHealth, 1000);
  assert.equal(proof.comboEnd.endHealth, 0);
  assert.equal(proof.comboEnd.appliedDamage, 1000);
  assert.equal(proof.comboEnd.forcedDamage, 0);
  assert.equal(game.telemetry.tods[0], 1);
}

{
  const { game, director } = makeShowcase(1100);
  runDirector(game, director);
  const proof = evaluateTodExhibition(game);
  const contacts = damagingContacts(game);
  const yakumo = contacts.filter((event) => event.moveId === "yakumo");

  assert.equal(contacts.length, 16);
  assert.equal(yakumo.length, 13);
  assert.equal(new Set(yakumo.map((event) => event.frame)).size, 13);
  assert(yakumo.slice(1).every((event, index) => event.frame > yakumo[index].frame));
  assert.equal(contacts.reduce((sum, event) => sum + event.appliedDamage, 0), 1000);
  assert.equal(game.fighters[1].health, 100, "the fixed route must not adapt its damage to an 1100 HP target");
  assert.equal(proof.success, false);
  assert.equal(game.telemetry.tods[0], 0);
}

{
  const { game, director } = makeShowcase(1000);
  game.fighters[1].health = 900;
  runDirector(game, director);
  const proof = evaluateTodExhibition(game);

  assert.equal(game.fighters[1].health, 0);
  assert.equal(proof.success, false, "a 900/1000 HP starting state must never be presented as a TOD");
  assert.equal(proof.comboEnd?.tod, false);
  assert.equal(game.telemetry.tods[0], 0);
}

process.stdout.write("v0.8 TOD exhibition ok · 16-hit natural kill + 1100/900 HP controls\n");
