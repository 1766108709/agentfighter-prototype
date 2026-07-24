import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src");
const ENTRY = path.join(ROOT, "src", "triad-champion-agent.js");
const FORBIDDEN_MODULE_BASENAMES = new Set([
  "ai.js",
  "ai-planner.js",
  "ai-executor.js",
]);

const STATIC_IMPORT_RE = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^\"'`;]*?\s+from\s*)?[\"']([^\"']+)[\"']/gm;
const HIGH_RISK_SOURCE_RULES = [
  [/\b(?:balanced|pressure|zoner)\b/i, "named opponent/preset label"],
  [/\bpreset\b/i, "opponent preset access"],
  [/(?:\.|\?\.)\s*getDebugState\s*(?:\?\.)?\s*\(|\[\s*["']getDebugState["']\s*\]\s*(?:\?\.)?\s*\(/, "external getDebugState call"],
  [/\b(?:matchInfo|info)\s*(?:\?\.|\.)\s*seed\b|\b(?:matchInfo|info)\s*\[\s*["']seed["']\s*\]/, "matchInfo.seed access"],
  [/\{[^{}]*\bseed\b[^{}]*\}\s*=\s*(?:matchInfo|info)\b/, "matchInfo seed destructuring"],
  [/\braw\s*game\b|\brawGame\b|\.\s*fighters\b|\.\s*combatEvents\b/i, "raw game access"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\brequire\s*\(|\bcreateRequire\b/, "CommonJS/dynamic module loading"],
  [/\b(?:node:)?fs(?:\/promises)?\b|\breadFile(?:Sync)?\s*\(/, "filesystem access"],
  [/\b(?:child_process|worker_threads|node:vm|node:module|process\.binding)\b/, "runtime/module escape hatch"],
  [/\b(?:eval|Function)\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, "runtime code/network loading"],
  [/\bMath\.random\s*\(|\bDate\.now\s*\(|\bperformance\.now\s*\(|\bcrypto\.getRandomValues\s*\(/, "external entropy/clock access"],
];

const INPUT_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);
const INPUT_KEY_SET = new Set(INPUT_KEYS);
const BLOCKED_RUNTIME_KEYS = new Set([
  "game", "rawGame", "fighters", "combatEvents", "ai", "controller",
  "commandBuffer", "directionHistory", "lastInput", "previousInput",
  "preset", "getDebugState",
]);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function assertNotForbiddenTarget(target, from = ENTRY) {
  const basename = path.basename(target).toLowerCase();
  assert(
    !FORBIDDEN_MODULE_BASENAMES.has(basename),
    `clean-room violation: ${path.relative(ROOT, from)} resolves forbidden module ${basename}`,
  );
}

function assertInsideSourceRoot(target, from = ENTRY) {
  const relative = path.relative(SOURCE_ROOT, target);
  assert(
    relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative),
    `clean-room dependency escapes src/: ${path.relative(ROOT, from)} -> ${target}`,
  );
}

async function resolveLocalModule(specifier, importer) {
  assert(
    specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:"),
    `clean-room candidate graph may only use local ESM dependencies; found ${JSON.stringify(specifier)}`,
  );
  const cleanSpecifier = specifier.replace(/[?#].*$/, "");
  const unresolved = cleanSpecifier.startsWith("file:")
    ? fileURLToPath(cleanSpecifier)
    : path.resolve(path.dirname(importer), cleanSpecifier);
  assertNotForbiddenTarget(unresolved, importer);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.js`, `${unresolved}.mjs`, path.join(unresolved, "index.js")];
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    const canonical = await realpath(candidate);
    assertNotForbiddenTarget(canonical, importer);
    assertInsideSourceRoot(canonical, importer);
    return canonical;
  }
  assert.fail(`cannot resolve clean-room dependency ${JSON.stringify(specifier)} from ${path.relative(ROOT, importer)}`);
}

function staticSpecifiers(source) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match[1]);
}

async function auditCandidateGraph(entry) {
  assert(await exists(entry), `candidate is missing: ${path.relative(ROOT, entry)}`);
  const queue = [await realpath(entry)];
  const seen = new Set();
  while (queue.length > 0) {
    const modulePath = queue.shift();
    if (seen.has(modulePath)) continue;
    assertNotForbiddenTarget(modulePath);
    assertInsideSourceRoot(modulePath);
    seen.add(modulePath);
    // The target check above intentionally happens before the first read.
    const source = await readFile(modulePath, "utf8");
    const label = path.relative(ROOT, modulePath);
    for (const [pattern, reason] of HIGH_RISK_SOURCE_RULES) {
      assert(!pattern.test(source), `clean-room violation in ${label}: ${reason}`);
    }
    for (const specifier of staticSpecifiers(source)) {
      assertNotForbiddenTarget(specifier, modulePath);
      queue.push(await resolveLocalModule(specifier, modulePath));
    }
  }
  return [...seen];
}

const graph = await auditCandidateGraph(ENTRY);
const candidateModule = await import(`${pathToFileURL(ENTRY).href}?cleanroom-audit`);

function resolveFactory(namespace) {
  const choices = [
    ["createTriadChampionAgent", namespace.createTriadChampionAgent],
    ["createAgent", namespace.createAgent],
    ["default", namespace.default],
  ];
  const selected = choices.find(([, value]) => typeof value === "function");
  assert(selected, "candidate must export a factory function (createTriadChampionAgent, createAgent, or default)");
  return selected;
}

const [factoryName, createCandidate] = resolveFactory(candidateModule);

function instantiateCandidate() {
  const agent = createCandidate();
  assert(agent && typeof agent === "object" && !Array.isArray(agent), `${factoryName}() must return an Agent V1 object`);
  assert.equal(typeof agent.act, "function", "candidate must implement act(observation)");
  assert.equal(Object.hasOwn(agent, "decide"), false, "candidate must not expose a raw-game decide(game) API");
  if (agent.getDebugState !== undefined) {
    assert.equal(typeof agent.getDebugState, "function", "candidate self-diagnostics must be a function");
  }
  return agent;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function guardedPublicValue(value, label, cache = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (cache.has(value)) return cache.get(value);
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "string" && BLOCKED_RUNTIME_KEYS.has(property)) {
        assert.fail(`${label} attempted non-public runtime access: ${property}`);
      }
      const nested = Reflect.get(target, property, receiver);
      return guardedPublicValue(nested, `${label}.${String(property)}`, cache);
    },
    set(_target, property) {
      assert.fail(`${label} attempted mutation: ${String(property)}`);
    },
    defineProperty(_target, property) {
      assert.fail(`${label} attempted mutation: ${String(property)}`);
    },
    deleteProperty(_target, property) {
      assert.fail(`${label} attempted mutation: ${String(property)}`);
    },
  });
  cache.set(value, proxy);
  return proxy;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFighter(relation, name, templateId, frame, x, facing) {
  const opponentActing = relation === "opponent" && frame >= 24 && frame < 35;
  const selfStunned = relation === "self" && frame >= 42 && frame < 47;
  return {
    relation,
    name,
    templateId,
    position: { x, y: 0 },
    velocity: { x: frame % 18 < 5 ? facing * 1.6 : 0, y: 0 },
    size: { width: 42, height: 96 },
    facing,
    onGround: true,
    health: relation === "self" ? Math.max(1, 10000 - frame * 9) : Math.max(1, 10000 - frame * 7),
    maxHealth: 10000,
    recoverableHealth: 0,
    roundsWon: 0,
    resources: {
      super: 1200 + frame * 8,
      superMax: 3000,
      drive: 6000 - frame * 3,
      driveMax: 6000,
      guard: 10000,
      guardMax: 10000,
      stun: 0,
      stunMax: 10000,
      burnout: false,
    },
    state: {
      action: opponentActing ? "standHeavyPunch" : selfStunned ? "hitstun" : "idle",
      moveId: opponentActing ? "standHeavyPunch" : null,
      moveName: opponentActing ? "Standing Heavy Punch" : null,
      phase: opponentActing ? (frame < 34 ? "startup" : "active") : "idle",
      actionFrame: opponentActing ? frame - 23 : 0,
      hitstunFrames: selfStunned ? 47 - frame : 0,
      blockstunFrames: 0,
      knockdownFrames: 0,
      knockdownType: "none",
      comboCount: 0,
      comboDamage: 0,
    },
  };
}

function makeObservation(frame) {
  const separation = frame < 20 ? 260 - frame * 5 : frame < 50 ? 160 : 220;
  const selfX = 300 + (frame % 10);
  const opponentX = selfX + separation;
  const recentEvents = [];
  if (frame >= 24) {
    recentEvents.push({
      frame: 24,
      type: "moveStart",
      fighterId: 1,
      moveId: "standHeavyPunch",
      category: "normal",
      tags: ["normal", "standing", "punch", "heavy"],
      range: 72,
    });
  }
  if (frame >= 42) {
    recentEvents.push({
      frame: 42,
      type: "contact",
      attackerId: 1,
      defenderId: 0,
      moveId: "standHeavyPunch",
      category: "normal",
      outcome: "hit",
    });
  }
  return deepFreeze({
    schema: "agentfighter.observation",
    version: 1,
    frame,
    roundFrame: frame,
    tickRate: 60,
    phase: "fighting",
    timerFrames: 3600 - frame,
    side: "left",
    selfIndex: 0,
    perception: { delayFrames: 0, opponentFrame: frame },
    round: { number: 1, score: { self: 0, opponent: 0 } },
    arena: { width: 960, height: 540, floorY: 460, left: 48, right: 912 },
    self: makeFighter("self", "Same Public Self", "vanguard", frame, selfX, 1),
    opponent: makeFighter("opponent", "Same Public Opponent", "ember", frame, opponentX, -1),
    projectiles: frame >= 54 && frame < 72 ? [{
      id: 17,
      owner: "opponent",
      sourceMoveId: "projectile",
      position: { x: opponentX - (frame - 54) * 4, y: 390 },
      velocity: { x: -4, y: 0 },
      size: { width: 24, height: 24, radius: 12 },
      facing: -1,
      lifeFrames: 72 - frame,
      variant: "normal",
    }] : [],
    recentEvents,
  });
}

function makeMatchInfo(identity, index) {
  return deepFreeze({
    schema: "agentfighter.match-info",
    version: 1,
    matchId: `cleanroom-${identity}-${index}`,
    seed: [0, 0x7fffffff, 0xffffffff][index],
    tickRate: 60,
    bestOf: 3,
    roundSeconds: 60,
    side: "left",
    selfIndex: 0,
    self: { name: `self-${identity}`, templateId: "vanguard", maxHealth: 10000 },
    opponent: { name: `opponent-${identity}`, templateId: "ember", maxHealth: 10000 },
    arena: { width: 960, height: 540, floorY: 460, left: 48, right: 912 },
  });
}

function validateAction(action, label) {
  assert(action && typeof action === "object" && !Array.isArray(action), `${label} must return an ActionV1 object`);
  assert.deepEqual(Object.keys(action).sort(), ["input", "schema", "version"], `${label} ActionV1 top-level keys`);
  assert.equal(action.schema, "agentfighter.action", `${label} ActionV1 schema`);
  assert.equal(action.version, 1, `${label} ActionV1 version`);
  assert(action.input && typeof action.input === "object" && !Array.isArray(action.input), `${label}.input must be an object`);
  assert.deepEqual(Object.keys(action.input).sort(), [...INPUT_KEYS].sort(), `${label} must emit exactly canonical input keys`);
  for (const [key, value] of Object.entries(action.input)) {
    assert(INPUT_KEY_SET.has(key), `${label} emitted unknown input ${key}`);
    assert.equal(typeof value, "boolean", `${label}.input.${key} must be boolean`);
  }
  assert(!(action.input.left && action.input.right), `${label} cannot press left+right`);
  assert(!(action.input.up && action.input.down), `${label} cannot press up+down`);
  return clone(action);
}

function callSync(callback, label) {
  const returned = callback();
  assert(!(returned && typeof returned.then === "function"), `${label} must be synchronous`);
  return returned;
}

function validateSelfDiagnostics(agent, label) {
  if (typeof agent.getDebugState !== "function") return null;
  const first = callSync(() => agent.getDebugState(), `${label}.getDebugState`);
  let serialized;
  assert.doesNotThrow(() => { serialized = JSON.stringify(first); }, `${label} self-diagnostics must be JSON-safe`);
  assert(serialized.length <= 16_384, `${label} self-diagnostics must stay bounded`);
  const normalized = JSON.parse(serialized);
  assert.deepEqual(
    JSON.parse(JSON.stringify(callSync(() => agent.getDebugState(), `${label}.getDebugState repeat`))),
    normalized,
    `${label} self-diagnostics must be a read-only snapshot`,
  );
  assert(
    !/(?:opponent|preset|intent|reason|observation|rawgame|fighters|combatevents|commandbuffer|directionhistory)/i.test(serialized),
    `${label} self-diagnostics may contain only own queue/mode/counters, not opponent or raw Observation data`,
  );
  assert(
    !serialized.includes("agentfighter.observation")
      && !serialized.includes("Same Public Self")
      && !serialized.includes("Same Public Opponent"),
    `${label} self-diagnostics must not retain a raw Observation snapshot`,
  );
  return normalized;
}

function testObservationAndHistoryOnly() {
  const identities = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
  assert.equal(new Set(identities).size, 3, "randomized fake identities must be unique");
  const agents = identities.map(() => instantiateCandidate());
  agents.forEach((agent, index) => {
    const info = guardedPublicValue(clone(makeMatchInfo(identities[index], index)), `agent-${index}.matchInfo`);
    callSync(() => agent.reset?.(info), `agent-${index}.reset`);
  });

  const traces = agents.map(() => []);
  for (let frame = 0; frame < 96; frame += 1) {
    const canonicalObservation = makeObservation(frame);
    agents.forEach((agent, index) => {
      // Each agent gets a separate immutable clone; combat observations remain
      // byte-for-byte identical despite randomized match identities and seeds.
      const observation = guardedPublicValue(
        clone(canonicalObservation),
        `agent-${index}.observation[${frame}]`,
      );
      const action = callSync(() => agent.act(observation), `agent-${index}.act[${frame}]`);
      traces[index].push(validateAction(action, `agent-${index}.act[${frame}]`));
    });
  }
  assert.deepEqual(traces[1], traces[0], "outputs must not depend on randomized opponent identity or matchInfo.seed");
  assert.deepEqual(traces[2], traces[0], "outputs must depend only on the public observation trace and own history");
  agents.forEach((agent, index) => validateSelfDiagnostics(agent, `agent-${index}`));
  return { identities, frames: traces[0].length };
}

function testPublicNameAgnosticism() {
  const identities = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
  const agents = identities.map(() => instantiateCandidate());
  agents.forEach((agent, index) => {
    const commonInfo = clone(makeMatchInfo("same-reset-identity", 0));
    callSync(
      () => agent.reset?.(guardedPublicValue(commonInfo, `name-agent-${index}.matchInfo`)),
      `name-agent-${index}.reset`,
    );
  });
  const traces = agents.map(() => []);
  for (let frame = 0; frame < 64; frame += 1) {
    agents.forEach((agent, index) => {
      const observation = clone(makeObservation(frame));
      // Identity labels are public but are not combat evidence and must not
      // select a hidden matchup policy.
      observation.self.name = `self-${identities[index]}`;
      observation.opponent.name = `opponent-${identities[index]}`;
      const guarded = guardedPublicValue(observation, `name-agent-${index}.observation[${frame}]`);
      traces[index].push(validateAction(
        callSync(() => agent.act(guarded), `name-agent-${index}.act[${frame}]`),
        `name-agent-${index}.act[${frame}]`,
      ));
    });
  }
  assert.deepEqual(traces[1], traces[0], "public fighter names must not select a matchup policy");
  assert.deepEqual(traces[2], traces[0], "randomized public identity labels must not affect actions");
  return traces[0].length;
}

function testResetClearsOwnHistory() {
  const agent = instantiateCandidate();
  const run = (identity, seedIndex) => {
    callSync(
      () => agent.reset?.(guardedPublicValue(clone(makeMatchInfo(identity, seedIndex)), `reset-${identity}.matchInfo`)),
      `reset-${identity}`,
    );
    const trace = [];
    for (let frame = 0; frame < 64; frame += 1) {
      const observation = guardedPublicValue(clone(makeObservation(frame)), `reset-${identity}.observation[${frame}]`);
      trace.push(validateAction(
        callSync(() => agent.act(observation), `reset-${identity}.act[${frame}]`),
        `reset-${identity}.act[${frame}]`,
      ));
    }
    return trace;
  };
  const first = run(randomBytes(12).toString("hex"), 0);
  callSync(() => agent.end?.({ outcome: "loss" }), "candidate.end between reset traces");
  const second = run(randomBytes(12).toString("hex"), 2);
  assert.deepEqual(second, first, "reset must clear own history and ignore prior result/randomized match metadata");
  return first.length;
}

async function testSymmetricRealtimeObservation() {
  // The formal evaluator is intentionally outside the candidate dependency
  // graph and may load trusted built-in tournament support.
  const { runHeadlessTournament } = await import("../src/headless.js");
  const observed = { A: [], B: [] };
  const candidate = instantiateCandidate();
  const neutral = {
    name: "cleanroom-neutral",
    reset() {},
    act() {
      return {
        schema: "agentfighter.action",
        version: 1,
        input: Object.fromEntries(INPUT_KEYS.map((key) => [key, false])),
      };
    },
    end() {},
  };
  const wrap = (participant, agent) => ({
    name: agent.name,
    reset: (...args) => agent.reset?.(...args),
    act(observation) {
      observed[participant].push({
        frame: observation.frame,
        delayFrames: observation.perception.delayFrames,
        opponentFrame: observation.perception.opponentFrame,
      });
      return agent.act(observation);
    },
    end: (...args) => agent.end?.(...args),
  });
  let decisionFrames = 0;
  const summary = runHeadlessTournament({
    matches: 1,
    agentA: "balanced",
    agentB: "zoner",
    templateA: "vanguard",
    templateB: "ember",
    difficulty: "normal",
    seed: 0x51a7,
    roundSeconds: 10,
    bestOf: 1,
    swapSides: false,
    maxFramesPerMatch: 120,
  }, {
    agents: { A: wrap("A", candidate), B: wrap("B", neutral) },
    onDecision({ frame, decisions }) {
      decisionFrames += 1;
      for (const participant of ["A", "B"]) {
        assert.equal(decisions[participant].decisionFrame, frame, `${participant} decision frame`);
        assert.equal(decisions[participant].observedFrame, frame, `${participant} realtime observation`);
      }
    },
  });
  assert.equal(Object.hasOwn(summary.settings, "delay"), false, "formal match settings must remove delay");
  assert.equal(decisionFrames, summary.totalFrames, "every formal frame must expose both decisions");
  assert(observed.A.length > 0 && observed.B.length > 0, "formal realtime check must receive observations");
  assert.equal(observed.A.length, observed.B.length, "both participants must receive equal decision counts");
  for (const participant of ["A", "B"]) {
    observed[participant].forEach((entry, index) => {
      assert.equal(entry.frame, index, `${participant} current self frame`);
      assert.equal(entry.delayFrames, 0, `${participant} declared realtime perception`);
      assert.equal(entry.opponentFrame, index, `${participant} current opponent frame`);
    });
  }
  return summary.totalFrames;
}

const provenance = testObservationAndHistoryOnly();
const nameFrames = testPublicNameAgnosticism();
const resetFrames = testResetClearsOwnHistory();
const formalFrames = await testSymmetricRealtimeObservation();

process.stdout.write(
  `triad-cleanroom ok · modules=${graph.length} · randomized-identities=${provenance.identities.length}`
  + ` · trace-frames=${provenance.frames} · name-frames=${nameFrames}`
  + ` · reset-frames=${resetFrames} · formal-frames=${formalFrames} · realtime=both-sides\n`,
);
