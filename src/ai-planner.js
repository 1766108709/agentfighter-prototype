import { canAffordMove } from "./resources.js";

export const TACTICAL_INTENTS = Object.freeze([
  "defend",
  "antiAir",
  "poke",
  "whiffBait",
  "whiffPunish",
  "approach",
  "projectile",
  "hitConfirm",
  "comboRoute",
  "frameTrap",
  "throw",
  "shimmy",
  "meaty",
  "reversalBait",
  "reversal",
  "resourceBuild",
  "superConfirm",
]);

const STYLE_WEIGHTS = Object.freeze({
  balanced: { aggression: 0.55, patience: 0.58, risk: 0.45, resource: 0.65 },
  pressure: { aggression: 0.82, patience: 0.35, risk: 0.68, resource: 0.55 },
  zoner: { aggression: 0.32, patience: 0.82, risk: 0.28, resource: 0.78 },
});

export function createTacticalPlanner({ preset = "balanced", difficulty = "normal", seed = 1 } = {}) {
  const style = STYLE_WEIGHTS[preset] ?? STYLE_WEIGHTS.balanced;
  const skill = difficultyValue(difficulty);
  let rng = hashSeed(seed);
  let lastPlan = null;
  let lastPlanFrame = -1000;
  let lastObservedEventFrame = -1;
  let habits;

  function reset({ preserveAdaptation = false } = {}) {
    lastPlan = null;
    lastPlanFrame = -1000;
    lastObservedEventFrame = -1;
    if (!preserveAdaptation || !habits) {
      habits = {
        wakeupMash: 1,
        wakeupReversal: 1,
        wakeupBlock: 2,
        throwTech: 1,
        standGuard: 2,
        crouchGuard: 2,
        crouchGuard: 2,
        jump: 1,
        whiff: 1,
        samples: 8,
      };
    }
  }

  function plan(game, selfIndex, moveset, options = {}) {
    const frame = finite(game?.frame);
    const self = game?.fighters?.[selfIndex];
    const opponent = game?.fighters?.[1 - selfIndex];
    if (!self || !opponent) return neutralPlan(frame, "missing fighter state");
    observe(game, selfIndex);

    const distance = Math.abs(finite(opponent.x) - finite(self.x));
    const width = finite(game?.arena?.width, 1280);
    const candidates = [];
    const moves = Object.values(moveset?.moves ?? moveset ?? {}).filter((move) => canAffordMove(self, move));
    const contact = self.lastContact;
    const opponentMove = opponent.currentMove ?? opponent.moveData;
    const opponentPhase = opponent.movePhase ?? game?.frameData?.[1 - selfIndex]?.phase;
    const near = distance <= width * 0.075;
    const mid = distance <= width * 0.16;
    const far = distance >= width * 0.22;
    const opponentDown = opponent.action === "knockdown" || finite(opponent.knockdownFrames) > 0;
    const selfDown = self.action === "knockdown" || finite(self.knockdownFrames) > 0;
    const opponentAir = !opponent.onGround || opponent.action === "jump";
    const opponentAttacking = Boolean(opponentMove || isAttackName(opponent.action));
    const recentHitConfirm = contact?.outcome === "hit" && frame - finite(contact.frame) <= 12;
    const recentBlockConfirm = contact?.outcome === "block" && frame - finite(contact.frame) <= 12;

    if (selfDown) {
      const reversal = bestMove(moves, ["reversal"], distance, self);
      if (reversal) add(candidates, "reversal", reversal, 48 + habitRate("wakeupMash") * 8, "起身有资源，保留无敌逆转威慑");
      add(candidates, "defend", null, 58 + style.patience * 18, "倒地中，优先观察对手压起身选择");
    } else if (recentHitConfirm) {
      const superMove = bestMove(moves, ["super", "climax"], distance, self);
      const comboMove = bestMove(moves, ["combo", "special", "targetCombo"], distance, self);
      if (superMove) {
        const meterCommitment = finite(self.superMeter) / Math.max(1, finite(self.maxSuperMeter, 300));
        add(candidates, "superConfirm", superMove, 82 + meterCommitment * 20 + skill * 12, "已确认命中，资源可转化为确定伤害");
      }
      if (comboMove) add(candidates, "comboRoute", comboMove, 86 + skill * 16, "命中确认后选择可持续真连的取消路线");
    } else if (recentBlockConfirm) {
      const safeFollow = bestMove(moves, ["safe", "frameTrap"], distance, self);
      if (safeFollow) add(candidates, "frameTrap", safeFollow, 62 + habitRate("wakeupMash") * 22, "对手爱抢招，使用延迟取消形成帧陷阱");
      add(candidates, "shimmy", null, 60 + habitRate("throwTech") * 25, "停手后退，诱导拆投或抢招空挥");
    } else if (opponentDown) {
      const meaty = bestMove(moves, ["meaty", "active"], distance, self);
      if (meaty) add(candidates, "meaty", meaty, 65 + style.aggression * 18, "利用持续帧覆盖起身");
      add(candidates, "throw", bestMove(moves, ["throw"], distance, self), 58 + habitRate("wakeupBlock") * 24, "对手偏向起身防御，加入投技二择");
      add(candidates, "reversalBait", null, 54 + habitRate("wakeupReversal") * 34, "停在无敌技射程外，准备惩罚起身逆转");
      add(candidates, "shimmy", null, 52 + habitRate("throwTech") * 30, "假装投技后后撤，骗拆投硬直");
    } else if (opponentAir) {
      const antiAir = bestMove(moves, ["antiAir"], distance, self);
      if (antiAir) add(candidates, "antiAir", antiAir, 90 + skill * 12, "对手离地，选择覆盖当前高度的对空技");
      add(candidates, "defend", null, 54 + style.patience * 15, "对空角度不稳时保留防御");
    } else if (opponentAttacking && opponentPhase === "recovery") {
      const punish = bestMove(moves, ["whiffPunish", "longRange", "super"], distance, self);
      if (punish) add(candidates, "whiffPunish", punish, 96 + skill * 18, "识别到空挥收招，使用启动与距离均能命中的惩罚");
    } else {
      if (near) {
        add(candidates, "throw", bestMove(moves, ["throw"], distance, self), 45 + habitRate("standGuard") * 20, "近身以投技迫使对手不能只防御");
        const trap = bestMove(moves, ["frameTrap", "fast"], distance, self);
        if (trap) add(candidates, "frameTrap", trap, 48 + style.aggression * 18, "用小负帧或正帧技测试对手是否抢招");
      }
      if (mid) {
        const poke = bestMove(moves, ["poke", "longRange"], distance, self);
        if (poke) add(candidates, "poke", poke, 50 + style.patience * 12, "以安全长技确认对手移动");
        add(candidates, "whiffBait", null, 49 + habitRate("whiff") * 18 + style.patience * 12, "进入对手攻击边缘后立即撤步，制造空挥");
      }
      if (far) {
        const projectile = bestMove(moves, ["projectile"], distance, self);
        if (projectile) add(candidates, "projectile", projectile, 50 + (preset === "zoner" ? 24 : 0), "远距离用飞行物交换空间并迫使对手行动");
        add(candidates, "approach", null, 46 + style.aggression * 22, "超出有效射程，推进到可博弈距离");
      }
      add(candidates, "resourceBuild", bestMove(moves, ["resourceBuild"], distance, self), 31 + style.resource * 16, "当前风险低，积累下一次确认的资源威慑");
      add(candidates, "defend", null, 32 + style.patience * 15, "没有明确优势时不无意义按键");
    }

    if (candidates.length === 0) candidates.push(neutralPlan(frame, "no legal tactical candidate"));
    for (const candidate of candidates) {
      candidate.score += deterministicNoise() * Math.max(1, 12 - skill * 10);
      candidate.score += options.scoreAdjust?.[candidate.intent] ?? 0;
    }
    candidates.sort((a, b) => b.score - a.score || String(a.moveId).localeCompare(String(b.moveId)));
    lastPlan = { ...candidates[0], frame, candidates: candidates.slice(0, 4) };
    lastPlanFrame = frame;
    return lastPlan;
  }

  function observe(game, selfIndex) {
    const events = game?.combatEvents ?? [];
    for (const event of events) {
      if (event.frame <= lastObservedEventFrame) continue;
      lastObservedEventFrame = Math.max(lastObservedEventFrame, event.frame);
      if (event.fighterId !== 1 - selfIndex) continue;
      habits.samples += 1;
      if (event.type === "throwTech") habits.throwTech += 1;
      else if (event.type === "bait" && event.baited === "reversal") habits.wakeupReversal += 1;
      else if (event.type === "moveStart" && event.tags?.includes?.("reversal")) habits.wakeupReversal += 1;
      else if (event.type === "contact" && event.outcome === "whiff") habits.whiff += 1;
      else if (event.type === "guard") habits[event.crouching ? "crouchGuard" : "standGuard"] += 1;
      else if (event.type === "jump") habits.jump += 1;
      else if (event.type === "wakeupAction" && event.action === "button") habits.wakeupMash += 1;
      else if (event.type === "wakeupAction" && event.action === "block") habits.wakeupBlock += 1;
    }
    if (habits.samples > 400) {
      for (const key of Object.keys(habits)) habits[key] *= 0.5;
    }
  }

  function getDebugState() {
    return { lastPlan, lastPlanFrame, habits: { ...habits } };
  }

  function habitRate(key) {
    return finite(habits[key]) / Math.max(1, finite(habits.samples));
  }

  function deterministicNoise() {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  }

  reset();
  return { plan, observe, reset, getDebugState };
}

