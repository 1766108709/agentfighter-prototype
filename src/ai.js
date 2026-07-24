import { MOVESETS as ENGINE_MOVESETS } from "./engine.js";
import { createTacticalPlanner } from "./ai-planner.js";
import { createCommandExecutor } from "./ai-executor.js";
import { EMPTY_COMBAT_INPUT, normalizeCombatInput } from "./input-schema.js";
import { canAffordMove } from "./resources.js";
import { recordCombatEvent } from "./telemetry.js";

const CANONICAL_KEYS = Object.freeze(Object.keys(EMPTY_COMBAT_INPUT));

const CANONICAL_PRESETS = {
  balanced: Object.freeze({
    id: "balanced",
    name: "均衡型",
    description: "试探、确认、骗招与资源转换均衡，按局势切换攻守。",
    jumpApproachEvery: 4,
    idealRange: 0.165,
    retreatRange: 0.058,
    normalRange: 0.105,
    antiAirRange: 0.145,
    projectileRange: 0.215,
    aggression: 0.56,
    guardBias: 0.53,
    throwBias: 0.31,
    projectileBias: 0.38,
    dpBias: 0.69,
    jumpBias: 0.12,
    heavyBias: 0.42,
    highBias: 0.34,
    midBias: 0.34,
    lowBias: 0.32,
  }),
  pressure: Object.freeze({
    id: "pressure",
    name: "压迫型",
    description: "主动取得近身优势，用压起身、帧陷阱、投与后撤骗招持续施压。",
    jumpApproachEvery: 2,
    idealRange: 0.072,
    retreatRange: 0.038,
    normalRange: 0.1,
    antiAirRange: 0.135,
    projectileRange: 0.285,
    aggression: 0.87,
    guardBias: 0.34,
    throwBias: 0.58,
    projectileBias: 0.13,
    dpBias: 0.61,
    jumpBias: 0.23,
    heavyBias: 0.35,
    highBias: 0.4,
    midBias: 0.35,
    lowBias: 0.25,
  }),
  zoner: Object.freeze({
    id: "zoner",
    name: "远程型",
    description: "用飞行物和长技控制空间，等待空挥后确认惩罚。",
    jumpApproachEvery: 6,
    idealRange: 0.285,
    retreatRange: 0.17,
    normalRange: 0.108,
    antiAirRange: 0.165,
    projectileRange: 0.155,
    aggression: 0.25,
    guardBias: 0.68,
    throwBias: 0.38,
    projectileBias: 0.9,
    dpBias: 0.84,
    jumpBias: 0.07,
    heavyBias: 0.53,
    highBias: 0.25,
    midBias: 0.39,
    lowBias: 0.36,
  }),
};

// Keep the historical lookup alias without adding a fourth UI preset.
Object.defineProperty(CANONICAL_PRESETS, "rushdown", {
  value: CANONICAL_PRESETS.pressure,
  enumerable: false,
});

export const AI_PRESETS = Object.freeze(CANONICAL_PRESETS);

const PRESET_ALIASES = Object.freeze({
  balanced: "balanced",
  balance: "balanced",
  default: "balanced",
  "均衡": "balanced",
  "均衡型": "balanced",
  pressure: "pressure",
  rushdown: "pressure",
  aggressive: "pressure",
  "压迫": "pressure",
  "压迫型": "pressure",
  zoner: "zoner",
  zoning: "zoner",
  ranged: "zoner",
  "远程": "zoner",
  "远程型": "zoner",
});

/**
 * Create a deterministic, controller-level fighting-game agent.
 *
 * The planner chooses a reasoned tactical intent; the executor then performs
 * the same multi-frame directions and button chords available to a player.
 * `movesets` is injectable for simulations/tests, while the live game uses the
 * engine's exported MOVESETS catalogue.
 */
