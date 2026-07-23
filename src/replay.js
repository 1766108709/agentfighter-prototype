import { createGame, nextRound, stepGame } from "./combat-engine.js";
import { EMPTY_COMBAT_INPUT, normalizeCombatInput } from "./input-schema.js";
import { recordCombatEvent } from "./telemetry.js";

export const REPLAY_FORMAT = "agentfighter.replay";
export const REPLAY_SCHEMA = "ReplayV1";
export const REPLAY_VERSION = 1;
export const REPLAY_CHECKPOINT_INTERVAL = 120;
export const REPLAY_MAX_CHECKPOINTS = 32;

const HASH_PATTERN = /^[0-9a-f]{8}$/;
const UINT32_MAX = 0xffffffff;
const CANONICAL_INPUT_KEYS = Object.freeze(Object.keys(EMPTY_COMBAT_INPUT));
const CANONICAL_INPUT_KEY_SET = new Set(CANONICAL_INPUT_KEYS);
const INPUT_SOURCE_KEYS = new Set([
  ...CANONICAL_INPUT_KEYS,
  "light", "heavy", "special", "grab", "parry", "roll", "driveImpact", "blowback",
  "lightPunch", "punchLight", "mediumPunch", "punchMedium", "heavyPunch", "punchHeavy",
  "lightKick", "kickLight", "mediumKick", "kickMedium", "heavyKick", "kickHeavy",
]);
const NON_COMBAT_PRESENTATION_FIELDS = new Set([
  "aiDebug",
  "aiIntents",
  "aiTelemetry",
  "agentDebug",
  "aiIntent",
  "aiReason",
  "aiMoveId",
  "aiPlanFrame",
  "aiPlan",
  "ai",
]);

export class ReplayValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayValidationError";
  }
}

export class ReplayDivergenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReplayDivergenceError";
    this.details = details;
  }
}

/**
 * Record a fresh createGame() instance without changing combat-engine semantics.
 *
 * `recordFrame()` is the only method that advances simulation time. Call
 * `advanceRound()` before the next AI decisions when a multi-round match is in
 * `roundOver`; that transition is attached to the following replay frame.
 */