function bestMove(moves, desiredTags, distance, fighter) {
  const desired = new Set(desiredTags);
  let best = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const tags = new Set([move.category, ...(move.tags ?? [])]);
    const matches = [...desired].reduce((count, tag) => count + (tags.has(tag) ? 1 : 0), 0);
    if (matches === 0) continue;
    const range = finite(move.range, estimatedRange(move));
    const reaches = range <= 0 || distance <= range * 1.18;
    const damageEfficiency = finite(move.damage) / Math.max(1, finite(move.startup) + finite(move.recovery) * 0.45);
    const costPenalty = resourceCommitment(fighter, move) * 7;
    const score = matches * 20 + damageEfficiency + (reaches ? 8 : -18) - costPenalty;
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }
  return best;
}

function estimatedRange(move) {
  const boxes = move?.hitboxes ?? move?.hits?.flatMap?.((hit) => hit.hitboxes ?? []) ?? [];
  return boxes.reduce((maximum, box) => {
    const reach = Math.abs(finite(box.offsetX)) + finite(box.width) / 2;
    return Math.max(maximum, reach);
  }, 0);
}

function resourceCommitment(fighter, move) {
  const cost = move?.resourceCost ?? move?.cost ?? {};
  const superRatio = finite(cost.super ?? cost.meter) / Math.max(1, finite(fighter?.maxSuperMeter, 300));
  const driveRatio = finite(cost.drive) / Math.max(1, finite(fighter?.maxDrive, 600));
  return superRatio + driveRatio;
}

function add(candidates, intent, move, score, reason) {
  candidates.push({ intent, moveId: move?.id ?? null, score, reason });
}

function neutralPlan(frame, reason) {
  return { frame, intent: "defend", moveId: null, score: 0, reason };
}

function isAttackName(action) {
  return /attack|light|medium|heavy|punch|kick|fireball|rekka|super|throw|shoryu|oniyaki/i.test(String(action ?? ""));
}

function difficultyValue(value) {
  return { easy: 0.25, normal: 0.55, hard: 0.78, expert: 0.94 }[String(value)] ?? 0.55;
}

function hashSeed(value) {
  let hash = Number(value) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