export function createScriptAI(options = {}) {
  if (Object.hasOwn(options, "observationDelayFrames")) {
    throw new RangeError("observationDelayFrames has been removed; observations are always real-time");
  }
  const {
    preset = "balanced",
    difficulty = "normal",
    seed = 1,
    movesets = ENGINE_MOVESETS,
  } = options;
  const presetValue = typeof preset === "object" && preset ? preset.id : preset;
  const presetKey = PRESET_ALIASES[String(presetValue ?? "balanced").toLowerCase()] ?? "balanced";
  const profile = AI_PRESETS[presetKey];
  const difficultyName = normalizeDifficultyName(difficulty);
  let planner = createTacticalPlanner({ preset: presetKey, difficulty: difficultyName, seed });
  // Motions stay tournament-legal but compact enough to fit real cancel
  // windows. Difficulty changes planning/observation, not whether the agent is
  // physically capable of completing 236 before the authored window closes.
  const executorDifficulty = difficultyName === "easy" ? "normal" : "hard";
  let executor = createCommandExecutor({ difficulty: executorDifficulty });
  const adaptedMovesets = new Map();

  let syntheticFrame;
  let lastGameFrame;
  let lastDecisionKey;
  let lastCanonicalInput;
  let lastPlan;
  let lastObservedFrame;
  let lastOpponentHealth;
  let lastOpponentBlockstun;
  let inferredContact;
  let handledContactToken;
  let approachPlans;
  let wasAirborne;
  let airMoveUsed;
  let prebufferedCancel;
  let closeMixups;
  let okiMixups;
  let blockedMixups;
  let pendingBait;
  let wakeupMixups;

  function resetTemporal() {
    syntheticFrame = 0;
    lastGameFrame = -1;
    lastDecisionKey = "";
    lastCanonicalInput = { ...EMPTY_COMBAT_INPUT };
    lastPlan = null;
    lastObservedFrame = -1;
    lastOpponentHealth = null;
    lastOpponentBlockstun = 0;
    inferredContact = null;
    handledContactToken = "";
    approachPlans = 0;
    wasAirborne = false;
    airMoveUsed = false;
    prebufferedCancel = null;
    closeMixups = 0;
    okiMixups = 0;
    blockedMixups = 0;
    pendingBait = null;
    wakeupMixups = 0;
    executor.interrupt();
  }

  function reset(options = {}) {
    if (options?.preserveAdaptation) planner.reset({ preserveAdaptation: true });
    else planner = createTacticalPlanner({ preset: presetKey, difficulty: difficultyName, seed });
    executor = createCommandExecutor({ difficulty: executorDifficulty });
    resetTemporal();
  }

  function decide(game, selfIndex = 0) {
    const frame = frameNumber(game);
    const decisionKey = `${frame}:${selfIndex}`;
    if (decisionKey === lastDecisionKey) return compatibleInput(lastCanonicalInput);

    if (frame < lastGameFrame) reset({ preserveAdaptation: true });
    lastGameFrame = frame;
    lastDecisionKey = decisionKey;

    const self = game?.fighters?.[selfIndex];
    const liveOpponent = game?.fighters?.[1 - selfIndex];
    if (!self || !liveOpponent || !isCombatPhase(game?.phase) || finite(self.health, 1) <= 0) {
      executor.interrupt();
      return remember(EMPTY_COMBAT_INPUT);
    }

    updateAirState(self);
    inferLegacyContact(self, liveOpponent, frame);
    const observation = currentObservation(game, liveOpponent, frame);
    const opponent = observation.fighter;
    resolvePendingBait(game, selfIndex, opponent, frame);
    const contact = normalizedContact(self.lastContact ?? inferredContact, frame);
    const plannerSelf = contact === self.lastContact ? self : { ...self, lastContact: contact };
    const observedGame = makeObservedGame(game, selfIndex, plannerSelf, opponent, observation, frame);
    const moveset = movesetFor(self, movesets, adaptedMovesets);
    const stanceLegalMoveset = stanceMoveset(moveset, self, opponent, game?.arena);
    const contactToken = tokenForContact(contact);
    const freshContact = Boolean(contactToken && contactToken !== handledContactToken);
    const currentId = currentMoveId(self);
    if (prebufferedCancel && prebufferedCancel.fromMoveId !== currentId) prebufferedCancel = null;

    if (isHitStunned(self)) {
      executor.interrupt();
      recordPlan(self, {
        frame,
        intent: "defend",
        moveId: null,
        score: 0,
        reason: "受创硬直中，等待重新获得控制权",
      });
      return remember(EMPTY_COMBAT_INPUT);
    }

    if (isBlockStunned(self)) {
      executor.interrupt();
      recordPlan(self, {
        frame,
        intent: "defend",
        moveId: null,
        score: 0,
        reason: "格挡硬直中，维持防御并观察对手后续",
      });
      return remember(backGuardInput(self, opponent));
    }

    // A motion is a commitment: finish its directions/chord instead of
    // teleporting to another answer midway through the command.
    const bufferedReleaseReady = Boolean(
      freshContact
      && prebufferedCancel
      && (prebufferedCancel.ready || executor.getDebugState().queuedFrames <= 1),
    );
    if (executor.isBusy() && !bufferedReleaseReady) {
      const executorPlan = executor.getDebugState().activePlan ?? lastPlan;
      const activePlan = String(executorPlan?.moveId ?? "").startsWith("prebuffer:")
        ? { ...executorPlan, moveId: prebufferedCancel?.moveId ?? executorPlan.moveId.slice("prebuffer:".length) }
        : executorPlan;
      if (activePlan) recordPlan(self, activePlan);
      const commandInput = executor.step(self, opponent);
      if (prebufferedCancel && !executor.isBusy()) {
        prebufferedCancel.ready = true;
        prebufferedCancel.readyFrame = frame;
      }
      return remember(adaptDefensiveInput(commandInput, activePlan, opponent));
    }
    if (bufferedReleaseReady) executor.interrupt();

    // Once airborne, choose an authored air option deterministically. This is
    // still a tactical command route, not a random jump/attack dice roll.
    if (isAirborne(self) && !airMoveUsed) {
      const airMove = chooseAirMove(stanceLegalMoveset, self.templateId);
      if (airMove) {
        airMoveUsed = true;
        const airPlan = {
          frame,
          intent: "approach",
          moveId: airMove.id,
          score: 80,
          reason: airMove.tags?.includes?.("crossup")
            ? "跳入角度成立，选择可换边的空中攻击"
            : "跳入后使用空中攻击，争取落地确认与压制",
        };
        recordPlan(self, airPlan);
        return remember(executor.start(airPlan, airMove, self, opponent));
      }
    }

    const projectileThreat = incomingProjectileThreat(
      observation.projectiles,
      self,
      selfIndex,
      finite(game?.arena?.width, 1280) * 0.18,
    );
    if (projectileThreat && !isMoveBusy(self) && !isKnockedDown(self)) {
      const defenseMove = chooseProjectileDefense(stanceLegalMoveset, self);
      const projectilePlan = {
        frame,
        intent: "defend",
        moveId: defenseMove?.id ?? null,
        score: 98,
        reason: defenseMove?.tags?.includes?.("parry")
          ? "飞行物即将接触，使用 Drive Parry 保存站位"
          : defenseMove?.tags?.includes?.("roll")
            ? "飞行物即将接触，使用无敌翻滚穿过弹道"
            : "飞行物即将接触，保持后下防御避免无意义换血",
      };
      recordPlan(self, projectilePlan);
      const projectileInput = defenseMove
        ? executor.start(projectilePlan, defenseMove, self, opponent)
        : backGuardInput(self, opponent);
      return remember(adaptDefensiveInput(projectileInput, projectilePlan, opponent));
    }

    const throwTechRange = finite(game?.arena?.width, 1280) * 0.085;
    if (
      isIncomingThrow(opponent)
      && Math.abs(finite(opponent.x) - finite(self.x)) <= throwTechRange
      && !isMoveBusy(self)
      && !isKnockedDown(self)
    ) {
      const techPlan = {
        frame,
        intent: "defend",
        moveId: null,
        score: 100,
        reason: "观测到近身投技启动，以同帧投输入尝试拆投",
      };
      recordPlan(self, techPlan);
      return remember({ ...EMPTY_COMBAT_INPUT, throw: true });
    }

    if (isGroundStrikeThreat(opponent, self) && !isMoveBusy(self) && !isKnockedDown(self)) {
      const guardPlan = {
        frame,
        intent: "defend",
        moveId: null,
        score: 96,
        reason: "对手地面攻击已进入启动/生效阶段，按攻击高度选择防御",
      };
      recordPlan(self, guardPlan);
      const guard = backGuardInput(self, opponent);
      return remember(adaptDefensiveInput(guard, guardPlan, opponent));
    }

    if (isMoveBusy(self) && !freshContact && !hasResolvedContact(self)) {
      const shouldRefresh = prebufferedCancel?.ready
        && frame - finite(prebufferedCancel.readyFrame, frame) >= 5;
      if (!prebufferedCancel || shouldRefresh) {
        const target = prebufferedCancel
          ? getMove(stanceLegalMoveset, prebufferedCancel.moveId)
          : choosePrebufferTarget(stanceLegalMoveset, self);
        if (target?.command?.motion) {
          prebufferedCancel = {
            fromMoveId: currentId,
            moveId: target.id,
            ready: false,
            readyFrame: -1,
          };
          const bufferPlan = {
            frame,
            intent: "hitConfirm",
            moveId: target.id,
            score: 0,
            reason: `预输入 ${target.command.label || target.command.motion} 方向，命中后才按攻击键`,
          };
          const motionOnly = {
            ...target,
            id: `prebuffer:${target.id}`,
            command: { ...target.command, buttons: [] },
          };
          recordPlan(self, bufferPlan);
          return remember(executor.start(bufferPlan, motionOnly, self, opponent));
        }
      }
    }

    // During an authored move, only a new hit/block contact may reopen the
    // planner. That is the actual hit-confirm/cancel decision point.
    if (isMoveBusy(self) && !freshContact) return remember(EMPTY_COMBAT_INPUT);

    const cancelSelection = freshContact
      ? contactCancelMoveset(stanceLegalMoveset, self, contact)
      : { moveset: stanceLegalMoveset, authored: false };
    if (freshContact && cancelSelection.authored && Object.keys(cancelSelection.moveset.moves).length === 0) {
      handledContactToken = contactToken;
      const confirmPlan = {
        frame,
        intent: contact.outcome === "block" ? "frameTrap" : "hitConfirm",
        moveId: null,
        score: 0,
        reason: contact.outcome === "block"
          ? "已确认格挡，但当前取消窗不允许续招；停手保留下一次帧陷阱"
          : "已确认命中，但当前招式没有合法取消；等待收招后继续连段",
      };
      recordPlan(self, confirmPlan);
      return remember(EMPTY_COMBAT_INPUT);
    }

    const decisionMoveset = cancelSelection.moveset;
    let plan = planner.plan(observedGame, selfIndex, decisionMoveset, {
      scoreAdjust: tacticalScoreAdjust(profile.id),
    });
    const bufferedTarget = bufferedReleaseReady
      ? getMove(decisionMoveset, prebufferedCancel?.moveId)
      : null;
    if (bufferedTarget) {
      plan = {
        frame,
        intent: "comboRoute",
        moveId: bufferedTarget.id,
        score: 120,
        reason: "攻击已经确认命中，补上预输入招式的攻击键完成取消",
      };
    }
    if (!bufferedTarget && Array.isArray(plan.candidates)) {
      const opponentDown = opponent?.action === "knockdown" || finite(opponent?.knockdownFrames) > 0;
      const selfDown = isKnockedDown(self);
      if (selfDown && finite(self?.knockdownFrames) <= 9) {
        wakeupMixups += 1;
        const desired = wakeupMixups % 4 === 0 ? "reversal" : "defend";
        plan = candidateVariant(plan, desired, frame);
      } else if (opponentDown) {
        okiMixups += 1;
        const desired = ["meaty", "throw", "reversalBait", "shimmy"][okiMixups % 4];
        plan = candidateVariant(plan, desired, frame);
      } else if (freshContact && contact?.outcome === "block") {
        blockedMixups += 1;
        if (blockedMixups % 3 === 0) plan = candidateVariant(plan, "shimmy", frame);
      } else if (["frameTrap", "throw"].includes(plan.intent)) {
        closeMixups += 1;
        if (closeMixups % 3 === 0) plan = candidateVariant(plan, "throw", frame);
        else if (closeMixups % 5 === 0) plan = candidateVariant(plan, "shimmy", frame);
      }
    }
    if (plan.reason === "no legal tactical candidate") {
      const tacticalWidth = finite(observedGame?.arena?.width, 640);
      const distance = Math.abs(finite(opponent?.x) - finite(self?.x));
      plan = distance > tacticalWidth * 0.16
        ? {
          frame,
          intent: "approach",
          moveId: null,
          score: 1,
          reason: "当前没有能触及的惩罚技，先推进回到有效博弈距离",
        }
        : {
          frame,
          intent: "defend",
          moveId: null,
          score: 1,
          reason: "当前没有合法抢招，短暂防御等待下一处空档",
        };
    }
    const tentativeMove = getMove(decisionMoveset, plan.moveId);
    if (tentativeMove && requiresImmediateReach(plan.intent) && !moveCanReach(tentativeMove, self, opponent)) {
      plan = {
        frame,
        intent: "approach",
        moveId: null,
        score: 2,
        reason: `${tentativeMove.name ?? tentativeMove.id} 当前够不到，先移动到实际碰撞盒射程`,
      };
    }
    if (freshContact) handledContactToken = contactToken;

    // Deterministic jump approaches keep air-to-ground/air-special routes in
    // the real action space. The planner still decides *when* approach is the
    // best tactic; this only selects one authored approach variant.
    if (plan.intent === "approach" && self.onGround !== false && !isKnockedDown(self)) {
      approachPlans += 1;
      if (approachPlans % profile.jumpApproachEvery === 0) {
        plan = {
          ...plan,
          moveId: null,
          reason: "地面推进容易被截击，改用一次可对空惩罚的跳入试探",
        };
        const jumpCommand = {
          id: "jumpApproach",
          command: { direction: "upForward", buttons: [] },
        };
        recordPlan(self, plan);
        airMoveUsed = false;
        return remember(executor.start(plan, jumpCommand, self, opponent));
      }
    }

    let move = getMove(decisionMoveset, plan.moveId);
    if (bufferedTarget && move?.id === bufferedTarget.id) {
      move = {
        ...move,
        command: { ...move.command, motion: null, direction: null },
      };
      prebufferedCancel = null;
    }
    if (["whiffBait", "reversalBait", "shimmy"].includes(plan.intent)) {
      pendingBait = { intent: plan.intent, frame };
    }
    recordPlan(self, plan);
    return remember(adaptDefensiveInput(executor.start(plan, move, self, opponent), plan, opponent));
  }

  function frameNumber(game) {
    if (Number.isFinite(game?.frame)) return Math.floor(game.frame);
    syntheticFrame += 1;
    return syntheticFrame;
  }

  function remember(input) {
    lastCanonicalInput = normalizeCombatInput(input);
    return compatibleInput(lastCanonicalInput);
  }

  function recordPlan(fighter, plan) {
    lastPlan = plan ? { ...plan } : null;
    mutatePlanState(fighter, lastPlan);
  }

  function updateAirState(self) {
    const airborne = isAirborne(self);
    if (wasAirborne && !airborne) airMoveUsed = false;
    if (!wasAirborne && airborne) airMoveUsed = false;
    wasAirborne = airborne;
  }

  function inferLegacyContact(self, opponent, frame) {
    const health = finite(opponent.health, NaN);
    const blockstun = finite(opponent.blockstun, finite(opponent.blockstunFrames));
    if (blockstun > 0 && blockstun > lastOpponentBlockstun) {
      inferredContact = {
        outcome: "block",
        frame,
        moveId: currentMoveId(self),
        inferred: true,
      };
    } else if (Number.isFinite(lastOpponentHealth) && health < lastOpponentHealth) {
      inferredContact = {
        outcome: "hit",
        frame,
        moveId: currentMoveId(self),
        inferred: true,
      };
    }
    if (Number.isFinite(health)) lastOpponentHealth = health;
    lastOpponentBlockstun = blockstun;
  }

  function currentObservation(game, opponent, frame) {
    const snapshot = {
      frame,
      fighter: snapshotFighter(opponent),
      projectiles: (game?.projectiles ?? []).map(snapshotProjectile),
    };
    lastObservedFrame = snapshot.frame;
    return snapshot;
  }

  function getDebugState() {
    return {
      preset: presetKey,
      difficulty: difficultyName,
      observedFrame: lastObservedFrame,
      lastPlan,
      planner: planner.getDebugState(),
      executor: executor.getDebugState(),
    };
  }

  function resolvePendingBait(game, selfIndex, opponent, frame) {
    if (!pendingBait) return;
    if (frame - pendingBait.frame > 60) {
      pendingBait = null;
      return;
    }
    const move = opponent?.currentMove ?? opponent?.moveData;
    const contact = opponent?.lastContact;
    const recovery = String(opponent?.movePhase ?? "").toLowerCase() === "recovery";
    const whiffed = contact?.outcome === "whiff" && finite(contact?.frame, -1) >= pendingBait.frame;
    if (!recovery && !whiffed) return;
    const moveText = `${move?.id ?? contact?.moveId ?? opponent?.action ?? ""} ${(move?.tags ?? []).join(" ")}`.toLowerCase();
    const baited = /reversal|shoryu|oniyaki|dragon/.test(moveText)
      ? "reversal"
      : /throw|grab|nage/.test(moveText)
        ? "throw"
        : "button";
    recordCombatEvent(game, "bait", {
      fighterId: selfIndex,
      opponentId: 1 - selfIndex,
      intent: pendingBait.intent,
      baited,
      moveId: move?.id ?? contact?.moveId ?? null,
    });
    pendingBait = null;
  }

  reset();
  return {
    name: profile.name,
    description: profile.description,
    reset,
    decide,
    getDebugState,
  };
}

