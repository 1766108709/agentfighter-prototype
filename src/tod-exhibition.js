import { neutralInput } from "./input.js";

export const TOD_EXHIBITION_ROUTE_LABEL = "c.C → 3D → QUICK MAX → YAKUMO";

const ROUTE_STEPS = Object.freeze({
  intro: "满血 · 满资源 · 角落就位",
  closeC: "STEP 1/4 · c.C 起手",
  waitCloseC: "STEP 1/4 · c.C 命中确认",
  shiki88: "STEP 2/4 · 3D 两段确认",
  waitShiki88: "STEP 2/4 · 3D 两段确认",
  quickMax: "STEP 3/4 · QUICK MAX",
  waitYakumo: "STEP 4/4 · YAKUMO 启动",
  yakumo: "STEP 4/4 · YAKUMO",
  verify: "逐击验真中",
  complete: "十割成立",
  failed: "路线失败",
});

const QCB_HCF_BUFFER = Object.freeze([
  { direction: "down", buttons: { lk: true, hp: true } },
  { direction: "downBack" },
  { direction: "back" },
  { direction: "downBack" },
  { direction: "down" },
  { direction: "downForward" },
  { direction: "forward" },
  { direction: "neutral" },
  { direction: "forward", buttons: { hp: true, hk: true } },
]);

export function prepareTodExhibition(game) {
  game.presentationMode = "tod-exhibition";
  const attacker = game.fighters[0];
  const defender = game.fighters[1];
  const right = game.arena.right - defender.width / 2;
  attacker.x = right - 65;
  attacker.prevX = attacker.x;
  defender.x = right;
  defender.prevX = defender.x;
  attacker.facing = 1;
  defender.facing = -1;
  attacker.superMeter = attacker.maxSuperMeter;
  attacker.maxModeFrames = 0;
  defender.health = defender.maxHealth;
  defender.recoverableHealth = 0;
  return game;
}

export function createTodExhibitionDirector({ introFrames = 54, stageTimeout = 300 } = {}) {
  let stage = "intro";
  let stageFrames = 0;
  let introRemaining = Math.max(1, introFrames);
  let commandQueue = [];
  let failedReason = "";

  function changeStage(next) {
    stage = next;
    stageFrames = 0;
  }

  function fail(reason) {
    failedReason = reason;
    changeStage("failed");
    return neutralInput();
  }

  function next(game) {
    if (!game || game.phase !== "fighting" || stage === "failed" || stage === "complete") return neutralInput();
    stageFrames += 1;
    if (stageFrames > stageTimeout) return fail(`${ROUTE_STEPS[stage] ?? stage} 超时`);

    if (stage === "intro") {
      introRemaining -= 1;
      if (introRemaining <= 0) changeStage("closeC");
      return neutralInput();
    }

    if (stage === "closeC") {
      changeStage("waitCloseC");
      return { hp: true };
    }

    if (stage === "waitCloseC") {
      if (hasDamagingContact(game, "closeC")) {
        changeStage("shiki88");
        return relativeInput(game.fighters[0].facing, "downForward", { hk: true });
      }
      return neutralInput();
    }

    if (stage === "shiki88") {
      changeStage("waitShiki88");
      return neutralInput();
    }

    if (stage === "waitShiki88") {
      if (contactCount(game, "shiki88Canceled") >= 2) {
        commandQueue = [...QCB_HCF_BUFFER];
        changeStage("quickMax");
      } else {
        return neutralInput();
      }
    }

    if (stage === "quickMax") {
      const command = commandQueue.shift();
      if (command) return relativeInput(game.fighters[0].facing, command.direction, command.buttons);
      changeStage("waitYakumo");
      return neutralInput();
    }

    if (stage === "waitYakumo") {
      if (hasMoveStart(game, "yakumo")) changeStage("yakumo");
      return neutralInput();
    }

    if (stage === "yakumo") {
      if (contactCount(game, "yakumo") >= 13) changeStage("verify");
      return neutralInput();
    }

    if (stage === "verify") {
      const result = evaluateTodExhibition(game);
      if (result.success) changeStage("complete");
      else if (game.phase !== "fighting" || game.fighters[1].health <= 0) return fail(result.reason || "验真失败");
      return neutralInput();
    }

    return neutralInput();
  }

  function status(game) {
    const proof = evaluateTodExhibition(game);
    const combo = game?.combos?.[0] ?? {};
    const displayStage = proof.success ? "complete" : stage;
    return {
      stage: displayStage,
      label: ROUTE_STEPS[displayStage] ?? ROUTE_STEPS.waitCloseC,
      failedReason,
      hits: proof.hits || combo.hits || 0,
      damage: proof.damage || Math.min(game?.fighters?.[1]?.maxHealth ?? 0, combo.damage || 0),
      success: proof.success,
      reason: proof.reason,
    };
  }

  return { next, status };
}

