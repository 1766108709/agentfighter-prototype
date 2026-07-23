import assert from "node:assert/strict";

import { validateMoveset } from "../src/move-data.js";
import {
  EMBER_DATA_VERSION,
  EMBER_MOVESET,
  EMBER_ROSTER_METADATA,
  EMBER_TOD_SKELETONS,
} from "../src/movesets/ember.js";

const moves = EMBER_MOVESET.moves;
const moveIds = new Set(Object.keys(moves));

assert.deepEqual(validateMoveset(EMBER_MOVESET), []);
assert.equal(EMBER_DATA_VERSION.version, "2.51");
assert.equal(EMBER_DATA_VERSION.balanceDataVersion, "2.50");
assert(moveIds.size >= 76, `expected a full Ember roster, received only ${moveIds.size} moves`);

const requiredMoves = [
  // Close / far / crouch.
  "closeA", "closeB", "closeC", "closeD",
  "farA", "farB", "farC", "farD",
  "crouchA", "crouchB", "crouchC", "sweep",
  // Hop / jump and command normals.
  "hopA", "hopB", "hopC", "hopD",
  "jumpA", "jumpB", "jumpC", "jumpD",
  "gofuYo", "gofuYoCanceled", "shiki88", "shiki88Canceled", "narakuOtoshi",
  // Blowbacks, throws, and Rush.
  "blowbackGround", "blowbackHop", "blowbackJump",
  "hatsugane", "issetsuSeoiNage", "rush1", "rush2",
  // Every strength and EX version.
  "oniyakiLight", "oniyakiHeavy", "oniyakiEx",
  "redKickLight", "redKickHeavy", "redKickEx",
  "kaiLight", "kaiHeavy", "kaiEx", "kaiFollowLight", "kaiFollowHeavy",
  "kototsukiYoLight", "kototsukiYoHeavy", "kototsukiYoEx",
  // Aragami tree.
  "aragami", "konokizu", "yanosabi1", "nanase", "yanosabi2",
  "kototsukiYo2", "migariUgachi", "munotsuchi", "hikigane", "tsurubeotoshi",
  // Dokugami tree, including the explicit lab placeholder.
  "dokugami", "dokugamiEx", "tsumiyomi", "batsuyomi", "oniyaki2",
  // Supers / MAX / Climax.
  "orochinagiLight", "orochinagiHeavy", "maxOrochinagi",
  "shiki182Light", "shiki182Heavy", "max182", "yakumo",
  // Universal systems.
  "rollForward", "rollBackward",
  "guardCancelRollForward", "guardCancelRollBackward", "guardCancelBlowback",
  "shatterStrike", "advanceStrike", "quickMax",
];

for (const id of requiredMoves) assert(moveIds.has(id), `missing required move: ${id}`);

const requiredFields = [
  "command",
  "category",
  "startup",
  "activeWindows",
  "recovery",
  "damage",
  "hit",
  "cancel",
  "cost",
  "routeFrom",
  "routeTo",
  "knockdown",
  "juggle",
  "tags",
  "animation",
  "dataConfidence",
];

for (const move of Object.values(moves)) {
  for (const field of requiredFields) {
    assert(Object.hasOwn(move, field), `${move.id}: missing authored field ${field}`);
  }
  assert(move.command && typeof move.command === "object", `${move.id}: command must be structured`);
  assert(typeof move.commandLabel === "string", `${move.id}: command label must be present`);
  assert(Number.isInteger(move.startup) && move.startup >= 1, `${move.id}: invalid startup`);
  assert(Number.isInteger(move.recovery) && move.recovery >= 0, `${move.id}: invalid recovery`);
  assert(Number.isFinite(move.damage) && move.damage >= 0, `${move.id}: invalid damage`);
  assert(Array.isArray(move.activeWindows) && move.activeWindows.length > 0, `${move.id}: no active windows`);
  assert(Array.isArray(move.hits) && move.hits.length > 0, `${move.id}: no normalized hits`);
  assert(Array.isArray(move.cancels), `${move.id}: cancels must normalize to an array`);
  assert(Array.isArray(move.routeFrom) && Array.isArray(move.routeTo), `${move.id}: routes must be arrays`);
  assert(Array.isArray(move.tags), `${move.id}: tags must be an array`);
  assert.equal(typeof move.animation, "string", `${move.id}: animation must be explicit`);
  assert.equal(typeof move.dataConfidence, "string", `${move.id}: confidence must be explicit`);

  const windowIds = move.activeWindows.map((window) => window.hitId);
  assert.equal(new Set(windowIds).size, windowIds.length, `${move.id}: active windows need independent hitIds`);
  const hitIds = move.hits.map((hit) => hit.id);
  assert.equal(new Set(hitIds).size, hitIds.length, `${move.id}: scripted hits need independent hit IDs`);

  for (const routeId of [...move.routeFrom, ...move.routeTo]) {
    assert(moveIds.has(routeId), `${move.id}: dangling route reference ${routeId}`);
  }
}