export function createReplayRecorder(game, options = {}) {
  assertGame(game);
  assertPlainObject(options, "recorder options");
  if (game.frame !== 0 || game.roundFrame !== 0 || game.phase !== "fighting") {
    throw new ReplayValidationError("Replay recording must start from a fresh fighting game at frame 0.");
  }

  // The normalized engine config intentionally carries a few optional
  // `undefined` fields (for example startingDrive). ReplayV1 omits those keys
  // so the persisted document remains JSON-safe; createGame restores defaults.
  const config = cloneEngineConfig(game.config);
  const reconstructed = createGame(config);
  const initialStateHash = replayStateHash(game);
  if (replayStateHash(reconstructed) !== initialStateHash) {
    throw new ReplayValidationError(
      "The initial game cannot be reconstructed from game.config; start recording immediately after createGame().",
    );
  }

  const replay = {
    format: REPLAY_FORMAT,
    schema: REPLAY_SCHEMA,
    version: REPLAY_VERSION,
    engine: {
      version: String(game.version ?? "unknown"),
      tickRate: positiveInteger(game.tickRate, "game.tickRate"),
    },
    initial: {
      seed: uint32(options.seed ?? 0, "seed"),
      config,
      stateHash: initialStateHash,
    },
    rules: buildRules(game, options.rules),
    metadata: cloneJson(options.metadata ?? {}, "replay metadata"),
    frames: [],
    events: [],
    end: null,
  };

  let closed = false;
  let pendingAdvanceRound = false;
  let lastGameplayHash = replayStateHash(game, { ignoreTelemetry: true });
  let lastStateHash = initialStateHash;
  const seenEvents = new WeakSet();
  for (const event of game.combatEvents ?? []) {
    if (event && typeof event === "object") seenEvents.add(event);
  }

  function assertOpen() {
    if (closed) throw new ReplayValidationError("Cannot modify a finalized replay.");
  }

  function assertGameplayUnchanged() {
    const actual = replayStateHash(game, { ignoreTelemetry: true });
    if (actual !== lastGameplayHash) {
      throw new ReplayValidationError(
        "Game state changed outside the replay recorder; advance it only with recordFrame()/advanceRound().",
      );
    }
  }

  function collectNewEvents() {
    const fresh = [];
    for (const event of game.combatEvents ?? []) {
      if (!event || typeof event !== "object" || seenEvents.has(event)) continue;
      seenEvents.add(event);
      fresh.push(cloneJson(event, "combat event"));
    }
    return fresh;
  }

  function hasUnrecordedEvents() {
    return (game.combatEvents ?? []).some(
      (event) => event && typeof event === "object" && !seenEvents.has(event),
    );
  }

  function appendEvents(events, cursor, timing) {
    for (const event of events) {
      replay.events.push({
        sequence: replay.events.length,
        cursor,
        timing,
        event,
      });
    }
  }

  /** Advance a completed round without consuming a simulation frame. */
  function advanceRound() {
    assertOpen();
    if (pendingAdvanceRound) {
      throw new ReplayValidationError("A round advance is already waiting to be recorded.");
    }
    assertGameplayUnchanged();
    if (hasUnrecordedEvents()) {
      throw new ReplayValidationError("Unrecorded combat events exist; record a frame before advancing the round.");
    }
    if (game.phase !== "roundOver" || game.matchWinner !== null) {
      throw new ReplayValidationError("advanceRound() requires roundOver with no match winner.");
    }
    nextRound(game);
    pendingAdvanceRound = true;
    lastGameplayHash = replayStateHash(game, { ignoreTelemetry: true });
    lastStateHash = replayStateHash(game);
    return game;
  }

  /**
   * Canonicalize and record one pair of controller inputs, then call stepGame().
   * Returns the live game plus JSON-safe frame/event records for adapters/UI.
   */
  function recordFrame(inputFrames = {}, frameOptions = {}) {
    assertOpen();
    assertPlainObject(inputFrames, "input frame");
    assertPlainObject(frameOptions, "frame options");
    for (const key of Object.keys(inputFrames)) {
      if (key !== "p1" && key !== "p2") {
        throw new ReplayValidationError(`input frame.${key} is not supported.`);
      }
    }
    for (const key of Object.keys(frameOptions)) {
      if (key !== "advanceRound" && key !== "decisions") {
        throw new ReplayValidationError(`frame options.${key} is not supported.`);
      }
    }
    if (frameOptions.advanceRound === true) advanceRound();
    else if (frameOptions.advanceRound != null && frameOptions.advanceRound !== false) {
      throw new ReplayValidationError("frameOptions.advanceRound must be a boolean.");
    }
    assertGameplayUnchanged();

    const inputs = {
      p1: canonicalizeInput(inputFrames.p1, "inputs.p1"),
      p2: canonicalizeInput(inputFrames.p2, "inputs.p2"),
    };
    const decisions = normalizeDecisions(frameOptions.decisions);
    const cursor = replay.frames.length + 1;
    const eventStart = replay.events.length;
    const preEvents = collectNewEvents();
    appendEvents(preEvents, cursor, "preStep");

    stepGame(game, inputs);

    const postEvents = collectNewEvents();
    appendEvents(postEvents, cursor, "postStep");
    const stateHash = replayStateHash(game);
    const frame = {
      sequence: cursor - 1,
      engineFrame: game.frame,
      advanceRound: pendingAdvanceRound,
      inputs,
      eventRange: {
        start: eventStart,
        count: preEvents.length + postEvents.length,
        preStepCount: preEvents.length,
      },
      stateHash,
    };
    if (decisions !== undefined) frame.decisions = decisions;
    replay.frames.push(frame);
    pendingAdvanceRound = false;
    lastGameplayHash = replayStateHash(game, { ignoreTelemetry: true });
    lastStateHash = stateHash;

    return {
      game,
      cursor,
      frame: cloneJson(frame, "replay frame"),
      events: cloneJson([...preEvents, ...postEvents], "frame events"),
    };
  }

  /** Finalize and return a detached, JSON-safe ReplayV1 object. */
  function finish(endMetadata = {}) {
    assertOpen();
    assertGameplayUnchanged();
    if (pendingAdvanceRound) {
      throw new ReplayValidationError("Record a frame after advanceRound() before finalizing the replay.");
    }
    if (hasUnrecordedEvents() || replayStateHash(game) !== lastStateHash) {
      throw new ReplayValidationError("Game telemetry changed after the last recorded frame.");
    }
    replay.end = {
      completed: game.phase === "matchOver",
      totalFrames: replay.frames.length,
      eventCount: replay.events.length,
      engineFrame: game.frame,
      stateHash: lastStateHash,
      summary: summarizeReplayGame(game),
      metadata: cloneJson(endMetadata, "end metadata"),
    };
    validateReplayV1(replay);
    closed = true;
    return cloneJson(replay, "replay");
  }

  return {
    game,
    recordFrame,
    step: recordFrame,
    advanceRound,
    finish,
    get frameCount() { return replay.frames.length; },
    get eventCount() { return replay.events.length; },
    get isFinalized() { return closed; },
    snapshot() { return cloneJson(replay, "replay"); },
  };
}

