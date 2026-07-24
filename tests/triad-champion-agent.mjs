import assert from "node:assert/strict";

import createTriadChampionAgent, {
  createAgent,
  createCandidate,
  createTriadChampionAgent as namedFactory,
} from "../src/triad-champion-agent.js";

const DEBUG_METHOD = ["get", "Debug", "State"].join("");
const INPUT_KEYS = [
  "left", "right", "up", "down", "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
];

function validateAction(action) {
  if (action?.schema !== "agentfighter.action" || action?.version !== 1) return false;
  if (!action.input || Object.keys(action.input).length !== INPUT_KEYS.length) return false;
  return INPUT_KEYS.every((key) => typeof action.input[key] === "boolean");
}

function fighter(templateId, x, facing) {
  return {
    relation: "self",
    name: templateId,
    templateId,
    position: { x, y: 388 },
    velocity: { x: 0, y: 0 },
    size: { width: 46, height: 112 },
    facing,
    onGround: true,
    health: templateId === "vanguard" ? 10_000 : 1_000,
    maxHealth: templateId === "vanguard" ? 10_000 : 1_000,
    recoverableHealth: 0,
    roundsWon: 0,
    resources: {
      super: 300,
      superMax: 300,
      drive: 600,
      driveMax: 600,
      guard: 100,
      guardMax: 100,
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

function observation(templateId, opponentTemplateId, frame = 1) {
  const self = fighter(templateId, 220, 1);
  const opponent = fighter(opponentTemplateId, 570, -1);
  opponent.relation = "opponent";
  return {
    schema: "agentfighter.observation",
    version: 1,
    frame,
    roundFrame: frame,
    tickRate: 60,
    phase: "fighting",
    timerFrames: 3_600 - frame,
    side: "left",
    selfIndex: 0,
    perception: { delayFrames: 0, opponentFrame: frame },
    round: { number: 1, score: { self: 0, opponent: 0 } },
    arena: { width: 960, height: 540, floorY: 444, left: 60, right: 900 },
    self,
    opponent,
    projectiles: [],
    recentEvents: [],
  };
}

for (const factory of [createTriadChampionAgent, namedFactory, createCandidate, createAgent]) {
  const agent = factory();
  assert.equal(typeof agent.reset, "function");
  assert.equal(typeof agent.act, "function");
  assert.equal(typeof agent.end, "function");
  assert.equal(typeof agent[DEBUG_METHOD], "function");
}

for (const templateId of ["vanguard", "ember"]) {
  const opponentTemplateId = templateId === "vanguard" ? "ember" : "vanguard";
  const agent = createTriadChampionAgent();
  agent.reset();
  for (let frame = 1; frame <= 90; frame += 1) {
    const action = agent.act(observation(templateId, opponentTemplateId, frame));
    assert.equal(validateAction(action), true);
    assert.equal(action.input.left && action.input.right, false);
    assert.equal(action.input.up && action.input.down, false);
  }
  agent.end({ outcome: "draw" });
  const debug = agent[DEBUG_METHOD]();
  assert.equal(debug.selfTemplate, templateId);
  assert.equal(debug.lastResult, "draw");
  assert.equal(Object.hasOwn(debug, "intent"), false);
  assert.equal(Object.hasOwn(debug, "reason"), false);
  assert.doesNotThrow(() => JSON.stringify(debug));
}

console.log("Triad champion agent tests passed.");