function makeObservedGame(game, selfIndex, self, opponent, observation, frame) {
  const fighters = [...(game?.fighters ?? [])];
  fighters[selfIndex] = self;
  fighters[1 - selfIndex] = opponent;
  const targetEventFrame = frame - Math.max(0, frame - observation.frame);
  return {
    ...game,
    // Tactical ranges are based on character scale, not the full 1280 px
    // stage. Otherwise two agents mistake half-screen distance for poke range
    // and mirror back-and-forth forever without ever making contact.
    arena: {
      ...(game?.arena ?? {}),
      width: Math.min(
        finite(game?.arena?.width, 1280),
        Math.max(520, finite(self?.height, 112) * 5.7),
      ),
    },
    fighters,
    projectiles: observation.projectiles,
    combatEvents: (game?.combatEvents ?? []).filter(
      (event) => Number.isFinite(event?.frame) && event.frame <= targetEventFrame,
    ),
  };
}

function tacticalScoreAdjust(preset) {
  if (preset === "pressure") {
    return { poke: 7, frameTrap: 9, throw: 6, meaty: 8, approach: 4, whiffBait: -2 };
  }
  if (preset === "zoner") {
    return { projectile: 12, poke: 4, whiffBait: 3, whiffPunish: 8, defend: 3 };
  }
  return { poke: 6, projectile: 7, whiffPunish: 7, antiAir: 5, frameTrap: 3, whiffBait: 1 };
}

