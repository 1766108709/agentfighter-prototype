import { CHARACTER_TEMPLATES, MOVESETS, createGame, nextRound, stepGame, TICK_RATE } from "./engine.js";
import { AI_PRESETS } from "./ai.js";
import { TACTICAL_INTENTS } from "./ai-planner.js";
import { createReplayRecorder } from "./replay.js";
import {
  createInProcessAgentRunner,
  createMatchInfoV1,
  createMatchResultV1,
  createScriptAIAgent,
} from "./agent-sdk.js";

const AGENT_IDS = Object.freeze(["balanced", "pressure", "zoner"]);
const TEMPLATE_IDS = Object.freeze(["vanguard", "ember"]);
const DIFFICULTIES = Object.freeze(["easy", "normal", "hard", "expert"]);
const FORMATS = Object.freeze(["text", "json"]);
const MAX_MATCHES = 100000;

export const HEADLESS_DEFAULTS = Object.freeze({
  matches: 100,
  agentA: "balanced",
  agentB: "zoner",
  templateA: "vanguard",
  templateB: "ember",
  difficulty: "normal",
  delay: 12,
  seed: 1,
  roundSeconds: 60,
  bestOf: 3,
  swapSides: true,
  format: "text",
});

export const HEADLESS_HELP = `AgentFighter 无头锦标赛 / Headless Tournament

用法 / Usage:
  node headless.mjs [options]

选项 / Options:
  --matches <n>          比赛数量，默认 100
  --agent-a <preset>     A 选手：balanced|pressure|zoner
  --agent-b <preset>     B 选手：balanced|pressure|zoner
  --template-a <id>      A 模板：vanguard|ember，默认 vanguard
  --template-b <id>      B 模板：vanguard|ember，默认 ember
  --difficulty <level>   easy|normal|hard|expert，默认 normal
  --delay <frames>       双方观测延迟 0-120F，默认 12
  --seed <uint32>        锦标赛确定性种子，默认 1
  --round-seconds <n>    每回合秒数 10-300，默认 60
  --best-of <odd>        奇数局制 1|3|5|7|9，默认 3
  --no-swap              禁止交替换边；默认奇偶场交换左右
  --format <text|json>   输出格式，默认 text
  --help, -h             显示本帮助
`;

export class HeadlessArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeadlessArgumentError";
  }
}

