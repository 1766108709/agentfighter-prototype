import assert from "node:assert/strict";

import { createGame } from "../src/engine.js";
import {
  ACTION_V1_SCHEMA,
  AGENT_PROTOCOL_VERSION,
  MATCH_INFO_V1_SCHEMA,
  MATCH_RESULT_V1_SCHEMA,
  OBSERVATION_EVENT_LIMIT,
  OBSERVATION_V1_SCHEMA,
  createActionV1,
  createInProcessAgentRunner,
  createMatchInfoV1,
  createMatchResultV1,
  createObservationV1,
  createScriptAIAgent,
  validateActionV1,
} from "../src/agent-sdk.js";
import { runHeadlessTournament } from "../src/headless.js";
import { createReplayPlayer } from "../src/replay.js";

function testObservationBoundary() {
  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  game.secretServerState = "must-not-leak";
  game.fighters[0].lastInput.secretButton = true;
  game.fighters[0].directionHistory.push({ secretMotion: "must-not-leak" });
  game.fighters[0].commandBuffer = { secretCommand: "must-not-leak" };
  game.fighters[0].aiIntent = "hidden-plan";
  game.combatEvents.push({ frame: 0, privateReason: "must-not-leak" });

  const observation = createObservationV1(game, 1);
  assert.equal(observation.schema, OBSERVATION_V1_SCHEMA);
  assert.equal(observation.version, AGENT_PROTOCOL_VERSION);
  assert.equal(observation.selfIndex, 1);
  assert.equal(observation.self.name, game.fighters[1].name);
  assert.equal(observation.opponent.name, game.fighters[0].name);
  assert(Object.isFrozen(observation), "observation root must be immutable");
  assert(Object.isFrozen(observation.self.state), "nested observation values must be immutable");

  const serialized = JSON.stringify(observation);
  assert.doesNotThrow(() => JSON.parse(serialized), "ObservationV1 must be JSON-safe");
  for (const forbidden of [
    "must-not-leak",
    "lastInput",
    "previousInput",
    "directionHistory",
    "commandBuffer",
    "currentMove",
    "aiIntent",
    "combatEvents",
    "hitboxes",
  ]) {
    assert(!serialized.includes(forbidden), `observation must mask ${forbidden}`);
  }

  const info = createMatchInfoV1(game, 1, { matchId: "mask-test", seed: 9 });
  assert.equal(info.schema, MATCH_INFO_V1_SCHEMA);
  assert.equal(info.matchId, "mask-test");
  assert.equal(info.side, "right");
  assert.doesNotThrow(() => JSON.stringify(info));

  game.matchWinner = 1;
  game.phase = "matchOver";
  const result = createMatchResultV1(game, 1, { matchId: "mask-test", termination: "matchOver" });
  assert.equal(result.schema, MATCH_RESULT_V1_SCHEMA);
  assert.equal(result.outcome, "win");
  assert.doesNotThrow(() => JSON.stringify(result));
}

function testActionValidation() {
  const canonical = createActionV1({ right: true, lp: true });
  assert.equal(canonical.schema, ACTION_V1_SCHEMA);
  assert.equal(validateActionV1(canonical).valid, true);
  assert.equal(validateActionV1(canonical).input.right, true);
  assert.equal(validateActionV1(canonical).input.lp, true);
  assert.throws(
    () => createActionV1({ hpp: true }),
    /unknown input field: hpp/,
    "ActionV1 construction must reject misspelled controller fields",
  );
  assert.throws(
    () => createActionV1({ hp: 1 }),
    /input\.hp must be boolean/,
    "ActionV1 construction must reject non-boolean controller values",
  );

  for (const invalid of [
    null,
    Promise.resolve(canonical),
    { schema: ACTION_V1_SCHEMA, version: 99, input: {} },
    { schema: ACTION_V1_SCHEMA, version: 1, input: { lp: "yes" } },
    { schema: ACTION_V1_SCHEMA, version: 1, input: { cheat: true } },
    { schema: ACTION_V1_SCHEMA, version: 1, input: { left: true, right: true } },
    { schema: ACTION_V1_SCHEMA, version: 1, input: {}, rawGame: true },
  ]) {
    assert.equal(validateActionV1(invalid).valid, false, "invalid action must be rejected");
  }
}

