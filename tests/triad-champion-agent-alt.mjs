import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import createAgent from "../src/triad-champion-agent-alt.js";

const ACTION_KEYS = [
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
];

function fighter(templateId, x, facing) {
  return {
    relation: "self",
    templateId,
    position: { x, y: 0 },
    velocity: { x: 0, y: 0 },
    size: { width: 48, height: 96 },
    facing,
    onGround: true,
    health: 10_000,
    maxHealth: 10_000,
    recoverableHealth: 0,
    resources: {
      super: 300,
      superMax: 300,
      drive: 600,
      driveMax: 600,
      guard: 600,
      guardMax: 600,
      stun: 0,
      stunMax: 100,
      burnout: false,
    },
    state: {
      action: "idle",
      moveId: null,
      moveName: null,
      phase: "idle",
      actionFrame: 0,
      hitstunFrames: 0,
      blockstunFrames: 0,
      knockdownFrames: 0,
      knockdownType: "none",
      comboCount: 0,
      comboDamage: 0,
    },
  };
}

function observation(templateId = "vanguard") {
  const self = fighter(templateId, 180, 1);
  const opponent = fighter(templateId === "vanguard" ? "ember" : "vanguard", 620, -1);
  opponent.relation = "opponent";
  return {
    schema: "agentfighter.observation",
    version: 1,
    frame: 1,
    roundFrame: 1,
    tickRate: 60,
    phase: "fighting",
    timerFrames: 3600,
    side: "left",
    selfIndex: 0,
    perception: { delayFrames: 0, opponentFrame: 1 },
    round: { number: 1, score: { self: 0, opponent: 0 } },
    arena: { width: 960, height: 540, floorY: 450, left: 0, right: 960 },
    self,
    opponent,
    projectiles: [],
    recentEvents: [],
  };
}

function assertAction(action) {
  assert.equal(action.schema, "agentfighter.action");
  assert.equal(action.version, 1);
  assert.deepEqual(Object.keys(action.input), ACTION_KEYS);
  for (const value of Object.values(action.input)) assert.equal(typeof value, "boolean");
  assert(Object.isFrozen(action));
  assert(Object.isFrozen(action.input));
}

{
  const agent = createAgent("vanguard");
  agent.reset({ self: { templateId: "vanguard" } });
  const action = agent.act(observation("vanguard"));
  assertAction(action);
}

{
  const agent = createAgent("ember");
  agent.reset({ self: { templateId: "ember" } });
  const view = observation("ember");
  view.projectiles.push({
    id: 1,
    owner: "opponent",
    sourceMoveId: "hadokenLight",
    position: { x: 500, y: 410 },
    velocity: { x: -8, y: 0 },
    size: { width: 20, height: 20, radius: 10 },
    facing: -1,
    lifeFrames: 120,
    variant: "normal",
  });
  const action = agent.act(view);
  assertAction(action);
  assert.equal(action.input.right, true);
  assert.equal(action.input.up, true);
}

{
  const source = await readFile(new URL("../src/triad-champion-agent-alt.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /observation\?\.(?:game|raw)|observation\.(?:game|raw)/);
  assert.doesNotMatch(source, /opponent\.(?:templateId|name|preset|label|identity)/);
  assert.doesNotMatch(source, /info\?\.(?:seed|opponent)/);
}

console.log("triad champion alt tests passed");