/**
 * Create a deterministic ReplayV1 player.
 *
 * Cursor semantics are 0..totalFrames: cursor 0 is the initial state, and
 * cursor N is the state after replay frame N. Forward seeks continue from the
 * current state; backward seeks restore the nearest bounded checkpoint and
 * replay from there. Every simulated `step()` still verifies events and the
 * recorded state checksum.
 */
export function createReplayPlayer(value, options = {}) {
  const replay = cloneJson(value, "replay");
  validateReplayV1(replay);
  assertPlainObject(options, "replay player options");
  for (const key of Object.keys(options)) {
    if (key !== "checkpointInterval" && key !== "maxCheckpoints") {
      throw new ReplayValidationError(`replay player options.${key} is not supported.`);
    }
  }
  const checkpointInterval = integerInRange(
    options.checkpointInterval ?? REPLAY_CHECKPOINT_INTERVAL,
    1,
    1_000_000,
    "checkpointInterval",
  );
  const maxCheckpoints = integerInRange(
    options.maxCheckpoints ?? REPLAY_MAX_CHECKPOINTS,
    2,
    256,
    "maxCheckpoints",
  );

  let game;
  let cursor;
  let currentEvents;
  let seeking = false;
  let recovering = false;
  const checkpoints = new Map();
  const debug = {
    resetCount: 0,
    seekCount: 0,
    restoreCount: 0,
    checkpointHits: 0,
    totalSimulatedSteps: 0,
    lastSeekSteps: 0,
    lastSeekFrom: 0,
    lastSeekTarget: 0,
    lastRestoreCursor: 0,
    recoveryCount: 0,
    lastRecoveryCursor: 0,
  };

  function ensureEngineCompatible(candidate) {
    if (String(candidate.version ?? "unknown") !== replay.engine.version) {
      throw new ReplayValidationError(
        `Replay engine version ${replay.engine.version} is incompatible with ${candidate.version ?? "unknown"}.`,
      );
    }
    if (candidate.tickRate !== replay.engine.tickRate) {
      throw new ReplayValidationError(
        `Replay tick rate ${replay.engine.tickRate} is incompatible with ${candidate.tickRate}.`,
      );
    }
  }

  function expectedHashAt(targetCursor) {
    return targetCursor === 0
      ? replay.initial.stateHash
      : replay.frames[targetCursor - 1].stateHash;
  }

  function storeCheckpoint(force = false) {
    if (!force && cursor !== 0 && cursor % checkpointInterval !== 0) return;
    const snapshot = cloneGameState(game);
    const expected = expectedHashAt(cursor);
    const actual = replayStateHash(snapshot);
    if (actual !== expected) {
      throw divergence("Checkpoint snapshot does not match replay state.", cursor, expected, actual);
    }
    // Reinsert an existing cursor so eviction remains least-recently-written.
    checkpoints.delete(cursor);
    checkpoints.set(cursor, {
      cursor,
      game: snapshot,
      currentEvents: cloneJson(currentEvents, "checkpoint events"),
      stateHash: expected,
    });
    while (checkpoints.size > maxCheckpoints) {
      const removable = [...checkpoints.keys()].find((candidate) => candidate !== 0);
      if (removable === undefined) break;
      checkpoints.delete(removable);
    }
  }

  function initializeAtStart({ countReset = false } = {}) {
    game = createGame(replay.initial.config);
    ensureEngineCompatible(game);
    const actual = replayStateHash(game);
    if (actual !== replay.initial.stateHash) {
      throw divergence("Initial replay state does not match its checksum.", 0, replay.initial.stateHash, actual);
    }
    cursor = 0;
    currentEvents = [];
    if (countReset) debug.resetCount += 1;
    storeCheckpoint(true);
    return status();
  }

  function reset() {
    return initializeAtStart({ countReset: true });
  }

  function restoreCheckpoint(targetCursor) {
    let selected = 0;
    for (const candidate of checkpoints.keys()) {
      if (candidate <= targetCursor && candidate >= selected) selected = candidate;
    }
    const checkpoint = checkpoints.get(selected);
    if (!checkpoint) {
      throw new ReplayValidationError("Replay checkpoint 0 is unavailable.");
    }
    game = cloneGameState(checkpoint.game);
    cursor = checkpoint.cursor;
    currentEvents = cloneJson(checkpoint.currentEvents, "checkpoint events");
    const actual = replayStateHash(game);
    if (actual !== checkpoint.stateHash) {
      throw divergence("Restored checkpoint checksum diverged.", cursor, checkpoint.stateHash, actual);
    }
    debug.restoreCount += 1;
    debug.checkpointHits += selected > 0 ? 1 : 0;
    debug.lastRestoreCursor = selected;
    return selected;
  }

  function frameEvents(frame) {
    const { start, count } = frame.eventRange;
    return replay.events.slice(start, start + count);
  }

  function injectPreStepEvent(record) {
    const source = record.event;
    if (source.frame !== game.frame) {
      throw divergence(
        `Pre-step event belongs to engine frame ${source.frame}, not ${game.frame}.`,
        cursor + 1,
        source.frame,
        game.frame,
      );
    }
    const { frame: _frame, type, ...data } = source;
    const actual = recordCombatEvent(game, type, data);
    assertSameJson(actual, source, `pre-step event ${record.sequence}`, cursor + 1);
  }

  function recoverFailedStep(safeCursor, exposedGame) {
    const wasRecovering = recovering;
    recovering = true;
    try {
      restoreCheckpoint(safeCursor);
      while (cursor < safeCursor) advanceOneFrame();
      const restored = game;
      overwriteGameState(exposedGame, restored);
      game = exposedGame;
      const expected = expectedHashAt(safeCursor);
      const actual = replayStateHash(game);
      if (actual !== expected) {
        throw divergence("Failed-step recovery checksum diverged.", safeCursor, expected, actual);
      }
      debug.recoveryCount += 1;
      debug.lastRecoveryCursor = safeCursor;
    } finally {
      recovering = wasRecovering;
    }
  }

  function advanceOneFrame() {
    const frame = replay.frames[cursor];
    if (frame.advanceRound) {
      if (game.phase !== "roundOver" || game.matchWinner !== null) {
        throw divergence("Recorded round advance is invalid for the current state.", cursor + 1, "roundOver", game.phase);
      }
      nextRound(game);
    }

    const eventRecords = frameEvents(frame);
    const preRecords = eventRecords.slice(0, frame.eventRange.preStepCount);
    const postRecords = eventRecords.slice(frame.eventRange.preStepCount);
    for (const record of preRecords) injectPreStepEvent(record);

    const existingEvents = new WeakSet(
      (game.combatEvents ?? []).filter((event) => event && typeof event === "object"),
    );
    stepGame(game, frame.inputs);
    if (game.frame !== frame.engineFrame) {
      throw divergence("Engine frame diverged during replay.", cursor + 1, frame.engineFrame, game.frame);
    }
    const actualPostEvents = (game.combatEvents ?? [])
      .filter((event) => event && typeof event === "object" && !existingEvents.has(event));
    const expectedPostEvents = postRecords.map((record) => record.event);
    assertSameJson(actualPostEvents, expectedPostEvents, "post-step combat events", cursor + 1);

    const actualHash = replayStateHash(game);
    if (actualHash !== frame.stateHash) {
      throw divergence("Replay state checksum diverged.", cursor + 1, frame.stateHash, actualHash);
    }
    cursor += 1;
    currentEvents = eventRecords.map((record) => record.event);
    storeCheckpoint();
    if (!recovering) {
      debug.totalSimulatedSteps += 1;
      if (seeking) debug.lastSeekSteps += 1;
    }
    return { ...status(), done: cursor >= replay.frames.length };
  }

  function step() {
    if (cursor >= replay.frames.length) return { ...status(), done: true };
    const safeCursor = cursor;
    const exposedGame = game;
    try {
      return advanceOneFrame();
    } catch (error) {
      try {
        recoverFailedStep(safeCursor, exposedGame);
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
      }
      throw error;
    }
  }

  function seek(targetCursor) {
    const target = integerInRange(targetCursor, 0, replay.frames.length, "replay cursor");
    const from = cursor;
    debug.seekCount += 1;
    debug.lastSeekSteps = 0;
    debug.lastSeekFrom = from;
    debug.lastSeekTarget = target;
    if (target < cursor) restoreCheckpoint(target);
    seeking = true;
    try {
      while (cursor < target) step();
    } finally {
      seeking = false;
    }
    return status();
  }

  function verify() {
    // Verification deliberately starts at frame 0 and traverses every frame;
    // checkpoints optimize navigation, never weaken full replay validation.
    reset();
    while (cursor < replay.frames.length) step();
    const actualSummary = summarizeReplayGame(game);
    assertSameJson(actualSummary, replay.end.summary, "ending summary", cursor);
    const actualHash = replayStateHash(game);
    if (actualHash !== replay.end.stateHash) {
      throw divergence("Ending checksum diverged.", cursor, replay.end.stateHash, actualHash);
    }
    return {
      valid: true,
      totalFrames: replay.frames.length,
      eventCount: replay.events.length,
      stateHash: actualHash,
      summary: actualSummary,
    };
  }

  function frameAt(targetCursor) {
    const target = integerInRange(targetCursor, 0, replay.frames.length, "replay cursor");
    return target === 0 ? null : cloneJson(replay.frames[target - 1], "replay frame");
  }

  function eventsAt(targetCursor) {
    const target = integerInRange(targetCursor, 0, replay.frames.length, "replay cursor");
    if (target === 0) return [];
    return cloneJson(frameEvents(replay.frames[target - 1]).map((record) => record.event), "frame events");
  }

  function status() {
    return {
      game,
      cursor,
      totalFrames: replay.frames.length,
      currentFrame: cursor === 0 ? null : cloneJson(replay.frames[cursor - 1], "replay frame"),
      events: cloneJson(currentEvents, "current events"),
    };
  }

  initializeAtStart();
  return {
    reset,
    step,
    seek,
    verify,
    frameAt,
    eventsAt,
    get game() { return game; },
    get cursor() { return cursor; },
    get totalFrames() { return replay.frames.length; },
    get currentFrame() { return frameAt(cursor); },
    get currentEvents() { return cloneJson(currentEvents, "current events"); },
    get data() { return cloneJson(replay, "replay"); },
    get debugStats() {
      return {
        ...debug,
        checkpointInterval,
        maxCheckpoints,
        checkpointCount: checkpoints.size,
        checkpointCursors: [...checkpoints.keys()].sort((left, right) => left - right),
      };
    },
  };
}