/** Parse CLI-style arguments into options accepted by runHeadlessTournament. */
export function parseHeadlessArgs(argv = []) {
  if (!Array.isArray(argv)) {
    throw new HeadlessArgumentError("argv 必须是字符串数组 / argv must be an array of strings");
  }

  const parsed = { ...HEADLESS_DEFAULTS, help: false, noSwap: false };
  const valueOptions = new Map([
    ["--matches", "matches"],
    ["--agent-a", "agentA"],
    ["--agent-b", "agentB"],
    ["--template-a", "templateA"],
    ["--template-b", "templateB"],
    ["--difficulty", "difficulty"],
    ["--delay", "delay"],
    ["--seed", "seed"],
    ["--round-seconds", "roundSeconds"],
    ["--best-of", "bestOf"],
    ["--format", "format"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    if (raw === "--help" || raw === "-h") {
      parsed.help = true;
      continue;
    }
    if (raw === "--no-swap") {
      parsed.noSwap = true;
      parsed.swapSides = false;
      continue;
    }

    const separator = raw.indexOf("=");
    const flag = separator >= 0 ? raw.slice(0, separator) : raw;
    const property = valueOptions.get(flag);
    if (!property) {
      throw new HeadlessArgumentError(`未知参数 / Unknown option: ${raw}`);
    }

    let value = separator >= 0 ? raw.slice(separator + 1) : undefined;
    if (value === undefined) {
      const following = argv[index + 1];
      if (following === undefined || String(following).startsWith("--")) {
        throw new HeadlessArgumentError(`参数缺少值 / Missing value for: ${flag}`);
      }
      value = String(following);
      index += 1;
    }
    if (value === "") {
      throw new HeadlessArgumentError(`参数值不能为空 / Empty value for: ${flag}`);
    }
    parsed[property] = value;
  }

  const normalized = parsed.help
    ? parsed
    : validateAndNormalize(parsed, { preserveFormat: true });
  normalized.help = parsed.help;
  normalized.noSwap = !normalized.swapSides;
  return normalized;
}

/**
 * Run an engine-deterministic Agent-vs-Agent tournament without browser
 * modules. Injected Agent decisions are unverified and may themselves use
 * clocks, randomness, or external state.
 * All wins and action counts are attributed to participants A/B, independent
 * of which side they occupy in an individual match.
 *
 * Existing CLI presets remain the default. Agent V1 implementations can be
 * injected without receiving the mutable game object:
 *
 * `runHeadlessTournament(options, { agents: { A, B }, runnerOptions })`
 *
 * A fresh per-match agent may instead be returned by
 * `createAgent(participant, { matchIndex, preset, template, seed })`.
 * `onDecision` is an optional replay/diagnostics hook invoked after each side's
 * controller decision with the runner's JSON-safe `lastDecision` metadata.
 * `recordReplay` attaches ReplayV1 to each result; `onMatchReplay` can consume
 * it without retaining every replay in the tournament summary.
 * `matchIdForMatch(matchIndex)` can provide a host-owned public match id for
 * API runners; the CLI keeps its deterministic `headless-{seed}-{index}` ids.
 *
 * @param {object} [options] normal headless tournament settings
 * @param {object} [runtime] Agent V1 injection and runner settings
 * @returns {object} tournament summary
 */
export function runHeadlessTournament(options = {}, runtime = {}) {
  const config = validateAndNormalize(options);
  const agentRuntime = validateAgentRuntime(runtime);
  const startedAt = monotonicNow();
  const wins = { A: 0, B: 0, draw: 0 };
  const actionIds = dynamicActionIds(MOVESETS);
  const actions = {
    A: emptyActionDistribution(actionIds),
    B: emptyActionDistribution(actionIds),
  };
  const telemetry = { A: emptyTelemetry(), B: emptyTelemetry() };
  const diagnostics = { A: emptyDiagnosticSummary(), B: emptyDiagnosticSummary() };
  const results = [];
  let totalFrames = 0;
  let totalRounds = 0;

  for (let matchIndex = 0; matchIndex < config.matches; matchIndex += 1) {
    const result = runSingleMatch(config, matchIndex, agentRuntime);
    results.push(result);
    wins[result.winner] += 1;
    totalFrames += result.frames;
    totalRounds += result.rounds;
    mergeActionCounts(actions.A, result.actions.A);
    mergeActionCounts(actions.B, result.actions.B);
    mergeTelemetry(telemetry.A, result.telemetry.A);
    mergeTelemetry(telemetry.B, result.telemetry.B);
    mergeDiagnosticSummary(diagnostics.A, result.diagnostics.A);
    mergeDiagnosticSummary(diagnostics.B, result.diagnostics.B);
  }

  const wallTimeMs = monotonicNow() - startedAt;
  const simulatedSeconds = totalFrames / TICK_RATE;
  const fps = wallTimeMs > 0 ? totalFrames / (wallTimeMs / 1000) : 0;
  const participantA = participantSummary("A", config.agentA, config.templateA, wins, actions, telemetry, config.matches, results[0]?.agents?.A, diagnostics.A);
  const participantB = participantSummary("B", config.agentB, config.templateB, wins, actions, telemetry, config.matches, results[0]?.agents?.B, diagnostics.B);
  const injectedAgents = Boolean(runtime.agents?.A || runtime.agents?.B || runtime.createAgent);

  return {
    version: 2,
    matches: config.matches,
    wins,
    totalFrames,
    totalEngineFrames: totalFrames,
    totalRounds,
    totalSimulatedSeconds: rounded(simulatedSeconds, 3),
    actions,
    telemetry: {
      A: telemetry.A,
      B: telemetry.B,
      totals: combinedTelemetry(telemetry.A, telemetry.B),
    },
    templates: { A: config.templateA, B: config.templateB },
    participants: { A: participantA, B: participantB },
    diagnostics,
    determinism: {
      engine: "deterministic",
      agents: injectedAgents ? "unverified" : "seeded-built-in",
    },
    averages: {
      framesPerMatch: rounded(totalFrames / config.matches, 2),
      simulatedSecondsPerMatch: rounded(simulatedSeconds / config.matches, 3),
      roundsPerMatch: rounded(totalRounds / config.matches, 3),
    },
    wallTimeMs: rounded(wallTimeMs, 3),
    fps: rounded(fps, 2),
    settings: {
      agentA: config.agentA,
      agentB: config.agentB,
      templateA: config.templateA,
      templateB: config.templateB,
      difficulty: config.difficulty,
      delay: config.delay,
      seed: config.seed,
      roundSeconds: config.roundSeconds,
      bestOf: config.bestOf,
      swapSides: config.swapSides,
      maxFramesPerMatch: config.maxFramesPerMatch,
      maxRoundsPerMatch: config.maxRoundsPerMatch,
      recordReplay: agentRuntime.recordReplay === true,
      agentNameA: participantA.name,
      agentNameB: participantB.name,
    },
    results,
  };
}

/** Format a tournament result without printing every individual match. */
export function formatHeadlessText(summary) {
  const settings = summary.settings;
  const a = summary.participants.A;
  const b = summary.participants.B;
  const lines = [
    "AgentFighter 无头锦标赛 / Headless Tournament",
    `A: ${a.name} (${a.preset} · ${a.template})  vs  B: ${b.name} (${b.preset} · ${b.template})`,
    `设置: ${summary.matches} 场 · ${settings.bestOf} 局制 · ${settings.roundSeconds}s/回合 · ${settings.difficulty} · ${settings.delay}F 延迟 · seed ${settings.seed}`,
    `换边: ${settings.swapSides ? "开启（每场交替）" : "关闭"}`,
    "",
    `A  ${a.wins}胜 ${a.losses}负 ${a.draws}平 · 胜率 ${percent(a.winRate)}`,
    `B  ${b.wins}胜 ${b.losses}负 ${b.draws}平 · 胜率 ${percent(b.winRate)}`,
    `平均: ${summary.averages.framesPerMatch} 帧/场 · ${summary.averages.simulatedSecondsPerMatch}s/场 · ${summary.averages.roundsPerMatch} 回合/场`,
    `总计: ${summary.totalFrames} 引擎帧 · ${summary.totalSimulatedSeconds}s 模拟时间`,
    `性能: ${summary.wallTimeMs}ms 墙钟 · ${summary.fps} 模拟 FPS`,
    "",
    `A 动作启动: ${compactActionCounts(summary.actions.A)}`,
    `B 动作启动: ${compactActionCounts(summary.actions.B)}`,
    `A 博弈: ${compactTelemetry(summary.telemetry.A)}`,
    `B 博弈: ${compactTelemetry(summary.telemetry.B)}`,
  ];
  const capped = summary.results.filter((result) => result.termination !== "matchOver").length;
  if (capped > 0) lines.push(`警告 / Warning: ${capped} 场触发安全上限并按平局统计。`);
  return `${lines.join("\n")}\n`;
}

function runSingleMatch(config, matchIndex, runtime) {
  const swapped = config.swapSides && matchIndex % 2 === 1;
  const left = swapped ? "B" : "A";
  const right = swapped ? "A" : "B";
  const seedA = deriveSeed(config.seed, matchIndex, 0x243f6a88);
  let seedB = deriveSeed(config.seed, matchIndex, 0x9e3779b9);
  if (seedB === seedA) seedB = (seedB + 0x6d2b79f5) >>> 0;

  const aiA = createTournamentAI("A", config.agentA, config.templateA, config, seedA, matchIndex, runtime);
  const aiB = createTournamentAI("B", config.agentB, config.templateB, config, seedB, matchIndex, runtime);
  const leftAI = left === "A" ? aiA : aiB;
  const rightAI = right === "A" ? aiA : aiB;
  const leftTemplate = left === "A" ? config.templateA : config.templateB;
  const rightTemplate = right === "A" ? config.templateA : config.templateB;
  let game = createGame({
    bestOf: config.bestOf,
    roundSeconds: config.roundSeconds,
    playerName: `${leftAI.name || left} [${left}]`,
    aiName: `${rightAI.name || right} [${right}]`,
    playerTemplate: leftTemplate,
    aiTemplate: rightTemplate,
  });
  const shouldRecordReplay = runtime.recordReplay === true || typeof runtime.onMatchReplay === "function";
  const recorder = shouldRecordReplay ? createReplayRecorder(game, {
    seed: config.seed,
    metadata: { matchIndex, participants: { left, right }, seeds: { A: seedA, B: seedB } },
  }) : null;
  const sideTemplates = {
    left: game.fighters[0].templateId,
    right: game.fighters[1].templateId,
  };
  const suppliedMatchId = runtime.matchIdForMatch?.(matchIndex, {
    seed: config.seed,
    left,
    right,
  });
  const matchId = suppliedMatchId === undefined
    ? `headless-${config.seed}-${matchIndex + 1}`
    : externalMatchId(suppliedMatchId);
  aiA.reset(createMatchInfoV1(game, left === "A" ? 0 : 1, {
    matchId,
    matchIndex,
    seed: seedA,
  }));
  aiB.reset(createMatchInfoV1(game, left === "B" ? 0 : 1, {
    matchId,
    matchIndex,
    seed: seedB,
  }));

  const actionIds = dynamicActionIds(MOVESETS);
  const actionCounts = {
    A: emptyActionDistribution(actionIds),
    B: emptyActionDistribution(actionIds),
  };
  const matchTelemetry = { A: emptyTelemetry(), B: emptyTelemetry() };
  const previousAction = {
    A: fighterMoveKey(game.fighters[left === "A" ? 0 : 1]),
    B: fighterMoveKey(game.fighters[left === "B" ? 0 : 1]),
  };
  const previousPlanToken = { A: "", B: "" };
  const todActive = { A: false, B: false };
  const seenEvents = new WeakSet();
  const seenEventSignatures = new Set();
  const roundResults = [];
  let frames = 0;
  let rounds = 0;
  let termination = "frameLimit";

  while (frames < config.maxFramesPerMatch) {
    const leftInput = leftAI.decide?.(game, 0);
    const rightInput = rightAI.decide?.(game, 1);
    runtime.onDecision?.({
      matchIndex,
      frame: game.frame,
      decisions: {
        [left]: leftAI.getLastDecision?.() ?? null,
        [right]: rightAI.getLastDecision?.() ?? null,
      },
    });
    recordIntentDecision(matchTelemetry[left], previousPlanToken, left, leftAI, game.fighters[0]);
    recordIntentDecision(matchTelemetry[right], previousPlanToken, right, rightAI, game.fighters[1]);
    const stepped = recorder
      ? recorder.recordFrame({ p1: leftInput, p2: rightInput }, {
        decisions: {
          p1: leftAI.getLastDecision?.() ?? null,
          p2: rightAI.getLastDecision?.() ?? null,
        },
      }).game
      : stepGame(game, { p1: leftInput, p2: rightInput });
    if (stepped && stepped !== game && stepped.fighters) game = stepped;
    frames += 1;
    const leftMove = recordActionStart(actionCounts[left], previousAction, left, game.fighters[0]);
    const rightMove = recordActionStart(actionCounts[right], previousAction, right, game.fighters[1]);
    if (leftMove) recordMoveUsage(matchTelemetry[left], leftMove, leftTemplate);
    if (rightMove) recordMoveUsage(matchTelemetry[right], rightMove, rightTemplate);
    const hasCombatEvents = Array.isArray(game.combatEvents);
    recordComboState(matchTelemetry[left], todActive, left, game.fighters[0], game.fighters[1], !hasCombatEvents);
    recordComboState(matchTelemetry[right], todActive, right, game.fighters[1], game.fighters[0], !hasCombatEvents);
    recordCombatEvents(
      game,
      { left, right },
      matchTelemetry,
      seenEvents,
      seenEventSignatures,
    );

    if (game.phase !== "roundOver" && game.phase !== "matchOver") continue;
    rounds += 1;
    roundResults.push({
      round: game.roundNumber ?? game.round ?? rounds,
      winner: participantForWinner(game.roundWinner, left, right),
      reason: game.roundReason ?? null,
    });

    if (game.phase === "matchOver") {
      termination = "matchOver";
      break;
    }
    if (rounds >= config.maxRoundsPerMatch) {
      termination = "roundLimit";
      break;
    }
    // Do not create a pending round transition when the loop cannot record its
    // following frame. ReplayV1 attaches advanceRound to that next frame.
    if (frames >= config.maxFramesPerMatch) {
      termination = "frameLimit";
      break;
    }

    const advanced = recorder ? recorder.advanceRound() : nextRound(game);
    if (advanced && advanced !== game && advanced.fighters) game = advanced;
    previousAction.A = fighterMoveKey(game.fighters[left === "A" ? 0 : 1]);
    previousAction.B = fighterMoveKey(game.fighters[left === "B" ? 0 : 1]);
    todActive.A = false;
    todActive.B = false;
  }

  const winner = termination === "matchOver"
    ? participantForWinner(game.matchWinner, left, right)
    : "draw";
  const scoreA = game.score?.[left === "A" ? 0 : 1] ?? 0;
  const scoreB = game.score?.[left === "B" ? 0 : 1] ?? 0;

  const result = {
    match: matchIndex + 1,
    left,
    right,
    templates: {
      A: config.templateA,
      B: config.templateB,
      ...sideTemplates,
    },
    winner,
    frames,
    rounds,
    simulatedSeconds: rounded(frames / TICK_RATE, 3),
    score: { A: scoreA, B: scoreB },
    swapped,
    seeds: { A: seedA, B: seedB },
    termination,
    actions: actionCounts,
    telemetry: matchTelemetry,
    roundResults,
    agents: {
      A: runnerIdentity(aiA),
      B: runnerIdentity(aiB),
    },
  };
  aiA.end(createMatchResultV1(game, left === "A" ? 0 : 1, {
    matchId,
    frames,
    rounds,
    termination,
  }));
  aiB.end(createMatchResultV1(game, left === "B" ? 0 : 1, {
    matchId,
    frames,
    rounds,
    termination,
  }));
  result.diagnostics = {
    A: aiA.getDiagnosticSummary(),
    B: aiB.getDiagnosticSummary(),
  };
  if (recorder) {
    const replay = recorder.finish({ termination, winner, matchId });
    if (runtime.recordReplay === true) result.replay = replay;
    runtime.onMatchReplay?.(replay, { matchIndex, matchId, winner, termination });
  }
  return result;
}

function createTournamentAI(participant, preset, template, config, seed, matchIndex, runtime) {
  const context = Object.freeze({ participant, preset, template, seed, matchIndex });
  const injected = runtime.createAgent?.(participant, context) ?? runtime.agents?.[participant];
  const agent = injected ?? createScriptAIAgent({
    preset,
    difficulty: config.difficulty,
    // Fairness delay is enforced once by the platform runner for built-in and
    // injected Agents alike; the legacy implementation must not apply it twice.
    observationDelayFrames: 0,
    seed,
    movesets: MOVESETS,
  });
  const sharedOptions = runtime.runnerOptions ?? {};
  const participantOptions = runtime.runnerOptionsByParticipant?.[participant] ?? {};
  const runner = createInProcessAgentRunner(agent, {
    ...sharedOptions,
    ...participantOptions,
    observationDelayFrames: config.delay,
  });
  runner.source = injected ? "injected" : "preset";
  runner.agentDeterminism = injected ? "unverified" : "seeded-built-in";
  return runner;
}

function validateAgentRuntime(runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new HeadlessArgumentError("runtime 必须是对象 / runtime must be an object");
  }
  if (runtime.agents !== undefined && (!runtime.agents || typeof runtime.agents !== "object" || Array.isArray(runtime.agents))) {
    throw new HeadlessArgumentError("runtime.agents 必须是对象 / runtime.agents must be an object");
  }
  for (const participant of ["A", "B"]) {
    const agent = runtime.agents?.[participant];
    if (agent !== undefined && typeof agent?.act !== "function") {
      throw new HeadlessArgumentError(`runtime.agents.${participant} 必须实现 act(observation)`);
    }
  }
  if (runtime.createAgent !== undefined && typeof runtime.createAgent !== "function") {
    throw new HeadlessArgumentError("runtime.createAgent 必须是函数 / runtime.createAgent must be a function");
  }
  if (runtime.onDecision !== undefined && typeof runtime.onDecision !== "function") {
    throw new HeadlessArgumentError("runtime.onDecision 必须是函数 / runtime.onDecision must be a function");
  }
  if (runtime.recordReplay !== undefined && typeof runtime.recordReplay !== "boolean") {
    throw new HeadlessArgumentError("runtime.recordReplay 必须是布尔值 / runtime.recordReplay must be boolean");
  }
  if (runtime.onMatchReplay !== undefined && typeof runtime.onMatchReplay !== "function") {
    throw new HeadlessArgumentError("runtime.onMatchReplay 必须是函数 / runtime.onMatchReplay must be a function");
  }
  if (runtime.matchIdForMatch !== undefined && typeof runtime.matchIdForMatch !== "function") {
    throw new HeadlessArgumentError("runtime.matchIdForMatch 必须是函数 / runtime.matchIdForMatch must be a function");
  }
  return runtime;
}

function externalMatchId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new HeadlessArgumentError("match id 必须是安全标识符 / match id must be a safe identifier");
  }
  return id;
}

