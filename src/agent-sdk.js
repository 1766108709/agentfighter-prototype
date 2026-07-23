import { MOVESETS, TICK_RATE } from "./engine.js";
import { createScriptAI } from "./ai.js";
import { EMPTY_COMBAT_INPUT } from "./input-schema.js";

export const AGENT_PROTOCOL_VERSION = 1;
export const OBSERVATION_V1_SCHEMA = "agentfighter.observation";
export const ACTION_V1_SCHEMA = "agentfighter.action";
export const MATCH_INFO_V1_SCHEMA = "agentfighter.match-info";
export const MATCH_RESULT_V1_SCHEMA = "agentfighter.match-result";
export const OBSERVATION_EVENT_WINDOW_FRAMES = 240;
export const OBSERVATION_EVENT_LIMIT = 64;

const INPUT_KEYS = Object.freeze(Object.keys(EMPTY_COMBAT_INPUT));
const INPUT_KEY_SET = new Set(INPUT_KEYS);
const ACTION_TOP_LEVEL_KEY_SET = new Set(["schema", "version", "input"]);
const RUNNER_OPTION_KEY_SET = new Set([
  "decisionIntervalFrames", "observationDelayFrames", "holdLastAction", "deadlineMs",
  "invalidActionPolicy", "exceptionPolicy", "timeoutPolicy", "onDiagnostic", "clock",
]);
const FAILURE_POLICIES = new Set(["neutral", "hold-last", "disable"]);
const MAX_AGENT_DIAGNOSTICS = 256;
const PUBLIC_COMBAT_EVENT_TYPES = new Set([
  "bait",
  "cancel",
  "chargeRelease",
  "chargeStart",
  "comboEnd",
  "contact",
  "guard",
  "guardBreak",
  "jump",
  "knockdown",
  "moveStart",
  "stun",
  "throw",
  "throwTech",
  "wakeupAction",
]);

/**
 * Build the JSON-safe, immutable view delivered to an Agent V1.
 *
 * Only state visible in an ordinary match is copied. Internal controller
 * history, command buffers, authored move objects, hit registries, AI plans,
 * hitboxes, and the mutable game object are deliberately excluded.
 *
 * @param {object} game deterministic engine state
 * @param {0|1} selfIndex side controlled by the receiving agent
 * @returns {object} ObservationV1
 */
export function createObservationV1(game, selfIndex = 0) {
  const index = selfIndex === 1 ? 1 : 0;
  const other = 1 - index;
  const fighters = Array.isArray(game?.fighters) ? game.fighters : [];
  const score = Array.isArray(game?.score) ? game.score : [0, 0];
  const arena = game?.arena ?? {};
  const observation = {
    schema: OBSERVATION_V1_SCHEMA,
    version: AGENT_PROTOCOL_VERSION,
    frame: integer(game?.frame),
    roundFrame: integer(game?.roundFrame),
    tickRate: positive(game?.tickRate, TICK_RATE),
    phase: text(game?.phase, "fighting"),
    timerFrames: nonNegative(game?.timerFrames),
    side: index === 0 ? "left" : "right",
    selfIndex: index,
    perception: {
      delayFrames: 0,
      opponentFrame: integer(game?.frame),
    },
    round: {
      number: Math.max(1, integer(game?.roundNumber ?? game?.round, 1)),
      score: { self: nonNegative(score[index]), opponent: nonNegative(score[other]) },
    },
    arena: {
      width: nonNegative(arena.width),
      height: nonNegative(arena.height),
      floorY: finite(arena.floorY ?? arena.groundY),
      left: finite(arena.left),
      right: finite(arena.right),
    },
    self: publicFighter(fighters[index], "self"),
    opponent: publicFighter(fighters[other], "opponent"),
    projectiles: (Array.isArray(game?.projectiles) ? game.projectiles : [])
      .filter((projectile) => projectile?.alive !== false)
      .map((projectile) => publicProjectile(projectile, index)),
    recentEvents: publicRecentEvents(game, integer(game?.frame)),
  };
  return deepFreeze(observation);
}

/**
 * Build the immutable match descriptor passed once to `agent.reset(info)`.
 * @param {object} game newly-created engine state
 * @param {0|1} selfIndex controlled side
 * @param {object} [metadata] caller-owned identifiers (matchId/seed allowed)
 * @returns {object} MatchInfoV1
 */
