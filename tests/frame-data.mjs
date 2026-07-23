import assert from "node:assert/strict";

import {
  MOVES,
  MOVESETS,
  createGame,
  getMoveData,
  stepGame,
} from "../src/engine.js";

const neutral = () => ({
  left: false,
  right: false,
  up: false,
  down: false,
  light: false,
  heavy: false,
  special: false,
  guard: false,
});

function step(game, p1 = neutral(), p2 = neutral(), frames = 1) {
  for (let frame = 0; frame < frames; frame += 1) {
    stepGame(game, { p1, p2 });
  }
}

function frameTriple(move) {
  return [move.startup, move.active, move.recovery];
}

function assertFrameData(templateId, action, expected) {
  const move = getMoveData(templateId, action);
  assert(move, `${templateId}.${action} must be available through getMoveData`);
  assert.deepEqual(
    frameTriple(move),
    [expected.startup, expected.active, expected.recovery],
    `${templateId}.${action} must retain its authored startup/active/recovery frames`,
  );
  assert.equal(
    move.firstActive,
    expected.startup - 1,
    `${templateId}.${action}.firstActive must expose the zero-based first active frame`,
  );
  assert.equal(
    move.totalFrames,
    expected.totalFrames ?? expected.startup + expected.active + expected.recovery - 1,
    `${templateId}.${action}.totalFrames must retain authored gaps and landing recovery`,
  );
  return move;
}

function freshCloseGame(templateId = "vanguard", distance = 60) {
  const game = createGame({
    roundTimeSeconds: 30,
    playerTemplate: templateId,
    aiTemplate: templateId === "vanguard" ? "ember" : "vanguard",
  });
  game.fighters[0].x = 560;
  game.fighters[1].x = 560 + distance;
  game.fighters[0].facing = 1;
  game.fighters[1].facing = -1;
  return game;
}

function groundAttackResult({
  templateId = "vanguard",
  action,
  attackInput,
  attackInputs,
  guardInput,
  distance = 60,
}) {
  const game = freshCloseGame(templateId, distance);
  const defender = game.fighters[1];
  const startingHealth = defender.health;
  const move = getMoveData(templateId, action);

  for (const input of attackInputs ?? [attackInput]) {
    step(game, input, guardInput);
  }
  assert.equal(game.fighters[0].action, action, `${action} must start from its public input`);
  for (let frame = 0; frame < move.totalFrames + 8; frame += 1) {
    step(game, neutral(), guardInput);
  }

  return {
    game,
    move,
    attacker: game.fighters[0],
    defender,
    damage: startingHealth - defender.health,
  };
}

function healthDamageScale(result) {
  return MOVESETS[result.attacker.templateId].healthDamageScale
    ?? (result.attacker.templateId === "vanguard" ? 0.1 : 1);
}

function firstHit(result) {
  return result.move.hits?.[0] ?? result.move;
}

function assertBlocked(result, label) {
  const hit = firstHit(result);
  const rawDamage = hit.damage ?? result.move.damage ?? 0;
  const rawChip = hit.chipDamage ?? result.move.chipDamage ?? rawDamage * 0.08;
  assert.equal(
    result.damage,
    Math.max(0, Math.floor(rawChip * healthDamageScale(result))),
    `${label} must deal only its authored chip damage`,
  );
  assert.equal(result.attacker.lastContact?.outcome, "block", `${label} must register a block`);
}

function assertHit(result, label) {
  const hit = firstHit(result);
  assert.equal(
    result.damage,
    Math.max(hit.damage > 0 ? 1 : 0, Math.floor((hit.damage ?? result.move.damage ?? 0) * healthDamageScale(result))),
    `${label} must deal the health-scaled authored direct damage`,
  );
  assert.equal(result.attacker.lastContact?.outcome, "hit", `${label} must register a hit`);
}

function startHighLightAtFirstActive(game, templateId = "vanguard") {
  const move = getMoveData(templateId, "highLight");
  step(game, { ...neutral(), light: true });
  assert.equal(game.fighters[0].action, "highLight");
  while (game.fighters[0].actionFrame < move.firstActive) {
    step(game);
  }
  return move;
}

function findBox(game, type, owner) {
  return game.hitboxes.find((box) => box.type === type && box.owner === owner);
}