function participantForWinner(winner, left, right) {
  if (winner === 0 || winner === "p1" || winner === "player" || winner === "left") return left;
  if (winner === 1 || winner === "p2" || winner === "ai" || winner === "right") return right;
  return "draw";
}

function recordActionStart(distribution, previousAction, participant, fighter) {
  const action = fighterMoveKey(fighter);
  if (action === previousAction[participant]) return null;
  previousAction[participant] = action;
  if (Object.hasOwn(distribution, action)) {
    distribution[action] += 1;
    const aliases = MOVESETS?.[fighter?.templateId]?.aliases ?? {};
    for (const [alias, target] of Object.entries(aliases)) {
      if (target === action && Object.hasOwn(distribution, alias)) distribution[alias] += 1;
    }
    return action;
  }
  return null;
}

function fighterMoveKey(fighter) {
  const move = fighter?.currentMove ?? fighter?.moveData;
  if (typeof move === "string") return move;
  return move?.id ?? fighter?.action ?? "idle";
}

function moveTable(moveset) {
  if (moveset?.moves && typeof moveset.moves === "object") return moveset.moves;
  return Object.fromEntries(Object.entries(moveset ?? {}).filter(([, move]) => (
    move && typeof move === "object" && Number.isFinite(move.startup)
  )));
}

