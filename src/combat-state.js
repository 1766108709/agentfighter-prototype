export const COMBO_RULES = Object.freeze({
  defaultScalingStep: 0.1,
  minimumScaling: 0.1,
  superMinimumScaling: 0.4,
  hitstunDecayStartsAt: 8,
  maximumJugglePoints: 10,
  comboGraceFrames: 2,
});

export const KNOCKDOWN_TYPES = Object.freeze({
  soft: "soft",
  hard: "hard",
  launch: "launch",
  crumple: "crumple",
  groundBounce: "groundBounce",
  wallBounce: "wallBounce",
  none: "none",
});

export function initializeCombatState(fighter) {
  fighter.actionSerial = 0;
  fighter.hitRegistry = Object.create(null);
  fighter.lastContact = null;
  fighter.lastHitBy = null;
  fighter.counterState = null;
  fighter.comboOwner = null;
  fighter.comboCount = 0;
  fighter.comboDamage = 0;
  fighter.comboScaling = 1;
  fighter.comboGraceFrames = 0;
  fighter.jugglePoints = 0;
  fighter.knockdownType = KNOCKDOWN_TYPES.none;
  fighter.pendingTerminalKnockdownType = KNOCKDOWN_TYPES.none;
  fighter.quickRiseWindow = 0;
  fighter.delayedRiseFrames = 0;
  fighter.groundBouncesRemaining = 0;
  fighter.wallBouncesRemaining = 0;
  fighter.throwTechWindow = 0;
  return fighter;
}

export function beginActionCombatState(fighter) {
  fighter.actionSerial = (fighter.actionSerial ?? 0) + 1;
  fighter.hitRegistry = Object.create(null);
  fighter.lastContact = null;
  return fighter.actionSerial;
}

export function hitInstanceKey(attacker, defender, hitId = "main") {
  return `${attacker.actionSerial ?? 0}:${defender.id}:${String(hitId)}`;
}

export function canHitInstance(attacker, defender, hitId = "main") {
  return !attacker.hitRegistry?.[hitInstanceKey(attacker, defender, hitId)];
}

export function registerHitInstance(attacker, defender, hitId = "main") {
  if (!attacker.hitRegistry) attacker.hitRegistry = Object.create(null);
  const key = hitInstanceKey(attacker, defender, hitId);
  attacker.hitRegistry[key] = true;
  return key;
}

export function classifyCounterHit(defender) {
  const phase = defender?.movePhase ?? defender?.framePhase ?? defender?.phase;
  const attacking = Boolean(defender?.currentMove || defender?.isAttacking);
  if (attacking && phase === "recovery") return "punishCounter";
  if (attacking && (phase === "startup" || phase === "active" || phase === "gap")) return "counter";
  return "hit";
}

export function beginOrExtendCombo(attacker, defender, move, hit = {}) {
  const continuing = defender.comboOwner === attacker.id && comboCanContinue(defender);
  if (!continuing) {
    defender.comboOwner = attacker.id;
    defender.comboCount = 0;
    defender.comboDamage = 0;
    defender.comboScaling = clamp(hit.initialProration ?? move?.initialProration ?? 1, 0.1, 1);
    defender.jugglePoints = 0;
  }

  defender.comboCount += 1;
  const minimum = clamp(
    hit.minimumScaling ?? move?.minimumScaling ??
      (move?.category === "super" || move?.category === "climax"
        ? COMBO_RULES.superMinimumScaling
        : COMBO_RULES.minimumScaling),
    COMBO_RULES.minimumScaling,
    1,
  );
  const step = Math.max(0, finite(hit.scalingStep ?? move?.scalingStep, COMBO_RULES.defaultScalingStep));
  // A move's minimum scaling floors that move's damage only. It must not
  // restore the underlying combo scaling (for example a late super must not
  // turn a 20% combo back into a 40% combo for the move after it).
  const underlyingScale = defender.comboScaling;
  const scale = Math.max(minimum, underlyingScale);
  const counterType = hit.counterType ?? "hit";
  const counterMultiplier = counterType === "punishCounter" ? 1.2 : counterType === "counter" ? 1.1 : 1;
  const rawDamage = Math.max(0, finite(hit.damage ?? move?.damage));
  const damage = Math.max(rawDamage > 0 ? 1 : 0, Math.floor(rawDamage * scale * counterMultiplier));
  defender.comboDamage += damage;
  defender.comboScaling = Math.max(COMBO_RULES.minimumScaling, underlyingScale - step);
  defender.comboGraceFrames = COMBO_RULES.comboGraceFrames;

  attacker.comboCount = defender.comboCount;
  attacker.comboDamage = defender.comboDamage;
  attacker.comboScaling = defender.comboScaling;
  return {
    continuing,
    count: defender.comboCount,
    damage,
    totalDamage: defender.comboDamage,
    scaling: scale,
    nextScaling: defender.comboScaling,
    counterType,
  };
}

export function scaledHitstun(baseHitstun, comboCount, bonus = 0) {
  const decayHits = Math.max(0, finite(comboCount) - COMBO_RULES.hitstunDecayStartsAt);
  const multiplier = Math.max(0.55, 1 - decayHits * 0.035);
  return Math.max(1, Math.round((finite(baseHitstun) + finite(bonus)) * multiplier));
}

export function canJuggle(defender, hit = {}) {
  if (defender.onGround && defender.knockdownType !== KNOCKDOWN_TYPES.groundBounce) return true;
  const limit = finite(hit.juggleLimit, COMBO_RULES.maximumJugglePoints);
  return finite(defender.jugglePoints) + finite(hit.juggleCost, 1) <= limit;
}

