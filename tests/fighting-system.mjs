import assert from "node:assert/strict";
import { MOVESETS, createGame, getMoveData, stepGame } from "../src/engine.js";

const neutral = () => ({ left: false, right: false, up: false, down: false, light: false, heavy: false, special: false, guard: false });

function step(game, p1 = neutral(), p2 = neutral(), frames = 1) {
  for (let frame = 0; frame < frames; frame += 1) stepGame(game, { p1, p2 });
}

function freshCloseGame(distance = 65) {
  const game = createGame({ roundTimeSeconds: 30 });
  game.fighters[0].x = 560;
  game.fighters[1].x = 560 + distance;
  game.fighters[0].facing = 1;
  game.fighters[1].facing = -1;
  return game;
}

function expectedFirstHitDamage(game, action) {
  const attacker = game.fighters[0];
  const move = getMoveData(attacker.templateId, action);
  const rawDamage = move.hits?.[0]?.damage ?? move.damage ?? 0;
  const healthScale = MOVESETS[attacker.templateId].healthDamageScale
    ?? (attacker.templateId === "vanguard" ? 0.1 : 1);
  return Math.max(rawDamage > 0 ? 1 : 0, Math.floor(rawDamage * healthScale));
}

function assertStarts(input, action) {
  const game = createGame({ roundTimeSeconds: 30 });
  step(game, input);
  assert.equal(game.fighters[0].action, action, `${action} should start from its documented input`);
}

assertStarts({ ...neutral(), light: true }, "highLight");
assertStarts({ ...neutral(), heavy: true }, "highHeavy");
assertStarts({ ...neutral(), right: true, light: true }, "midLight");
assertStarts({ ...neutral(), right: true, heavy: true }, "midHeavy");
assertStarts({ ...neutral(), down: true, light: true }, "lowLight");
assertStarts({ ...neutral(), down: true, heavy: true }, "lowHeavy");

const mirrored = createGame({ roundTimeSeconds: 30 });
step(mirrored, neutral(), { ...neutral(), left: true, light: true });
assert.equal(mirrored.fighters[1].action, "midLight", "forward input should mirror for the right-side fighter");

const dpGame = createGame({ roundTimeSeconds: 30 });
step(dpGame, { ...neutral(), right: true });
step(dpGame, { ...neutral(), down: true });
step(dpGame, { ...neutral(), down: true, right: true, heavy: true });
assert.equal(dpGame.fighters[0].action, "dragonPunch", "forward, down, down-forward + heavy should start dragon punch");
assert(dpGame.fighters[0].strikeInvulnFrames > 0, "dragon punch should have startup strike invulnerability");

const fireballGame = createGame({ roundTimeSeconds: 30 });
fireballGame.fighters[1].x = 1170;
const initialEnergy = fireballGame.fighters[0].energy;
function qcf(button) {
  step(fireballGame, { ...neutral(), down: true });
  step(fireballGame, { ...neutral(), down: true, right: true });
  step(fireballGame, { ...neutral(), right: true });
  step(fireballGame, { ...neutral(), right: true, [button]: true });
}
qcf("light");
assert.equal(fireballGame.fighters[0].action, "fireballLight");
step(fireballGame, neutral(), neutral(), 50);
assert(fireballGame.nextProjectileId >= 2, "first QCF should spawn a projectile");
qcf("heavy");
assert.equal(fireballGame.fighters[0].action, "fireballHeavy");
step(fireballGame, neutral(), neutral(), 24);
assert(fireballGame.nextProjectileId >= 3, "a second QCF should spawn another projectile");
assert.equal(fireballGame.fighters[0].energy, initialEnergy, "repeated fireballs should consume no finite resource");

// Ordinary standing highs can hit crouchers in the complete data set; only
// moves explicitly tagged whiffsOnCrouch (such as Vanguard 5HK) pass over them.
const highVsCrouch = freshCloseGame();
step(highVsCrouch, { ...neutral(), light: true }, { ...neutral(), down: true });
step(highVsCrouch, neutral(), { ...neutral(), down: true }, 25);
assert.equal(
  highVsCrouch.fighters[1].maxHealth - highVsCrouch.fighters[1].health,
  expectedFirstHitDamage(highVsCrouch, "highLight"),
  "standing light punch should retain its authored ability to hit crouchers",
);
assert.equal(highVsCrouch.fighters[0].lastContact?.outcome, "hit");