function testHostileActionDescriptors() {
  const makeRaw = (input = {}) => ({ schema: ACTION_V1_SCHEMA, version: 1, input });
  const hidden = makeRaw();
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  assert.equal(validateActionV1(hidden).valid, false, "non-enumerable unknown top-level fields must be rejected");

  const symbol = Symbol("hidden");
  const symbolTop = makeRaw();
  symbolTop[symbol] = true;
  assert.equal(validateActionV1(symbolTop).valid, false, "Symbol top-level fields must be rejected");
  assert.throws(() => createActionV1({ [symbol]: true }), TypeError);

  let getterReads = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "hp", {
    enumerable: true,
    get() {
      getterReads += 1;
      if (getterReads > 1) throw new Error("TOCTOU getter changed");
      return true;
    },
  });
  assert.equal(validateActionV1(makeRaw(accessorInput)).valid, false);
  assert.equal(getterReads, 0, "validation must inspect descriptors without invoking getters");
  assert.throws(() => createActionV1(accessorInput), TypeError);
  assert.equal(getterReads, 0, "Action construction must not invoke accessors");

  const throwingTop = {};
  Object.defineProperty(throwingTop, "schema", {
    enumerable: true,
    get() { throw new Error("schema getter must never execute"); },
  });
  throwingTop.version = 1;
  throwingTop.input = {};
  assert.equal(validateActionV1(throwingTop).valid, false);

  const ownKeysProxy = new Proxy({}, {
    ownKeys() { throw new Error("ownKeys trap"); },
  });
  const descriptorProxy = new Proxy(makeRaw(), {
    getOwnPropertyDescriptor() { throw new Error("descriptor trap"); },
  });
  assert.doesNotThrow(() => validateActionV1(ownKeysProxy));
  assert.equal(validateActionV1(ownKeysProxy).valid, false);
  assert.doesNotThrow(() => validateActionV1(descriptorProxy));
  assert.equal(validateActionV1(descriptorProxy).valid, false);
  assert.throws(() => createActionV1(ownKeysProxy), TypeError);

  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  for (const [candidate, expectedKind] of [
    [makeRaw(accessorInput), "invalid-action"],
    [hidden, "invalid-action"],
    [symbolTop, "invalid-action"],
    [ownKeysProxy, "invalid-action"],
    [descriptorProxy, "validation-exception"],
  ]) {
    const runner = createInProcessAgentRunner({ act: () => candidate });
    runner.reset(createMatchInfoV1(game, 0));
    let input;
    assert.doesNotThrow(() => { input = runner.decide(game, 0); });
    assert(Object.values(input).every((pressed) => pressed === false));
    assert.equal(runner.getDiagnostics()[0].kind, expectedKind);
  }
  assert.equal(getterReads, 0);

  const noisy = createInProcessAgentRunner({ act: () => ({ schema: ACTION_V1_SCHEMA, version: 1, input: { hp: 1 } }) });
  noisy.reset(createMatchInfoV1(game, 0));
  for (let frame = 0; frame < 300; frame += 1) {
    game.frame = frame;
    noisy.decide(game, 0);
  }
  assert.equal(noisy.getDiagnosticSummary().total, 300);
  assert.equal(noisy.getDiagnosticSummary().byKind["invalid-action"], 300);
  assert.equal(noisy.getDiagnostics().length, 256, "diagnostic retention must be bounded without losing totals");
}