/** Throw ReplayValidationError unless value is a complete ReplayV1 document. */
export function validateReplayV1(value) {
  assertPlainObject(value, "replay");
  if (value.format !== REPLAY_FORMAT) {
    throw new ReplayValidationError(`Unsupported replay format: ${String(value.format)}.`);
  }
  if (value.schema !== REPLAY_SCHEMA) {
    throw new ReplayValidationError(`Unsupported replay schema: ${String(value.schema)}.`);
  }
  if (value.version !== REPLAY_VERSION) {
    throw new ReplayValidationError(`Unsupported replay version: ${String(value.version)}.`);
  }
  assertPlainObject(value.engine, "replay.engine");
  if (typeof value.engine.version !== "string" || !value.engine.version) {
    throw new ReplayValidationError("replay.engine.version must be a non-empty string.");
  }
  positiveInteger(value.engine.tickRate, "replay.engine.tickRate");
  assertPlainObject(value.initial, "replay.initial");
  uint32(value.initial.seed, "replay.initial.seed");
  assertPlainObject(value.initial.config, "replay.initial.config");
  assertJsonSafe(value.initial.config, "replay.initial.config");
  assertHash(value.initial.stateHash, "replay.initial.stateHash");
  assertPlainObject(value.rules, "replay.rules");
  assertJsonSafe(value.rules, "replay.rules");
  assertJsonSafe(value.metadata, "replay.metadata");
  if (!Array.isArray(value.frames)) throw new ReplayValidationError("replay.frames must be an array.");
  if (!Array.isArray(value.events)) throw new ReplayValidationError("replay.events must be an array.");
  assertPlainObject(value.end, "replay.end");

  let nextEventStart = 0;
  value.frames.forEach((frame, index) => {
    const label = `replay.frames[${index}]`;
    assertPlainObject(frame, label);
    if (frame.sequence !== index) throw new ReplayValidationError(`${label}.sequence must equal ${index}.`);
    if (frame.engineFrame !== index + 1) {
      throw new ReplayValidationError(`${label}.engineFrame must equal ${index + 1}.`);
    }
    if (typeof frame.advanceRound !== "boolean") {
      throw new ReplayValidationError(`${label}.advanceRound must be a boolean.`);
    }
    assertPlainObject(frame.inputs, `${label}.inputs`);
    assertCanonicalInput(frame.inputs.p1, `${label}.inputs.p1`);
    assertCanonicalInput(frame.inputs.p2, `${label}.inputs.p2`);
    if (Object.hasOwn(frame, "decisions")) normalizeDecisions(frame.decisions);
    assertPlainObject(frame.eventRange, `${label}.eventRange`);
    const { start, count, preStepCount } = frame.eventRange;
    if (start !== nextEventStart) throw new ReplayValidationError(`${label}.eventRange.start is not contiguous.`);
    if (!Number.isInteger(count) || count < 0) throw new ReplayValidationError(`${label}.eventRange.count must be non-negative.`);
    if (!Number.isInteger(preStepCount) || preStepCount < 0 || preStepCount > count) {
      throw new ReplayValidationError(`${label}.eventRange.preStepCount is invalid.`);
    }
    for (let offset = 0; offset < count; offset += 1) {
      const record = value.events[start + offset];
      if (!record || record.cursor !== index + 1) {
        throw new ReplayValidationError(`${label}.eventRange contains an event for another cursor.`);
      }
      const expectedTiming = offset < preStepCount ? "preStep" : "postStep";
      if (record.timing !== expectedTiming) {
        throw new ReplayValidationError(`${label}.eventRange has invalid ${record.timing} ordering.`);
      }
    }
    nextEventStart += count;
    assertHash(frame.stateHash, `${label}.stateHash`);
  });
  if (nextEventStart !== value.events.length) {
    throw new ReplayValidationError("Replay frame event ranges do not cover replay.events exactly.");
  }

  value.events.forEach((record, index) => {
    const label = `replay.events[${index}]`;
    assertPlainObject(record, label);
    if (record.sequence !== index) throw new ReplayValidationError(`${label}.sequence must equal ${index}.`);
    if (!Number.isInteger(record.cursor) || record.cursor < 1 || record.cursor > value.frames.length) {
      throw new ReplayValidationError(`${label}.cursor is outside the replay timeline.`);
    }
    if (record.timing !== "preStep" && record.timing !== "postStep") {
      throw new ReplayValidationError(`${label}.timing must be preStep or postStep.`);
    }
    assertPlainObject(record.event, `${label}.event`);
    if (!Number.isInteger(record.event.frame) || record.event.frame < 0) {
      throw new ReplayValidationError(`${label}.event.frame must be a non-negative integer.`);
    }
    if (typeof record.event.type !== "string" || !record.event.type) {
      throw new ReplayValidationError(`${label}.event.type must be a non-empty string.`);
    }
    assertJsonSafe(record.event, `${label}.event`);
  });

  if (typeof value.end.completed !== "boolean") {
    throw new ReplayValidationError("replay.end.completed must be a boolean.");
  }
  if (value.end.totalFrames !== value.frames.length) {
    throw new ReplayValidationError("replay.end.totalFrames does not match replay.frames.");
  }
  if (value.end.eventCount !== value.events.length) {
    throw new ReplayValidationError("replay.end.eventCount does not match replay.events.");
  }
  if (!Number.isInteger(value.end.engineFrame) || value.end.engineFrame < 0) {
    throw new ReplayValidationError("replay.end.engineFrame must be a non-negative integer.");
  }
  if (value.end.engineFrame !== value.frames.length) {
    throw new ReplayValidationError("replay.end.engineFrame must equal replay.end.totalFrames.");
  }
  assertHash(value.end.stateHash, "replay.end.stateHash");
  const expectedEndHash = value.frames.length > 0
    ? value.frames[value.frames.length - 1].stateHash
    : value.initial.stateHash;
  if (value.end.stateHash !== expectedEndHash) {
    throw new ReplayValidationError("replay.end.stateHash does not match the final recorded state.");
  }
  assertPlainObject(value.end.summary, "replay.end.summary");
  assertJsonSafe(value.end.summary, "replay.end.summary");
  assertJsonSafe(value.end.metadata, "replay.end.metadata");
  return true;
}

