import assert from "node:assert/strict";

import { createGame, stepGame } from "../src/engine.js";

const NEUTRAL = Object.freeze({});

function relativeInput(facing, direction, buttons = {}) {
  const input = { ...buttons };
  const normalizedDirection = direction.toLowerCase();
  if (normalizedDirection.includes("down")) input.down = true;
  if (normalizedDirection.includes("up")) input.up = true;
  const forward = normalizedDirection.includes("forward");
  const back = normalizedDirection.includes("back");
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

function idle(game, count, p1 = NEUTRAL, p2 = NEUTRAL) {
  for (let index = 0; index < count && game.phase === "fighting"; index += 1) frame(game, p1, p2);
}

function fighterInput(game, fighterId, input, opponentInput = NEUTRAL) {
  return fighterId === 0
    ? frame(game, input, opponentInput)
    : frame(game, opponentInput, input);
}

function tap(game, fighterId, buttons, direction = "neutral", opponentInput = NEUTRAL) {
  const fighter = game.fighters[fighterId];
  fighterInput(game, fighterId, relativeInput(fighter.facing, direction, buttons), opponentInput);
}

const MOTION_DIRECTIONS = Object.freeze({
  qcf: ["down", "downForward", "forward"],
  qcb: ["down", "downBack", "back"],
  dp: ["forward", "down", "downForward"],
  rdp: ["back", "down", "downBack"],
  hcb: ["forward", "downForward", "down", "downBack", "back"],
  qcfQcf: ["down", "downForward", "forward", "down", "downForward", "forward"],
  qcbHcf: ["down", "downBack", "back", "downBack", "down", "downForward", "forward"],
});

function motion(game, fighterId, name, buttons, opponentInput = NEUTRAL) {
  const directions = MOTION_DIRECTIONS[name];
  assert(directions, `unknown test motion ${name}`);
  const facing = game.fighters[fighterId].facing;
  directions.forEach((direction, index) => {
    const finalButtons = index === directions.length - 1 ? buttons : NEUTRAL;
    fighterInput(game, fighterId, relativeInput(facing, direction, finalButtons), opponentInput);
  });
}

function makeDuel({ meter = 0, p1x = 500, p2x = 560 } = {}) {
  const game = createGame({
    bestOf: 1,
    roundSeconds: 60,
    players: [
      { templateId: "ember", startingSuperMeter: meter },
      { templateId: "ember", startingSuperMeter: 0 },
    ],
  });
  game.fighters[0].x = p1x;
  game.fighters[0].prevX = p1x;
  game.fighters[1].x = p2x;
  game.fighters[1].prevX = p2x;
  frame(game);
  return game;
}

function events(game, type, predicate = () => true) {
  return game.combatEvents.filter((event) => event.type === type && predicate(event));
}

function waitFor(game, predicate, { maximum = 240, p1 = NEUTRAL, p2 = NEUTRAL } = {}) {
  for (let index = 0; index < maximum && game.phase === "fighting"; index += 1) {
    if (predicate()) return true;
    frame(game, p1, p2);
  }
  return predicate();
}

function assertHardTerminalRise(game, label) {
  const knockdownCount = events(game, "knockdown").length;
  assert(
    waitFor(game, () => events(game, "knockdown").length > knockdownCount, { maximum: 300, p2: { lp: true } }),
    `${label} must eventually enter knockdown through stepGame`,
  );
  const knockdown = events(game, "knockdown").at(-1);
  assert.equal(knockdown.knockdownType, "hard", `${label} must restore its terminal hard knockdown`);
  assert.equal(knockdown.wakeup, "hardRise", `${label} must reject the held LP quick-rise attempt`);
  assert(knockdown.duration > 16, `${label} must not inherit quick-rise duration`);

  const wakeupCount = events(game, "wakeupAction").length;
  assert(
    waitFor(game, () => events(game, "wakeupAction").length > wakeupCount, { maximum: 120, p2: { lp: true } }),
    `${label} hard rise must complete through stepGame`,
  );
  assert.equal(events(game, "wakeupAction").at(-1).option, "hardRise", `${label} must remain non-techable through wakeup`);
}

// Soft knockdowns accept a real quick-rise input; hard knockdowns ignore it.
{
  const soft = makeDuel();
  motion(soft, 0, "dp", { lp: true });
  assert(waitFor(soft, () => soft.fighters[1].action === "hit"), "623A must connect before testing wakeup input");
  assert(
    waitFor(soft, () => events(soft, "knockdown").length > 0, { p2: { lp: true } }),
    `soft KD must reach wakeup selection: ${JSON.stringify({ frame: soft.frame, fighter: soft.fighters[1], events: soft.combatEvents.slice(-12) })}`,
  );
  const softKd = events(soft, "knockdown").at(-1);
  assert.equal(softKd.knockdownType, "soft");
  assert.equal(softKd.wakeup, "quickRise");
  assert(softKd.duration <= 16, `quick rise must shorten soft KD, got ${softKd.duration}F`);
  assert(waitFor(soft, () => events(soft, "wakeupAction").length > 0, { p2: { lp: true } }), "quick rise must complete through stepGame");
  assert.equal(events(soft, "wakeupAction").at(-1).option, "quickRise");

  const hard = makeDuel();
  tap(hard, 0, { hp: true }, "forward");
  assert(waitFor(hard, () => hard.fighters[1].action === "hit"), "close throw must connect before testing hard KD");
  assert(waitFor(hard, () => events(hard, "knockdown").length > 0, { p2: { lp: true } }), "hard KD must reach wakeup selection");
  const hardKd = events(hard, "knockdown").at(-1);
  assert.equal(hardKd.knockdownType, "hard");
  assert.equal(hardKd.wakeup, "hardRise");
  assert(hardKd.duration > softKd.duration, "hard KD must not inherit the quick-rise duration");
  assert(waitFor(hard, () => events(hard, "wakeupAction").length > 0, { p2: { lp: true } }), "hard rise must complete through stepGame");
  assert.equal(events(hard, "wakeupAction").at(-1).option, "hardRise");
}

// A single real 3D input has two independent hit IDs. Neither contact may be
// deduped, and a preceding c.C must apply the engine's move-to-move proration.
{
  const standalone = makeDuel({ p1x: 500, p2x: 552 });
  tap(standalone, 0, { hk: true }, "downForward");
  assert(waitFor(standalone, () => events(standalone, "contact", (event) => event.moveId === "shiki88" && event.damage > 0).length >= 2), "3D must deliver both authored contacts");
  const standaloneHits = events(standalone, "contact", (event) => event.moveId === "shiki88" && event.damage > 0);
  assert.deepEqual(standaloneHits.map((event) => event.comboCount), [1, 2]);
  assert(standaloneHits.every((event) => event.damage > 0), "both independent hit IDs must deal damage");
  const registeredHitIds = Object.keys(standalone.fighters[0].hitRegistry).map((key) => key.split(":").at(-1));
  assert(registeredHitIds.includes("low") && registeredHitIds.includes("mid"), "3D must register its low/mid hit IDs independently");
  assert.equal(standalone.combos[0].hits, 2);
  assert.equal(standalone.combos[0].damage, standaloneHits.reduce((sum, event) => sum + event.damage, 0));

  const scaled = makeDuel({ p1x: 500, p2x: 552 });
  tap(scaled, 0, { hp: true });
  assert(waitFor(scaled, () => events(scaled, "contact", (event) => event.moveId === "closeC" && event.damage > 0).length > 0), "c.C scaling starter must hit");
  tap(scaled, 0, { hk: true }, "downForward");
  assert(waitFor(scaled, () => events(scaled, "contact", (event) => event.moveId === "shiki88Canceled" && event.damage > 0).length >= 2), "c.C must cancel into both 3D contacts");
  const routeHits = events(scaled, "contact", (event) => event.damage > 0);
  assert.deepEqual(routeHits.map((event) => event.comboCount), [1, 2, 3]);
  const prorated3D = routeHits.slice(1);
  assert(prorated3D[0].damage < standaloneHits[0].damage, "the starter must prorate 3D hit one");
  assert(prorated3D[1].damage < standaloneHits[1].damage, "the starter must prorate 3D hit two");
  assert.equal(scaled.combos[0].damage, routeHits.reduce((sum, event) => sum + event.damage, 0));
}

// EX Red Kick must produce a physical ground bounce through stepGame: the
// bounce stock is consumed and the ground-bounce state becomes an air launch,
// then the authored terminal hard knockdown is restored on final landing.
{
  const game = makeDuel({ meter: 50, p1x: 1035, p2x: 1115 });
  motion(game, 0, "rdp", { lk: true, hk: true });
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "redKickEx" && event.damage > 0).length > 0), "EX Red Kick must connect from 4214BD");
  let sawGroundBounce = false;
  let bounceState = null;
  for (let index = 0; index < 160 && game.phase === "fighting"; index += 1) {
    frame(game);
    if (!sawGroundBounce && game.effects.some((effect) => effect.type === "groundBounce")) {
      sawGroundBounce = true;
      bounceState = {
        frame: game.frame,
        onGround: game.fighters[1].onGround,
        knockdownType: game.fighters[1].knockdownType,
        remaining: game.fighters[1].groundBouncesRemaining,
      };
    }
    if (sawGroundBounce && !game.fighters[0].currentMove) break;
  }
  assert(sawGroundBounce, "groundBounce hit must rebound on floor contact");
  assert.deepEqual(bounceState && {
    onGround: bounceState.onGround,
    knockdownType: bounceState.knockdownType,
    remaining: bounceState.remaining,
  }, { onGround: false, knockdownType: "launch", remaining: 0 });
  assert.equal(game.fighters[1].pendingTerminalKnockdownType, "hard", "EX Red Kick must retain hard as its pending terminal");
  assertHardTerminalRise(game, "EX Red Kick ground bounce");
}