export function createMatchInfoV1(game, selfIndex = 0, metadata = {}) {
  const observation = createObservationV1(game, selfIndex);
  const info = {
    schema: MATCH_INFO_V1_SCHEMA,
    version: AGENT_PROTOCOL_VERSION,
    matchId: text(metadata.matchId, `match-${integer(metadata.matchIndex, 0) + 1}`),
    seed: integer(metadata.seed),
    tickRate: observation.tickRate,
    bestOf: Math.max(1, integer(game?.config?.bestOf, 1)),
    roundSeconds: Math.max(1, integer(game?.config?.roundSeconds, 60)),
    side: observation.side,
    selfIndex: observation.selfIndex,
    self: {
      name: observation.self.name,
      templateId: observation.self.templateId,
      maxHealth: observation.self.maxHealth,
    },
    opponent: {
      name: observation.opponent.name,
      templateId: observation.opponent.templateId,
      maxHealth: observation.opponent.maxHealth,
    },
    arena: observation.arena,
  };
  return deepFreeze(info);
}

/**
 * Build the immutable terminal value passed to `agent.end(result)`.
 * @param {object} game terminal engine state
 * @param {0|1} selfIndex controlled side
 * @param {object} [metadata] termination and aggregate metadata
 * @returns {object} MatchResultV1
 */
export function createMatchResultV1(game, selfIndex = 0, metadata = {}) {
  const index = selfIndex === 1 ? 1 : 0;
  const score = Array.isArray(game?.score) ? game.score : [0, 0];
  const winner = game?.matchWinner;
  return deepFreeze({
    schema: MATCH_RESULT_V1_SCHEMA,
    version: AGENT_PROTOCOL_VERSION,
    matchId: text(metadata.matchId, "match-1"),
    outcome: winner === index ? "win" : winner === 1 - index ? "loss" : "draw",
    winner: winner === 0 ? "left" : winner === 1 ? "right" : "draw",
    score: { self: nonNegative(score[index]), opponent: nonNegative(score[1 - index]) },
    frames: nonNegative(metadata.frames ?? game?.frame),
    rounds: nonNegative(metadata.rounds ?? game?.roundNumber ?? game?.round),
    termination: text(metadata.termination, game?.phase === "matchOver" ? "matchOver" : "stopped"),
  });
}

/**
 * Create a complete ActionV1. Omitted controller fields are false. Unknown
 * fields and non-boolean values throw instead of being silently discarded, so
 * controller typos fail at their source.
 * @param {object} [input] canonical controller booleans
 * @returns {object} ActionV1
 * @throws {TypeError} when input is not a strict canonical controller object
 */
export function createActionV1(input = {}) {
  const inspected = inspectDataObject(input, "input", INPUT_KEY_SET);
  const errors = [...inspected.errors, ...directionErrors(inspected.values)];
  if (errors.length > 0) throw new TypeError(`Invalid ActionV1 input: ${errors.join("; ")}`);
  return buildActionV1(inspected.values);
}

function buildActionV1(input) {
  return deepFreeze({
    schema: ACTION_V1_SCHEMA,
    version: AGENT_PROTOCOL_VERSION,
    input: Object.fromEntries(INPUT_KEYS.map((key) => [key, input[key] === true])),
  });
}

/**
 * Strictly validate an untrusted Agent V1 action.
 * Unknown fields, non-booleans, conflicting directions, wrong schema/version,
 * promises, and non-plain objects are rejected instead of coerced.
 *
 * @param {unknown} candidate untrusted agent return value
 * @returns {{valid:boolean, action:object|null, input:object|null, errors:string[]}}
 */
export function validateActionV1(candidate) {
  const top = inspectDataObject(candidate, "action", ACTION_TOP_LEVEL_KEY_SET);
  const errors = [...top.errors];
  if (top.values.schema !== ACTION_V1_SCHEMA) errors.push(`schema must equal ${ACTION_V1_SCHEMA}`);
  if (top.values.version !== AGENT_PROTOCOL_VERSION) errors.push(`version must equal ${AGENT_PROTOCOL_VERSION}`);
  const input = inspectDataObject(top.values.input, "input", INPUT_KEY_SET);
  errors.push(...input.errors, ...directionErrors(input.values));
  if (errors.length > 0) return { valid: false, action: null, input: null, errors };
  const action = buildActionV1(input.values);
  return { valid: true, action, input: { ...action.input }, errors: [] };
}