// Forward overheads open crouch guard; lows open stand guard; correct guards only take chip.
const midVsCrouchGuard = freshCloseGame();
step(midVsCrouchGuard, { ...neutral(), right: true, light: true }, { ...neutral(), down: true, guard: true });
step(midVsCrouchGuard, neutral(), { ...neutral(), down: true, guard: true }, 30);
assert.equal(
  midVsCrouchGuard.fighters[1].maxHealth - midVsCrouchGuard.fighters[1].health,
  expectedFirstHitDamage(midVsCrouchGuard, "midLight"),
  "forward overhead should beat crouch guard with health-scaled direct damage",
);

const lowVsStandGuard = freshCloseGame();
step(lowVsStandGuard, { ...neutral(), down: true, light: true }, { ...neutral(), guard: true });
step(lowVsStandGuard, neutral(), { ...neutral(), guard: true }, 30);
assert.equal(
  lowVsStandGuard.fighters[1].maxHealth - lowVsStandGuard.fighters[1].health,
  expectedFirstHitDamage(lowVsStandGuard, "lowLight"),
  "low should beat stand guard with health-scaled direct damage",
);

const lowVsCrouchGuard = freshCloseGame();
step(lowVsCrouchGuard, { ...neutral(), down: true, light: true }, { ...neutral(), down: true, guard: true });
step(lowVsCrouchGuard, neutral(), { ...neutral(), down: true, guard: true }, 30);
const lowChip = lowVsCrouchGuard.fighters[1].maxHealth - lowVsCrouchGuard.fighters[1].health;
assert.equal(lowChip, 0, "authored normal attacks should deal zero chip through crouch guard");
assert.equal(lowVsCrouchGuard.fighters[0].lastContact?.outcome, "block");

const highVsStandGuard = freshCloseGame();
step(highVsStandGuard, { ...neutral(), light: true }, { ...neutral(), guard: true });
step(highVsStandGuard, neutral(), { ...neutral(), guard: true }, 25);
const highChip = highVsStandGuard.fighters[1].maxHealth - highVsStandGuard.fighters[1].health;
assert.equal(highChip, 0, "authored normal attacks should deal zero chip through stand guard");
assert.equal(highVsStandGuard.fighters[0].lastContact?.outcome, "block");

const throwVsGuard = freshCloseGame(52);
step(throwVsGuard, { ...neutral(), special: true }, { ...neutral(), guard: true });
for (let frame = 0; frame < 40 && throwVsGuard.fighters[1].action !== "knockdown"; frame += 1) {
  step(throwVsGuard, neutral(), { ...neutral(), guard: true });
}
assert.equal(
  throwVsGuard.fighters[1].maxHealth - throwVsGuard.fighters[1].health,
  expectedFirstHitDamage(throwVsGuard, "throw"),
  "throw should break guard for its health-scaled authored damage",
);
assert.equal(throwVsGuard.fighters[1].action, "knockdown", "successful throw should knock down");
assert.equal(throwVsGuard.fighters[1].knockdownType, "hard", "Vanguard throw should force hard knockdown");

const whiffedThrow = freshCloseGame(320);
step(whiffedThrow, { ...neutral(), special: true });
step(whiffedThrow, neutral(), neutral(), 8);
assert.equal(whiffedThrow.fighters[0].action, "throw", "missed throw should remain committed to its authored recovery");
assert.equal(whiffedThrow.frameData[0].phase, "recovery", "missed throw should expose punishable recovery frames");
assert.equal(whiffedThrow.fighters[0].lastContact, null, "whiff recovery must not fabricate contact");
step(whiffedThrow, { ...neutral(), light: true });
assert.equal(whiffedThrow.fighters[0].action, "throw", "a whiffed throw cannot cancel recovery into a normal");
step(whiffedThrow, neutral(), neutral(), 30);
assert.equal(whiffedThrow.fighters[0].action, "idle", "throw whiff recovery should eventually return to neutral");

process.stdout.write("fighting system ok · 6 normals + guards + throw + motions\n");
