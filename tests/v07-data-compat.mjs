import assert from "node:assert/strict";

import { finalizeMove } from "../src/move-data.js";
import {
  awardContactResources,
  initializeFighterResources,
} from "../src/resources.js";
import { VANGUARD_MOVESET } from "../src/movesets/vanguard.js";

const explicitMulti = finalizeMove({
  id: "explicitMulti",
  name: "Explicit Multi",
  category: "special",
  startup: 3,
  activeWindows: [
    { id: "firstWindow", hitId: "first", start: 3, end: 4 },
    { id: "lastWindow", hitId: "last", start: 7, end: 8 },
  ],
  recovery: 10,
  damage: 100,
  knockdownType: "hard",
  launchX: 9,
  launchY: -7,
  groundBounces: 2,
  wallBounces: 3,
  hits: [
    {
      id: "first",
      start: 3,
      end: 4,
      damage: 40,
      lateDamage: 25,
      lateWindow: { start: 4, end: 4 },
      canHitCrouch: false,
      recoverableDamage: true,
    },
    {
      id: "last",
      start: 7,
      end: 8,
      damage: 60,
      overheadOnlyIfFirstWhiffs: true,
    },
  ],
});

const [first, last] = explicitMulti.hits;
assert.equal(first.knockdownType, undefined, "an early explicit hit must not inherit move knockdown");
assert.equal(first.launchX, undefined, "an early explicit hit must not inherit move launch X");
assert.equal(first.launchY, undefined, "an early explicit hit must not inherit move launch Y");
assert.equal(first.groundBounces, undefined, "an early explicit hit must not inherit move ground bounce");
assert.equal(first.wallBounces, undefined, "an early explicit hit must not inherit move wall bounce");
assert.equal(last.knockdownType, "hard", "the terminal explicit hit inherits move knockdown");
assert.equal(last.launchX, 9, "the terminal explicit hit inherits move launch X");
assert.equal(last.launchY, -7, "the terminal explicit hit inherits move launch Y");
assert.equal(last.groundBounces, 2, "the terminal explicit hit inherits move ground bounce");
assert.equal(last.wallBounces, 3, "the terminal explicit hit inherits move wall bounce");

assert.equal(first.lateDamage, 25, "custom late damage metadata must survive normalization");
assert.deepEqual(first.lateWindow, { start: 4, end: 4 });
assert.equal(first.canHitCrouch, false, "false-valued custom metadata must survive normalization");
assert.equal(first.recoverableDamage, true);
assert.equal(last.overheadOnlyIfFirstWhiffs, true);

const explicitOverrides = finalizeMove({
  id: "explicitOverrides",
  startup: 2,
  activeWindows: [
    { id: "one", start: 2, end: 2 },
    { id: "two", start: 4, end: 4 },
  ],
  recovery: 4,
  damage: 90,
  knockdownType: "hard",
  launchX: 10,
  launchY: -10,
  groundBounces: 2,
  wallBounces: 2,
  hits: [
    {
      id: 101,
      start: "2.9",
      end: "2.9",
      damage: "30",
      knockdownType: "launch",
      launchX: 1,
      launchY: -1,
      groundBounces: 0,
      wallBounces: 0,
    },
    {
      id: "two",
      start: 4,
      end: 4,
      damage: 60,
      knockdownType: "soft",
      launchX: 2,
      launchY: -2,
      groundBounces: 1,
      wallBounces: 1,
    },
  ],
});

assert.deepEqual(
  explicitOverrides.hits.map((hit) => ({
    id: hit.id,
    start: hit.start,
    damage: hit.damage,
    knockdownType: hit.knockdownType,
    launchX: hit.launchX,
    launchY: hit.launchY,
    groundBounces: hit.groundBounces,
    wallBounces: hit.wallBounces,
  })),
  [
    { id: "101", start: 2, damage: 30, knockdownType: "launch", launchX: 1, launchY: -1, groundBounces: 0, wallBounces: 0 },
    { id: "two", start: 4, damage: 60, knockdownType: "soft", launchX: 2, launchY: -2, groundBounces: 1, wallBounces: 1 },
  ],
  "explicit hit values win while canonical fields remain normalized",
);

const single = finalizeMove({
  id: "single",
  startup: 5,
  activeWindows: [{ id: "main", start: 5, end: 6 }],
  recovery: 5,
  damage: 50,
  knockdownType: "soft",
  launchY: -4,
  hits: [{ id: "main", start: 5, end: 6, damage: 50 }],
});
assert.equal(single.hits[0].knockdownType, "soft", "a single explicit hit retains top-level fallback");
assert.equal(single.hits[0].launchY, -4);

const vanguard = VANGUARD_MOVESET.moves;
assert.deepEqual(vanguard.superArt1.hits.map((hit) => hit.knockdownType), [undefined, undefined, undefined, undefined, "normal"]);
assert.deepEqual(vanguard.tatsuMedium.hits.map((hit) => hit.knockdownType), [undefined, "normal"]);
assert.equal(vanguard.shoryukenLight.hits[0].lateDamage, 800);
assert.deepEqual(vanguard.shoryukenLight.hits[0].lateWindow, { start: 8, end: 14 });
assert.equal(vanguard.tatsuMedium.hits[0].canHitCrouch, true);
assert.equal(vanguard.tatsuMedium.hits[1].canHitCrouch, false);
assert.equal(vanguard.collarboneBreaker.hits[1].overheadOnlyIfFirstWhiffs, true);
assert.equal(vanguard.driveReversalBlock.hits[0].recoverableDamage, true);
assert.equal(vanguard.superArt3.hits[0].nonCinematicLateDamage, 3600);

function resourceFighter(id) {
  const fighter = { id, templateId: "vanguard" };
  initializeFighterResources(fighter, "vanguard", { superMeter: 0, drive: 600 });
  return fighter;
}

const attacker = resourceFighter(0);
const defender = resourceFighter(1);
const fourHitMove = { damage: 1000 };
for (const hit of [{ damage: 250 }, { damage: 250 }, { damage: 250 }, { damage: 250 }]) {
  awardContactResources(attacker, defender, fourHitMove, "hit", hit);
}
assert.equal(defender.superMeter, 25, "multi-hit defender gain uses each hit once, not total move damage repeatedly");

const legacyDefender = resourceFighter(2);
awardContactResources(attacker, legacyDefender, fourHitMove, "hit");
assert.equal(legacyDefender.superMeter, 25, "legacy callers without current hit retain move-damage fallback");

const zeroDamageDefender = resourceFighter(3);
awardContactResources(attacker, zeroDamageDefender, fourHitMove, "hit", { damage: 0 });
assert.equal(zeroDamageDefender.superMeter, 2, "an explicit zero-damage hit must not fall back to move damage");

console.log("v0.7 move-data/resource compatibility tests passed");