function validateBox(box, label) {
  assert(box && typeof box === "object", `${label} must exist`);
  for (const key of ["x", "y", "width", "height"]) {
    assert(Number.isFinite(box[key]), `${label}.${key} must be finite`);
  }
  assert(box.width > 0 && box.height > 0, `${label} must have positive dimensions`);
  assert(["hurt", "hit", "projectile"].includes(box.type), `${label}.type must be public`);
  assert([0, 1].includes(box.owner), `${label}.owner must identify a fighter`);
}

function qcfInputs(button = "light") {
  return [
    { ...neutral(), down: true },
    { ...neutral(), down: true, right: true },
    { ...neutral(), right: true },
    { ...neutral(), right: true, [button]: true },
  ];
}

function issueQcf(game, button = "light") {
  for (const input of qcfInputs(button)) step(game, input);
}

function coversAuthoredFrame(move, frame) {
  const windows = move.activeWindows ?? [
    { start: move.startup, end: move.startup + move.active - 1 },
  ];
  return windows.some((window) => frame >= window.start && frame <= window.end);
}

// Exact v0.7 authored frame data. Startup remains one-based in data,
// while firstActive is the zero-based simulation frame used by the engine.
const vanguardHighLight = assertFrameData("vanguard", "highLight", {
  startup: 4,
  active: 3,
  recovery: 7,
});
assertFrameData("vanguard", "lowHeavy", { startup: 9, active: 3, recovery: 23 });
const vanguardDragonPunch = assertFrameData("vanguard", "dragonPunch", {
  startup: 5,
  active: 10,
  recovery: 21,
  totalFrames: 47,
});

const fireballLight = getMoveData("vanguard", "fireballLight");
const fireballLightProjectileFrame = fireballLight.projectileFrame ?? fireballLight.startup;
assert.equal(
  fireballLightProjectileFrame,
  16,
  "Vanguard light fireball must generate on authored frame 16",
);
assert.equal(fireballLight.totalFrames, 47, "Vanguard light fireball must take 47 total frames");
const fireballHeavy = getMoveData("vanguard", "fireballHeavy");
const fireballHeavyProjectileFrame = fireballHeavy.projectileFrame ?? fireballHeavy.startup;
assert.equal(
  fireballHeavyProjectileFrame,
  12,
  "Vanguard heavy fireball must generate on authored frame 12",
);
assert.equal(fireballHeavy.totalFrames, 47, "Vanguard heavy fireball must take 47 total frames");

assertFrameData("ember", "highLight", { startup: 4, active: 2, recovery: 8 });
assertFrameData("ember", "lowHeavy", { startup: 7, active: 4, recovery: 23 });
assertFrameData("ember", "rekkaLight", { startup: 11, active: 6, recovery: 21 });
const emberAirHammer = getMoveData("ember", "airHammer");
assert.deepEqual(
  [emberAirHammer.startup, emberAirHammer.active, emberAirHammer.hit?.landingRecovery],
  [12, 4, 1],
  "Ember airHammer must retain 12F startup, 4F active, and 1F landing recovery",
);
assert.equal(emberAirHammer.firstActive, 11);

assert(MOVESETS.vanguard && MOVESETS.ember, "MOVESETS must expose both authored templates");
assert.notDeepEqual(
  frameTriple(getMoveData("vanguard", "highLight")),
  frameTriple(getMoveData("ember", "highLight")),
  "the same action must resolve to template-specific frame data",
);
assert(MOVES && MOVES.highLight && MOVES.lowHeavy, "legacy MOVES actions must remain available");
assert(MOVES.light && MOVES.heavy && MOVES.special, "legacy MOVES aliases must remain available");
assert.deepEqual(
  frameTriple(MOVES.highLight),
  frameTriple(getMoveData("vanguard", "highLight")),
  "MOVES must remain the Vanguard-compatible legacy view",
);