/** Stable, compact terminal/key-state representation used by replay consumers. */
export function summarizeReplayGame(game) {
  assertGame(game);
  return {
    stateHash: replayStateHash(game),
    engineFrame: game.frame,
    roundFrame: game.roundFrame,
    timerFrames: game.timerFrames,
    phase: game.phase,
    roundNumber: game.roundNumber,
    roundWinner: game.roundWinner,
    roundReason: game.roundReason,
    matchWinner: game.matchWinner,
    score: [...game.score],
    hitstopFrames: game.hitstopFrames,
    fighters: game.fighters.map((fighter) => ({
      id: fighter.id,
      templateId: fighter.templateId,
      health: fighter.health,
      maxHealth: fighter.maxHealth,
      x: fighter.x,
      y: fighter.y,
      vx: fighter.vx,
      vy: fighter.vy,
      facing: fighter.facing,
      onGround: fighter.onGround,
      action: fighter.action,
      currentMoveId: fighter.currentMoveId,
      actionFrame: fighter.actionFrame,
      hitstunFrames: fighter.hitstunFrames,
      blockstunFrames: fighter.blockstunFrames,
      knockdownFrames: fighter.knockdownFrames,
      superMeter: fighter.superMeter,
      drive: fighter.drive,
      guardGauge: fighter.guardGauge,
      comboCount: fighter.comboCount,
      comboDamage: fighter.comboDamage,
    })),
    projectileCount: game.projectiles.length,
    telemetry: cloneJson(game.telemetry ?? {}, "game telemetry"),
  };
}