function testRunnerPolicies() {
  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  for (const options of [
    { observationDelayFrame: 3 },
    { observationDelayFrames: 0 },
    { observationDelayFrames: 1.5 },
    { decisionIntervalFrames: "2" },
    { deadlineMs: -1 },
    { timeoutPolicy: "ignore" },
    { holdLastAction: 1 },
  ]) {
    assert.throws(
      () => createInProcessAgentRunner({ act: () => createActionV1() }, options),
      TypeError,
      `invalid runner option must fail closed: ${JSON.stringify(options)}`,
    );
  }
  assert.throws(
    () => createInProcessAgentRunner(
      { act: () => createActionV1() },
      { observationDelayFrames: 1 },
    ),
    /取消|removed/i,
    "positive SDK delay must fail with an explicit migration error",
  );
  let calls = 0;
  const agent = {
    name: "interval-agent",
    reset(info) {
      assert.equal(info.schema, MATCH_INFO_V1_SCHEMA);
    },
    act(observation) {
      calls += 1;
      assert.equal(observation.schema, OBSERVATION_V1_SCHEMA);
      assert(!Object.hasOwn(observation, "fighters"), "raw fighter array must never reach Agent V1");
      return createActionV1({ right: true, lp: calls % 2 === 1 });
    },
  };
  const runner = createInProcessAgentRunner(agent, { decisionIntervalFrames: 2, holdLastAction: true });
  runner.reset(createMatchInfoV1(game, 0));
  const first = runner.decide(game, 0);
  assert.equal(first.right, true);
  assert.equal(first.lp, true);
  game.frame = 1;
  const held = runner.decide(game, 0);
  assert.deepEqual(held, first, "last action must be held between decision ticks");
  assert.equal(calls, 1);
  game.frame = 2;
  const second = runner.decide(game, 0);
  assert.equal(second.lp, false);
  assert.equal(calls, 2);
  assert.equal(runner.getLastDecision().source, "agent");
  assert.doesNotThrow(() => JSON.stringify(runner.getLastDecision()));

  const invalidRunner = createInProcessAgentRunner({
    act: () => ({ schema: ACTION_V1_SCHEMA, version: 1, input: { hp: "cheat" } }),
  });
  invalidRunner.reset(createMatchInfoV1(game, 0));
  const invalidFallback = invalidRunner.decide(game, 0);
  assert(Object.values(invalidFallback).every((pressed) => pressed === false));
  assert.equal(invalidRunner.getDiagnostics()[0].kind, "invalid-action");

  let exceptionCalls = 0;
  const exceptionRunner = createInProcessAgentRunner({
    act() {
      exceptionCalls += 1;
      if (exceptionCalls === 1) return createActionV1({ down: true, guard: true });
      throw new Error("agent exploded");
    },
  }, { exceptionPolicy: "hold-last" });
  game.frame = 0;
  exceptionRunner.reset(createMatchInfoV1(game, 0));
  const beforeException = exceptionRunner.decide(game, 0);
  game.frame = 1;
  const afterException = exceptionRunner.decide(game, 0);
  assert.deepEqual(afterException, beforeException, "exception hold-last policy must be deterministic");
  assert.equal(exceptionRunner.getDiagnostics()[0].kind, "act-exception");

  const clockValues = [0, 5];
  const timeoutRunner = createInProcessAgentRunner({
    act: () => createActionV1({ hp: true }),
  }, {
    deadlineMs: 1,
    timeoutPolicy: "disable",
    clock: () => clockValues.shift() ?? 5,
  });
  game.frame = 0;
  timeoutRunner.reset(createMatchInfoV1(game, 0));
  const timedOut = timeoutRunner.decide(game, 0);
  assert.equal(timedOut.hp, false, "deadline violation must fall back to neutral");
  assert.equal(timeoutRunner.disabled, true);
  assert.equal(timeoutRunner.nonDeterministic, true, "a finite wall-clock deadline is non-deterministic");
  assert.equal(timeoutRunner.getDiagnostics()[0].kind, "deadline-exceeded");
  assert.equal(timeoutRunner.getDiagnostics()[0].nonDeterministic, true);
  assert.equal(timeoutRunner.getDiagnostics()[0].details.nonDeterministic, true);
  assert.equal(timeoutRunner.getLastDecision().nonDeterministic, true);
  assert.equal(timeoutRunner.getLastDecision().diagnostic.nonDeterministic, true);

  const deterministicRunner = createInProcessAgentRunner({ act: () => createActionV1() });
  assert.equal(deterministicRunner.nonDeterministic, false, "the default infinite deadline must stay deterministic");

  const asyncRunner = createInProcessAgentRunner({ act: async () => createActionV1({ hp: true }) });
  asyncRunner.reset(createMatchInfoV1(game, 0));
  const asyncFallback = asyncRunner.decide(game, 0);
  assert.equal(asyncFallback.hp, false);
  assert.equal(asyncRunner.getDiagnostics()[0].kind, "async-action");
}