function dynamicActionIds(catalogue) {
  return [...new Set(
    Object.values(catalogue ?? {}).flatMap((moveset) => [
      ...Object.keys(moveTable(moveset)),
      ...Object.entries(moveset ?? {})
        .filter(([, move]) => move && typeof move === "object" && Number.isFinite(move.startup))
        .map(([id]) => id),
    ]),
  )].sort();
}

function emptyActionDistribution(actionIds = dynamicActionIds(MOVESETS)) {
  return Object.fromEntries(actionIds.map((action) => [action, 0]));
}

function mergeActionCounts(target, source) {
  for (const [action, count] of Object.entries(source ?? {})) {
    if (!Object.hasOwn(target, action)) target[action] = 0;
    target[action] += count ?? 0;
  }
}

function emptyTelemetry() {
  return {
    intents: Object.fromEntries(TACTICAL_INTENTS.map((intent) => [intent, 0])),
    maxComboHits: 0,
    maxComboDamage: 0,
    tod: 0,
    TOD: 0,
    supers: 0,
    odEx: 0,
    punishCounter: 0,
    whiffPunish: 0,
    whiffPunishAttempts: 0,
    baits: 0,
    baitAttempts: 0,
  };
}

function recordIntentDecision(telemetry, previousTokens, participant, ai, fighter) {
  const debug = ai?.getDebugState?.();
  const plan = debug?.lastPlan ?? fighter?.aiPlan;
  if (!plan?.intent) return;
  const token = `${plan.intent}:${plan.moveId ?? ""}:${plan.reason ?? ""}`;
  if (token === previousTokens[participant]) return;
  previousTokens[participant] = token;
  if (!Object.hasOwn(telemetry.intents, plan.intent)) telemetry.intents[plan.intent] = 0;
  telemetry.intents[plan.intent] += 1;
  if (plan.intent === "whiffPunish") telemetry.whiffPunishAttempts += 1;
  if (["whiffBait", "reversalBait", "shimmy"].includes(plan.intent)) telemetry.baitAttempts += 1;
}