/** Deterministic checksum of combat state; agent presentation fields are omitted. */
export function replayStateHash(game, options = {}) {
  assertGame(game);
  const stable = stableValue(game, {
    ignoreTelemetry: options.ignoreTelemetry === true,
    seen: new WeakSet(),
  });
  return fnv1a(JSON.stringify(stable));
}

function buildRules(game, extensions) {
  const custom = extensions ?? {};
  assertPlainObject(custom, "rules extensions");
  return {
    bestOf: game.config.bestOf,
    winsNeeded: game.config.winsNeeded,
    roundSeconds: game.config.roundSeconds,
    inputBufferFrames: game.config.inputBufferFrames,
    trainingResources: game.config.trainingResources,
    extensions: cloneJson(custom, "rules extensions"),
  };
}

function canonicalizeInput(value, label) {
  if (value == null) return { ...EMPTY_COMBAT_INPUT };
  assertPlainObject(value, label);
  for (const [key, child] of Object.entries(value)) {
    if (!INPUT_SOURCE_KEYS.has(key)) throw new ReplayValidationError(`${label}.${key} is not a supported input field.`);
    if (typeof child !== "boolean") throw new ReplayValidationError(`${label}.${key} must be a boolean.`);
  }
  const normalized = normalizeCombatInput(value);
  return Object.fromEntries(CANONICAL_INPUT_KEYS.map((key) => [key, normalized[key]]));
}

