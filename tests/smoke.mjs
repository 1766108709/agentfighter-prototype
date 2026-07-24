import assert from "node:assert/strict";
import { createGame, stepGame, nextRound, restartMatch } from "../src/engine.js";
import { createScriptAI } from "../src/ai.js";

const neutral = () => ({ left: false, right: false, up: false, down: false, light: false, heavy: false, special: false, guard: false });

const movementGame = createGame({ roundTimeSeconds: 10 });
const startX = movementGame.fighters[0].x;
for (let frame = 0; frame < 12; frame += 1) {
  stepGame(movementGame, { p1: { ...neutral(), right: true }, p2: neutral() });
}
assert(movementGame.fighters[0].x > startX, "player should move right");

const projectileGame = createGame({ roundTimeSeconds: 10 });
const startingEnergy = projectileGame.fighters[0].energy;
const qcf = [
  { ...neutral(), down: true },
  { ...neutral(), down: true, right: true },
  { ...neutral(), right: true },
  { ...neutral(), right: true, light: true },
];
for (const input of qcf) stepGame(projectileGame, { p1: input, p2: neutral() });
assert.equal(projectileGame.fighters[0].action, "fireballLight", "QCF + light should start a fireball");
for (let frame = 0; frame < 16; frame += 1) {
  stepGame(projectileGame, { p1: neutral(), p2: neutral() });
}
assert(projectileGame.projectiles.length > 0, "motion command should create a projectile");
assert.equal(projectileGame.fighters[0].energy, startingEnergy, "fireballs should not consume a finite resource");

const match = createGame({ roundTimeSeconds: 10, bestOf: 3 });
const p1 = createScriptAI({ preset: "pressure", difficulty: "hard", seed: 11 });
const p2 = createScriptAI({ preset: "zoner", difficulty: "normal", seed: 22 });

for (let frame = 0; frame < 30000 && match.phase !== "matchOver"; frame += 1) {
  if (match.phase === "roundOver") {
    nextRound(match);
    p1.reset();
    p2.reset();
  }
  stepGame(match, { p1: p1.decide(match, 0), p2: p2.decide(match, 1) });
  for (const fighter of match.fighters) {
    assert(Number.isFinite(fighter.x) && Number.isFinite(fighter.y), "fighter coordinates must stay finite");
    assert(fighter.health >= 0 && fighter.health <= fighter.maxHealth, "health must stay in bounds");
    assert(fighter.energy >= 0 && fighter.energy <= fighter.maxEnergy, "energy must stay in bounds");
  }
}

assert.equal(match.phase, "matchOver", "AI match should finish");
assert([0, 1].includes(match.matchWinner), "match must have a winner");
restartMatch(match);
assert.equal(match.phase, "fighting", "restart should return to fighting");
assert.deepEqual(match.score, [0, 0], "restart should clear score");

process.stdout.write(`smoke ok · winner=${match.matchWinner ?? "reset"}\n`);