// Startup semantics: action frame startup-1 is the first effective frame.
const startupGame = freshCloseGame("vanguard", 60);
const startupDefender = startupGame.fighters[1];
const startupHealth = startupDefender.health;
step(startupGame, { ...neutral(), light: true });
assert.equal(startupGame.fighters[0].actionFrame, 0);
while (startupGame.fighters[0].actionFrame < vanguardHighLight.firstActive) {
  assert.equal(
    startupDefender.health,
    startupHealth,
    `highLight must not hit on pre-active action frame ${startupGame.fighters[0].actionFrame}`,
  );
  step(startupGame);
}
assert.equal(startupGame.fighters[0].actionFrame, vanguardHighLight.firstActive);
assert(startupDefender.health < startupHealth, "highLight must hit on startup-1, its first active frame");

// Guard matrix: true mids block at either height; overhead and low require the
// correct height. High attacks only miss crouchers when the authored move is
// tagged whiffsOnCrouch; ordinary standing punches remain crouch-blockable.
assert.equal(getMoveData("ember", "rekkaLight").hitLevel, "mid");
assert.equal(getMoveData("vanguard", "midLight").hitLevel, "overhead");
assert.equal(getMoveData("vanguard", "lowLight").hitLevel, "low");
assert.equal(getMoveData("vanguard", "highLight").hitLevel, "high");

assertBlocked(
  groundAttackResult({
    templateId: "ember",
    action: "rekkaLight",
    attackInputs: qcfInputs("light"),
    guardInput: { ...neutral(), guard: true },
  }),
  "standing guard against mid",
);
assertBlocked(
  groundAttackResult({
    templateId: "ember",
    action: "rekkaLight",
    attackInputs: qcfInputs("light"),
    guardInput: { ...neutral(), down: true, guard: true },
  }),
  "crouching guard against mid",
);
assertHit(
  groundAttackResult({
    action: "lowLight",
    attackInput: { ...neutral(), down: true, light: true },
    guardInput: { ...neutral(), guard: true },
  }),
  "standing guard against low",
);
assertBlocked(
  groundAttackResult({
    action: "lowLight",
    attackInput: { ...neutral(), down: true, light: true },
    guardInput: { ...neutral(), down: true, guard: true },
  }),
  "crouching guard against low",
);

const highVsCrouch = groundAttackResult({
  action: "highLight",
  attackInput: { ...neutral(), light: true },
  guardInput: { ...neutral(), down: true, guard: true },
});
assertBlocked(highVsCrouch, "crouching guard against standing light punch");

const taggedHighVsCrouch = groundAttackResult({
  action: "standHeavyKick",
  attackInput: { ...neutral(), hk: true },
  guardInput: { ...neutral(), down: true },
});
assert(
  taggedHighVsCrouch.move.tags.includes("whiffsOnCrouch"),
  "Vanguard 5HK must retain its authored crouch-whiff property",
);
assert.equal(taggedHighVsCrouch.damage, 0, "whiffsOnCrouch attacks must miss a crouching stance");
assert.notEqual(taggedHighVsCrouch.attacker.lastContact?.outcome, "hit");
assertBlocked(
  groundAttackResult({
    action: "midLight",
    attackInput: { ...neutral(), right: true, light: true },
    guardInput: { ...neutral(), guard: true },
  }),
  "standing guard against overhead",
);
assertHit(
  groundAttackResult({
    action: "midLight",
    attackInput: { ...neutral(), right: true, light: true },
    guardInput: { ...neutral(), down: true, guard: true },
  }),
  "crouching guard against overhead",
);

// Public frame-data and collision snapshots must be renderer-independent.
const structureGame = createGame({ playerTemplate: "vanguard", aiTemplate: "ember" });
step(structureGame);
assert(Array.isArray(structureGame.frameData), "game.frameData must be an array");
assert.equal(structureGame.frameData.length, 2, "game.frameData must contain one record per fighter");
for (const [index, data] of structureGame.frameData.entries()) {
  assert.equal(typeof data.action, "string", `frameData[${index}].action must be a string`);
  assert(Number.isInteger(data.frame) && data.frame >= 0, `frameData[${index}].frame must be non-negative`);
  for (const key of ["startup", "active", "recovery"]) {
    assert(Number.isFinite(data[key]), `frameData[${index}].${key} must be numeric`);
  }
  assert.equal(typeof data.phase, "string", `frameData[${index}].phase must be a string`);
  assert(data.templateName, `frameData[${index}].templateName must be present`);
}

