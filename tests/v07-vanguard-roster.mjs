import assert from "node:assert/strict";

import { getMovesetMove, validateMoveset } from "../src/move-data.js";
import { VANGUARD_MOVESET } from "../src/movesets/vanguard.js";

const EXPECTED_BY_CATEGORY = {
  normal: [
    "standLightPunch", "standMediumPunch", "standHeavyPunch",
    "standLightKick", "standMediumKick", "standHeavyKick",
    "crouchLightPunch", "crouchMediumPunch", "crouchHeavyPunch",
    "crouchLightKick", "crouchMediumKick", "crouchHeavyKick",
    "jumpLightPunch", "jumpMediumPunch", "jumpHeavyPunch",
    "jumpLightKick", "jumpMediumKick", "jumpHeavyKick",
  ],
  commandNormal: [
    "collarboneBreaker", "solarPlexusStrike", "shortUppercut", "axeKick", "whirlwindKick",
  ],
  targetCombo: ["highDoubleStrike", "fuwaSecond", "fuwaFinisher"],
  throw: ["shoulderThrow", "somersaultThrow"],
  special: [
    "hadokenLight", "hadokenMedium", "hadokenHeavy", "hadokenDenjin",
    "shoryukenLight", "shoryukenMedium", "shoryukenHeavy",
    "tatsuLight", "tatsuMedium", "tatsuHeavy", "airTatsu", "whirlwindAirTatsu",
    "highBladeLight", "highBladeMedium", "highBladeHeavy",
    "hashogekiLight", "hashogekiMedium", "hashogekiHeavy", "hashogekiDenjin", "denjinCharge",
  ],
  od: [
    "hadokenOD", "hadokenODDenjin", "shoryukenOD", "tatsuOD", "airTatsuOD",
    "whirlwindAirTatsuOD", "highBladeOD", "hashogekiOD", "hashogekiODDenjin",
  ],
  super: [
    "superArt1", "superArt1Denjin",
    "superArt2Level1", "superArt2Level1Denjin",
    "superArt2Level2", "superArt2Level2Denjin",
    "superArt2Level3", "superArt2Level3Denjin", "superArt3",
  ],
  climax: ["criticalArt"],
  system: [
    "forwardDash", "backDash", "driveImpact", "driveReversalBlock", "driveReversalWakeup",
    "driveParry", "perfectParryStrike", "perfectParryProjectile", "parryDriveRush",
    "cancelDriveRush", "throwEscape", "neutralTaunt", "forwardTaunt", "backTaunt", "downTaunt",
  ],
};

const expectedIds = Object.values(EXPECTED_BY_CATEGORY).flat();
const moves = VANGUARD_MOVESET.moves;

assert.equal(expectedIds.length, 82, "the authored roster expectation must remain explicit");
assert.equal(new Set(expectedIds).size, expectedIds.length, "expected move IDs must be unique");
assert.equal(Object.keys(moves).length, 82, "Vanguard must expose the full 82-entry operable roster");
assert.deepEqual(new Set(Object.keys(moves)), new Set(expectedIds), "no expected move may be missing or silently renamed");
assert.deepEqual(validateMoveset(VANGUARD_MOVESET), []);
assert(Object.isFrozen(VANGUARD_MOVESET));

for (const [category, ids] of Object.entries(EXPECTED_BY_CATEGORY)) {
  assert.equal(VANGUARD_MOVESET.catalog[category].length, ids.length, `${category} catalog count`);
  for (const id of ids) assert.equal(moves[id].category, category, `${id} category`);
}

const requiredFields = [
  "command", "category", "startup", "activeWindows", "recovery", "damage",
  "hit", "block", "cancel", "resource", "knockdown", "juggle", "tags", "animation",
];

for (const move of Object.values(moves)) {
  for (const field of requiredFields) {
    assert(Object.hasOwn(move, field), `${move.id} must author ${field}`);
  }
  assert(move.command && typeof move.command === "object", `${move.id} command object`);
  assert.equal(typeof move.commandLabel, "string", `${move.id} normalized command label`);
  assert(Number.isInteger(move.startup) && move.startup >= 1, `${move.id} startup`);
  assert(Number.isInteger(move.recovery) && move.recovery >= 0, `${move.id} recovery`);
  assert(Number.isFinite(move.damage) && move.damage >= 0, `${move.id} damage`);
  assert(Array.isArray(move.activeWindows) && move.activeWindows.length > 0, `${move.id} active windows`);
  assert(Array.isArray(move.hits) && move.hits.length > 0, `${move.id} hits`);
  assert(Array.isArray(move.cancels), `${move.id} normalized cancels`);
  assert(Array.isArray(move.tags) && move.tags.length > 0, `${move.id} tags`);
  assert.equal(typeof move.animation, "string", `${move.id} animation`);
  assert(move.resourceCost && typeof move.resourceCost === "object", `${move.id} resource cost`);

  const hitIds = new Set(move.hits.map((hit) => hit.id));
  assert.equal(hitIds.size, move.hits.length, `${move.id} hit IDs must be independent`);
  for (const window of move.activeWindows) {
    assert(window.id && window.hitId, `${move.id} active windows need id + hitId`);
    assert(window.start >= move.startup, `${move.id}/${window.id} cannot activate before startup`);
    assert(window.end >= window.start, `${move.id}/${window.id} valid interval`);
    assert(hitIds.has(window.hitId), `${move.id}/${window.id} must resolve to a hit definition`);
  }
}