function candidateVariant(plan, intent, frame) {
  const candidate = plan?.candidates?.find((entry) => entry.intent === intent);
  return candidate
    ? { ...candidate, frame, candidates: plan.candidates }
    : plan;
}

function snapshotFighter(fighter) {
  const currentMove = fighter?.currentMove ?? fighter?.moveData ?? null;
  return {
    id: fighter?.id,
    templateId: fighter?.templateId,
    x: finite(fighter?.x),
    y: finite(fighter?.y),
    vx: finite(fighter?.vx),
    vy: finite(fighter?.vy),
    width: finite(fighter?.width, 46),
    height: finite(fighter?.height, 112),
    facing: fighter?.facing,
    health: finite(fighter?.health, 1),
    maxHealth: finite(fighter?.maxHealth, 1000),
    action: fighter?.action ?? "idle",
    state: fighter?.state ?? "",
    actionFrame: finite(fighter?.actionFrame),
    actionDuration: finite(fighter?.actionDuration),
    onGround: fighter?.onGround !== false,
    hitstun: finite(fighter?.hitstun, finite(fighter?.hitstunFrames)),
    hitstunFrames: finite(fighter?.hitstunFrames, finite(fighter?.hitstun)),
    blockstun: finite(fighter?.blockstun, finite(fighter?.blockstunFrames)),
    blockstunFrames: finite(fighter?.blockstunFrames, finite(fighter?.blockstun)),
    knockdownFrames: finite(fighter?.knockdownFrames),
    knockdownType: fighter?.knockdownType,
    movePhase: fighter?.movePhase,
    lastContact: fighter?.lastContact && typeof fighter.lastContact === "object"
      ? { ...fighter.lastContact }
      : fighter?.lastContact,
    currentMove: currentMove && typeof currentMove === "object" ? { ...currentMove } : currentMove,
    moveData: currentMove && typeof currentMove === "object" ? { ...currentMove } : currentMove,
  };
}

