import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";
import {
  createTodExhibitionDirector,
  evaluateTodExhibition,
  prepareTodExhibition,
} from "../src/tod-exhibition.js";

const NEUTRAL = Object.freeze({});

const MOTION_DIRECTIONS = Object.freeze({
  qcf: ["down", "downForward", "forward"],
  qcb: ["down", "downBack", "back"],
  dp: ["forward", "down", "downForward"],
  qcbHcf: ["down", "downBack", "back", "downBack", "down", "downForward", "forward"],
});

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

function motion(game, name, buttons) {
  const facing = game.fighters[0].facing;
  for (const [index, direction] of MOTION_DIRECTIONS[name].entries()) {
    const finalButtons = index === MOTION_DIRECTIONS[name].length - 1 ? buttons : NEUTRAL;
    frame(game, relativeInput(facing, direction, finalButtons));
  }
}

function waitFor(game, predicate, maximum = 300, p2 = NEUTRAL) {
  for (let index = 0; index < maximum && game.phase === "fighting"; index += 1) {
    if (predicate()) return true;
    frame(game, NEUTRAL, p2);
  }
  return predicate();
}

function makeDuel({ meter = 0, maxHealth = 1000, p1x = 500, p2x = 560 } = {}) {
  const game = createGame({
    bestOf: 1,
    roundSeconds: 60,
    players: [
      { templateId: "vanguard", startingSuperMeter: meter },
      { templateId: "vanguard", maxHealth },
    ],
  });
  Object.assign(game.fighters[0], { x: p1x, prevX: p1x, facing: 1 });
  Object.assign(game.fighters[1], { x: p2x, prevX: p2x, facing: -1 });
  frame(game);
  return game;
}

function events(game, type, predicate = () => true) {
  return game.combatEvents.filter((event) => event.type === type && predicate(event));
}

// 苍流轻升龙保留可受身的普通击倒。
{
  const game = makeDuel();
  motion(game, "dp", { lp: true });
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "shoryukenLight").length > 0));
  assert(waitFor(game, () => events(game, "knockdown").length > 0, 180, { lp: true }));
  const knockdown = events(game, "knockdown").at(-1);
  assert.equal(knockdown.knockdownType, "soft");
  assert.equal(knockdown.wakeup, "quickRise");
}

// OD旋风腿与重斧踢分别覆盖多段命中和真实地面反弹。
{
  const multi = makeDuel();
  motion(multi, "qcb", { lk: true, mk: true });
  assert(waitFor(
    multi,
    () => events(multi, "contact", (event) => event.moveId === "tatsuOD" && event.appliedDamage > 0).length >= 3,
  ));
  const contacts = events(multi, "contact", (event) => event.moveId === "tatsuOD" && event.appliedDamage > 0);
  assert.deepEqual(contacts.map((event) => event.comboCount), [1, 2, 3]);
  assert.equal(new Set(contacts.map((event) => event.hitId)).size, 3);

  const bounce = makeDuel({ p1x: 500, p2x: 550 });
  frame(bounce, relativeInput(bounce.fighters[0].facing, "back", { hk: true }));
  assert(waitFor(bounce, () => bounce.effects.some((effect) => effect.type === "groundBounce"), 240));
  assert.equal(bounce.fighters[1].groundBouncesRemaining, 0);
  assert.equal(bounce.fighters[1].onGround, false);
}

// OD上段足在角落产生物理墙反弹。
{
  const game = makeDuel({ p1x: 1105, p2x: 1177 });
  motion(game, "qcf", { lk: true, mk: true });
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "highBladeOD").length > 0));
  assert(waitFor(game, () => game.effects.some((effect) => effect.type === "wallBounce")));
  assert.equal(game.fighters[1].wallBouncesRemaining, 0);
  assert.equal(game.fighters[1].onGround, false);
}

// 苍流奥义的十三次冲击必须逐帧结算，并以不可受身硬倒地收尾。
{
  const game = makeDuel({ meter: 300, maxHealth: 2000 });
  game.fighters[0].maxModeFrames = 600;
  motion(game, "qcbHcf", { hp: true, hk: true });
  assert(waitFor(
    game,
    () => events(game, "contact", (event) => event.moveId === "yakumo" && event.appliedDamage > 0).length === 13,
    240,
  ));
  const contacts = events(game, "contact", (event) => event.moveId === "yakumo" && event.appliedDamage > 0);
  assert.equal(new Set(contacts.map((event) => event.frame)).size, 13);
  assert(contacts.slice(1).every((event, index) => event.frame > contacts[index].frame));
  assert.equal(contacts.at(-1).hitId, "scriptedHit13");
  assert(waitFor(game, () => events(game, "knockdown").length > 0));
  assert.equal(events(game, "knockdown").at(-1).knockdownType, "hard");
  assert.equal(events(game, "knockdown").at(-1).wakeup, "hardRise");
}

// 唯一角色的四步满资源路线必须通过自然十割验真。
{
  const game = prepareTodExhibition(createGame({
    bestOf: 1,
    players: [
      { templateId: "vanguard", startingSuperMeter: 300 },
      { templateId: "vanguard", maxHealth: 1000 },
    ],
  }));
  const director = createTodExhibitionDirector({ introFrames: 1 });
  for (let index = 0; index < 480 && game.phase === "fighting"; index += 1) {
    frame(game, director.next(game));
  }
  const proof = evaluateTodExhibition(game);
  assert.equal(proof.success, true);
  assert.equal(proof.hits, 16);
  assert.equal(proof.damage, 1000);
  assert.equal(game.telemetry.tods[0], 1);
}

process.stdout.write("v0.7 苍流 combat runtime ok · KD + multi-hit + bounce + 16-hit natural TOD\n");