function assertCanonicalInput(value, label) {
  assertPlainObject(value, label);
  const keys = Object.keys(value);
  if (keys.length !== CANONICAL_INPUT_KEYS.length || keys.some((key) => !CANONICAL_INPUT_KEY_SET.has(key))) {
    throw new ReplayValidationError(`${label} must contain exactly the canonical combat input fields.`);
  }
  for (const key of CANONICAL_INPUT_KEYS) {
    if (typeof value[key] !== "boolean") throw new ReplayValidationError(`${label}.${key} must be a boolean.`);
  }
}

function normalizeDecisions(value) {
  if (value === undefined) return undefined;
  assertPlainObject(value, "decisions");
  for (const key of Object.keys(value)) {
    if (key !== "p1" && key !== "p2") throw new ReplayValidationError(`decisions.${key} is not supported.`);
  }
  const result = {};
  if (Object.hasOwn(value, "p1")) result.p1 = cloneJson(value.p1, "decisions.p1");
  if (Object.hasOwn(value, "p2")) result.p2 = cloneJson(value.p2, "decisions.p2");
  return result;
}

function stableValue(value, context, key = "") {
  // Only known renderer/controller annotations are excluded. Future combat
  // fields such as aiArmor must affect determinism unless explicitly reviewed.
  if (NON_COMBAT_PRESENTATION_FIELDS.has(key)) return undefined;
  if (context.ignoreTelemetry && (key === "telemetry" || key === "combatEvents")) return undefined;
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReplayValidationError("Game state contains a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (context.seen.has(value)) throw new ReplayValidationError("Game state contains a cycle.");
    context.seen.add(value);
    const result = value.map((child) => stableValue(child, context));
    context.seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (context.seen.has(value)) throw new ReplayValidationError("Game state contains a cycle.");
    context.seen.add(value);
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      const child = stableValue(value[childKey], context, childKey);
      if (child !== undefined) result[childKey] = child;
    }
    context.seen.delete(value);
    return result;
  }
  throw new ReplayValidationError(`Game state contains unsupported ${typeof value}.`);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cloneJson(value, label) {
  assertJsonSafe(value, label);
  return JSON.parse(JSON.stringify(value));
}