const legacyAliases = {
  highLight: "closeA",
  highHeavy: "closeC",
  midLight: "farA",
  midHeavy: "farC",
  lowLight: "crouchB",
  lowHeavy: "sweep",
  rekkaLight: "aragami",
  rekkaHeavy: "dokugami",
  dragonPunch: "oniyakiHeavy",
  airLight: "jumpA",
  airHeavy: "jumpD",
  airHammer: "narakuOtoshi",
  throw: "hatsugane",
};
for (const [alias, target] of Object.entries(legacyAliases)) {
  assert.equal(EMBER_MOVESET.aliases[alias], target, `legacy alias changed: ${alias}`);
}

// Kyo has no separately-authored neutral-jump buttons or air throw. Vertical
// movement aliases must resolve to the sourced hop/jump rows instead.
assert.equal(EMBER_ROSTER_METADATA.hasAirThrow, false);
assert(!Object.values(moves).some((move) => move.tags.includes("airThrow")));
assert.equal(EMBER_MOVESET.aliases.verticalHopB, "hopB");
assert.equal(EMBER_MOVESET.aliases.verticalJumpB, "jumpB");
assert(moves.hopB.hit.jumpModes.includes("verticalHop"));
assert(moves.jumpB.hit.jumpModes.includes("verticalJump"));

// Exact multi-hit windows with real gaps.
assert.deepEqual(
  moves.shiki88.activeWindows.map(({ start, end }) => [start, end]),
  [[7, 8], [15, 16]],
);
assert.deepEqual(
  moves.oniyakiLight.activeWindows.map(({ start, end }) => [start, end]),
  [[4, 7], [9, 12]],
);
assert.deepEqual(
  moves.kaiEx.activeWindows.map(({ start, end }) => [start, end]),
  [[10, 12], [19, 22]],
);
assert.deepEqual(
  moves.shiki182Light.activeWindows.map(({ start, end }) => [start, end]),
  [[13, 14], [33, 34]],
);
for (const move of Object.values(moves).filter((entry) => entry.tags.includes("multiHit"))) {
  assert(move.hits.length > 1, `${move.id}: multiHit tag requires multiple hit records`);
}
assert.equal(moves.oniyakiEx.activeWindows.length, 10);
assert.equal(moves.oniyakiEx.hits.length, 11, "EX Oniyaki needs ten contact phases plus a scripted finisher");
assert.equal(moves.yakumo.hits.length, 13, "Yakumo cinematic impacts must not share a hit ID");

// Cancel masks: Oniyaki only super-cancels the first hit; 88 Shiki special-
// cancels only hit one but retains its broader super route.
assert.equal(moves.oniyakiLight.cancels.length, 1);
assert.equal(moves.oniyakiLight.cancels[0].start, 4);
assert.equal(moves.oniyakiLight.cancels[0].end, 7);
assert.equal(moves.shiki88.cancels.length, 2);
assert.deepEqual(moves.shiki88.cancels[0].into, ["special", "super", "climax"]);
assert.equal(moves.shiki88.cancels[0].end, 8);
assert.equal(moves.shiki88.cancels[1].end, 16);
assert(moves.nanase.cancels.some((cancel) => cancel.into.includes("super")), "2.50 Nanase super cancel is missing");

// Every authored route branch closes and points back to its legal parent.
const expectedBranches = {
  aragami: ["konokizu", "yanosabi2", "munotsuchi"],
  konokizu: ["yanosabi1", "nanase"],
  yanosabi2: ["kototsukiYo2", "migariUgachi"],
  munotsuchi: ["hikigane", "tsurubeotoshi"],
  dokugami: ["tsumiyomi"],
  dokugamiEx: ["tsumiyomi"],
  tsumiyomi: ["batsuyomi"],
  batsuyomi: ["oniyaki2"],
  kaiLight: ["kaiFollowLight"],
  kaiHeavy: ["kaiFollowHeavy"],
};
for (const [parent, children] of Object.entries(expectedBranches)) {
  assert.deepEqual(moves[parent].routeTo, children, `${parent}: branch list drifted`);
  for (const child of children) {
    assert(moves[child].routeFrom.includes(parent), `${parent} -> ${child}: child does not accept its parent`);
  }
}