// Ground Blowback at the wall consumes one wall-bounce stock and reverses the
// launch velocity, then restores its non-techable hard terminal on landing.
{
  const game = makeDuel({ p1x: 1110, p2x: 1177 });
  tap(game, 0, { hp: true, hk: true });
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "blowbackGround" && event.damage > 0).length > 0), "C+D must connect at the corner");
  assert(waitFor(game, () => game.effects.some((effect) => effect.type === "wallBounce")), "corner blowback must create a physical wall bounce");
  assert.equal(game.fighters[1].wallBouncesRemaining, 0, "wall-bounce stock must be consumed once");
  assert.equal(game.fighters[1].onGround, false, "wall bounce must leave the defender airborne for a juggle");
  assert.equal(game.fighters[1].knockdownType, "launch");
  assert.equal(game.fighters[1].pendingTerminalKnockdownType, "hard", "C+D must retain hard as its pending terminal");
  assertHardTerminalRise(game, "C+D wall bounce");
}

// Cinematic contacts must resolve on distinct authored frames in numeric order.
// The thirteenth hit is the sole terminal hit, so a standalone Yakumo must
// visibly deliver every impact before producing a hard knockdown.
{
  const game = makeDuel({ meter: 500, p1x: 500, p2x: 560 });
  motion(game, 0, "qcbHcf", { hp: true, hk: true });
  assert(
    waitFor(game, () => events(game, "contact", (event) => event.moveId === "yakumo" && event.damage > 0).length === 13),
    "Yakumo must deliver all 13 authored contacts",
  );
  const contacts = events(game, "contact", (event) => event.moveId === "yakumo" && event.damage > 0);
  assert.deepEqual(
    contacts.map((event) => event.hitId),
    ["hit1", ...Array.from({ length: 12 }, (_, index) => `scriptedHit${index + 2}`)],
    "cinematic hit IDs must follow authored order instead of lexicographic order",
  );
  assert.equal(new Set(contacts.map((event) => event.frame)).size, 13, "every Yakumo impact must own a distinct game frame");
  assert(contacts.slice(1).every((event, index) => event.frame > contacts[index].frame), "Yakumo event frames must be strictly increasing");
  assert(contacts.every((event) => event.damageModifier === 1), "Yakumo outside MAX mode must retain the normal 1x modifier");
  assert.equal(contacts.reduce((total, event) => total + event.appliedDamage, 0), 510, "standalone Yakumo must retain its authored 510 damage");
  assert(waitFor(game, () => events(game, "knockdown").length > 0), "Yakumo's final contact must reach knockdown resolution");
  const knockdown = events(game, "knockdown").at(-1);
  assert.equal(knockdown.knockdownType, "hard");
  assert.equal(knockdown.wakeup, "hardRise");
}