assert(Array.isArray(structureGame.hitboxes), "game.hitboxes must be an array");
validateBox(findBox(structureGame, "hurt", 0), "player 1 hurtbox");
validateBox(findBox(structureGame, "hurt", 1), "player 2 hurtbox");

const rightFacingGame = createGame({ playerTemplate: "vanguard" });
rightFacingGame.fighters[0].x = 640;
rightFacingGame.fighters[1].x = 900;
startHighLightAtFirstActive(rightFacingGame);
const rightHitbox = findBox(rightFacingGame, "hit", 0);
validateBox(rightHitbox, "right-facing hitbox");

const leftFacingGame = createGame({ playerTemplate: "vanguard" });
leftFacingGame.fighters[0].x = 640;
leftFacingGame.fighters[1].x = 380;
startHighLightAtFirstActive(leftFacingGame);
const leftHitbox = findBox(leftFacingGame, "hit", 0);
validateBox(leftHitbox, "left-facing hitbox");
assert.equal(leftHitbox.width, rightHitbox.width, "mirroring must preserve hitbox width");
assert.equal(leftHitbox.height, rightHitbox.height, "mirroring must preserve hitbox height");
const rightOffset = rightHitbox.x + rightHitbox.width / 2 - rightFacingGame.fighters[0].x;
const leftOffset = leftHitbox.x + leftHitbox.width / 2 - leftFacingGame.fighters[0].x;
assert(Math.abs(rightOffset + leftOffset) < 1e-9, "hitbox center must mirror around the fighter root");
assert(Math.abs(leftHitbox.y - rightHitbox.y) < 1e-9, "horizontal mirroring must preserve Y");

const projectileGame = createGame({ playerTemplate: "vanguard" });
projectileGame.fighters[1].x = 1100;
issueQcf(projectileGame, "light");
assert.equal(projectileGame.fighters[0].action, "fireballLight");
for (let frame = 0; frame < fireballLightProjectileFrame + 3 && projectileGame.projectiles.length === 0; frame += 1) {
  step(projectileGame);
}
assert(projectileGame.projectiles.length > 0, "light fireball must create a projectile");
validateBox(findBox(projectileGame, "projectile", 0), "projectile hitbox");

// Ember DP has two active windows separated by frame 8. Move the defender in
// only for the gap, then prove frame 9 becomes effective again.
for (let frame = 5; frame <= 14; frame += 1) {
  assert(
    coversAuthoredFrame(vanguardDragonPunch, frame),
    `Vanguard DP must have no inactive gap on authored frame ${frame}`,
  );
}
const emberDragonPunch = getMoveData("ember", "oniyakiLight");
assert.deepEqual(
  emberDragonPunch.activeWindows.map(({ start, end }) => ({ start, end })),
  [{ start: 4, end: 7 }, { start: 9, end: 12 }],
  "Ember DP must expose its two discrete active windows",
);

const gapGame = createGame({ playerTemplate: "ember", aiTemplate: "vanguard" });
gapGame.fighters[1].x = 1000;
step(gapGame, { right: true });
step(gapGame, { down: true });
step(gapGame, { down: true, right: true, lp: true });
assert.equal(gapGame.fighters[0].action, "oniyakiLight");
while (gapGame.fighters[0].actionFrame < 6) step(gapGame);

const gapAttacker = gapGame.fighters[0];
const gapDefender = gapGame.fighters[1];
gapAttacker.x = 560;
gapAttacker.prevY = gapAttacker.y;
gapAttacker.vx = 0;
gapDefender.x = 605;
gapDefender.y = gapGame.arena.floorY;
gapDefender.prevY = gapDefender.y;
const gapHealth = gapDefender.health;

step(gapGame);
assert.equal(gapAttacker.actionFrame, 7, "action frame 7 must represent authored frame 8");
assert.equal(gapDefender.health, gapHealth, "the frame-8 gap between active windows must not hit");
step(gapGame);
assert.equal(gapAttacker.actionFrame, 8, "action frame 8 must represent authored frame 9");
assert(gapDefender.health < gapHealth, "the second active window must hit on frame 9");

process.stdout.write(
  "frame data ok · template moves + startup/guard semantics + public hitboxes + active windows\n",
);