function recordMoveUsage(telemetry, moveId, templateId) {
  const move = findMove(templateId, moveId);
  const text = `${moveId} ${move?.category ?? ""} ${(move?.tags ?? []).join(" ")}`.toLowerCase();
  if (move?.category === "super" || move?.category === "climax" || /\bsuper\b|climax|critical art|\bca\b/.test(text)) {
    telemetry.supers += 1;
  }
  if (move?.category === "od" || /(^|[^a-z])(od|ex)([^a-z]|$)/.test(text)) telemetry.odEx += 1;
}

function findMove(templateId, moveId) {
  const moveset = MOVESETS?.[templateId];
  const moves = moveTable(moveset);
  const id = moveset?.aliases?.[moveId] ?? moveId;
  return moves?.[id] ?? null;
}

function recordComboState(telemetry, todActive, participant, fighter, opponent, inferTod) {
  const hits = Math.max(0, Math.floor(finite(fighter?.comboCount, finite(fighter?.comboHits))));
  const damage = Math.max(0, finite(fighter?.comboDamage, finite(fighter?.currentComboDamage)));
  telemetry.maxComboHits = Math.max(telemetry.maxComboHits, hits);
  telemetry.maxComboDamage = Math.max(telemetry.maxComboDamage, damage);
  const opponentLife = Math.max(1, finite(opponent?.maxHealth, 1000));
  const isTod = hits > 0 && damage >= opponentLife;
  if (inferTod && isTod && !todActive[participant]) {
    telemetry.tod += 1;
    telemetry.TOD = telemetry.tod;
  }
  todActive[participant] = isTod;
  if (hits <= 0) todActive[participant] = false;
}