function snapshotProjectile(projectile) {
  return {
    id: projectile?.id,
    ownerIndex: projectile?.ownerIndex,
    fighterIndex: projectile?.fighterIndex,
    owner: projectile?.owner,
    x: finite(projectile?.x),
    y: finite(projectile?.y),
    vx: finite(projectile?.vx, finite(projectile?.velocityX)),
    active: projectile?.active !== false && projectile?.alive !== false && projectile?.dead !== true,
  };
}

// Renderer/headless-facing tactical state is written in one place.
function mutatePlanState(fighter, plan) {
  if (!fighter || !plan) return;
  fighter.aiIntent = plan.intent ?? "defend";
  fighter.aiReason = plan.reason ?? "";
  fighter.aiMoveId = plan.moveId ?? null;
  fighter.aiPlanFrame = finite(plan.frame);
  fighter.aiPlan = {
    intent: fighter.aiIntent,
    reason: fighter.aiReason,
    moveId: fighter.aiMoveId,
    frame: fighter.aiPlanFrame,
    score: finite(plan.score),
  };
}

function movesetFor(fighter, catalogue, cache) {
  const templateId = String(fighter?.templateId ?? fighter?.characterTemplate ?? "vanguard");
  const raw = catalogue?.[templateId] ?? catalogue?.vanguard ?? { moves: {} };
  if (cache.has(raw)) return cache.get(raw);
  if (raw?.moves && typeof raw.moves === "object") {
    const enhanced = {
      ...raw,
      moves: Object.fromEntries(
        Object.entries(raw.moves).map(([id, move]) => [id, enhanceAuthoredMove(id, move)]),
      ),
    };
    cache.set(raw, enhanced);
    return enhanced;
  }
  const moves = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (!value || typeof value !== "object" || !Number.isFinite(value.startup)) continue;
    moves[id] = adaptLegacyMove(id, value);
  }
  const adapted = {
    id: templateId,
    name: templateId,
    aliases: {},
    moves,
  };
  cache.set(raw, adapted);
  return adapted;
}

function enhanceAuthoredMove(id, move) {
  const tags = new Set(move?.tags ?? []);
  const category = move?.category ?? "normal";
  const startup = finite(move?.startup, 99);
  const activeFrames = finite(move?.activeFrameCount, finite(move?.active, 1));
  const blockAdvantage = finite(move?.block?.advantage, finite(move?.blockAdvantage, -99));
  const nonAttack = tags.has("nonAttack") || move?.hitLevel === "none" || finite(move?.damage) <= 0;

  if (category === "normal" && !nonAttack) {
    if (startup <= 6 || tags.has("light")) tags.add("fast");
    if (startup <= 9) tags.add("combo");
    if (startup <= 12 && (tags.has("medium") || tags.has("heavy"))) tags.add("poke");
    if (startup <= 12 && tags.has("heavy")) tags.add("whiffPunish");
    if (blockAdvantage >= -2 || tags.has("rapidCancel")) tags.add("frameTrap");
    if (blockAdvantage >= -3) tags.add("safe");
    if (activeFrames >= 3) tags.add("meaty");
  }
  if (category === "commandNormal" && !nonAttack) {
    tags.add("poke");
    if (startup <= 14 || tags.has("advancing")) tags.add("whiffPunish");
    if (blockAdvantage >= 0 || tags.has("plusOnBlock")) tags.add("frameTrap");
    if (activeFrames >= 3) tags.add("meaty");
  }
  if (category === "targetCombo") tags.add("combo");
  if (["special", "od"].includes(category) && !tags.has("nonAttack")) tags.add("combo");
  if (["super", "climax"].includes(category)) tags.add("combo");
  if (category === "throw") tags.add("throw");
  if (move?.resource?.gains || tags.has("resourceGain") || tags.has("charge")) tags.add("resourceBuild");

  let range = finite(move?.range, estimateRange(move));
  if (range <= 0) {
    if (tags.has("projectile")) range = 9999;
    else if (category === "throw") range = 62;
    else if (tags.has("advancing") || tags.has("longRange")) range = 120;
    else if (tags.has("heavy")) range = 102;
    else if (tags.has("medium")) range = 90;
    else if (["special", "od", "super", "climax"].includes(category)) range = 100;
    else range = 74;
  }

  return {
    ...move,
    id: move?.id ?? id,
    tags: [...tags],
    range,
    strength: move?.strength
      ?? (tags.has("heavy") ? "heavy" : tags.has("medium") ? "medium" : tags.has("light") ? "light" : ""),
  };
}

function adaptLegacyMove(id, move) {
  const lower = id.toLowerCase();
  const air = lower.startsWith("air");
  let category = "normal";
  if (lower.includes("throw")) category = "throw";
  else if (/super|climax|ca$/.test(lower)) category = lower.includes("climax") ? "climax" : "super";
  else if (/od|ex/.test(lower)) category = "od";
  else if (/fireball|dragon|rekka|tatsu|hammer|special/.test(lower)) category = "special";

  const tags = [];
  if (category === "normal") {
    tags.push("poke", "meaty", "active");
    if (lower.includes("light")) tags.push("fast", "frameTrap", "combo");
    if (lower.includes("heavy")) tags.push("longRange", "whiffPunish");
  }
  if (lower.includes("fireball")) tags.push("projectile", "spaceControl");
  if (lower.includes("dragon")) tags.push("antiAir", "reversal", "combo");
  if (lower.includes("rekka")) tags.push("combo", "frameTrap", "longRange");
  if (lower.includes("tatsu") || lower.includes("hammer")) tags.push("combo");
  if (category === "throw") tags.push("throw");
  if (category === "super" || category === "climax") tags.push("super", "combo");
  if (category === "od") tags.push("combo", "special");

  return {
    ...move,
    id,
    category,
    tags: [...new Set([...(move.tags ?? []), ...tags])],
    stance: move.stance ?? (air ? "air" : "ground"),
    command: move.command ?? legacyCommand(id),
    animation: move.animation ?? id,
    range: finite(move.range, estimateRange(move)),
  };
}