const aliases = {
  highLight: "standLightPunch",
  highHeavy: "standHeavyPunch",
  midLight: "collarboneBreaker",
  midHeavy: "solarPlexusStrike",
  lowLight: "crouchLightKick",
  lowHeavy: "crouchHeavyKick",
  fireballLight: "hadokenLight",
  fireballHeavy: "hadokenHeavy",
  dragonPunch: "shoryukenLight",
  airLight: "jumpLightPunch",
  airHeavy: "jumpHeavyKick",
  airTatsu: "airTatsu",
  throw: "shoulderThrow",
};
assert.deepEqual(VANGUARD_MOVESET.aliases, aliases);
for (const [alias, target] of Object.entries(aliases)) {
  assert.equal(getMovesetMove(VANGUARD_MOVESET, alias), moves[target], `${alias} compatibility alias`);
}

// Canonical live-data conflict checks: these catch accidental fallback to old UFD values.
assert.equal(moves.crouchLightKick.block.advantage, -1, "live Capcom 2LK is -1 on block");
assert.equal(moves.jumpMediumPunch.startup, 8, "live Capcom j.MP starts in 8F");
assert.equal(moves.shoryukenHeavy.block.advantage, -36, "live Capcom HP Shoryuken is -36");

// True multi-hit attacks require separate hit IDs; Air Tatsu intentionally reuses one.
assert.deepEqual(moves.tatsuOD.hits.map((hit) => hit.damage), [200, 200, 200, 200, 200]);
assert.equal(new Set(moves.tatsuOD.activeWindows.map((window) => window.hitId)).size, 5);
assert.deepEqual(moves.hadokenODDenjin.hits.map((hit) => hit.damage), [400, 400, 400]);
assert.equal(moves.axeKick.hits.length, 2);
assert.equal(moves.hashogekiHeavy.hits.length, 2);
assert.equal(moves.superArt1Denjin.hits.length, 8);
assert.equal(moves.airTatsu.hits.length, 1, "normal Air Tatsu only damages a target once");
assert.deepEqual(new Set(moves.airTatsu.activeWindows.map((window) => window.hitId)), new Set(["spin"]));

// Resource and condition coverage.
assert.equal(moves.hadokenOD.resourceCost.drive, 200);
assert.equal(moves.hadokenODDenjin.resource.consumes.denjin, 1);
assert.equal(moves.superArt1.resourceCost.super, 100);
assert.equal(moves.superArt2Level3.resourceCost.super, 200);
assert.equal(moves.superArt3.resourceCost.super, 300);
assert.equal(moves.driveImpact.resourceCost.drive, 100);
assert.equal(moves.cancelDriveRush.resourceCost.drive, 300);
assert(moves.criticalArt.resource.conditions.includes("healthRatio<=0.25"));
assert(moves.denjinCharge.resource.conditions.includes("denjinStock<1"));

// Cancel masks cannot collapse to a single boolean.
assert.deepEqual(moves.crouchHeavyPunch.cancels.map(({ start, end }) => [start, end]), [[9, 9]]);
assert(moves.jumpMediumPunch.cancels[0].moves.includes("airTatsuOD"));
assert.deepEqual(
  moves.whirlwindKick.cancels[0].moves,
  ["whirlwindAirTatsu", "whirlwindAirTatsuOD"],
);
assert(moves.highDoubleStrike.cancels[0].moves.includes("denjinCharge"));
assert(moves.hadokenOD.cancels[0].into.includes("super2"));
assert(moves.hadokenLight.cancels[0].into.includes("super3"));

// Ryu/Vanguard has two ground throws and explicitly no air throw.
assert.equal(EXPECTED_BY_CATEGORY.throw.length, 2);
assert(!Object.values(moves).some((move) => move.tags.includes("airThrow")));

process.stdout.write(
  "v0.7 Vanguard roster ok · 82 moves · full strengths/OD/Denjin/supers/system + aliases\n",
);