function testRealtimePlatformObservation() {
  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  const perceptions = [];
  const runner = createInProcessAgentRunner({
    act(observation) {
      perceptions.push({
        decisionFrame: observation.frame,
        opponentFrame: observation.perception.opponentFrame,
        selfX: observation.self.position.x,
        opponentX: observation.opponent.position.x,
      });
      return createActionV1();
    },
  });
  runner.reset(createMatchInfoV1(game, 0));

  for (let frame = 0; frame <= 8; frame += 1) {
    game.frame = frame;
    game.fighters[0].x = 100 + frame;
    game.fighters[1].x = 500 + frame;
    runner.decide(game, 0);
  }
  assert.deepEqual(
    perceptions.map((entry) => entry.opponentFrame),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    "opponent perception must stay on the current simulation frame",
  );
  assert.deepEqual(perceptions.map((entry) => entry.decisionFrame), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(perceptions.map((entry) => entry.selfX), [100, 101, 102, 103, 104, 105, 106, 107, 108]);
  assert.equal(perceptions.at(-1).opponentX, 508, "opponent state must be current alongside self state");
  assert.equal(runner.getLastDecision().decisionFrame, 8);
  assert.equal(runner.getLastDecision().observedFrame, 8);
  assert.equal(runner.getLastDecision().opponentObservedFrame, 8);
  assert.equal(runner.getLastDecision().observationFrame, 8, "legacy metadata alias must mean current frame");
  assert.equal(Object.hasOwn(runner, "observationDelayFrames"), false);

  const delayedObservation = {
    ...createObservationV1(game, 0),
    frame: 8,
    perception: { delayFrames: 3, opponentFrame: 5 },
  };
  assert.throws(
    () => runner.act(delayedObservation),
    /real-time/i,
    "direct runner.act calls must reject delayed or forged observations",
  );

  game.roundNumber = 2;
  game.round = 2;
  game.frame = 20;
  game.fighters[1].x = 900;
  runner.decide(game, 0);
  assert.equal(perceptions.at(-1).opponentFrame, 20, "round transition must remain on the current frame");
  assert.equal(perceptions.at(-1).opponentX, 900);
  assert.equal(runner.getLastDecision().decisionFrame, 20);
  assert.equal(runner.getLastDecision().observedFrame, 20);
}

function testSafeRecentEventsAndAdapter() {
  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  game.frame = 300;
  game.combatEvents = [
    { frame: 59, type: "throwTech", fighterId: 1 },
    { frame: 295, type: "intent", fighterId: 1, intent: "secret-intent", reason: "must-not-leak" },
    {
      frame: 299,
      type: "throwTech",
      fighterId: 1,
      attackerId: 0,
      moveId: "throw",
      outcome: "teched",
      reason: "must-not-leak",
      input: { lp: true, lk: true },
      commandBuffer: { motion: "secret-motion" },
      aiPlan: { reason: "secret-plan" },
      nestedEngineObject: game.fighters[0],
    },
    { frame: 301, type: "jump", fighterId: 1 },
  ];
  const observation = createObservationV1(game, 0);
  assert.equal(observation.recentEvents.length, 1, "event window/type/future filters must apply");
  assert.deepEqual(observation.recentEvents[0], {
    frame: 299,
    type: "throwTech",
    fighterId: 1,
    attackerId: 0,
    moveId: "throw",
    outcome: "teched",
    category: "throw",
    tags: ["throw", "groundThrow", "hardKnockdown", "punishDamage2040"],
  });
  assert(Object.isFrozen(observation.recentEvents));
  assert(Object.isFrozen(observation.recentEvents[0]));
  const serialized = JSON.stringify(observation.recentEvents);
  for (const forbidden of ["must-not-leak", "secret-intent", "secret-motion", "secret-plan", "commandBuffer", "aiPlan"]) {
    assert(!serialized.includes(forbidden), `recentEvents must strip sensitive field ${forbidden}`);
  }

  game.combatEvents = Array.from({ length: OBSERVATION_EVENT_LIMIT + 10 }, (_, index) => ({
    frame: 220 + index,
    type: "jump",
    fighterId: 1,
    jumpType: "normal",
  }));
  game.frame = 300;
  const limited = createObservationV1(game, 0);
  assert.equal(limited.recentEvents.length, OBSERVATION_EVENT_LIMIT, "public event summaries must be bounded");

  game.combatEvents = [{ frame: 299, type: "throwTech", fighterId: 1, attackerId: 0, reason: "hidden" }];
  const scriptAgent = createScriptAIAgent({
    preset: "balanced",
    difficulty: "normal",
    seed: 41,
  });
  scriptAgent.reset(createMatchInfoV1(game, 0));
  scriptAgent.act(createObservationV1(game, 0));
  const habits = scriptAgent.getDebugState().planner.habits;
  assert.equal(habits.throwTech, 2, "safe throwTech summary must reach the legacy planner through the adapter");
  assert.equal(habits.samples, 9);
}

function testRecentEventsAreRealtime() {
  const game = createGame({ bestOf: 1, roundSeconds: 10 });
  game.combatEvents = [];
  const visibility = [];
  const runner = createInProcessAgentRunner({
    act(observation) {
      visibility.push({
        decisionFrame: observation.frame,
        observedFrame: observation.perception.opponentFrame,
        sawThrowTech: observation.recentEvents.some((event) => event.type === "throwTech"),
      });
      return createActionV1();
    },
  });
  runner.reset(createMatchInfoV1(game, 0));

  for (let frame = 0; frame <= 8; frame += 1) {
    game.frame = frame;
    if (frame === 4) {
      game.combatEvents.push({
        frame,
        type: "throwTech",
        fighterId: 1,
        attackerId: 0,
        reason: "must-not-leak",
      });
    }
    runner.decide(game, 0);
  }
  assert(visibility.slice(0, 4).every((entry) => entry.sawThrowTech === false));
  assert.equal(visibility[4].decisionFrame, 4);
  assert.equal(visibility[4].observedFrame, 4);
  assert.equal(visibility[4].sawThrowTech, true, "event must appear on the frame it becomes public");
}

function createCustomAgent(name, lifecycle, { invalidAt = -1 } = {}) {
  return {
    name,
    reset(info) {
      lifecycle.resets.push(info);
    },
    act(observation) {
      lifecycle.observations += 1;
      lifecycle.observedFrames.push(observation.frame);
      lifecycle.opponentFrames.push(observation.perception.opponentFrame);
      if (observation.frame === invalidAt) {
        return { schema: ACTION_V1_SCHEMA, version: 1, input: { hp: "invalid" } };
      }
      const selfX = observation.self.position.x;
      const opponentX = observation.opponent.position.x;
      const towardRight = selfX < opponentX;
      const attack = observation.frame % 16 === 0;
      return createActionV1({
        left: !towardRight,
        right: towardRight,
        hp: attack,
      });
    },
    end(result) {
      lifecycle.ends.push(result);
    },
  };
}

function testCustomHeadlessAgents() {
  const a = { resets: [], ends: [], observations: 0, observedFrames: [], opponentFrames: [] };
  const b = { resets: [], ends: [], observations: 0, observedFrames: [], opponentFrames: [] };
  let decisionHooks = 0;
  let replayFromHook = null;
  const summary = runHeadlessTournament({
    matches: 1,
    agentA: "balanced",
    agentB: "zoner",
    templateA: "vanguard",
    templateB: "ember",
    roundSeconds: 10,
    bestOf: 1,
    seed: 73,
    maxFramesPerMatch: 1_200,
  }, {
    agents: {
      A: createCustomAgent("custom-A", a),
      B: createCustomAgent("custom-B", b, { invalidAt: 1 }),
    },
    recordReplay: true,
    onMatchReplay(replay) { replayFromHook = replay; },
    onDecision(frame) {
      decisionHooks += 1;
      assert(frame.decisions.A && frame.decisions.B, "decision hook must expose both decisions");
      assert.equal(frame.decisions.A.decisionFrame, frame.frame);
      assert.equal(frame.decisions.B.decisionFrame, frame.frame);
      assert.equal(frame.decisions.A.observedFrame, frame.frame);
      assert.equal(frame.decisions.B.observedFrame, frame.frame);
    },
  });

  assert.equal(summary.matches, 1);
  assert.equal(summary.participants.A.name, "custom-A");
  assert.equal(summary.participants.B.name, "custom-B");
  assert.equal(summary.participants.A.source, "injected");
  assert.equal(summary.determinism.agents, "unverified");
  assert(summary.totalFrames > 0);
  assert(a.observations > 0 && b.observations > 0, "both custom agents must receive observations");
  assert.equal(a.resets.length, 1);
  assert.equal(b.resets.length, 1);
  assert.equal(a.ends.length, 1);
  assert.equal(b.ends.length, 1);
  assert.equal(a.resets[0].schema, MATCH_INFO_V1_SCHEMA);
  assert.equal(b.resets[0].schema, MATCH_INFO_V1_SCHEMA);
  assert.equal(a.ends[0].schema, MATCH_RESULT_V1_SCHEMA);
  assert.equal(b.ends[0].schema, MATCH_RESULT_V1_SCHEMA);
  assert.equal(decisionHooks, summary.totalFrames);
  assert.deepEqual(
    a.observedFrames,
    b.observedFrames,
    "both custom Agents must receive the same current decision frame",
  );
  assert.deepEqual(a.opponentFrames, b.opponentFrames, "both custom Agents must receive the same current opponent frame");
  for (let index = 0; index < a.opponentFrames.length; index += 1) {
    assert.equal(a.observedFrames[index], index);
    assert.equal(a.opponentFrames[index], index);
  }
  assert.equal(Object.hasOwn(summary.settings, "delay"), false, "headless summaries must not advertise a removed delay rule");
  assert.equal(summary.diagnostics.A.total, 0);
  assert.equal(summary.diagnostics.B.byKind["invalid-action"], 1);
  assert.equal(summary.diagnostics.B.failedMatches, 1);
  assert.equal(summary.results[0].diagnostics.B.disabled, false);
  assert(summary.results[0].replay, "recordReplay must attach ReplayV1 to the match result");
  assert.deepEqual(replayFromHook, summary.results[0].replay);
  assert.equal(createReplayPlayer(summary.results[0].replay).verify().valid, true);
  assert(
    summary.results[0].replay.frames.some((frame) => (
      frame.decisions?.p1?.observedFrame != null && frame.decisions?.p2?.observedFrame != null
    )),
    "headless replay must retain both Agent decision metadata records",
  );
  assert(
    summary.results[0].replay.frames.some((frame) => frame.decisions?.p2?.diagnostic?.kind === "invalid-action"),
    "headless replay must retain Agent diagnostics",
  );
  assert(
    Object.values(summary.actions.A).some((count) => count > 0),
    "custom A must produce a recognized combat action",
  );
  assert(
    Object.values(summary.actions.B).some((count) => count > 0),
    "custom B must produce a recognized combat action",
  );
}

function testFrameLimitReplayAtRoundBoundary() {
  const makeNeutral = (name) => ({
    name,
    reset() {},
    act: () => createActionV1(),
    end() {},
  });
  const summary = runHeadlessTournament({
    matches: 1,
    bestOf: 3,
    roundSeconds: 10,
    maxFramesPerMatch: 600,
    seed: 8080,
  }, {
    agents: { A: makeNeutral("neutral-A"), B: makeNeutral("neutral-B") },
    recordReplay: true,
  });
  const result = summary.results[0];
  assert.equal(result.frames, 600);
  assert.equal(result.rounds, 1);
  assert.equal(result.termination, "frameLimit");
  assert.equal(result.replay.end.completed, false);
  assert.equal(result.replay.end.totalFrames, 600);
  assert.equal(result.replay.frames.at(-1).advanceRound, false);

  const player = createReplayPlayer(result.replay);
  const verification = player.verify();
  assert.equal(verification.valid, true);
  assert.equal(player.cursor, result.replay.frames.length);
  assert.equal(player.game.phase, "roundOver");
  assert.equal(player.game.roundNumber, 1, "frame-capped replay must not enter an unrecorded next round");
}

testObservationBoundary();
testActionValidation();
testHostileActionDescriptors();
testRunnerPolicies();
testRealtimePlatformObservation();
testSafeRecentEventsAndAdapter();
testRecentEventsAreRealtime();
testCustomHeadlessAgents();
testFrameLimitReplayAtRoundBoundary();

process.stdout.write("agent-sdk ok · schemas, masking, realtime observations, policies, custom headless agents\n");