function legacyCommand(id) {
  const lower = id.toLowerCase();
  const heavy = lower.includes("heavy") || lower.includes("dragon") || lower.includes("tatsu") || lower.includes("hammer");
  const button = heavy ? "hp" : "lp";
  if (lower.includes("throw")) return { buttons: ["throw"], label: "投" };
  if (lower.includes("dragon")) return { motion: "dp", buttons: ["hp"], label: "623HP" };
  if (lower.includes("airtatsu")) return { motion: "qcb", buttons: ["hk"], air: true, label: "空中214HK" };
  if (lower.includes("airhammer")) return { direction: "down", buttons: ["hp"], air: true, label: "空中2HP" };
  if (lower.includes("fireball") || lower.includes("rekka")) {
    return { motion: "qcf", buttons: [button], label: `236${button.toUpperCase()}` };
  }
  if (lower.startsWith("mid")) return { direction: "forward", buttons: [button], label: `6${button.toUpperCase()}` };
  if (lower.startsWith("low")) return { direction: "down", buttons: [button], label: `2${button.toUpperCase()}` };
  return { buttons: [button], air: lower.startsWith("air"), label: button.toUpperCase() };
}

function stanceMoveset(moveset, fighter, opponent, arena) {
  const airborne = isAirborne(fighter);
  const distance = Math.abs(finite(opponent?.x) - finite(fighter?.x));
  const moves = Object.fromEntries(Object.entries(moveset?.moves ?? {}).filter(([, move]) => {
    const airMove = /air|jump|hop/i.test(String(move.stance ?? ""))
      || move.command?.air
      || move.tags?.includes?.("airOnly");
    if (airborne ? !airMove : airMove) return false;
    if (move.disabled || move.needsLab) return false;
    if (!moveConditionsMet(move, fighter, opponent, arena)) return false;
    const closeRange = finite(move.closeRange, 92);
    if (move.proximity === "close" && distance > closeRange) return false;
    if (move.proximity === "far" && distance <= closeRange) return false;
    const routeFrom = asArray(move.routeFrom ?? move.followupFrom ?? move.from);
    const currentId = currentMoveId(fighter);
    if (routeFrom.length > 0 && !routeFrom.includes(currentId) && !move.tags?.includes?.("standalone")) return false;
    return true;
  }));
  return { ...moveset, moves };
}

function moveConditionsMet(move, fighter, opponent, arena) {
  const tags = new Set(move?.tags ?? []);
  const conditions = asArray(move?.resource?.conditions ?? move?.conditions).map((value) => String(value).replaceAll(" ", ""));
  const healthRatio = finite(fighter?.health, 1) / Math.max(1, finite(fighter?.maxHealth, 1));
  if ((tags.has("criticalArt") || tags.has("ca") || tags.has("lowHealthOnly")) && healthRatio > 0.25) return false;
  if (tags.has("nonCritical") && healthRatio <= 0.25) return false;
  if ((tags.has("requiresDenjin") || tags.has("denjin") || conditions.some((condition) => condition.includes("denjinStock>=1"))) && finite(fighter?.denjinStock) < 1) return false;
  if ((tags.has("noDenjin") || conditions.some((condition) => condition.includes("denjinStock<1"))) && finite(fighter?.denjinStock) >= 1) return false;
  if (conditions.some((condition) => condition.includes("healthRatio<=0.25")) && healthRatio > 0.25) return false;
  if (conditions.some((condition) => condition.includes("healthRatio>0.25")) && healthRatio <= 0.25) return false;
  if (conditions.some((condition) => condition.includes("maxModeFrames>0")) && finite(fighter?.maxModeFrames) <= 0) return false;
  if (conditions.some((condition) => condition.includes("maxModeFrames<=0")) && finite(fighter?.maxModeFrames) > 0) return false;
  if (conditions.includes("inBlockstun") && !isBlockStunned(fighter) && fighter?.action !== "block") return false;
  if (conditions.includes("wakeupRecovery") && !isKnockedDown(fighter)) return false;
  if (conditions.includes("insideThrowTechWindow") && finite(fighter?.throwTechWindow) <= 0) return false;
  if (move.condition === "corner" && !isCornered(opponent, arena)) return false;
  if (move.condition === "maxMode" && finite(fighter?.maxModeFrames) <= 0) return false;
  return true;
}

function isCornered(fighter, arena = {}) {
  const left = finite(arena?.left, finite(arena?.sidePadding, 80));
  const right = finite(arena?.right, finite(arena?.width, 1280) - left);
  const margin = Math.max(55, finite(fighter?.width, 46) * 1.5);
  return finite(fighter?.x) <= left + margin || finite(fighter?.x) >= right - margin;
}

function contactCancelMoveset(moveset, fighter, contact) {
  const currentMove = fighter?.currentMove ?? fighter?.moveData;
  const cancels = Array.isArray(currentMove?.cancels) ? currentMove.cancels : [];
  const routeMoves = Object.fromEntries(Object.entries(moveset?.moves ?? {}).filter(([, move]) => (
    asArray(move?.routeFrom ?? move?.followupFrom ?? move?.from).includes(currentMove?.id)
  )));
  const cancelMask = new Set(
    asArray(currentMove?.cancelMask ?? currentMove?.cancelTier)
      .flatMap((value) => String(value).split(/[+/,| ]+/))
      .filter(Boolean),
  );
  if (cancels.length === 0 && Object.keys(routeMoves).length === 0 && cancelMask.size === 0) {
    return { moveset, authored: false };
  }

  const actionFrame = finite(fighter?.actionFrame, finite(contact?.actionFrame, NaN));
  const outcome = contact?.outcome ?? "hit";
  const rawOutcome = contact?.rawOutcome ?? outcome;
  const activeRules = cancels.filter((cancel) => {
    const outcomes = Array.isArray(cancel.on) ? cancel.on : [cancel.on ?? "hit"];
    if (!outcomes.includes(outcome) && !outcomes.includes(rawOutcome) && !outcomes.includes("contact") && !outcomes.includes("any")) return false;
    if (!Number.isFinite(actionFrame)) return true;
    const start = finite(cancel.start, 1);
    const end = finite(cancel.end, start);
    // Engine actionFrame conventions differ by one frame across legacy/new
    // data. This tolerance still keeps the request inside the authored window.
    return actionFrame >= start - 2 && actionFrame <= end + 1;
  });
  if (activeRules.length === 0 && Object.keys(routeMoves).length === 0 && cancelMask.size === 0) {
    return { moveset: { ...moveset, moves: {} }, authored: true };
  }

  const moves = Object.fromEntries(Object.entries(moveset.moves ?? {}).filter(([id, move]) => (
    Object.hasOwn(routeMoves, id)
      || activeRules.some((cancel) => cancelAllowsMove(cancel, id, move))
      || cancelMaskAllowsMove(cancelMask, move)
  )));
  return { moveset: { ...moveset, moves }, authored: true };
}