export function consumeJuggle(defender, hit = {}) {
  defender.jugglePoints = finite(defender.jugglePoints) + Math.max(0, finite(hit.juggleCost, 1));
  return defender.jugglePoints;
}

export function applyHitReaction(defender, hit = {}, direction = 1) {
  const type = hit.knockdownType ?? (hit.knockdown ? KNOCKDOWN_TYPES.soft : KNOCKDOWN_TYPES.none);
  const terminalType = terminalKnockdownType(hit);
  defender.knockdownType = type;
  // Bounce resolution temporarily becomes `launch` so the defender remains
  // juggleable. Preserve the authored terminal separately until final landing.
  // A later authored knockdown supersedes any terminal left by an earlier hit.
  if (type !== KNOCKDOWN_TYPES.none) {
    defender.pendingTerminalKnockdownType = terminalType;
  }
  defender.vx = direction * finite(hit.launchX ?? hit.knockback, 4);
  if (type !== KNOCKDOWN_TYPES.none || hit.launchY != null) {
    defender.vy = finite(hit.launchY, -4.2);
    defender.onGround = false;
  }
  defender.groundBouncesRemaining = Math.max(
    defender.groundBouncesRemaining ?? 0,
    type === KNOCKDOWN_TYPES.groundBounce ? finite(hit.groundBounces, 1) : 0,
  );
  defender.wallBouncesRemaining = Math.max(
    defender.wallBouncesRemaining ?? 0,
    type === KNOCKDOWN_TYPES.wallBounce ? finite(hit.wallBounces, 1) : 0,
  );
  defender.quickRiseWindow = type === KNOCKDOWN_TYPES.soft ? finite(hit.quickRiseWindow, 8) : 0;
  defender.delayedRiseFrames = type === KNOCKDOWN_TYPES.soft ? finite(hit.maximumDelayRise, 18) : 0;
  return type;
}

export function resolveGroundContact(defender, arena, input = {}) {
  if (defender.y < arena.floorY) return { landed: false };
  defender.y = arena.floorY;
  if (defender.groundBouncesRemaining > 0) {
    defender.groundBouncesRemaining -= 1;
    defender.vy = -Math.max(4.5, Math.abs(finite(defender.vy)) * 0.72);
    defender.vx *= 0.78;
    defender.onGround = false;
    defender.knockdownType = KNOCKDOWN_TYPES.launch;
    return { landed: true, bounced: "ground" };
  }
  const terminalType = defender.pendingTerminalKnockdownType;
  if (terminalType && terminalType !== KNOCKDOWN_TYPES.none) {
    defender.knockdownType = terminalType;
  }
  defender.pendingTerminalKnockdownType = KNOCKDOWN_TYPES.none;
  defender.vy = 0;
  defender.onGround = true;
  const wakeup = chooseWakeupOption(defender, input);
  return { landed: true, bounced: null, wakeup };
}

export function resolveWallContact(defender, arena) {
  if (defender.wallBouncesRemaining <= 0 || defender.onGround) return false;
  const halfWidth = finite(defender.width, 46) / 2;
  const atLeft = defender.x <= arena.left + halfWidth;
  const atRight = defender.x >= arena.right - halfWidth;
  if (!atLeft && !atRight) return false;
  defender.wallBouncesRemaining -= 1;
  defender.x = atLeft ? arena.left + halfWidth : arena.right - halfWidth;
  defender.vx = (atLeft ? 1 : -1) * Math.max(4.5, Math.abs(finite(defender.vx)) * 0.8);
  defender.vy = Math.min(finite(defender.vy), -2.6);
  defender.knockdownType = KNOCKDOWN_TYPES.launch;
  return true;
}

export function chooseWakeupOption(fighter, input = {}) {
  if (fighter.knockdownType === KNOCKDOWN_TYPES.hard) return "hardRise";
  if (input.left || input.right) return "backRoll";
  if (input.lp || input.lk || input.light) return "quickRise";
  if (input.down && fighter.delayedRiseFrames > 0) return "delayRise";
  return "normalRise";
}

export function tickComboState(fighter) {
  if (comboCanContinue(fighter)) {
    fighter.comboGraceFrames = COMBO_RULES.comboGraceFrames;
    return false;
  }
  if ((fighter.comboGraceFrames ?? 0) > 0) {
    fighter.comboGraceFrames -= 1;
    return false;
  }
  return finishCombo(fighter);
}

export function finishCombo(defender) {
  if (!defender.comboCount) return false;
  defender.lastCombo = {
    owner: defender.comboOwner,
    count: defender.comboCount,
    damage: defender.comboDamage,
  };
  defender.comboOwner = null;
  defender.comboCount = 0;
  defender.comboDamage = 0;
  defender.comboScaling = 1;
  defender.jugglePoints = 0;
  return true;
}

function comboCanContinue(fighter) {
  return (
    finite(fighter.hitstunFrames ?? fighter.hitstun) > 0 ||
    !fighter.onGround ||
    fighter.action === "knockdown" ||
    fighter.knockdownType === KNOCKDOWN_TYPES.crumple ||
    fighter.knockdownType === KNOCKDOWN_TYPES.groundBounce ||
    fighter.knockdownType === KNOCKDOWN_TYPES.wallBounce
  );
}

function terminalKnockdownType(hit) {
  const terminal = String(hit.terminalKnockdownType ?? hit.terminal ?? hit.knockdown?.terminal ?? "").toLowerCase();
  if (terminal === "hard" || terminal === "hkd") return KNOCKDOWN_TYPES.hard;
  if (terminal === "soft" || terminal === "skd" || terminal === "normal") return KNOCKDOWN_TYPES.soft;
  return KNOCKDOWN_TYPES.none;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, finite(value)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
