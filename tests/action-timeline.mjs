import assert from "node:assert/strict";

import {
  MOVESETS,
  createGame,
  getMoveData,
  stepGame,
} from "../src/engine.js";
import { getFighterVisualPose } from "../src/renderer.js";

function boxesFor(game, owner, type) {
  return game.hitboxes.filter((box) => box.owner === owner && box.type === type);
}

function assertPublicBox(box, label) {
  assert(box && typeof box === "object", `${label} must be queryable`);
  for (const field of ["x", "y", "width", "height"]) {
    assert(Number.isFinite(box[field]), `${label}.${field} must be finite`);
  }
  assert(box.width > 0, `${label}.width must be positive`);
  assert(box.height > 0, `${label}.height must be positive`);
}

function pointInside(box, x, y) {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function activeFrameSet(move) {
  const frames = new Set();
  for (const window of move.activeWindows) {
    for (let frame = window.start; frame <= window.end; frame += 1) {
      frames.add(frame);
    }
  }
  return frames;
}

for (const [templateId, moveset] of Object.entries(MOVESETS)) {
  for (const move of Object.values(moveset.moves)) {
    const union = activeFrameSet(move);
    const authoredWindowFrames = move.activeWindows.reduce(
      (total, window) => total + window.end - window.start + 1,
      0,
    );
    assert.equal(
      move.activeFrameCount,
      union.size,
      `${templateId}.${move.id}: activeFrameCount must count unique timeline frames`,
    );
    assert.equal(
      move.activeWindowFrameCount,
      authoredWindowFrames,
      `${templateId}.${move.id}: activeWindowFrameCount must retain overlapping hit-window volume`,
    );
  }
}

function expectedPhase(move, authoredFrame, activeFrames) {
  if (authoredFrame < move.startup) return "startup";
  if (activeFrames.has(authoredFrame)) return "active";
  const finalActiveFrame = Math.max(...move.activeWindows.map((window) => window.end));
  return authoredFrame <= finalActiveFrame ? "gap" : "recovery";
}

function createSeparatedGame(templateId) {
  const game = createGame({
    playerTemplate: templateId,
    aiTemplate: templateId === "vanguard" ? "ember" : "vanguard",
    roundTimeSeconds: 30,
  });
  game.fighters[0].x = 280;
  game.fighters[1].x = 1000;
  game.fighters[0].facing = 1;
  game.fighters[1].facing = -1;
  return game;
}

function verifyMoveTimeline({
  label,
  templateId,
  moveId,
  startInputs,
  expectedPhaseCounts,
  verifyStrikeGeometry = false,
}) {
  const game = createSeparatedGame(templateId);
  const move = getMoveData(templateId, moveId);
  assert(move, `${label}: authored move must exist`);

  for (const input of startInputs) {
    stepGame(game, { p1: input, p2: {} });
  }

  const fighter = game.fighters[0];
  assert.equal(fighter.currentMove?.id, moveId, `${label}: public input must start the expected move`);

  const activeFrames = activeFrameSet(move);
  assert.equal(
    activeFrames.size,
    move.activeFrameCount,
    `${label}: authored activeFrameCount must equal the union of active-window frames`,
  );

  const observedPhaseCounts = {
    startup: 0,
    active: 0,
    gap: 0,
    recovery: 0,
  };

  for (let authoredFrame = 1; authoredFrame <= move.totalFrames; authoredFrame += 1) {
    const frameData = game.frameData[0];
    const expected = expectedPhase(move, authoredFrame, activeFrames);
    const hurtboxes = boxesFor(game, 0, "hurt");
    const hitboxes = boxesFor(game, 0, "hit");
    const visual = getFighterVisualPose(fighter);

    assert.equal(
      fighter.currentMove?.id,
      moveId,
      `${label}: move must remain active in the runtime through authored frame ${authoredFrame}`,
    );
    assert.equal(
      frameData.moveId,
      moveId,
      `${label}: move id must be queryable on authored frame ${authoredFrame}`,
    );
    assert.equal(
      frameData.frame,
      authoredFrame,
      `${label}: public frame snapshot must match authored frame ${authoredFrame}`,
    );
    assert.equal(
      frameData.phase,
      expected,
      `${label}: public phase must be ${expected} on authored frame ${authoredFrame}`,
    );
    assert.equal(
      fighter.movePhase,
      expected,
      `${label}: fighter pose phase must agree with frameData on authored frame ${authoredFrame}`,
    );
    assert.equal(
      visual.phase,
      expected,
      `${label}: rendered pose clock must agree with combat on authored frame ${authoredFrame}`,
    );
    assert.equal(
      typeof fighter.moveAnimation,
      "string",
      `${label}: animation/pose id must be queryable on authored frame ${authoredFrame}`,
    );
    assert(
      fighter.moveAnimation.length > 0,
      `${label}: animation/pose id must not be empty on authored frame ${authoredFrame}`,
    );

    assert(
      hurtboxes.length > 0,
      `${label}: at least one hurtbox must be queryable on authored frame ${authoredFrame}`,
    );
    hurtboxes.forEach((box, index) => {
      assertPublicBox(box, `${label} frame ${authoredFrame} hurtbox ${index}`);
    });
    assert(
      hurtboxes.some((box) => pointInside(
        box,
        visual.joints.head[0],
        visual.joints.head[1] - visual.headRadius + 1,
      )),
      `${label}: upper hurtbox must cover the rendered head silhouette on frame ${authoredFrame}`,
    );

    if (expected === "active") {
      assert(
        hitboxes.length > 0,
        `${label}: every active frame must expose an attack hitbox (missing on frame ${authoredFrame})`,
      );
      if (verifyStrikeGeometry) {
        const [strikeX, strikeY] = visual.strikePoint;
        assert(
          hitboxes.some((box) => pointInside(box, strikeX, strikeY)),
          `${label}: active hitbox must cover the rendered ${visual.strikeJoint} on frame ${authoredFrame}`,
        );
        assert(
          hurtboxes.some((box) => pointInside(box, strikeX, strikeY)),
          `${label}: limb hurtbox must cover the rendered ${visual.strikeJoint} on frame ${authoredFrame}`,
        );
      }
    } else {
      assert.equal(
        hitboxes.length,
        0,
        `${label}: ${expected} frame ${authoredFrame} must not expose an attack hitbox`,
      );
    }
    hitboxes.forEach((box, index) => {
      assertPublicBox(box, `${label} frame ${authoredFrame} hitbox ${index}`);
    });

    observedPhaseCounts[expected] += 1;
    if (authoredFrame < move.totalFrames) stepGame(game, { p1: {}, p2: {} });
  }

  assert.deepEqual(
    observedPhaseCounts,
    expectedPhaseCounts,
    `${label}: startup/active/gap/recovery durations must retain their authored frame counts`,
  );

  stepGame(game, { p1: {}, p2: {} });
  assert.equal(fighter.currentMove, null, `${label}: move must finish immediately after totalFrames`);
  assert.equal(game.frameData[0].phase, "idle", `${label}: pose phase must return to idle after recovery`);
  assert.equal(boxesFor(game, 0, "hit").length, 0, `${label}: attack hitbox must be cleared after recovery`);
  assert(boxesFor(game, 0, "hurt").length > 0, `${label}: idle hurtboxes must remain queryable`);
}

verifyMoveTimeline({
  label: "Vanguard standing light punch",
  templateId: "vanguard",
  moveId: "standLightPunch",
  startInputs: [{ lp: true }],
  expectedPhaseCounts: {
    startup: 3,
    active: 3,
    gap: 0,
    recovery: 7,
  },
  verifyStrikeGeometry: true,
});

verifyMoveTimeline({
  label: "Ember far light punch",
  templateId: "ember",
  moveId: "farA",
  startInputs: [{ lp: true }],
  expectedPhaseCounts: {
    startup: 5,
    active: 2,
    gap: 0,
    recovery: 14,
  },
  verifyStrikeGeometry: true,
});

verifyMoveTimeline({
  label: "Vanguard axe kick multi-window attack",
  templateId: "vanguard",
  moveId: "axeKick",
  startInputs: [{ left: true, hk: true }],
  expectedPhaseCounts: {
    startup: 9,
    active: 8,
    gap: 5,
    recovery: 21,
  },
});

// Projectile generation is not a melee-active frame. The debug snapshot must
// show the real orange projectile only, never a one-frame fake red strike box.
const projectileGame = createSeparatedGame("vanguard");
for (const input of [
  { down: true },
  { down: true, right: true },
  { right: true },
  { right: true, lp: true },
]) {
  stepGame(projectileGame, { p1: input, p2: {} });
}
const projectileMove = projectileGame.fighters[0].currentMove;
assert.equal(projectileMove?.id, "hadokenLight");
const projectileFrame = projectileMove.projectileFrame ?? projectileMove.startup;
while (projectileGame.frameData[0].frame < projectileFrame) {
  stepGame(projectileGame, { p1: {}, p2: {} });
}
assert.equal(boxesFor(projectileGame, 0, "hit").length, 0, "projectile startup must not expose a fake melee hitbox");
assert(boxesFor(projectileGame, 0, "projectile").length > 0, "projectile generation frame must expose the real projectile box");

process.stdout.write(
  "action timeline ok · startup/active/gap/recovery boxes + per-frame pose snapshots\n",
);