function choosePrebufferTarget(moveset, fighter) {
  const current = fighter?.currentMove ?? fighter?.moveData;
  if (!current) return null;
  const routes = Object.values(moveset?.moves ?? {}).filter((move) => (
    asArray(move?.routeFrom ?? move?.followupFrom ?? move?.from).includes(current.id)
  ));
  const rules = (current.cancels ?? []).filter((cancel) => {
    const outcomes = asArray(cancel.on ?? "hit");
    return outcomes.includes("hit") || outcomes.includes("contact") || outcomes.includes("any");
  });
  const mask = new Set(
    asArray(current.cancelMask ?? current.cancelTier)
      .flatMap((value) => String(value).split(/[+/,| ]+/))
      .filter(Boolean),
  );
  const candidates = Object.values(moveset?.moves ?? {}).filter((move) => (
    move.id !== current.id
      && move.command?.motion
      && canAffordMove(fighter, move)
      && (
        routes.some((route) => route.id === move.id)
        || rules.some((rule) => cancelAllowsMove(rule, move.id, move))
        || cancelMaskAllowsMove(mask, move)
      )
  ));
  candidates.sort((first, second) => prebufferScore(second, routes) - prebufferScore(first, routes));
  return candidates[0] ?? null;
}

function prebufferScore(move, routes) {
  const routeBonus = routes.some((route) => route.id === move.id) ? 160 : 0;
  const category = { special: 80, od: 68, super: 35, climax: 30 }[move?.category] ?? 10;
  const motionPenalty = ["qcfQcf", "qcbQcb", "qcbHcf", "qcfHcb"].includes(move?.command?.motion) ? 45 : 0;
  const resource = move?.resourceCost ?? move?.cost ?? {};
  const resourcePenalty = finite(resource.super) * 0.08 + finite(resource.drive) * 0.035;
  return routeBonus + category + finite(move?.damage) / 18 - finite(move?.startup) * 0.5 - motionPenalty - resourcePenalty;
}

function hasResolvedContact(fighter) {
  const contact = fighter?.lastContact;
  if (!contact || contact.outcome === "whiff") return false;
  if (Number.isFinite(contact.actionSerial) && Number.isFinite(fighter?.actionSerial)) {
    return contact.actionSerial === fighter.actionSerial;
  }
  return contact.moveId === currentMoveId(fighter);
}

function cancelMaskAllowsMove(mask, move) {
  if (mask.size === 0) return false;
  const tags = new Set(move?.tags ?? []);
  if ((mask.has("C") || mask.has("special")) && ["special", "od", "super", "climax", "system"].includes(move?.category)) return true;
  if (mask.has("super") && ["super", "climax"].includes(move?.category)) return true;
  if (mask.has("SA3") && (tags.has("sa3") || tags.has("criticalArt"))) return true;
  if (mask.has("SA2") && (tags.has("sa2") || tags.has("sa3") || tags.has("criticalArt"))) return true;
  if (mask.has("command") && move?.category === "commandNormal") return true;
  return false;
}

function cancelAllowsMove(cancel, moveId, move) {
  const explicitMoves = Array.isArray(cancel.moves) ? cancel.moves : cancel.moves ? [cancel.moves] : [];
  if (explicitMoves.includes(moveId)) return true;
  const into = Array.isArray(cancel.into) ? cancel.into : [cancel.into ?? "special"];
  return into.some((target) => {
    if (target === moveId || target === move?.id) return true;
    if (target === move?.category) return true;
    if (move?.tags?.includes?.(target)) return true;
    if (target === "super" && ["super", "climax"].includes(move?.category)) return true;
    if (target === "special" && ["special", "od"].includes(move?.category)) return true;
    return false;
  });
}

function chooseAirMove(moveset, templateId) {
  const moves = Object.values(moveset?.moves ?? {});
  const preferred = String(templateId).toLowerCase().includes("ember")
    ? ["airhammer", "naraku"]
    : ["airtatsu", "air_tatsu", "tatsumaki"];
  return moves.find((move) => preferred.some((term) => move.id.toLowerCase().includes(term)))
    ?? moves.find((move) => move.category === "special")
    ?? moves.find((move) => move.strength === "heavy")
    ?? moves[0]
    ?? null;
}

function incomingProjectileThreat(projectiles, self, selfIndex, maximumDistance) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const projectile of projectiles ?? []) {
    const owner = projectile?.ownerIndex ?? projectile?.fighterIndex ?? projectile?.owner;
    if (owner === selfIndex || projectile?.active === false) continue;
    const dx = finite(self?.x) - finite(projectile?.x, NaN);
    if (!Number.isFinite(dx)) continue;
    const distance = Math.abs(dx);
    if (distance > maximumDistance) continue;
    const velocity = finite(projectile?.vx);
    if (Math.abs(velocity) > 0.01 && dx * velocity <= 0) continue;
    if (distance < nearestDistance) {
      nearest = projectile;
      nearestDistance = distance;
    }
  }
  return nearest ? { projectile: nearest, distance: nearestDistance } : null;
}

function chooseProjectileDefense(moveset, fighter) {
  const moves = Object.values(moveset?.moves ?? {}).filter((move) => canAffordMove(fighter, move));
  return moves.find((move) => move.tags?.includes?.("parry"))
    ?? moves.find((move) => move.tags?.includes?.("roll"))
    ?? null;
}

function getMove(moveset, moveId) {
  if (!moveId) return null;
  const id = moveset?.aliases?.[moveId] ?? moveId;
  return moveset?.moves?.[id] ?? null;
}

function requiresImmediateReach(intent) {
  return ["antiAir", "poke", "whiffPunish", "frameTrap", "throw", "meaty"].includes(intent);
}

