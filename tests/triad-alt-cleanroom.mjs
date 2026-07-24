import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateActionV1 } from "../src/agent-sdk.js";
import { runHeadlessTournament } from "../src/headless.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src");
const ENTRY = path.join(SOURCE_ROOT, "triad-champion-agent-alt.js");
const EXPECTED_ENTRY_SHA256 = "798c3a17845a8123c0deac9df77aca5b81b0e8cbe4095b4264daa6ad46ec6bb1";
const FORBIDDEN_BASENAMES = new Set(["ai.js", "ai-planner.js", "ai-executor.js"]);
const ALLOWED_EDGES = new Map([
  ["src/triad-champion-agent-alt.js", new Set(["./movesets/vanguard.js", "./movesets/ember.js"])],
  ["src/movesets/vanguard.js", new Set(["../move-data.js"])],
  ["src/movesets/ember.js", new Set(["../move-data.js"])],
  ["src/move-data.js", new Set()],
]);
const STATIC_IMPORT_RE = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/gm;
const RUNTIME_SOURCE_RULES = Object.freeze([
  [/\bimport\s*\(/, "dynamic import"],
  [/\brequire\s*\(|\bcreateRequire\b|\bmodule\s*\.\s*require\b/, "CommonJS/module loading"],
  [/\b(?:node:)?fs(?:\/promises)?\b|\breadFile(?:Sync)?\s*\(|\bwriteFile(?:Sync)?\s*\(/, "filesystem access"],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|WebTransport|EventSource)\b|\b(?:node:)?(?:http|https|net|tls|dgram|dns)(?:\/promises)?\b/, "network access"],
  [/\bprocess\b|\b(?:process|import\.meta)\s*\.\s*env\b|\b(?:Deno|Bun)\s*\.\s*env\b/, "process/environment access"],
  [/\b(?:child_process|worker_threads|node:vm|node:module|process\.binding)\b/, "runtime/module escape hatch"],
  [/\b(?:eval|Function|globalThis|document|navigator|Deno|Bun|constructor)\b|\bimport\.meta\b/, "global/runtime escape"],
  [/\bMath\s*\.\s*random\s*\(|\bDate\s*\.\s*now\s*\(|\bperformance\s*\.\s*now\s*\(|\bcrypto\s*\.\s*getRandomValues\s*\(/, "external entropy/clock"],
]);
const CANDIDATE_SOURCE_RULES = Object.freeze([
  [/\b(?:balanced|pressure|zoner)\b/i, "named opponent preset"],
  [/\b(?:seed|preset|identity)\b/i, "reset/tournament identity metadata"],
  [/\bgame\b|\brawGame\b|\.\s*fighters\b|\.\s*combatEvents\b/i, "raw game access"],
  [/\b(?:foe|opponent)\s*(?:\?\.|\.)\s*(?:name|templateId|preset|label|identity)\b/i, "opponent identity access"],
  [/\b(?:info|matchInfo)\s*(?:\?\.|\.)\s*(?:matchId|seed|opponent)\b/i, "reset identity/opponent access"],
  [/\b(?:intent|reason|getDebugState)\b/i, "external intent/reason/debug access"],
]);
const INPUT_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function assertSafeTarget(file, importer = ENTRY) {
  assert(
    !FORBIDDEN_BASENAMES.has(path.basename(file).toLowerCase()),
    `clean-room graph attempted forbidden module from ${relative(importer)}: ${path.basename(file)}`,
  );
  const fromSource = path.relative(SOURCE_ROOT, file);
  assert(
    fromSource !== "" && fromSource !== ".." && !fromSource.startsWith(`..${path.sep}`) && !path.isAbsolute(fromSource),
    `clean-room graph escaped src/: ${relative(importer)} -> ${file}`,
  );
}

async function resolveLocal(specifier, importer) {
  assert(
    specifier.startsWith("."),
    `candidate graph may use only audited local ESM dependencies: ${relative(importer)} -> ${specifier}`,
  );
  const unresolved = path.resolve(path.dirname(importer), specifier.replace(/[?#].*$/, ""));
  assertSafeTarget(unresolved, importer);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.js`, `${unresolved}.mjs`, path.join(unresolved, "index.js")];
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    const canonical = await realpath(candidate);
    assertSafeTarget(canonical, importer);
    return canonical;
  }
  assert.fail(`cannot resolve ${specifier} from ${relative(importer)}`);
}

function staticSpecifiers(source) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match[1]);
}

async function auditGraph(entry) {
  const canonicalEntry = await realpath(entry);
  const queue = [canonicalEntry];
  const seen = new Set();
  const sources = new Map();
  while (queue.length > 0) {
    const modulePath = queue.shift();
    if (seen.has(modulePath)) continue;
    assertSafeTarget(modulePath);
    seen.add(modulePath);
    // The basename/root checks intentionally happen before the first read.
    const source = await readFile(modulePath, "utf8");
    sources.set(modulePath, source);
    const label = relative(modulePath);
    const allowed = ALLOWED_EDGES.get(label);
    assert(allowed, `unexpected module in candidate dependency graph: ${label}`);
    const specifiers = staticSpecifiers(source);
    assert.deepEqual(new Set(specifiers), allowed, `unexpected static dependency edge(s) from ${label}`);
    for (const [pattern, reason] of RUNTIME_SOURCE_RULES) {
      assert(!pattern.test(source), `clean-room runtime violation in ${label}: ${reason}`);
    }
    for (const specifier of specifiers) queue.push(await resolveLocal(specifier, modulePath));
  }
  const expected = [...ALLOWED_EDGES.keys()].sort();
  assert.deepEqual([...seen].map(relative).sort(), expected, "realpath dependency graph must match the public roster graph exactly");
  return { entry: canonicalEntry, files: [...seen], sources };
}

const graph = await auditGraph(ENTRY);
const entrySource = graph.sources.get(graph.entry);
assert.equal(sha256(entrySource), EXPECTED_ENTRY_SHA256, "candidate changed after the frozen hash was announced");
for (const [pattern, reason] of CANDIDATE_SOURCE_RULES) {
  assert(!pattern.test(entrySource), `candidate clean-room violation: ${reason}`);
}

const namespace = await import(`${pathToFileURL(graph.entry).href}?triad-alt-cleanroom-audit`);
assert.equal(namespace.default, namespace.createAgent);
assert.equal(namespace.default, namespace.createTriadChampionAgentAlt);
assert.equal(namespace.default.length, 0, "factory must expose a zero-argument gauntlet surface");
const createCandidate = namespace.default;

function randomToken(bytes = 12) {
  return randomBytes(bytes).toString("hex");
}

function randomUint32() {
  return randomBytes(4).readUInt32LE(0);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function publicGuard(value, reads, label, cache = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (cache.has(value)) return cache.get(value);
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        assert(Reflect.has(target, property), `candidate read a non-public field: ${label}.${property}`);
        reads.add(`${label}.${property}`);
      }
      return publicGuard(Reflect.get(target, property, receiver), reads, `${label}.${String(property)}`, cache);
    },
    set(_target, property) {
      assert.fail(`candidate mutated public input: ${label}.${String(property)}`);
    },
    defineProperty(_target, property) {
      assert.fail(`candidate mutated public input: ${label}.${String(property)}`);
    },
    deleteProperty(_target, property) {
      assert.fail(`candidate mutated public input: ${label}.${String(property)}`);
    },
  });
  cache.set(value, proxy);
  return proxy;
}

function fighter({ relation, name, templateId, x, facing, frame, role }) {
  const cycle = frame % 90;
  const isSelf = role === "self";
  const hitstunFrames = isSelf && cycle >= 12 && cycle < 15 ? 15 - cycle : 0;
  const blockstunFrames = isSelf && cycle >= 20 && cycle < 23 ? 23 - cycle : 0;
  const knockdownFrames = isSelf && cycle >= 28 && cycle < 32 ? 32 - cycle : 0;
  const airborne = (isSelf && cycle >= 38 && cycle < 43) || (!isSelf && cycle >= 47 && cycle < 51);
  const foeRecovery = !isSelf && cycle >= 56 && cycle < 60;
  const foeStartup = !isSelf && cycle >= 63 && cycle < 68;
  return {
    relation,
    name,
    templateId,
    position: { x, y: airborne ? 320 : 388 },
    velocity: { x: frame % 7 === 0 ? facing * 1.5 : 0, y: airborne ? -2 : 0 },
    size: { width: 44, height: 96 },
    facing,
    onGround: !airborne,
    health: isSelf ? Math.max(1, 9_200 - frame * 3) : Math.max(1, 8_900 - frame * 2),
    maxHealth: 10_000,
    recoverableHealth: 0,
    roundsWon: 0,
    resources: {
      super: 1_500,
      superMax: 3_000,
      drive: 5_000,
      driveMax: 6_000,
      guard: blockstunFrames > 0 ? 4_000 : 9_000,
      guardMax: 10_000,
      stun: 0,
      stunMax: 10_000,
      burnout: false,
    },
    state: {
      action: hitstunFrames > 0
        ? "hitstun"
        : blockstunFrames > 0
          ? "block"
          : foeStartup
            ? "standHeavyPunch"
            : "idle",
      moveId: foeStartup ? "standHeavyPunch" : null,
      moveName: foeStartup ? "Standing Heavy Punch" : null,
      phase: hitstunFrames > 0
        ? "hitstun"
        : blockstunFrames > 0
          ? "blockstun"
          : knockdownFrames > 0
            ? "knockdown"
            : foeRecovery
              ? "recovery"
              : foeStartup
                ? "startup"
                : "idle",
      actionFrame: foeStartup ? cycle - 62 : 0,
      hitstunFrames,
      blockstunFrames,
      knockdownFrames,
      knockdownType: knockdownFrames > 0 ? "hard" : "none",
      comboCount: hitstunFrames > 0 ? 2 : 0,
      comboDamage: hitstunFrames > 0 ? 1_200 : 0,
    },
  };
}

function observation(frame, identity, ownTemplate) {
  const facing = frame % 2 === 0 ? 1 : -1;
  const gaps = [42, 57, 72, 118, 148, 224, 260];
  const gap = gaps[frame % gaps.length];
  const selfX = facing > 0 ? 240 : 720;
  const opponentX = selfX + facing * (44 + gap);
  const cycle = frame % 90;
  return deepFreeze({
    schema: "agentfighter.observation",
    version: 1,
    frame,
    roundFrame: frame % 90,
    tickRate: 60,
    phase: cycle === 89 ? "roundOver" : "fighting",
    timerFrames: Math.max(0, 3_600 - frame),
    side: facing > 0 ? "left" : "right",
    selfIndex: facing > 0 ? 0 : 1,
    perception: { delayFrames: 0, opponentFrame: frame },
    round: { number: Math.floor(frame / 90) + 1, score: { self: 0, opponent: 0 } },
    arena: { width: 960, height: 540, floorY: 460, left: 48, right: 912 },
    self: fighter({
      relation: "self",
      name: identity.selfName,
      templateId: ownTemplate,
      x: selfX,
      facing,
      frame,
      role: "self",
    }),
    opponent: fighter({
      relation: "opponent",
      name: identity.opponentName,
      templateId: identity.opponentTemplate,
      x: opponentX,
      facing: -facing,
      frame,
      role: "opponent",
    }),
    projectiles: cycle >= 72 && cycle < 78 ? [{
      id: 17,
      owner: "opponent",
      sourceMoveId: "projectile",
      position: { x: selfX - facing * 120, y: 390 },
      velocity: { x: facing * 6, y: 0 },
      size: { width: 24, height: 24, radius: 12 },
      facing,
      lifeFrames: 80,
      variant: "normal",
    }] : [],
    recentEvents: [],
  });
}

function matchInfo(identity, ownTemplate, index) {
  return deepFreeze({
    schema: "agentfighter.match-info",
    version: 1,
    matchId: identity.matchId,
    seed: identity.seed,
    tickRate: 60,
    bestOf: 3,
    roundSeconds: 60,
    side: index % 2 === 0 ? "left" : "right",
    selfIndex: index % 2,
    self: { name: identity.selfName, templateId: ownTemplate, maxHealth: 10_000 },
    opponent: { name: identity.opponentName, templateId: identity.opponentTemplate, maxHealth: 10_000 },
    arena: { width: 960, height: 540, floorY: 460, left: 48, right: 912 },
  });
}

function callSync(callback, label) {
  const returned = callback();
  assert(!(returned && typeof returned.then === "function"), `${label} must be synchronous`);
  return returned;
}

function validateAction(action, label) {
  const official = validateActionV1(action);
  assert.equal(official.valid, true, `${label}: ${official.errors.join("; ")}`);
  assert.deepEqual(Object.keys(action).sort(), ["input", "schema", "version"]);
  assert.deepEqual(Object.keys(action.input).sort(), [...INPUT_KEYS].sort());
  for (const value of Object.values(action.input)) assert.equal(typeof value, "boolean");
  assert(!(action.input.left && action.input.right), `${label}: left+right conflict`);
  assert(!(action.input.up && action.input.down), `${label}: up+down conflict`);
  assert(Object.isFrozen(action), `${label}: ActionV1 root must be frozen`);
  assert(Object.isFrozen(action.input), `${label}: ActionV1 input must be frozen`);
  assert.doesNotThrow(() => JSON.stringify(action));
  return clone(action);
}

function instantiate(templateHint) {
  const agent = templateHint === undefined ? createCandidate() : createCandidate(templateHint);
  assert(agent && typeof agent === "object" && !Array.isArray(agent));
  assert.equal(typeof agent.reset, "function");
  assert.equal(typeof agent.act, "function");
  assert.equal(typeof agent.end, "function");
  assert.equal(Object.hasOwn(agent, "decide"), false, "candidate must not expose raw-game decide(game)");
  assert(Object.isFrozen(agent), "candidate facade must be frozen");
  return agent;
}

const identities = Array.from({ length: 3 }, (_, index) => ({
  matchId: `alt-cleanroom-${index}-${randomToken()}`,
  seed: randomUint32(),
  selfName: `self-${index}-${randomToken()}`,
  opponentName: `opponent-${index}-${randomToken()}`,
  opponentTemplate: index % 2 === 0 ? "ember" : "vanguard",
}));
assert.equal(new Set(identities.map(({ matchId }) => matchId)).size, identities.length);

for (const ownTemplate of ["vanguard", "ember"]) {
  const agents = identities.map(() => instantiate());
  const traces = agents.map(() => []);
  agents.forEach((agent, index) => {
    const reads = new Set();
    const guardedInfo = publicGuard(clone(matchInfo(identities[index], ownTemplate, index)), reads, "matchInfo");
    callSync(() => agent.reset(guardedInfo), `${ownTemplate}-${index}.reset`);
    assert(![...reads].some((read) => /^matchInfo\.(?:seed|matchId|opponent)(?:\.|$)/.test(read)));
    assert(![...reads].some((read) => /\.name$/.test(read)));
  });

  for (let frame = 0; frame < 180; frame += 1) {
    agents.forEach((agent, index) => {
      const reads = new Set();
      const guarded = publicGuard(clone(observation(frame, identities[index], ownTemplate)), reads, "observation");
      traces[index].push(validateAction(
        callSync(() => agent.act(guarded), `${ownTemplate}-${index}.act(${frame})`),
        `${ownTemplate}-${index}.act(${frame})`,
      ));
      assert(![...reads].some((read) => /^observation\.opponent\.(?:name|templateId)(?:\.|$)/.test(read)));
    });
  }
  for (let index = 1; index < traces.length; index += 1) {
    assert.deepEqual(
      traces[index],
      traces[0],
      `${ownTemplate}: randomized reset seed/names/opponent template must not change actions`,
    );
  }

  // A same-template public reset/observation overrides any factory hint; no
  // opponent or tournament metadata can be smuggled through construction.
  const hinted = instantiate(ownTemplate === "vanguard" ? "ember" : "vanguard");
  const plain = instantiate();
  hinted.reset(matchInfo(identities[0], ownTemplate, 0));
  plain.reset(matchInfo(identities[0], ownTemplate, 0));
  for (let frame = 0; frame < 45; frame += 1) {
    assert.deepEqual(
      validateAction(hinted.act(observation(frame, identities[0], ownTemplate)), `${ownTemplate}-hinted-${frame}`),
      validateAction(plain.act(observation(frame, identities[0], ownTemplate)), `${ownTemplate}-plain-${frame}`),
      "public self template must determine policy after reset, not a stale factory hint",
    );
  }

  for (const agent of agents) {
    if (agent.getDebugState === undefined) continue;
    assert.equal(typeof agent.getDebugState, "function");
    const first = callSync(() => agent.getDebugState(), "getDebugState");
    const serialized = JSON.stringify(first);
    assert.doesNotThrow(() => JSON.parse(serialized));
    assert.deepEqual(clone(callSync(() => agent.getDebugState(), "getDebugState repeat")), clone(first));
    assert(!/(?:opponent|preset|label|name|identity|seed|intent|reason|observation|rawgame)/i.test(serialized));
    for (const identity of identities) {
      assert(!serialized.includes(identity.matchId));
      assert(!serialized.includes(identity.selfName));
      assert(!serialized.includes(identity.opponentName));
    }
  }
  agents.forEach((agent) => callSync(() => agent.end({ outcome: "draw", opponent: { name: randomToken() } }), "agent.end"));
}

const headlessObservations = { A: [], B: [] };
const headlessDecisions = [];
const summary = runHeadlessTournament({
  matches: 2,
  agentA: "balanced",
  agentB: "zoner",
  templateA: "vanguard",
  templateB: "ember",
  difficulty: "normal",
  seed: randomUint32(),
  roundSeconds: 10,
  bestOf: 1,
  swapSides: true,
  maxFramesPerMatch: 600,
  maxRoundsPerMatch: 4,
}, {
  createAgent(participant, context) {
    const candidate = instantiate();
    return Object.freeze({
      reset: (info) => candidate.reset(info),
      act(observed) {
        assert(Object.isFrozen(observed));
        assert(Object.isFrozen(observed.self));
        assert(Object.isFrozen(observed.opponent.state));
        assert.equal(Object.hasOwn(observed, "game"), false);
        assert.equal(Object.hasOwn(observed, "fighters"), false);
        assert.equal(Object.hasOwn(observed, "combatEvents"), false);
        headlessObservations[participant].push({
          matchIndex: context.matchIndex,
          frame: observed.frame,
          delayFrames: observed.perception.delayFrames,
          opponentFrame: observed.perception.opponentFrame,
        });
        const action = candidate.act(observed);
        validateAction(action, `headless-${participant}`);
        return action;
      },
      end: (result) => candidate.end(result),
      getDebugState: () => candidate.getDebugState?.() ?? {},
    });
  },
  onDecision(record) {
    headlessDecisions.push(record);
  },
});

assert.equal(Object.hasOwn(summary.settings, "delay"), false);
assert.equal(summary.matches, 2);
assert.equal(summary.participants.A.source, "injected");
assert.equal(summary.participants.B.source, "injected");
assert.equal(summary.diagnostics.A.total, 0);
assert.equal(summary.diagnostics.B.total, 0);
assert.equal(headlessDecisions.length, summary.totalFrames);
for (const participant of ["A", "B"]) {
  assert.equal(headlessObservations[participant].length, summary.totalFrames);
  assert.deepEqual(new Set(headlessObservations[participant].map(({ delayFrames }) => delayFrames)), new Set([0]));
  for (const observed of headlessObservations[participant]) {
    assert.equal(observed.opponentFrame, observed.frame);
  }
}
for (const record of headlessDecisions) {
  for (const participant of ["A", "B"]) {
    const decision = record.decisions[participant];
    assert.equal(decision.decisionFrame, record.frame);
    assert.equal(decision.observedFrame, record.frame);
    assert.equal(decision.opponentObservedFrame, decision.observedFrame);
    assert.equal(decision.observationFrame, decision.observedFrame);
    assert.equal(decision.source, "agent");
    assert.equal(decision.valid, true);
    assert.equal(decision.diagnostic, null);
    validateAction(decision.action, `headless-decision-${participant}`);
  }
}

const finalSource = await readFile(graph.entry, "utf8");
assert.equal(sha256(finalSource), EXPECTED_ENTRY_SHA256, "candidate changed during final clean-room audit");
process.stdout.write(
  `triad-alt-cleanroom ok · sha256=${EXPECTED_ENTRY_SHA256}`
  + ` · graph=${graph.files.length} · identityVariants=${identities.length} · traceFrames=180x2`
  + ` · headlessMatches=${summary.matches} · headlessFrames=${summary.totalFrames} · realtime=both-sides\n`,
);
