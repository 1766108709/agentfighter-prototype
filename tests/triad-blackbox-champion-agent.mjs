import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import createAgent, {
  createAgent as createAlias,
  createTriadBlackboxChampionAgent,
} from "../src/triad-blackbox-champion-agent.js";

const INPUT_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);

function fighter({ x, facing, width = 40, name = randomBytes(8).toString("hex") }) {
  return {
    relation: "self",
    name,
    templateId: randomBytes(8).toString("hex"),
    position: { x, y: 0 },
    velocity: { x: 0, y: 0 },
    size: { width, height: 96 },
    facing,
    onGround: true,
    health: 10000,
    maxHealth: 10000,
    recoverableHealth: 0,
    roundsWon: 0,
    resources: {
      super: 0,
      superMax: 300,
      drive: 6000,
      driveMax: 6000,
      guard: 10000,
      guardMax: 10000,
      stun: 0,
      stunMax: 10000,
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

function observation({ frame = 0, gap = 58, facing = 1, phase = "fighting", selfName, otherName } = {}) {
  const selfX = facing > 0 ? 200 : 400;
  const otherX = selfX + facing * (40 + gap);
  const self = fighter({ x: selfX, facing, name: selfName });
  const other = fighter({ x: otherX, facing: -facing, name: otherName });
  other.relation = "opponent";
  return {
    schema: "agentfighter.observation",
    version: 1,
    frame,
    roundFrame: frame,
    tickRate: 60,
    phase,
    timerFrames: 3600 - frame,
    side: facing > 0 ? "left" : "right",
    selfIndex: facing > 0 ? 0 : 1,
    perception: { delayFrames: 0, opponentFrame: frame },
    round: { number: 1, score: { self: 0, opponent: 0 } },
    arena: { width: 960, height: 540, floorY: 460, left: 48, right: 912 },
    self,
    opponent: other,
    projectiles: [],
    recentEvents: [],
  };
}

function validateAction(action) {
  assert.deepEqual(Object.keys(action).sort(), ["input", "schema", "version"]);
  assert.equal(action.schema, "agentfighter.action");
  assert.equal(action.version, 1);
  assert.deepEqual(Object.keys(action.input).sort(), [...INPUT_KEYS].sort());
  for (const value of Object.values(action.input)) assert.equal(typeof value, "boolean");
  assert(!(action.input.left && action.input.right));
  assert(!(action.input.up && action.input.down));
  assert(Object.isFrozen(action));
  assert(Object.isFrozen(action.input));
  return action.input;
}

function pressed(input) {
  return Object.keys(input).filter((key) => input[key]);
}

assert.equal(createAgent, createAlias);
assert.equal(createAgent, createTriadBlackboxChampionAgent);
assert.equal(createAgent.length, 0, "gauntlet factory must receive no metadata");

const agent = createAgent();
assert.equal(typeof agent.act, "function");
assert.equal(typeof agent.reset, "function");
assert.equal(typeof agent.end, "function");
assert.equal(typeof agent.getDebugState, "function");
assert.equal(Object.hasOwn(agent, "decide"), false);

agent.reset({ seed: 0xffffffff, opponent: { name: randomBytes(8).toString("hex") } });
assert.deepEqual(pressed(validateAction(agent.act(observation({ frame: 1, gap: 58.001, facing: 1 })))), ["right"]);
assert.deepEqual(pressed(validateAction(agent.act(observation({ frame: 2, gap: 58.001, facing: -1 })))), ["left"]);

assert.deepEqual(
  pressed(validateAction(agent.act(observation({ frame: 0, gap: 58, facing: 1 })))),
  ["right", "throw"],
  "exactly 58px is inside throw range",
);
assert.deepEqual(
  pressed(validateAction(agent.act(observation({ frame: 3, gap: 0, facing: -1 })))),
  ["left", "throw"],
  "every third public frame uses relative forward+throw",
);
assert.deepEqual(
  pressed(validateAction(agent.act(observation({ frame: 1, gap: 58, facing: 1 })))),
  ["left", "down", "guard"],
);
assert.deepEqual(
  pressed(validateAction(agent.act(observation({ frame: 2, gap: 20, facing: -1 })))),
  ["right", "down", "guard"],
);
assert.deepEqual(
  pressed(validateAction(agent.act(observation({ frame: 6, gap: 500, facing: 1 })))),
  ["right"],
  "distance takes priority over the three-frame throw cadence",
);

for (const phase of ["intro", "roundOver", "matchOver", "paused"]) {
  assert.deepEqual(pressed(validateAction(agent.act(observation({ frame: 9, gap: 0, phase })))), []);
}
assert.deepEqual(pressed(validateAction(agent.act(null))), []);

const identities = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
const traces = identities.map((identity) => {
  const instance = createAgent();
  instance.reset({
    schema: "agentfighter.match-info",
    version: 1,
    matchId: identity,
    seed: Number.parseInt(identity.slice(0, 8), 16),
    opponent: { name: identity },
  });
  return Array.from({ length: 90 }, (_, frame) => {
    const gap = [57.999, 58, 58.001, 160][frame % 4];
    const value = observation({
      frame,
      gap,
      facing: frame % 2 === 0 ? 1 : -1,
      selfName: `self-${identity}`,
      otherName: `other-${identity}`,
    });
    return validateAction(instance.act(value));
  });
});
assert.deepEqual(traces[1], traces[0], "random public identities and match metadata cannot alter actions");
assert.deepEqual(traces[2], traces[0], "actions depend only on public combat geometry and frame cadence");

const beforeReset = agent.getDebugState();
assert.deepEqual(Object.keys(beforeReset), [
  "resets", "decisions", "neutralActions", "forwardActions", "guardActions", "throwActions", "endings",
]);
for (const value of Object.values(beforeReset)) assert(Number.isInteger(value) && value >= 0);
assert(!/(?:name|identity|seed|preset|intent|reason|observation|opponent)/i.test(JSON.stringify(beforeReset)));
agent.end({ outcome: "loss", opponent: { name: identities[0] } });
assert.equal(agent.getDebugState().endings, 1);
agent.reset({ seed: 29999, opponent: { name: identities[1] } });
assert.deepEqual(agent.getDebugState(), {
  resets: beforeReset.resets + 1,
  decisions: 0,
  neutralActions: 0,
  forwardActions: 0,
  guardActions: 0,
  throwActions: 0,
  endings: 0,
});

const sourcePath = fileURLToPath(new URL("../src/triad-blackbox-champion-agent.js", import.meta.url));
const source = await readFile(sourcePath, "utf8");
assert(!/(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["'][^"']+["']/m.test(source));
assert(!/\bimport\s*\(/.test(source));

process.stdout.write(
  `triad-blackbox-champion-agent ok · identities=${identities.length} · traceFrames=${traces[0].length}`
  + " · gapBoundary=58 · cadence=3 · imports=0\n",
);