function moveCanReach(move, self, opponent) {
  const tags = new Set(move?.tags ?? []);
  if (tags.has("projectile")) return true;
  const distance = Math.abs(finite(opponent?.x) - finite(self?.x));
  let range = finite(move?.range, estimateRange(move));
  if (range <= 0) {
    if (move?.category === "throw") range = 62;
    else if (tags.has("advancing") || tags.has("longRange")) range = 115;
    else if (tags.has("antiAir")) range = 100;
    else if (["special", "od"].includes(move?.category)) range = 105;
    else range = 78;
  }
  const bodyAllowance = (finite(self?.width, 46) + finite(opponent?.width, 46)) * 0.38;
  return distance <= range + bodyAllowance;
}

function compatibleInput(input) {
  const canonical = normalizeCombatInput(input);
  const legacy = {
    left: canonical.left,
    right: canonical.right,
    up: canonical.up,
    down: canonical.down,
    light: canonical.lp || canonical.mp || canonical.lk,
    heavy: canonical.hp || canonical.mk || canonical.hk,
    special: canonical.throw,
    guard: canonical.guard,
  };
  const descriptors = {};
  for (const key of CANONICAL_KEYS.filter((candidate) => !Object.hasOwn(legacy, candidate))) {
    descriptors[key] = {
      value: Boolean(canonical[key]),
      enumerable: false,
      configurable: true,
      writable: true,
    };
  }
  Object.defineProperties(legacy, descriptors);
  return legacy;
}

function backGuardInput(self, opponent) {
  const facing = facingSign(self, opponent);
  return {
    ...EMPTY_COMBAT_INPUT,
    [facing > 0 ? "left" : "right"]: true,
    down: Boolean(self?.crouching || self?.lastInput?.down),
    guard: true,
  };
}

function adaptDefensiveInput(input, plan, opponent) {
  if (!["defend", "reversalBait"].includes(plan?.intent)) return input;
  const canonical = normalizeCombatInput(input);
  if (!canonical.guard || canonical.up) return canonical;
  const move = opponent?.currentMove ?? opponent?.moveData;
  const level = String(move?.hitLevel ?? opponent?.hitLevel ?? "").toLowerCase();
  const overhead = ["overhead", "midhigh", "jump", "air", "highoverhead"].includes(level);
  return { ...canonical, down: !overhead };
}

function isIncomingThrow(opponent) {
  const move = opponent?.currentMove ?? opponent?.moveData;
  return move?.category === "throw" || /throw|grab|nage|投/i.test(`${move?.id ?? ""} ${opponent?.action ?? ""}`);
}

function isGroundStrikeThreat(opponent, self) {
  if (isAirborne(opponent)) return false;
  const move = opponent?.currentMove ?? opponent?.moveData;
  if (!move || move.category === "throw" || move.tags?.includes?.("nonAttack")) return false;
  const phase = String(opponent?.movePhase ?? move?.phase ?? "").toLowerCase();
  if (!["startup", "active"].includes(phase)) return false;
  const distance = Math.abs(finite(opponent?.x) - finite(self?.x));
  const range = Math.max(75, finite(move?.range, estimateRange(move)));
  return distance <= range + finite(self?.width, 46) * 0.65;
}

function normalizedContact(contact, frame) {
  if (!contact || typeof contact !== "object") return null;
  const rawOutcome = String(contact.outcome ?? contact.result ?? "").toLowerCase();
  const outcome = ["hit", "counter", "punishcounter", "punish-counter"].includes(rawOutcome)
    ? "hit"
    : ["block", "blocked", "guard"].includes(rawOutcome)
      ? "block"
      : rawOutcome;
  if (!outcome) return null;
  return {
    ...contact,
    rawOutcome,
    outcome,
    frame: Number.isFinite(contact.frame) ? contact.frame : frame,
  };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function tokenForContact(contact) {
  if (!contact) return "";
  return `${contact.frame}:${contact.outcome}:${contact.moveId ?? contact.action ?? ""}:${contact.hitId ?? ""}`;
}

function currentMoveId(fighter) {
  const move = fighter?.currentMove ?? fighter?.moveData;
  if (typeof move === "string") return move;
  return move?.id ?? fighter?.action ?? null;
}

function isCombatPhase(phase) {
  return !["roundOver", "matchOver", "paused", "menu", "ko"].includes(String(phase ?? "fighting"));
}

function isAirborne(fighter) {
  return fighter?.onGround === false || String(fighter?.action ?? "").toLowerCase().startsWith("jump");
}

function isKnockedDown(fighter) {
  const type = String(fighter?.knockdownType ?? "none").toLowerCase();
  return fighter?.action === "knockdown"
    || finite(fighter?.knockdownFrames) > 0
    || !["", "none", "standing", "neutral"].includes(type);
}

function isHitStunned(fighter) {
  return fighter?.action === "hit" || finite(fighter?.hitstun, finite(fighter?.hitstunFrames)) > 0;
}

function isBlockStunned(fighter) {
  return finite(fighter?.blockstun, finite(fighter?.blockstunFrames)) > 0;
}

function isMoveBusy(fighter) {
  if (fighter?.currentMove || fighter?.moveData) return true;
  const action = String(fighter?.action ?? "").toLowerCase();
  return /light|medium|heavy|fireball|dragon|shoryu|oniyaki|rekka|tatsu|hammer|throw|super|climax|attack/.test(action);
}

function facingSign(self, opponent) {
  if (Number.isFinite(self?.facing)) return Math.sign(self.facing) || 1;
  return finite(opponent?.x) >= finite(self?.x) ? 1 : -1;
}

function estimateRange(move) {
  const boxes = move?.hitboxes ?? [];
  return boxes.reduce(
    (maximum, box) => Math.max(maximum, Math.abs(finite(box.offsetX)) + finite(box.width) / 2),
    0,
  );
}

function normalizeDifficultyName(value) {
  if (typeof value === "string") {
    const key = value.toLowerCase();
    if (["easy", "normal", "hard", "expert"].includes(key)) return key;
    if (key === "简单") return "easy";
    if (key === "困难") return "hard";
    if (key === "高手") return "expert";
    return "normal";
  }
  const number = finite(value, 0.55);
  if (number >= 0.9) return "expert";
  if (number >= 0.7) return "hard";
  if (number <= 0.4) return "easy";
  return "normal";
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Math.round(Number.isFinite(number) ? number : fallback)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