export function evaluateTodExhibition(game) {
  const defender = game?.fighters?.[1];
  const contacts = (game?.combatEvents ?? []).filter((event) =>
    event.type === "contact" && event.fighterId === 0 && Number(event.appliedDamage) > 0
  );
  const comboEnd = [...(game?.combatEvents ?? [])].reverse().find((event) =>
    event.type === "comboEnd" && event.fighterId === 0
  );
  const moveStarts = (game?.combatEvents ?? []).filter((event) => event.type === "moveStart" && event.fighterId === 0);
  const quickMaxStart = moveStarts.find((event) => event.moveId === "quickMax");
  const yakumoStart = moveStarts.find((event) => event.moveId === "yakumo");
  const appliedDamage = contacts.reduce((sum, event) => sum + Number(event.appliedDamage || 0), 0);
  const standardDamage = contacts.every((event) => event.damageSource === "standard" && Number(event.forcedDamage || 0) === 0);
  const yakumoContacts = contacts.filter((event) => event.moveId === "yakumo");
  const starterMoveIds = contacts.slice(0, 3).map((event) => event.moveId);
  const authoredStarter = starterMoveIds.length === 3 &&
    starterMoveIds[0] === "closeC" &&
    starterMoveIds[1] === "shiki88Canceled" &&
    starterMoveIds[2] === "shiki88Canceled";
  const fullLife = Number(comboEnd?.startHealth) === Number(comboEnd?.maxHealth) && Number(comboEnd?.endHealth) === 0;
  const singleCombo = contacts.length > 0 &&
    new Set(contacts.map((event) => event.comboId)).size === 1 &&
    (!comboEnd?.comboId || contacts.every((event) => event.comboId === comboEnd.comboId));
  const legalResourceRoute = Boolean(
    quickMaxStart && yakumoStart &&
    Number(quickMaxStart.frame) < Number(yakumoStart.frame) &&
    yakumoContacts.length === 13 &&
    yakumoContacts.every((event) => Math.abs(Number(event.damageModifier) - 2.125) < 1e-9)
  );
  const success = Boolean(
    comboEnd?.tod &&
    comboEnd?.continuous &&
    fullLife &&
    standardDamage &&
    singleCombo &&
    authoredStarter &&
    legalResourceRoute &&
    Number(comboEnd.count) === 16 &&
    Number(comboEnd.appliedDamage) === Number(comboEnd.maxHealth) &&
    defender?.health === 0
  );
  let reason = "等待完整路线";
  if (success) reason = "满血起手 · 连段未断 · 无强制补伤";
  else if (comboEnd && !fullLife) reason = "不是满血起手的连续击杀";
  else if (!standardDamage) reason = "检测到非标准伤害";
  else if (comboEnd && !singleCombo) reason = "命中记录不属于同一连续连段";
  else if (comboEnd && !authoredStarter) reason = "起手不是 c.C → 3D 两段";
  else if (comboEnd && !legalResourceRoute) reason = "Quick MAX 或 Climax 资源路线不完整";
  else if (defender?.health === 0 && !comboEnd?.tod) reason = "KO 未通过自然十割验真";
  else if (comboEnd && Number(comboEnd.appliedDamage) !== Number(comboEnd.maxHealth)) reason = "实际扣血未覆盖完整生命值";
  return {
    success,
    reason,
    hits: Number(comboEnd?.count ?? contacts.at(-1)?.comboCount ?? 0),
    damage: Number(comboEnd?.appliedDamage ?? appliedDamage),
    maxHealth: Number(defender?.maxHealth ?? 0),
    contacts,
    comboEnd,
    quickMaxStart,
    yakumoStart,
    legalResourceRoute,
    authoredStarter,
  };
}

function hasMoveStart(game, moveId) {
  return (game.combatEvents ?? []).some((event) => event.type === "moveStart" && event.fighterId === 0 && event.moveId === moveId);
}

function hasDamagingContact(game, moveId) {
  return (game.combatEvents ?? []).some((event) => event.type === "contact" && event.fighterId === 0 && event.moveId === moveId && Number(event.appliedDamage ?? event.damage) > 0);
}

function contactCount(game, moveId) {
  return (game.combatEvents ?? []).filter((event) => event.type === "contact" && event.fighterId === 0 && event.moveId === moveId && Number(event.appliedDamage ?? event.damage) > 0).length;
}

function relativeInput(facing, direction, buttons = {}) {
  const input = { ...buttons };
  if (direction.includes("down")) input.down = true;
  if (direction.includes("up")) input.up = true;
  const forward = direction.includes("Forward") || direction === "forward";
  const back = direction.includes("Back") || direction === "back";
  if (forward || back) {
    const sign = (forward ? 1 : -1) * facing;
    input[sign > 0 ? "right" : "left"] = true;
  }
  return input;
}