function recordCombatEvents(game, sides, telemetry, seenEvents, seenSignatures) {
  for (const event of game?.combatEvents ?? []) {
    if (!event || typeof event !== "object") continue;
    if (seenEvents.has(event)) continue;
    const signature = eventSignature(event);
    if (seenSignatures.has(signature)) {
      seenEvents.add(event);
      continue;
    }
    seenEvents.add(event);
    seenSignatures.add(signature);

    const sideIndex = eventFighterIndex(event, game?.fighters ?? []);
    if (sideIndex !== 0 && sideIndex !== 1) continue;
    const participant = sideIndex === 0 ? sides.left : sides.right;
    const stats = telemetry[participant];
    const type = String(event.type ?? "").toLowerCase();
    const outcome = String(event.outcome ?? event.result ?? "").toLowerCase();

    if (type.includes("punishcounter") || type.includes("punish-counter") || outcome.includes("punishcounter") || outcome.includes("punish-counter")) {
      stats.punishCounter += 1;
    }
    if (type.includes("whiffpunish") || type.includes("whiff-punish") || event.whiffPunish === true) {
      stats.whiffPunish += 1;
    }
    if (type === "bait" || type.endsWith("bait") || event.bait === true) stats.baits += 1;
    if (type === "tod" || event.tod === true || event.TOD === true) {
      stats.tod += 1;
      stats.TOD = stats.tod;
    }
    if (["combo", "comboupdate", "comboend"].includes(type)) {
      stats.maxComboHits = Math.max(stats.maxComboHits, Math.floor(finite(event.hits, finite(event.comboCount, finite(event.count)))));
      stats.maxComboDamage = Math.max(stats.maxComboDamage, finite(event.damage, finite(event.comboDamage)));
    }
  }
}