/**
 * Adapt the existing trusted `createScriptAI` implementation to Agent V1.
 * The legacy AI receives a reconstructed public-state game, never the mutable
 * engine game or its private input/command state.
 *
 * @param {Parameters<typeof createScriptAI>[0]} [options]
 * @returns {{name:string, description:string, reset:Function, act:Function, end:Function, getDebugState:Function}}
 */
export function createScriptAIAgent(options = {}) {
  const script = createScriptAI(options);
  let lastRound = null;
  return {
    name: script.name,
    description: script.description,
    reset() {
      lastRound = null;
      script.reset?.();
    },
    act(observation) {
      if (lastRound !== null && observation.round.number !== lastRound) {
        script.reset?.({ preserveAdaptation: true });
      }
      lastRound = observation.round.number;
      const synthetic = observationToLegacyGame(observation);
      const input = script.decide(synthetic, observation.selfIndex);
      // The legacy controller also exposes light/heavy/special compatibility
      // aliases. Select only the canonical V1 fields before strict creation.
      return createActionV1(Object.fromEntries(
        INPUT_KEYS.map((key) => [key, input?.[key] === true]),
      ));
    },
    end() {},
    getDebugState: () => script.getDebugState?.() ?? {},
  };
}

// Descriptive compatibility alias for callers familiar with the old name.
export const createScriptAIAdapter = createScriptAIAgent;

/**
 * Wrap an Agent V1 for a synchronous deterministic engine loop.
 * This adapter is for trusted in-process code only. It is not a sandbox and
 * cannot pre-empt a blocking/infinite Agent; uploaded or otherwise untrusted
 * code must run in a Worker or separate process with an action mailbox.
 *
 * `decide(game, selfIndex)` is the trusted engine bridge. The wrapped agent is
 * called only as `act(observation)`. Promise-returning agents are rejected:
 * remote/async transports must make decisions outside the 60 Hz step loop and
 * feed completed ActionV1 values through a synchronous mailbox adapter.
 *
 * Deadline measurement is post-call because JavaScript cannot pre-empt a
 * blocking function. It detects overruns but cannot rescue an infinite loop;
 * untrusted code therefore still belongs in a Worker/process sandbox.
 * The default `Infinity` deadline is disabled to preserve cross-machine
 * determinism. Setting a finite `deadlineMs` enables wall-clock adjudication:
 * host load can then change whether a decision is accepted, so the runner,
 * deadline diagnostic, and affected lastDecision expose
 * `nonDeterministic=true`.
 *
 * @param {{reset?:Function, act:Function, end?:Function, name?:string}} agent Agent V1
 * @param {object} [options]
 * @param {number} [options.decisionIntervalFrames=1]
 * @param {number} [options.observationDelayFrames=0] platform-enforced delay
 * @param {boolean} [options.holdLastAction=true]
 * @param {number} [options.deadlineMs=Infinity]
 * @param {'neutral'|'hold-last'|'disable'} [options.invalidActionPolicy='neutral']
 * @param {'neutral'|'hold-last'|'disable'} [options.exceptionPolicy='neutral']
 * @param {'neutral'|'hold-last'|'disable'} [options.timeoutPolicy='neutral']
 * @param {Function} [options.onDiagnostic]
 * @param {Function} [options.clock] monotonic clock, injectable for tests
 * @returns {object} synchronous runner/adapter
 */