function cloneEngineConfig(value) {
  assertPlainObject(value, "game config");
  const json = JSON.stringify(value, (key, child) => {
    if (child === undefined) return undefined;
    if (typeof child === "number" && !Number.isFinite(child)) {
      throw new ReplayValidationError(`game config.${key} contains a non-finite number.`);
    }
    if (typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
      throw new ReplayValidationError(`game config.${key} is not JSON-safe.`);
    }
    return child;
  });
  const result = JSON.parse(json);
  assertJsonSafe(result, "game config");
  return result;
}

function cloneGameState(value) {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch (error) {
      throw new ReplayValidationError(`Unable to clone replay checkpoint: ${error?.message ?? String(error)}.`);
    }
  }
  return cloneStateFallback(value, new Map());
}

function overwriteGameState(target, source) {
  const restored = cloneGameState(source);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, restored);
  return target;
}

function cloneStateFallback(value, seen) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const child of value) result.push(cloneStateFallback(child, seen));
    return result;
  }
  const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, result);
  for (const [key, child] of Object.entries(value)) result[key] = cloneStateFallback(child, seen);
  return result;
}

function assertJsonSafe(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReplayValidationError(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new ReplayValidationError(`${label} contains a cycle.`);
    ancestors.add(value);
    value.forEach((child, index) => assertJsonSafe(child, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) throw new ReplayValidationError(`${label} contains a cycle.`);
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) assertJsonSafe(child, `${label}.${key}`, ancestors);
    ancestors.delete(value);
    return;
  }
  throw new ReplayValidationError(`${label} contains non-JSON value ${String(value)}.`);
}

function assertSameJson(actual, expected, label, cursor) {
  const actualText = JSON.stringify(stableValue(actual, { ignoreTelemetry: false, seen: new WeakSet() }));
  const expectedText = JSON.stringify(stableValue(expected, { ignoreTelemetry: false, seen: new WeakSet() }));
  if (actualText !== expectedText) throw divergence(`${label} diverged.`, cursor, expected, actual);
}

function divergence(message, cursor, expected, actual) {
  return new ReplayDivergenceError(message, { cursor, expected, actual });
}

function assertGame(game) {
  if (!game || !Array.isArray(game.fighters) || game.fighters.length !== 2 || !game.config) {
    throw new ReplayValidationError("Expected a game created by createGame().");
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new ReplayValidationError(`${label} must be a plain object.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new ReplayValidationError(`${label} must be a positive integer.`);
  return value;
}

function uint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new ReplayValidationError(`${label} must be an unsigned 32-bit integer.`);
  }
  return value >>> 0;
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ReplayValidationError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new ReplayValidationError(`${label} must be an eight-character lowercase hexadecimal checksum.`);
  }
}
