export const RESOURCE_RULES = Object.freeze({
  vanguard: Object.freeze({
    superMax: 300,
    driveMax: 600,
    guardMax: 100,
    driveRegenPerFrame: 0.7,
    driveRegenDelay: 90,
  }),
  ember: Object.freeze({
    superMax: 500,
    driveMax: 0,
    guardMax: 100,
    driveRegenPerFrame: 0,
    driveRegenDelay: 0,
  }),
});

export function initializeFighterResources(fighter, templateId, options = {}) {
  const rules = RESOURCE_RULES[templateId] ?? RESOURCE_RULES.vanguard;
  fighter.maxSuperMeter = rules.superMax;
  fighter.superMeter = clampResource(options.superMeter ?? options.startingSuperMeter ?? 0, rules.superMax);
  fighter.maxDrive = rules.driveMax;
  fighter.drive = clampResource(options.drive ?? options.startingDrive ?? rules.driveMax, rules.driveMax);
  fighter.maxGuardGauge = rules.guardMax;
  fighter.guardGauge = clampResource(options.guardGauge ?? rules.guardMax, rules.guardMax);
  fighter.driveRegenLockFrames = 0;
  fighter.guardRegenLockFrames = 0;
  fighter.burnout = rules.driveMax > 0 && fighter.drive <= 0;
  syncLegacyEnergy(fighter);
  return fighter;
}

export function resourceCost(move) {
  const value = move?.resourceCost ?? move?.cost ?? {};
  return {
    super: Math.max(0, finite(value.super ?? value.meter ?? value.power)),
    drive: Math.max(0, finite(value.drive)),
    guard: Math.max(0, finite(value.guard)),
  };
}

export function canAffordMove(fighter, move) {
  const cost = resourceCost(move);
  return (
    finite(fighter?.superMeter) >= cost.super &&
    finite(fighter?.drive) >= cost.drive &&
    finite(fighter?.guardGauge) >= cost.guard
  );
}

export function spendMoveCost(fighter, move) {
  if (!canAffordMove(fighter, move)) return false;
  const cost = resourceCost(move);
  fighter.superMeter = Math.max(0, finite(fighter.superMeter) - cost.super);
  fighter.drive = Math.max(0, finite(fighter.drive) - cost.drive);
  fighter.guardGauge = Math.max(0, finite(fighter.guardGauge) - cost.guard);
  if (cost.drive > 0) fighter.driveRegenLockFrames = Math.max(fighter.driveRegenLockFrames ?? 0, 90);
  if (cost.guard > 0) fighter.guardRegenLockFrames = Math.max(fighter.guardRegenLockFrames ?? 0, 120);
  fighter.burnout = finite(fighter.maxDrive) > 0 && fighter.drive <= 0;
  syncLegacyEnergy(fighter);
  return true;
}

export function gainSuperMeter(fighter, amount) {
  const maximum = Math.max(0, finite(fighter?.maxSuperMeter));
  fighter.superMeter = clampResource(finite(fighter?.superMeter) + Math.max(0, finite(amount)), maximum);
  syncLegacyEnergy(fighter);
  return fighter.superMeter;
}

export function changeDrive(fighter, amount, regenLockFrames = 0) {
  const maximum = Math.max(0, finite(fighter?.maxDrive));
  if (maximum <= 0) return 0;
  fighter.drive = clampResource(finite(fighter?.drive) + finite(amount), maximum);
  fighter.driveRegenLockFrames = Math.max(fighter.driveRegenLockFrames ?? 0, regenLockFrames);
  fighter.burnout = fighter.drive <= 0;
  return fighter.drive;
}

export function damageGuardGauge(fighter, amount) {
  const maximum = Math.max(0, finite(fighter?.maxGuardGauge, 100));
  fighter.guardGauge = clampResource(finite(fighter?.guardGauge, maximum) - Math.max(0, finite(amount)), maximum);
  fighter.guardRegenLockFrames = Math.max(fighter.guardRegenLockFrames ?? 0, 150);
  return fighter.guardGauge;
}

export function tickFighterResources(fighter, templateId) {
  const rules = RESOURCE_RULES[templateId] ?? RESOURCE_RULES.vanguard;
  if ((fighter.driveRegenLockFrames ?? 0) > 0) {
    fighter.driveRegenLockFrames -= 1;
  } else if (rules.driveMax > 0 && fighter.drive < rules.driveMax) {
    const burnoutModifier = fighter.burnout ? 0.55 : 1;
    fighter.drive = Math.min(rules.driveMax, fighter.drive + rules.driveRegenPerFrame * burnoutModifier);
    if (fighter.drive >= rules.driveMax) fighter.burnout = false;
  }

  if ((fighter.guardRegenLockFrames ?? 0) > 0) {
    fighter.guardRegenLockFrames -= 1;
  } else if (fighter.guardGauge < rules.guardMax) {
    fighter.guardGauge = Math.min(rules.guardMax, fighter.guardGauge + 0.18);
  }
  syncLegacyEnergy(fighter);
}

export function awardContactResources(attacker, defender, move, outcome, currentHit = null) {
  const landedHit = outcome === "hit" || outcome === "counter" || outcome === "punishCounter";
  const attackerGain = landedHit
    ? finite(move?.meterGain ?? move?.superGainOnHit, 8)
    : finite(move?.meterOnBlock ?? move?.superGainOnBlock, 4);
  gainSuperMeter(attacker, attackerGain);
  const contactDamage = finite(currentHit?.damage, finite(move?.damage));
  gainSuperMeter(defender, landedHit ? Math.max(2, contactDamage / 40) : 2);

  if (attacker?.templateId === "vanguard") {
    changeDrive(attacker, landedHit ? 12 : 5);
    changeDrive(defender, landedHit ? -10 : -finite(move?.driveDamageOnBlock, 18), 90);
  } else if (!landedHit) {
    damageGuardGauge(defender, finite(move?.guardDamage, 5));
  }
}

export function resourceSnapshot(fighter) {
  return {
    super: finite(fighter?.superMeter),
    superMax: finite(fighter?.maxSuperMeter),
    drive: finite(fighter?.drive),
    driveMax: finite(fighter?.maxDrive),
    guard: finite(fighter?.guardGauge),
    guardMax: finite(fighter?.maxGuardGauge),
    burnout: Boolean(fighter?.burnout),
  };
}

function syncLegacyEnergy(fighter) {
  fighter.maxEnergy = Math.max(1, finite(fighter.maxSuperMeter, 300));
  fighter.energy = clampResource(finite(fighter.superMeter), fighter.maxEnergy);
}

function clampResource(value, maximum) {
  return Math.max(0, Math.min(Math.max(0, finite(maximum)), finite(value)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