export function createInProcessAgentRunner(agent, options = {}) {
  if (!agent || typeof agent.act !== "function") throw new TypeError("Agent V1 must implement act(observation)");
  const inspectedOptions = inspectDataObject(options, "runner option", RUNNER_OPTION_KEY_SET);
  if (inspectedOptions.errors.length > 0) throw new TypeError(`Invalid runner options: ${inspectedOptions.errors.join("; ")}`);
  const runnerOptions = inspectedOptions.values;
  const decisionIntervalFrames = strictInteger(runnerOptions.decisionIntervalFrames, 1, 3600, 1, "decisionIntervalFrames");
  const observationDelayFrames = strictInteger(runnerOptions.observationDelayFrames, 0, 3600, 0, "observationDelayFrames");
  if (runnerOptions.holdLastAction !== undefined && typeof runnerOptions.holdLastAction !== "boolean") {
    throw new TypeError("holdLastAction must be boolean");
  }
  const holdLastAction = runnerOptions.holdLastAction !== false;
  const deadlineMs = strictDeadline(runnerOptions.deadlineMs);
  const invalidActionPolicy = strictFailurePolicy(runnerOptions.invalidActionPolicy, "invalidActionPolicy");
  const exceptionPolicy = strictFailurePolicy(runnerOptions.exceptionPolicy, "exceptionPolicy");
  const timeoutPolicy = strictFailurePolicy(runnerOptions.timeoutPolicy, "timeoutPolicy");
  if (runnerOptions.onDiagnostic !== undefined && typeof runnerOptions.onDiagnostic !== "function") {
    throw new TypeError("onDiagnostic must be a function");
  }
  if (runnerOptions.clock !== undefined && typeof runnerOptions.clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  const clock = runnerOptions.clock ?? monotonicNow;
  const onDiagnostic = runnerOptions.onDiagnostic ?? null;
  const neutral = createActionV1();
  let lastAction = neutral;
  let lastDecision = null;
  let diagnostics = [];
  let diagnosticTotal = 0;
  let diagnosticCounts = Object.create(null);
  let disabled = false;
  let nextDecisionFrame = 0;
  let matchInfo = null;
  let observationHistory = [];
  let latestObservationFrame = -1;
  let latestObservationRound = null;

  function emit(kind, frame, message, details = {}) {
    const nonDeterministic = details?.nonDeterministic === true;
    const diagnostic = deepFreeze({
      schema: "agentfighter.diagnostic",
      version: AGENT_PROTOCOL_VERSION,
      kind,
      frame: nonNegative(frame),
      message: text(message),
      nonDeterministic,
      details: jsonSafe(details),
    });
    diagnosticTotal += 1;
    diagnosticCounts[kind] = (diagnosticCounts[kind] ?? 0) + 1;
    if (diagnostics.length >= MAX_AGENT_DIAGNOSTICS) diagnostics.shift();
    diagnostics.push(diagnostic);
    try {
      onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never destabilize the simulation that they observe.
    }
    return diagnostic;
  }

  function fallback(policy) {
    if (policy === "disable") disabled = true;
    return policy === "hold-last" ? lastAction : neutral;
  }

  function reset(info) {
    matchInfo = info;
    lastAction = neutral;
    lastDecision = null;
    diagnostics = [];
    diagnosticTotal = 0;
    diagnosticCounts = Object.create(null);
    disabled = false;
    nextDecisionFrame = 0;
    observationHistory = [];
    latestObservationFrame = -1;
    latestObservationRound = null;
    try {
      const returned = agent.reset?.(info);
      if (isThenable(returned)) {
        returned.catch?.(() => {});
        emit("async-reset", 0, "async reset is not supported by the synchronous runner");
        disabled = exceptionPolicy === "disable";
      }
    } catch (error) {
      emit("reset-exception", 0, errorMessage(error));
      disabled = exceptionPolicy === "disable";
    }
  }

  function act(observation) {
    const decisionFrame = nonNegative(observation?.frame);
    const observed = selectDelayedObservation(observation, decisionFrame);
    if (disabled) return remember(observation, observed, neutral, "disabled", false, 0, null);
    if (decisionFrame < nextDecisionFrame) {
      const held = holdLastAction ? lastAction : neutral;
      return remember(observation, observed, held, holdLastAction ? "held" : "neutral-gap", true, 0, null);
    }
    nextDecisionFrame = decisionFrame + decisionIntervalFrames;
    let candidate;
    const started = clock();
    try {
      candidate = agent.act(observed);
    } catch (error) {
      const elapsed = elapsedSince(started, clock);
      const diagnostic = emit("act-exception", decisionFrame, errorMessage(error));
      return remember(observation, observed, fallback(exceptionPolicy), "fallback", false, elapsed, diagnostic);
    }
    const elapsed = elapsedSince(started, clock);
    let candidateIsThenable;
    try {
      candidateIsThenable = isThenable(candidate);
    } catch (error) {
      const diagnostic = emit("validation-exception", decisionFrame, errorMessage(error));
      return remember(observation, observed, fallback(invalidActionPolicy), "fallback", false, elapsed, diagnostic);
    }
    if (candidateIsThenable) {
      suppressThenableRejection(candidate);
      const diagnostic = emit(
        "async-action",
        decisionFrame,
        "Promise actions are unsupported in the synchronous 60 Hz runner; use a mailbox/Worker transport",
      );
      return remember(observation, observed, fallback(exceptionPolicy), "fallback", false, elapsed, diagnostic);
    }
    if (elapsed > deadlineMs) {
      const diagnostic = emit("deadline-exceeded", decisionFrame, `decision exceeded ${deadlineMs}ms`, {
        elapsedMs: elapsed,
        nonDeterministic: true,
      });
      return remember(observation, observed, fallback(timeoutPolicy), "fallback", false, elapsed, diagnostic);
    }
    let validated;
    try {
      validated = validateActionV1(candidate);
    } catch (error) {
      const diagnostic = emit("validation-exception", decisionFrame, errorMessage(error));
      return remember(observation, observed, fallback(invalidActionPolicy), "fallback", false, elapsed, diagnostic);
    }
    if (!validated.valid) {
      const diagnostic = emit("invalid-action", decisionFrame, "agent returned an invalid ActionV1", { errors: validated.errors });
      return remember(observation, observed, fallback(invalidActionPolicy), "fallback", false, elapsed, diagnostic);
    }
    lastAction = validated.action;
    return remember(observation, observed, validated.action, "agent", true, elapsed, null);
  }

  function selectDelayedObservation(observation, decisionFrame) {
    const round = observation?.round?.number ?? null;
    if (decisionFrame < latestObservationFrame || (latestObservationRound !== null && round !== latestObservationRound)) {
      observationHistory = [];
    }
    latestObservationRound = round;
    const latest = observationHistory[observationHistory.length - 1];
    if (latest && nonNegative(latest.frame) === decisionFrame) observationHistory[observationHistory.length - 1] = observation;
    else observationHistory.push(observation);
    latestObservationFrame = decisionFrame;

    const targetFrame = decisionFrame - observationDelayFrames;
    while (
      observationHistory.length > 2 &&
      nonNegative(observationHistory[1]?.frame) <= targetFrame
    ) observationHistory.shift();

    let selected = observationHistory[0] ?? observation;
    for (let index = observationHistory.length - 1; index >= 0; index -= 1) {
      if (nonNegative(observationHistory[index]?.frame) <= targetFrame) {
        selected = observationHistory[index];
        break;
      }
    }
    // Before enough frames exist, every participant receives the same earliest
    // legal snapshot instead of being allowed to peek at current state.
    return composePerceivedObservation(observation, selected, observationDelayFrames);
  }

  function decide(game, selfIndex = 0) {
    return act(createObservationV1(game, selfIndex)).input;
  }

  function remember(decisionObservation, observedObservation, action, source, valid, elapsedMs, diagnostic) {
    const decisionFrame = nonNegative(decisionObservation?.frame);
    const observedFrame = nonNegative(
      observedObservation?.perception?.opponentFrame ?? observedObservation?.frame,
    );
    lastDecision = deepFreeze({
      schema: "agentfighter.decision",
      version: AGENT_PROTOCOL_VERSION,
      decisionFrame,
      observedFrame,
      opponentObservedFrame: observedFrame,
      observationFrame: observedFrame,
      action,
      source,
      valid,
      elapsedMs: rounded(elapsedMs),
      nonDeterministic: diagnostic?.nonDeterministic === true,
      diagnostic: diagnostic ? {
        kind: diagnostic.kind,
        message: diagnostic.message,
        nonDeterministic: diagnostic.nonDeterministic,
      } : null,
    });
    return action;
  }

  function end(result) {
    try {
      const returned = agent.end?.(result);
      if (isThenable(returned)) {
        returned.catch?.(() => {});
        emit("async-end", result?.frames, "async end is not supported by the synchronous runner");
      }
    } catch (error) {
      emit("end-exception", result?.frames, errorMessage(error));
    }
  }

  return {
    name: text(agent.name, "Agent V1"),
    description: text(agent.description),
    reset,
    act,
    decide,
    end,
    getLastDecision: () => lastDecision,
    getDiagnostics: () => [...diagnostics],
    getDiagnosticSummary: () => ({
      total: diagnosticTotal,
      retained: diagnostics.length,
      byKind: { ...diagnosticCounts },
      disabled,
      failed: disabled || diagnosticTotal > 0,
      nonDeterministic: Number.isFinite(deadlineMs),
    }),
    getDebugState() {
      try {
        return agent.getDebugState?.() ?? {};
      } catch (error) {
        emit("debug-exception", lastDecision?.observationFrame, errorMessage(error));
        return {};
      }
    },
    get disabled() { return disabled; },
    get nonDeterministic() { return Number.isFinite(deadlineMs); },
    get observationDelayFrames() { return observationDelayFrames; },
    get lastDecision() { return lastDecision; },
    get matchInfo() { return matchInfo; },
  };
}

function publicFighter(fighter = {}, relation) {
  const move = fighter.currentMove ?? fighter.moveData;
  return {
    relation,
    name: text(fighter.name),
    templateId: text(fighter.templateId ?? fighter.template),
    position: { x: finite(fighter.x), y: finite(fighter.y) },
    velocity: { x: finite(fighter.vx), y: finite(fighter.vy) },
    size: { width: nonNegative(fighter.width), height: nonNegative(fighter.height) },
    facing: finite(fighter.facing, 1) >= 0 ? 1 : -1,
    onGround: fighter.onGround !== false,
    health: nonNegative(fighter.health),
    maxHealth: nonNegative(fighter.maxHealth),
    recoverableHealth: nonNegative(fighter.recoverableHealth),
    roundsWon: nonNegative(fighter.roundsWon ?? fighter.rounds),
    resources: {
      super: nonNegative(fighter.superMeter),
      superMax: nonNegative(fighter.maxSuperMeter),
      drive: nonNegative(fighter.drive),
      driveMax: nonNegative(fighter.maxDrive),
      guard: nonNegative(fighter.guardGauge),
      guardMax: nonNegative(fighter.maxGuardGauge),
      stun: nonNegative(fighter.stunGauge),
      stunMax: nonNegative(fighter.maxStunGauge),
      burnout: Boolean(fighter.burnout),
    },
    state: {
      action: text(fighter.action ?? fighter.state, "idle"),
      moveId: nullableText(move?.id ?? fighter.currentMoveId),
      moveName: nullableText(move?.name),
      phase: text(fighter.movePhase, "idle"),
      actionFrame: nonNegative(fighter.actionFrame),
      hitstunFrames: nonNegative(fighter.hitstunFrames ?? fighter.hitstun),
      blockstunFrames: nonNegative(fighter.blockstunFrames ?? fighter.blockstun),
      knockdownFrames: nonNegative(fighter.knockdownFrames),
      knockdownType: text(fighter.knockdownType, "none"),
      comboCount: nonNegative(fighter.comboCount ?? fighter.comboHits),
      comboDamage: nonNegative(fighter.comboDamage),
    },
  };
}

function publicProjectile(projectile, selfIndex) {
  return {
    id: integer(projectile.id),
    owner: projectile.owner === selfIndex ? "self" : "opponent",
    sourceMoveId: nullableText(projectile.sourceMoveId),
    position: { x: finite(projectile.x), y: finite(projectile.y) },
    velocity: { x: finite(projectile.vx), y: finite(projectile.vy) },
    size: {
      width: nonNegative(projectile.width),
      height: nonNegative(projectile.height),
      radius: nonNegative(projectile.radius),
    },
    facing: finite(projectile.facing, 1) >= 0 ? 1 : -1,
    lifeFrames: nonNegative(projectile.lifeFrames),
    variant: text(projectile.variant, "normal"),
  };
}

function publicRecentEvents(game, currentFrame) {
  const minimumFrame = Math.max(0, currentFrame - OBSERVATION_EVENT_WINDOW_FRAMES);
  return (Array.isArray(game?.combatEvents) ? game.combatEvents : [])
    .filter((event) => (
      isPlainObject(event) &&
      PUBLIC_COMBAT_EVENT_TYPES.has(event.type) &&
      Number.isFinite(Number(event.frame)) &&
      integer(event.frame) >= minimumFrame &&
      integer(event.frame) <= currentFrame
    ))
    .slice(-OBSERVATION_EVENT_LIMIT)
    .map((event) => publicCombatEvent(game, event));
}

function publicCombatEvent(game, event) {
  const summary = {
    frame: nonNegative(event.frame),
    type: boundedText(event.type),
  };
  for (const key of ["fighterId", "opponentId", "attackerId", "defenderId", "sourceId", "ownerId"]) {
    const value = Number(event[key]);
    if (Number.isInteger(value) && (value === 0 || value === 1)) summary[key] = value;
  }
  for (const key of [
    "moveId", "category", "outcome", "result", "action", "baited",
    "jumpType", "knockdownType", "wakeup", "hitLevel",
  ]) {
    if (typeof event[key] === "string" && event[key]) summary[key] = boundedText(event[key]);
  }
  if (typeof event.crouching === "boolean") summary.crouching = event.crouching;

  const moveId = summary.moveId;
  const ownerId = summary.attackerId ?? summary.sourceId ?? summary.fighterId;
  const templateId = game?.fighters?.[ownerId]?.templateId;
  const moveset = MOVESETS?.[templateId];
  const resolvedMoveId = moveset?.aliases?.[moveId] ?? moveId;
  const move = resolvedMoveId ? moveset?.moves?.[resolvedMoveId] : null;
  if (!summary.category && typeof move?.category === "string") summary.category = boundedText(move.category);
  if (Array.isArray(move?.tags)) {
    summary.tags = move.tags
      .filter((tag) => typeof tag === "string")
      .slice(0, 32)
      .map((tag) => boundedText(tag, 48));
  }
  const range = Number.isFinite(Number(event.range)) ? Number(event.range) : Number(move?.range);
  if (Number.isFinite(range)) summary.range = range;
  return summary;
}

function composePerceivedObservation(current, delayed, delayFrames) {
  const selfIndex = current.selfIndex;
  const opponentIndex = 1 - selfIndex;
  const ownProjectiles = current.projectiles.filter((projectile) => projectile.owner === "self");
  const delayedOpponentProjectiles = delayed.projectiles.filter((projectile) => projectile.owner === "opponent");
  const currentSelfEvents = current.recentEvents.filter(
    (event) => eventActorId(event) === selfIndex,
  );
  const delayedOpponentEvents = delayed.recentEvents.filter((event) => {
    const actor = eventActorId(event);
    return actor === opponentIndex || actor === null;
  });
  const recentEvents = [...currentSelfEvents, ...delayedOpponentEvents]
    .sort((a, b) => a.frame - b.frame || a.type.localeCompare(b.type))
    .slice(-OBSERVATION_EVENT_LIMIT);
  return deepFreeze({
    ...current,
    opponent: delayed.opponent,
    projectiles: [...ownProjectiles, ...delayedOpponentProjectiles]
      .sort((a, b) => a.id - b.id),
    recentEvents,
    perception: {
      delayFrames,
      opponentFrame: delayed.frame,
    },
  });
}

function eventActorId(event) {
  for (const key of ["fighterId", "attackerId", "sourceId", "ownerId"]) {
    if (event?.[key] === 0 || event?.[key] === 1) return event[key];
  }
  return null;
}

function observationToLegacyGame(observation) {
  const self = legacyFighter(observation.self, observation.selfIndex);
  const opponent = legacyFighter(observation.opponent, 1 - observation.selfIndex);
  const fighters = observation.selfIndex === 0 ? [self, opponent] : [opponent, self];
  return {
    frame: observation.frame,
    roundFrame: observation.roundFrame,
    timerFrames: observation.timerFrames,
    tickRate: observation.tickRate,
    phase: observation.phase,
    roundNumber: observation.round.number,
    round: observation.round.number,
    score: observation.selfIndex === 0
      ? [observation.round.score.self, observation.round.score.opponent]
      : [observation.round.score.opponent, observation.round.score.self],
    arena: { ...observation.arena, centerX: observation.arena.width / 2 },
    fighters,
    projectiles: observation.projectiles.map((projectile) => ({
      id: projectile.id,
      owner: projectile.owner === "self" ? observation.selfIndex : 1 - observation.selfIndex,
      sourceMoveId: projectile.sourceMoveId,
      x: projectile.position.x,
      y: projectile.position.y,
      vx: projectile.velocity.x,
      vy: projectile.velocity.y,
      width: projectile.size.width,
      height: projectile.size.height,
      radius: projectile.size.radius,
      facing: projectile.facing,
      lifeFrames: projectile.lifeFrames,
      alive: true,
    })),
    combatEvents: (observation.recentEvents ?? []).map((event) => ({ ...event })),
  };
}

function legacyFighter(snapshot, id) {
  const moveset = MOVESETS[snapshot.templateId];
  const moveId = snapshot.state.moveId;
  const resolvedMoveId = moveset?.aliases?.[moveId] ?? moveId;
  const currentMove = resolvedMoveId ? moveset?.moves?.[resolvedMoveId] ?? null : null;
  return {
    id,
    name: snapshot.name,
    templateId: snapshot.templateId,
    template: snapshot.templateId,
    x: snapshot.position.x,
    y: snapshot.position.y,
    vx: snapshot.velocity.x,
    vy: snapshot.velocity.y,
    width: snapshot.size.width,
    height: snapshot.size.height,
    facing: snapshot.facing,
    onGround: snapshot.onGround,
    health: snapshot.health,
    maxHealth: snapshot.maxHealth,
    recoverableHealth: snapshot.recoverableHealth,
    roundsWon: snapshot.roundsWon,
    action: snapshot.state.action,
    state: snapshot.state.action,
    currentMoveId: resolvedMoveId,
    currentMove,
    moveData: currentMove,
    movePhase: snapshot.state.phase,
    actionFrame: snapshot.state.actionFrame,
    hitstunFrames: snapshot.state.hitstunFrames,
    hitstun: snapshot.state.hitstunFrames,
    blockstunFrames: snapshot.state.blockstunFrames,
    blockstun: snapshot.state.blockstunFrames,
    knockdownFrames: snapshot.state.knockdownFrames,
    knockdownType: snapshot.state.knockdownType,
    comboCount: snapshot.state.comboCount,
    comboDamage: snapshot.state.comboDamage,
    superMeter: snapshot.resources.super,
    maxSuperMeter: snapshot.resources.superMax,
    drive: snapshot.resources.drive,
    maxDrive: snapshot.resources.driveMax,
    guardGauge: snapshot.resources.guard,
    maxGuardGauge: snapshot.resources.guardMax,
    stunGauge: snapshot.resources.stun,
    maxStunGauge: snapshot.resources.stunMax,
    burnout: snapshot.resources.burnout,
  };
}

function strictFailurePolicy(value, name) {
  if (value === undefined) return "neutral";
  if (!FAILURE_POLICIES.has(value)) {
    throw new TypeError(`${name} must be neutral, hold-last, or disable`);
  }
  return value;
}

function inspectDataObject(value, label, allowedKeys) {
  const values = Object.create(null);
  const errors = [];
  if (!value || typeof value !== "object") {
    errors.push(`${label} must be a plain object`);
    return { values, errors };
  }

  let prototype;
  try {
    prototype = Reflect.getPrototypeOf(value);
  } catch (error) {
    errors.push(`${label} prototype inspection failed: ${errorMessage(error)}`);
    return { values, errors };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    errors.push(`${label} must be a plain object`);
    return { values, errors };
  }

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    errors.push(`${label} key inspection failed: ${errorMessage(error)}`);
    return { values, errors };
  }

  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      errors.push(`unknown ${label} field: ${String(key)}`);
      continue;
    }
    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      errors.push(`${label}.${key} descriptor inspection failed: ${errorMessage(error)}`);
      continue;
    }
    if (!descriptor) {
      errors.push(`${label}.${key} descriptor is missing`);
    } else if (!("value" in descriptor)) {
      errors.push(`${label}.${key} must be a data property; accessors are forbidden`);
    } else if (descriptor.enumerable !== true) {
      errors.push(`${label}.${key} must be enumerable`);
    } else {
      values[key] = descriptor.value;
    }
  }

  if (label === "input") {
    for (const [key, valueEntry] of Object.entries(values)) {
      if (typeof valueEntry !== "boolean") errors.push(`input.${key} must be boolean`);
    }
  }
  return { values, errors };
}