// Full-resource corner route: c.C > 3D > Quick MAX > Yakumo. Every action is
// entered through canonical controller frames. The fixed MAX Climax modifier
// makes this a natural 1000-damage route without reading remaining health.
{
  const right = 1177;
  const game = makeDuel({ meter: 500, p1x: right - 65, p2x: right });

  tap(game, 0, { hp: true });
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "closeC" && event.damage > 0).length > 0), "TOD starter c.C must hit");

  tap(game, 0, { hk: true }, "downForward");
  assert(waitFor(game, () => events(game, "contact", (event) => event.moveId === "shiki88Canceled" && event.comboCount >= 3).length > 0), "c.C must cancel into both hits of 3D");

  // Use the second hit's freeze to prebuffer 214236. Quick MAX remains the
  // buffered cancel; Yakumo's CD chord is pressed only after MAX starts.
  tap(game, 0, { lk: true, hp: true }, "down");
  for (const direction of MOTION_DIRECTIONS.qcbHcf.slice(1)) {
    fighterInput(game, 0, relativeInput(game.fighters[0].facing, direction));
  }
  frame(game);
  assert.equal(events(game, "moveStart", (event) => event.moveId === "quickMax").length, 1, "3D contact must cancel into Quick MAX");
  assert(game.fighters[0].maxModeFrames > 0, "Quick MAX must establish MAX mode");

  tap(game, 0, { hp: true, hk: true }, "forward");
  assert.equal(events(game, "moveStart", (event) => event.moveId === "yakumo").length, 1, "prebuffered 214236CD must start Yakumo");
  assert(waitFor(
    game,
    () => events(game, "contact", (event) => event.moveId === "yakumo" && event.appliedDamage > 0).length === 13,
    { maximum: 180 },
  ), "all thirteen Yakumo contacts must resolve");

  const routeContacts = events(game, "contact", (event) => event.fighterId === 0 && event.appliedDamage > 0);
  const yakumoContacts = routeContacts.filter((event) => event.moveId === "yakumo");
  assert.equal(routeContacts.length, 16, "route must retain all three starter contacts plus thirteen cinematic contacts");
  assert.deepEqual(routeContacts.map((event) => event.comboCount), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(new Set(yakumoContacts.map((event) => event.frame)).size, 13, "TOD cinematic hits must not batch on one frame");
  assert(yakumoContacts.slice(1).every((event, index) => event.frame > yakumoContacts[index].frame));
  assert.equal(yakumoContacts.at(-1).hitId, "scriptedHit13", "the authored terminal contact must remain last");
  assert.equal(new Set(routeContacts.map((event) => event.comboId)).size, 1, "every contact must belong to one uninterrupted combo");
  assert(routeContacts.every((event) => event.damageSource === "standard" && event.forcedDamage === 0));
  assert(routeContacts.every((event) => event.healthBefore - event.healthAfter === event.appliedDamage));
  assert(routeContacts.every((event) => event.scaledDamage >= event.appliedDamage && Number.isFinite(event.comboScale)));
  assert(routeContacts.slice(0, 3).every((event) => event.damageModifier === 1), "starter damage must remain unmodified");
  assert(yakumoContacts.every((event) => event.damageModifier === 2.125), "only MAX-state Yakumo receives the fixed Climax modifier");
  assert.equal(
    routeContacts.reduce((total, event) => total + event.appliedDamage, 0),
    game.fighters[1].maxHealth,
    "contact evidence must reconcile exactly to the health bar",
  );
  assert.equal(game.fighters[1].health, 0, "the full-resource route must naturally remove exactly one life bar");
  assert.equal(events(game, "todConfirm").length, 0, "the removed route-specific TOD confirmation must never fire");
  assert.equal(events(game, "comboEnd", (event) => event.tod).length, 1, "the KO must produce verified natural TOD telemetry");
  assert.equal(game.telemetry.tods[0], 1);

  const comboEnd = events(game, "comboEnd", (event) => event.fighterId === 0).at(-1);
  assert(comboEnd?.tod, "the naturally ended combo must retain TOD evidence");
  assert.equal(comboEnd.count, 16);
  assert.equal(comboEnd.continuous, true);
  assert.equal(comboEnd.startHealth, game.fighters[1].maxHealth);
  assert.equal(comboEnd.endHealth, 0);
  assert.equal(comboEnd.appliedDamage, game.fighters[1].maxHealth);
  assert.equal(comboEnd.forcedDamage, 0);
}

process.stdout.write("v0.7 combat runtime ok · KD tech + scaling + multi-hit + bounce + verified natural TOD\n");
