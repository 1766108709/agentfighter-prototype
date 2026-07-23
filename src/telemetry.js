const MAX_EVENTS = 512;

export function initializeTelemetry(game) {
  game.combatEvents = [];
  game.telemetry = {
    moveStarts: [{}, {}],
    intents: [{}, {}],
    outcomes: [{}, {}],
    comboCount: [0, 0],
    longestCombo: [0, 0],
    maximumComboDamage: [0, 0],
    supers: [0, 0],
    exMoves: [0, 0],
    throws: [0, 0],
    throwTechs: [0, 0],
    counters: [0, 0],
    punishCounters: [0, 0],
    whiffPunishes: [0, 0],
    baits: [0, 0],
    tods: [0, 0],
  };
  return game.telemetry;
}

export function recordCombatEvent(game, type, data = {}) {
  if (!game.telemetry) initializeTelemetry(game);
  const event = { frame: game.frame ?? 0, type, ...data };
  game.combatEvents.push(event);
  if (game.combatEvents.length > MAX_EVENTS) game.combatEvents.splice(0, game.combatEvents.length - MAX_EVENTS);
  applyCounter(game.telemetry, event);
  return event;
}

export function recordMoveStart(game, fighter, move) {
  return recordCombatEvent(game, "moveStart", {
    fighterId: fighter.id,
    moveId: move.id,
    category: move.category,
    resourceCost: move.resourceCost ?? move.cost ?? null,
  });
}

export function recordIntent(game, fighterId, intent, reason = "") {
  return recordCombatEvent(game, "intent", { fighterId, intent, reason });
}

export function recordComboEnd(game, attackerId, combo) {
  const defender = game.fighters?.[1 - attackerId];
  const evidence = {
    fighterId: attackerId,
    count: combo.count,
    damage: combo.damage,
    comboId: combo.comboId ?? null,
    startHealth: finiteNumber(combo.startHealth, defender?.comboStartHealth),
    endHealth: finiteNumber(combo.endHealth, defender?.health),
    maxHealth: finiteNumber(combo.maxHealth, defender?.maxHealth),
    appliedDamage: finiteNumber(combo.appliedDamage, defender?.comboAppliedDamage),
    forcedDamage: finiteNumber(combo.forcedDamage, defender?.comboForcedDamage, 0),
    damageSource: combo.damageSource ?? (finiteNumber(combo.forcedDamage, defender?.comboForcedDamage, 0) > 0 ? "mixed" : "standard"),
    continuous: combo.continuous === true,
  };
  return recordCombatEvent(game, "comboEnd", {
    ...evidence,
    tod: isNaturalTodEvidence(evidence),
  });
}

/**
 * A TOD is evidence about one uninterrupted combo, not merely a large damage
 * number.  In particular, theoretical overkill and route-specific HP writes
 * cannot satisfy this predicate: the damage actually removed from the
 * defender must account for their complete, full life bar.
 */
export function isNaturalTodEvidence(evidence = {}) {
  const maxHealth = finiteNumber(evidence.maxHealth);
  const startHealth = finiteNumber(evidence.startHealth);
  const endHealth = finiteNumber(evidence.endHealth);
  const appliedDamage = finiteNumber(evidence.appliedDamage);
  const forcedDamage = finiteNumber(evidence.forcedDamage, 0);
  const count = finiteNumber(evidence.count, 0);
  return Boolean(evidence.comboId)
    && evidence.continuous === true
    && count > 0
    && maxHealth > 0
    && startHealth === maxHealth
    && endHealth === 0
    && appliedDamage === maxHealth
    && forcedDamage === 0;
}

export function recentCombatEvents(game, predicate, maximum = 32) {
  const events = game?.combatEvents ?? [];
  const filtered = typeof predicate === "function" ? events.filter(predicate) : events;
  return filtered.slice(-Math.max(0, maximum));
}

export function telemetrySnapshot(game) {
  return JSON.parse(JSON.stringify(game?.telemetry ?? {}));
}

function applyCounter(telemetry, event) {
  const index = event.fighterId;
  if (index !== 0 && index !== 1) return;
  if (event.type === "moveStart") {
    increment(telemetry.moveStarts[index], event.moveId);
    if (event.category === "super" || event.category === "climax") telemetry.supers[index] += 1;
    if (event.category === "od") telemetry.exMoves[index] += 1;
  } else if (event.type === "intent") {
    increment(telemetry.intents[index], event.intent);
  } else if (event.type === "contact") {
    increment(telemetry.outcomes[index], event.outcome);
    if (event.outcome === "counter") telemetry.counters[index] += 1;
    if (event.outcome === "punishCounter") telemetry.punishCounters[index] += 1;
    if (event.whiffPunish) telemetry.whiffPunishes[index] += 1;
  } else if (event.type === "throw") {
    telemetry.throws[index] += 1;
  } else if (event.type === "throwTech") {
    telemetry.throwTechs[index] += 1;
  } else if (event.type === "bait") {
    telemetry.baits[index] += 1;
  } else if (event.type === "comboEnd") {
    telemetry.comboCount[index] += 1;
    telemetry.longestCombo[index] = Math.max(telemetry.longestCombo[index], event.count ?? 0);
    telemetry.maximumComboDamage[index] = Math.max(telemetry.maximumComboDamage[index], event.damage ?? 0);
    if (event.tod) telemetry.tods[index] += 1;
  }
}

function increment(record, key) {
  if (!key) return;
  record[key] = (record[key] ?? 0) + 1;
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}
