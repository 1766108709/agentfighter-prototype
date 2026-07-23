import assert from "node:assert/strict";
import { CHARACTER_TEMPLATES, createGame, stepGame } from "../src/engine.js";

const neutral = () => ({ left: false, right: false, up: false, down: false, light: false, heavy: false, special: false, guard: false });
const step = (game, p1 = neutral(), p2 = neutral(), frames = 1) => {
  for (let frame = 0; frame < frames; frame += 1) stepGame(game, { p1, p2 });
};

function putInAir(game, index = 0, height = 72) {
  const fighter = game.fighters[index];
  fighter.onGround = false;
  fighter.y = game.arena.floorY - height;
  fighter.prevY = fighter.y;
  fighter.vy = 0;
  fighter.vx = 0;
  fighter.action = "jump";
  fighter.state = "jump";
  fighter.actionFrame = 4;
  fighter.actionDuration = 0;
  return fighter;
}

assert(CHARACTER_TEMPLATES.vanguard && CHARACTER_TEMPLATES.ember, "both character templates should be exported");

const templateGame = createGame({ playerTemplate: "vanguard", aiTemplate: "ember" });
assert.equal(templateGame.fighters[0].templateId, "vanguard");
assert.equal(templateGame.fighters[1].templateId, "ember");

const airLightGame = createGame();
putInAir(airLightGame);
step(airLightGame, { ...neutral(), light: true });
assert.equal(airLightGame.fighters[0].action, "airLight", "the legacy light alias should still start the fast air attack");

const canonicalAirLightGame = createGame({ playerTemplate: "vanguard" });
putInAir(canonicalAirLightGame);
step(canonicalAirLightGame, { lp: true });
assert.equal(canonicalAirLightGame.fighters[0].action, "jumpLightPunch", "LP must resolve to the full roster's jump light punch");

const airHeavyGame = createGame();
putInAir(airHeavyGame);
step(airHeavyGame, { ...neutral(), heavy: true });
assert.equal(airHeavyGame.fighters[0].action, "airHeavy", "the legacy heavy alias should still start the jump-in heavy attack");

const canonicalAirHeavyGame = createGame({ playerTemplate: "vanguard" });
putInAir(canonicalAirHeavyGame);
step(canonicalAirHeavyGame, { hk: true });
assert.equal(canonicalAirHeavyGame.fighters[0].action, "jumpHeavyKick", "HK must resolve to the full roster's jump heavy kick");

const tatsuGame = createGame({ playerTemplate: "vanguard" });
putInAir(tatsuGame, 0, 105);
step(tatsuGame, { ...neutral(), down: true });
step(tatsuGame, { ...neutral(), down: true, left: true });
step(tatsuGame, { ...neutral(), left: true });
step(tatsuGame, { ...neutral(), left: true, heavy: true });
assert.equal(tatsuGame.fighters[0].action, "airTatsu", "air QCB + K should start Vanguard's spin kick");

const hammerGame = createGame({ playerTemplate: "ember" });
putInAir(hammerGame, 0, 105);
step(hammerGame, { down: true, hp: true });
assert.equal(hammerGame.fighters[0].action, "narakuOtoshi", "air down + HP should start Ember's downward strike");

const emberQcf = createGame({ playerTemplate: "ember" });
step(emberQcf, { ...neutral(), down: true });
step(emberQcf, { ...neutral(), down: true, right: true });
step(emberQcf, { ...neutral(), right: true });
step(emberQcf, { right: true, lp: true });
assert.equal(emberQcf.fighters[0].action, "aragami", "Ember QCF+LP should become an advancing rekka, not a projectile");
assert.equal(emberQcf.projectiles.length, 0);

const hitGame = createGame();
hitGame.fighters[0].x = 560;
hitGame.fighters[1].x = 625;
putInAir(hitGame, 0, 58);
const healthBefore = hitGame.fighters[1].health;
step(hitGame, { ...neutral(), heavy: true });
step(hitGame, neutral(), neutral(), 14);
assert(hitGame.fighters[1].health < healthBefore, "a descending heavy kick should hit a nearby standing opponent");

const landingGame = createGame();
putInAir(landingGame, 0, 38);
step(landingGame, { ...neutral(), heavy: true });
step(landingGame, neutral(), neutral(), 120);
assert.equal(landingGame.fighters[0].onGround, true, "air attack should eventually land");
assert(!landingGame.fighters[0].action.startsWith("air"), "landing should leave the air attack state");
assert(Number.isFinite(landingGame.fighters[0].x) && Number.isFinite(landingGame.fighters[0].y));

process.stdout.write("air combat ok · 2 templates + 4 air attacks + landing\n");