function eventFighterIndex(event, fighters) {
  const candidate = event.fighterIndex
    ?? event.fighterId
    ?? event.attackerIndex
    ?? event.attackerId
    ?? event.sourceIndex
    ?? event.ownerIndex;
  if (candidate === 0 || candidate === 1) return candidate;
  return fighters.findIndex((fighter) => fighter?.id === candidate);
}

function eventSignature(event) {
  return [
    event.frame,
    event.type,
    event.fighterIndex ?? event.fighterId ?? event.attackerIndex ?? event.attackerId,
    event.moveId ?? event.action,
    event.hitId,
    event.comboCount ?? event.hits ?? event.count,
    event.comboDamage ?? event.damage,
    event.outcome ?? event.result,
  ].join(":");
}

function mergeTelemetry(target, source) {
  for (const [intent, count] of Object.entries(source?.intents ?? {})) {
    if (!Object.hasOwn(target.intents, intent)) target.intents[intent] = 0;
    target.intents[intent] += count;
  }
  target.maxComboHits = Math.max(target.maxComboHits, source?.maxComboHits ?? 0);
  target.maxComboDamage = Math.max(target.maxComboDamage, source?.maxComboDamage ?? 0);
  for (const field of [
    "tod",
    "supers",
    "odEx",
    "punishCounter",
    "whiffPunish",
    "whiffPunishAttempts",
    "baits",
    "baitAttempts",
  ]) target[field] += source?.[field] ?? 0;
  target.TOD = target.tod;
  return target;
}

function combinedTelemetry(first, second) {
  return mergeTelemetry(mergeTelemetry(emptyTelemetry(), first), second);
}

function runnerIdentity(runner) {
  return {
    name: runner.name,
    description: runner.description,
    source: runner.source ?? "unknown",
    determinism: runner.agentDeterminism ?? "unverified",
  };
}

function emptyDiagnosticSummary() {
  return { total: 0, byKind: {}, disabledMatches: 0, failedMatches: 0, nonDeterministicMatches: 0 };
}

function mergeDiagnosticSummary(target, source = {}) {
  target.total += source.total ?? 0;
  for (const [kind, count] of Object.entries(source.byKind ?? {})) {
    target.byKind[kind] = (target.byKind[kind] ?? 0) + count;
  }
  if (source.disabled) target.disabledMatches += 1;
  if (source.failed) target.failedMatches += 1;
  if (source.nonDeterministic) target.nonDeterministicMatches += 1;
  return target;
}

function participantSummary(id, preset, template, wins, actions, telemetry, matches, identity = {}, diagnostics = {}) {
  const other = id === "A" ? "B" : "A";
  return {
    id,
    preset,
    name: identity.name || AI_PRESETS[preset]?.name || preset,
    description: identity.description || AI_PRESETS[preset]?.description || "",
    source: identity.source ?? "preset",
    determinism: identity.determinism ?? "unverified",
    template,
    templateName: CHARACTER_TEMPLATES[template]?.name || template,
    wins: wins[id],
    losses: wins[other],
    draws: wins.draw,
    winRate: rounded(wins[id] / matches, 6),
    actionStarts: actions[id],
    telemetry: telemetry[id],
    diagnostics,
  };
}