function directionErrors(input) {
  const errors = [];
  if (input.left === true && input.right === true) errors.push("left and right cannot both be true");
  if (input.up === true && input.down === true) errors.push("up and down cannot both be true");
  return errors;
}

function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isThenable(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  let current = value;
  while (current) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, "then");
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function";
    current = Reflect.getPrototypeOf(current);
  }
  return false;
}

function suppressThenableRejection(value) {
  try {
    // Attach only to a native Promise brand; never execute an arbitrary
    // user-supplied `.then()` while rejecting an async action.
    Promise.prototype.then.call(value, undefined, () => {});
  } catch {
    // Classification already rejected async actions; suppression is best-effort.
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictInteger(value, minimum, maximum, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function strictDeadline(value) {
  if (value === undefined || value === Infinity) return Infinity;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("deadlineMs must be a non-negative finite number or Infinity");
  }
  return value;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback = 1) {
  const number = finite(value, fallback);
  return number > 0 ? number : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value));
}

function text(value, fallback = "") {
  return value == null ? fallback : String(value);
}

function boundedText(value, maximum = 96) {
  return text(value).slice(0, maximum);
}

function nullableText(value) {
  return value == null ? null : String(value);
}

function elapsedSince(started, clock) {
  return Math.max(0, finite(clock()) - finite(started));
}

function rounded(value) {
  return Math.round(finite(value) * 1000) / 1000;
}

function errorMessage(error) {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return "uninspectable error";
  }
}

function monotonicNow() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}