// EX = half bar, level 1 = one, MAX = two, Climax = three. The Ember meter
// uses 100 units per KOF power-gauge bar.
for (const id of ["oniyakiEx", "redKickEx", "kaiEx", "dokugamiEx", "kototsukiYoEx"]) {
  assert.equal(moves[id].cost.super, 50, `${id}: EX cost must be half a bar`);
}
for (const id of ["orochinagiLight", "orochinagiHeavy", "shiki182Light", "shiki182Heavy"]) {
  assert.equal(moves[id].cost.super, 100, `${id}: level-one super cost must be one bar`);
}
for (const id of ["maxOrochinagi", "max182"]) {
  assert.equal(moves[id].cost.super, 200, `${id}: MAX super cost must be two bars`);
}
assert.equal(moves.yakumo.cost.super, 300);
assert.equal(moves.shatterStrike.cost.super, 100);
assert.equal(moves.advanceStrike.cost.super, 50);
assert.equal(moves.quickMax.cost.super, 200);
assert.equal(moves.guardCancelBlowback.cost.super, 100);
assert.equal(moves.guardCancelRollForward.cost.super, 100);
assert.deepEqual(moves.rollForward.cost, {});

// System frame and state checks.
assert.equal(moves.rollForward.totalFrames, 33);
assert.deepEqual(moves.rollForward.hit.invulnerability[0], {
  type: "strike+projectile",
  start: 1,
  end: 24,
});
assert.equal(moves.guardCancelBlowback.startup, 7);
assert.equal(moves.guardCancelBlowback.hit.startupAgainstAirMove, 11);
assert.equal(moves.shatterStrike.knockdown.type, "crumple");
assert.equal(moves.shatterStrike.knockdown.airHitType, "wallBounce");
assert.equal(moves.advanceStrike.hit.contactRecovery, 14);
assert.equal(moves.advanceStrike.hit.throwCounterFollowupScaling, 0.3);

const knockdownKinds = new Set(Object.values(moves).map((move) => move.knockdown.type));
for (const kind of ["soft", "hard", "launch", "groundBounce", "wallBounce", "crumple"]) {
  assert(knockdownKinds.has(kind), `missing knockdown kind: ${kind}`);
}
assert.equal(moves.redKickEx.knockdown.groundBounces, 1);
assert.equal(moves.blowbackGround.knockdown.wallBounces, 1);
assert.equal(moves.hikigane.juggle.mode, "juggle");
assert.equal(moves.kaiHeavy.knockdown.terminal, "soft");

// The official command list marks EX Dokugami, but current frame data does not
// expose a trustworthy independent row. It must remain unusable until labbed.
assert.equal(moves.dokugamiEx.dataConfidence, "needsLab");
assert.equal(moves.dokugamiEx.needsLab, true);
assert.equal(moves.dokugamiEx.disabled, true);
assert.equal(moves.dokugamiEx.damage, 0);
assert(moves.dokugamiEx.tags.includes("disabledUntilLab"));

// TOD routes are validation fixtures, not a claim that the structure-only
// route is already a frame-perfect 2.51 recording.
for (const [name, skeleton] of Object.entries(EMBER_TOD_SKELETONS)) {
  assert(Array.isArray(skeleton.route) && skeleton.route.length > 0, `${name}: empty TOD route`);
  for (const moveId of skeleton.route) {
    assert(moveIds.has(moveId), `${name}: TOD skeleton references missing move ${moveId}`);
  }
}
const tod = EMBER_TOD_SKELETONS.fullResourceNearTodAcceptance.route.map((id) => moves[id]);
assert(tod.some((move) => move.id === "quickMax"));
assert(tod.some((move) => move.category === "od"));
assert(tod.some((move) => move.tags.includes("rekka") || move.tags.includes("specialFollowup")));
assert(tod.some((move) => move.category === "super" && move.cost.super === 100));
assert(tod.some((move) => move.tags.includes("maxSuper")));
assert(tod.some((move) => move.category === "climax"));
assert(EMBER_TOD_SKELETONS.fullResourceNearTodAcceptance.status.includes("needs-2.51-playback"));

process.stdout.write(
  `v0.7 Ember roster ok · ${moveIds.size} moves · closed rekkas · resources · multi-hit IDs · knockdowns · TOD fixtures\n`,
);