function validateAndNormalize(options, { preserveFormat = false } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HeadlessArgumentError("options 必须是对象 / options must be an object");
  }

  const matches = integerOption(options.matches ?? HEADLESS_DEFAULTS.matches, "matches", 1, MAX_MATCHES);
  const agentA = enumOption(options.agentA ?? HEADLESS_DEFAULTS.agentA, "agent-a", AGENT_IDS);
  const agentB = enumOption(options.agentB ?? HEADLESS_DEFAULTS.agentB, "agent-b", AGENT_IDS);
  const templateA = enumOption(options.templateA ?? HEADLESS_DEFAULTS.templateA, "template-a", TEMPLATE_IDS);
  const templateB = enumOption(options.templateB ?? HEADLESS_DEFAULTS.templateB, "template-b", TEMPLATE_IDS);
  const difficulty = enumOption(options.difficulty ?? HEADLESS_DEFAULTS.difficulty, "difficulty", DIFFICULTIES);
  const delay = integerOption(options.delay ?? HEADLESS_DEFAULTS.delay, "delay", 0, 120);
  const seed = integerOption(options.seed ?? HEADLESS_DEFAULTS.seed, "seed", 0, 0xffffffff);
  const roundSeconds = integerOption(options.roundSeconds ?? HEADLESS_DEFAULTS.roundSeconds, "round-seconds", 10, 300);
  const bestOf = integerOption(options.bestOf ?? HEADLESS_DEFAULTS.bestOf, "best-of", 1, 9);
  if (bestOf % 2 === 0) {
    throw new HeadlessArgumentError("best-of 必须是 1-9 的奇数 / best-of must be an odd number from 1 to 9");
  }

  if (options.noSwap !== undefined && typeof options.noSwap !== "boolean") {
    throw new HeadlessArgumentError("noSwap 必须是布尔值 / noSwap must be boolean");
  }
  if (options.swapSides !== undefined && typeof options.swapSides !== "boolean") {
    throw new HeadlessArgumentError("swapSides 必须是布尔值 / swapSides must be boolean");
  }
  const swapSides = options.noSwap === true ? false : options.swapSides !== false;
  const format = enumOption(options.format ?? HEADLESS_DEFAULTS.format, "format", FORMATS);
  const derivedFrameLimit = Math.max(
    roundSeconds * TICK_RATE * bestOf * 4,
    (roundSeconds * TICK_RATE + 600) * (bestOf * 2 + 4),
  );
  const maxFramesPerMatch = integerOption(
    options.maxFramesPerMatch ?? derivedFrameLimit,
    "maxFramesPerMatch",
    TICK_RATE,
    100000000,
  );
  const maxRoundsPerMatch = integerOption(
    options.maxRoundsPerMatch ?? bestOf * 4 + 4,
    "maxRoundsPerMatch",
    bestOf,
    1000,
  );

  const normalized = {
    matches,
    agentA,
    agentB,
    templateA,
    templateB,
    difficulty,
    delay,
    seed: seed >>> 0,
    roundSeconds,
    bestOf,
    swapSides,
    maxFramesPerMatch,
    maxRoundsPerMatch,
  };
  if (preserveFormat || Object.hasOwn(options, "format")) normalized.format = format;
  return normalized;
}

function integerOption(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new HeadlessArgumentError(
      `${name} 必须是 ${minimum}-${maximum} 的整数 / ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return number;
}

function enumOption(value, name, allowed) {
  const normalized = String(value).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new HeadlessArgumentError(
      `${name} 无效：${value}；可选 / expected: ${allowed.join("|")}`,
    );
  }
  return normalized;
}

function deriveSeed(baseSeed, matchIndex, salt) {
  let value = (baseSeed ^ Math.imul(matchIndex + 1, 0x9e3779b1) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return value || (salt >>> 0) || 1;
}

function compactActionCounts(distribution) {
  const entries = Object.entries(distribution ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, first], [, second]) => second - first)
    .map(([action, count]) => `${action}=${count}`);
  return entries.length > 0 ? entries.join(", ") : "无 / none";
}

function compactTelemetry(telemetry) {
  const leadingIntents = Object.entries(telemetry?.intents ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, first], [, second]) => second - first)
    .slice(0, 4)
    .map(([intent, count]) => `${intent}=${count}`)
    .join(", ") || "none";
  return `意图[${leadingIntents}] · 最大连击 ${telemetry?.maxComboHits ?? 0} hits/${rounded(telemetry?.maxComboDamage ?? 0, 1)} dmg`
    + ` · TOD ${telemetry?.tod ?? 0} · 超杀 ${telemetry?.supers ?? 0} · OD/EX ${telemetry?.odEx ?? 0}`
    + ` · PC ${telemetry?.punishCounter ?? 0} · 空挥惩罚 ${telemetry?.whiffPunish ?? 0} · 骗招 ${telemetry?.baits ?? 0}`;
}

function percent(value) {
  return `${rounded(value * 100, 2)}%`;
}

function rounded(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function monotonicNow() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}
