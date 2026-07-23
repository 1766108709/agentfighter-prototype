import {
  EMPTY_COMBAT_INPUT,
  ATTACK_BUTTONS,
  normalizeCombatInput,
  pressedCombatButtons,
  relativeDirection,
  axis,
} from "./input-schema.js";
import {
  recordDirection,
  matchMotion,
  matchCommandInput,
  clearConsumedMotion,
} from "./command-resolver.js";
import {
  initializeFighterResources,
  canAffordMove,
  spendMoveCost,
  tickFighterResources,
  awardContactResources,
  gainSuperMeter,
  changeDrive,
  damageGuardGauge,
} from "./resources.js";
import {
  KNOCKDOWN_TYPES,
  initializeCombatState,
  beginActionCombatState,
  canHitInstance,
  registerHitInstance,
  classifyCounterHit,
  beginOrExtendCombo,
  scaledHitstun,
  canJuggle,
  consumeJuggle,
  applyHitReaction,
  resolveGroundContact,
  resolveWallContact,
  chooseWakeupOption,
  tickComboState,
} from "./combat-state.js";
import {
  initializeTelemetry,
  recordCombatEvent,
  recordMoveStart,
  recordComboEnd,
} from "./telemetry.js";
import { VANGUARD_MOVESET } from "./movesets/vanguard.js";
import { EMBER_MOVESET } from "./movesets/ember.js";

export const TICK_RATE = 60;

const DEFAULTS = Object.freeze({
  width: 1280,
  height: 720,
  floorOffset: 130,
  sidePadding: 80,
  roundSeconds: 60,
  bestOf: 3,
  maxHealth: 1000,
  walkSpeed: 5,
  backWalkSpeed: 4.2,
  airSpeed: 3.2,
  jumpSpeed: 12.2,
  hopSpeed: 9.4,
  gravity: 0.66,
  fighterWidth: 46,
  fighterHeight: 112,
  inputBufferFrames: 10,
});

const LOCOMOTION_ACTIONS = new Set([
  "idle", "walk", "crouch", "jump", "landingRecovery", "block", "hit",
  "knockdown", "throwWhiff", "guardBreak", "ko",
]);
const IMMOBILE_ACTIONS = new Set(["hit", "knockdown", "guardBreak", "ko"]);
const BOX_REFERENCE_HEIGHT = 112;
const REVERSAL_BUFFER_FRAMES = 6;
const DRIVE_RUSH_ADVANTAGE_FRAMES = 4;

const BASE_MOVESETS = Object.freeze({
  vanguard: VANGUARD_MOVESET,
  ember: EMBER_MOVESET,
});

function exposeMoveset(moveset) {
  const aliases = Object.fromEntries(
    Object.entries(moveset.aliases ?? {}).map(([alias, target]) => [alias, moveset.moves[target]]),
  );
  return Object.freeze({ ...moveset, ...moveset.moves, ...aliases });
}

/**
 * Public movesets expose both the v0.7 schema (`moves`, `catalog`, `aliases`)
 * and flattened move properties for older integrations.
 */
export const MOVESETS = Object.freeze({
  vanguard: exposeMoveset(VANGUARD_MOVESET),
  ember: exposeMoveset(EMBER_MOVESET),
});

export const CHARACTER_TEMPLATES = Object.freeze({
  vanguard: Object.freeze({
    id: "vanguard",
    name: VANGUARD_MOVESET.name,
    archetype: VANGUARD_MOVESET.archetype,
    controlLayout: "sixButton",
    moves: Object.keys(VANGUARD_MOVESET.moves),
  }),
  ember: Object.freeze({
    id: "ember",
    name: EMBER_MOVESET.name,
    archetype: EMBER_MOVESET.archetype,
    controlLayout: "fourButton",
    moves: Object.keys(EMBER_MOVESET.moves),
  }),
});

export function getMoveData(templateId, action) {
  const moveset = BASE_MOVESETS[normalizeTemplateId(templateId)];
  if (!moveset || !action) return null;
  const id = moveset.aliases?.[action] ?? action;
  return moveset.moves[id] ?? null;
}

const compatibilityMoves = {};
for (const [id, move] of Object.entries(VANGUARD_MOVESET.moves)) compatibilityMoves[id] = move;
for (const [alias, target] of Object.entries(VANGUARD_MOVESET.aliases ?? {})) {
  compatibilityMoves[alias] = VANGUARD_MOVESET.moves[target];
}
for (const alias of ["rekkaLight", "rekkaHeavy", "airHammer"]) {
  const target = EMBER_MOVESET.aliases?.[alias];
  if (target) compatibilityMoves[alias] = EMBER_MOVESET.moves[target];
}
compatibilityMoves.light = compatibilityMoves.highLight;
compatibilityMoves.heavy = compatibilityMoves.highHeavy;
compatibilityMoves.special = compatibilityMoves.throw;
export const MOVES = Object.freeze(compatibilityMoves);

export function createGame(options = {}) {
  const config = normalizeOptions(options);
  const arena = createArena(config);
  const game = {
    tickRate: TICK_RATE,
    version: "0.7",
    config,
    arena,
    fighters: [],
    projectiles: [],
    effects: [],
    frame: 0,
    roundFrame: 0,
    timerFrames: config.roundSeconds * TICK_RATE,
    phase: "fighting",
    roundNumber: 1,
    round: 1,
    roundWinner: null,
    roundReason: null,
    matchWinner: null,
    score: [0, 0],
    hitstopFrames: 0,
    nextProjectileId: 1,
    nextEffectId: 1,
    nextComboId: 1,
    hitboxes: [],
    frameData: [],
    combos: [{ hits: 0, damage: 0, active: false }, { hits: 0, damage: 0, active: false }],
    aiDebug: [{}, {}],
  };
  game.fighters = [
    createFighter(0, config.players[0], arena, config, 0),
    createFighter(1, config.players[1], arena, config, 0),
  ];
  initializeTelemetry(game);
  refreshCombatSnapshot(game);
  return game;
}

export function stepGame(game, inputFrames = {}) {
  assertGame(game);
  const inputs = [
    normalizeEngineInput(inputFrames.p1),
    normalizeEngineInput(inputFrames.p2),
  ];

  game.frame += 1;
  snapshotPreviousPositions(game);
  updateEffects(game);
  captureInput(game, game.fighters[0], inputs[0]);
  captureInput(game, game.fighters[1], inputs[1]);

  if (game.phase !== "fighting") {
    refreshCombatSnapshot(game);
    return game;
  }

  if (game.hitstopFrames > 0) {
    game.hitstopFrames -= 1;
    tickCommandBuffers(game.fighters);
    refreshCombatSnapshot(game);
    return game;
  }

  game.roundFrame += 1;
  game.timerFrames = Math.max(0, game.timerFrames - 1);
  refreshFacing(game.fighters);

  for (let index = 0; index < 2; index += 1) {
    const fighter = game.fighters[index];
    tickFighterResources(fighter, fighter.templateId);
    tickFighterTimers(fighter);
    updateFighter(game, fighter, inputs[index]);
  }

  updateProjectiles(game);
  resolveStageAndPushboxes(game);
  refreshFacing(game.fighters);
  resolveProjectileClashes(game);
  const contacts = collectContacts(game, inputs);
  resolveContacts(game, contacts, inputs);
  resolvePostContactCancels(game);
  resolveStageAndPushboxes(game);
  refreshFacing(game.fighters);
  finishExpiredCombos(game);
  tickCommandBuffers(game.fighters);

  if (game.fighters[0].health <= 0 || game.fighters[1].health <= 0) {
    finishRoundFromHealth(game, "ko");
  } else if (game.timerFrames <= 0) {
    finishRoundOnTime(game);
  }

  refreshCombatSnapshot(game);
  return game;
}

export function nextRound(game) {
  assertGame(game);
  if (game.phase !== "roundOver" || game.matchWinner !== null) return game;
  const score = [...game.score];
  game.roundNumber += 1;
  game.round = game.roundNumber;
  game.roundFrame = 0;
  game.timerFrames = game.config.roundSeconds * TICK_RATE;
  game.roundWinner = null;
  game.roundReason = null;
  game.hitstopFrames = 0;
  game.projectiles = [];
  game.effects = [];
  game.nextProjectileId = 1;
  game.nextEffectId = 1;
  game.nextComboId = 1;
  game.fighters = [
    createFighter(0, game.config.players[0], game.arena, game.config, score[0]),
    createFighter(1, game.config.players[1], game.arena, game.config, score[1]),
  ];
  game.combos = [{ hits: 0, damage: 0, active: false }, { hits: 0, damage: 0, active: false }];
  initializeTelemetry(game);
  game.phase = "fighting";
  refreshCombatSnapshot(game);
  return game;
}

export function restartMatch(game) {
  assertGame(game);
  const fresh = createGame(game.config);
  for (const key of Object.keys(game)) delete game[key];
  Object.assign(game, fresh);
  return game;
}

function normalizeOptions(options) {
  const arenaOptions = options.arena ?? {};
  const width = finiteNumber(arenaOptions.width ?? options.width, DEFAULTS.width, 480, 1920);
  const height = finiteNumber(arenaOptions.height ?? options.height, DEFAULTS.height, 320, 1080);
  const floorY = finiteNumber(
    arenaOptions.floorY ?? options.floorY,
    height - DEFAULTS.floorOffset,
    height * 0.55,
    height - 24,
  );
  const sidePadding = finiteNumber(
    arenaOptions.sidePadding ?? options.sidePadding,
    DEFAULTS.sidePadding,
    16,
    width * 0.2,
  );
  let bestOf = Math.max(1, Math.floor(finiteNumber(options.bestOf, DEFAULTS.bestOf, 1, 9)));
  if (bestOf % 2 === 0) bestOf += 1;
  const playerInput = options.players ?? options.fighters ?? [];
  const p1 = playerInput[0] ?? options.p1 ?? {};
  const p2 = playerInput[1] ?? options.p2 ?? {};
  const p1Template = normalizeTemplateId(p1.templateId ?? p1.template ?? options.playerTemplate);
  const p2Template = normalizeTemplateId(p2.templateId ?? p2.template ?? options.aiTemplate ?? "ember");
  const defaultHealth = finiteNumber(options.maxHealth, DEFAULTS.maxHealth, 100, 10000);
  const config = {
    width,
    height,
    floorY,
    sidePadding,
    roundSeconds: Math.floor(finiteNumber(options.roundSeconds ?? options.roundTimeSeconds, DEFAULTS.roundSeconds, 10, 300)),
    bestOf,
    winsNeeded: Math.floor(bestOf / 2) + 1,
    maxHealth: Math.floor(defaultHealth),
    walkSpeed: finiteNumber(options.walkSpeed, DEFAULTS.walkSpeed, 1, 14),
    backWalkSpeed: finiteNumber(options.backWalkSpeed, DEFAULTS.backWalkSpeed, 1, 14),
    airSpeed: finiteNumber(options.airSpeed, DEFAULTS.airSpeed, 0, 10),
    jumpSpeed: finiteNumber(options.jumpSpeed, DEFAULTS.jumpSpeed, 5, 24),
    hopSpeed: finiteNumber(options.hopSpeed, DEFAULTS.hopSpeed, 4, 18),
    gravity: finiteNumber(options.gravity, DEFAULTS.gravity, 0.2, 2),
    fighterWidth: finiteNumber(options.fighterWidth, DEFAULTS.fighterWidth, 24, 90),
    fighterHeight: finiteNumber(options.fighterHeight, DEFAULTS.fighterHeight, 64, 180),
    inputBufferFrames: Math.floor(finiteNumber(options.inputBufferFrames, DEFAULTS.inputBufferFrames, 2, 30)),
    startingSuperMeter: finiteNumber(options.startingSuperMeter, 0, 0, 500),
    startingDrive: options.startingDrive,
    trainingResources: Boolean(options.trainingResources),
    players: [],
  };
  config.players = [
    normalizePlayer(p1, {
      name: options.playerName ?? "PLAYER",
      color: options.playerColor ?? "#62e7ff",
      accent: options.playerAccent ?? "#d9fbff",
      templateId: p1Template,
      maxHealth: p1.maxHealth ?? config.maxHealth,
      startingSuperMeter: p1.superMeter ?? p1.startingSuperMeter ?? config.startingSuperMeter,
      startingDrive: p1.drive ?? p1.startingDrive ?? config.startingDrive,
    }),
    normalizePlayer(p2, {
      name: options.aiName ?? "AGENT",
      color: options.aiColor ?? "#ff5f8f",
      accent: options.aiAccent ?? "#ffe0e9",
      templateId: p2Template,
      maxHealth: p2.maxHealth ?? config.maxHealth,
      startingSuperMeter: p2.superMeter ?? p2.startingSuperMeter ?? config.startingSuperMeter,
      startingDrive: p2.drive ?? p2.startingDrive ?? config.startingDrive,
    }),
  ];
  return config;
}

function normalizePlayer(value, fallback) {
  const templateId = normalizeTemplateId(value.templateId ?? value.template ?? fallback.templateId);
  return {
    name: String(value.name ?? fallback.name),
    color: String(value.color ?? fallback.color),
    accent: String(value.accent ?? fallback.accent),
    templateId,
    templateName: CHARACTER_TEMPLATES[templateId].name,
    maxHealth: Math.floor(finiteNumber(value.maxHealth ?? fallback.maxHealth, DEFAULTS.maxHealth, 100, 10000)),
    startingSuperMeter: finiteNumber(value.superMeter ?? value.startingSuperMeter ?? fallback.startingSuperMeter, 0, 0, 500),
    startingDrive: value.drive ?? value.startingDrive ?? fallback.startingDrive,
  };
}

function normalizeTemplateId(value) {
  const raw = value && typeof value === "object" ? value.id ?? value.templateId : value;
  const id = String(raw ?? "vanguard").toLowerCase();
  return BASE_MOVESETS[id] ? id : "vanguard";
}

function createArena(config) {
  return {
    width: config.width,
    height: config.height,
    floorY: config.floorY,
    groundY: config.floorY,
    left: config.sidePadding,
    right: config.width - config.sidePadding,
    top: 110,
    centerX: config.width / 2,
  };
}

function createFighter(id, player, arena, config, roundsWon) {
  const x = id === 0 ? arena.width * 0.3 : arena.width * 0.7;
  const fighter = {
    id,
    name: player.name,
    color: player.color,
    accent: player.accent,
    templateId: player.templateId,
    templateName: player.templateName,
    template: player.templateId,
    characterTemplate: player.templateId,
    x,
    y: arena.floorY,
    prevX: x,
    prevY: arena.floorY,
    vx: 0,
    vy: 0,
    width: config.fighterWidth,
    height: config.fighterHeight,
    facing: id === 0 ? 1 : -1,
    onGround: true,
    health: player.maxHealth,
    maxHealth: player.maxHealth,
    recoverableHealth: 0,
    stunGauge: 0,
    maxStunGauge: 100,
    roundsWon,
    rounds: roundsWon,
    action: "idle",
    state: "idle",
    currentMoveId: null,
    currentMove: null,
    moveData: null,
    moveAnimation: "idle",
    movePhase: "idle",
    actionFrame: 0,
    actionDuration: 0,
    hitstunFrames: 0,
    hitstun: 0,
    blockstunFrames: 0,
    blockstun: 0,
    knockdownFrames: 0,
    pendingKnockdown: false,
    invulnFrames: 0,
    strikeInvulnFrames: 0,
    throwInvulnFrames: 0,
    armorHits: 0,
    armorThroughFrame: 0,
    airAttackUsed: false,
    airLandingRecoveryFrames: 0,
    jumpType: "normal",
    commandBuffer: null,
    cancelRequest: null,
    directionHistory: [],
    currentDirection: "neutral",
    previousInput: { ...EMPTY_COMBAT_INPUT },
    lastInput: { ...EMPTY_COMBAT_INPUT },
    pressedButtons: [],
    guardHeight: "standing",
    lastJumpHeld: false,
    spawnedProjectiles: Object.create(null),
    denjinStock: 0,
    maxModeFrames: 0,
    chargeState: null,
    chargedDamageMultiplier: 1,
    moveTakeoffFrame: 0,
    pendingSelfLaunch: null,
    nextComboProration: null,
    driveRushAdvantageFrames: 0,
    driveRushAdvantageActionSerial: null,
    aiIntent: "",
    aiReason: "",
  };
  initializeFighterResources(fighter, player.templateId, {
    superMeter: player.startingSuperMeter,
    drive: player.startingDrive,
  });
  initializeCombatState(fighter);
  return fighter;
}

function normalizeEngineInput(value) {
  const raw = value ?? EMPTY_COMBAT_INPUT;
  const explicitCanonical = ATTACK_BUTTONS.some((button) => Object.hasOwn(raw, button));
  return {
    ...normalizeCombatInput(raw),
    _legacy: !explicitCanonical && (Object.hasOwn(raw, "light") || Object.hasOwn(raw, "heavy") || Object.hasOwn(raw, "special")),
  };
}

function snapshotPreviousPositions(game) {
  for (const fighter of game.fighters) {
    fighter.prevX = fighter.x;
    fighter.prevY = fighter.y;
  }
  for (const projectile of game.projectiles) {
    projectile.prevX = projectile.x;
    projectile.prevY = projectile.y;
  }
}

function captureInput(game, fighter, input) {
  const direction = relativeDirection(input, fighter.facing);
  recordDirection(fighter.directionHistory, direction, game.frame);
  fighter.currentDirection = direction;
  fighter.guardHeight = input.down ? "crouching" : "standing";
  fighter.pressedButtons = pressedCombatButtons(input, fighter.previousInput);
  const previousDirection = relativeDirection(fighter.previousInput, fighter.facing);
  const request = resolveMoveRequest(game, fighter, input, fighter.pressedButtons, direction !== previousDirection);
  if (request) {
    const buffered = { ...request, frames: game.config.inputBufferFrames, requestedFrame: game.frame };
    fighter.commandBuffer = buffered;
    if (fighter.currentMove) fighter.cancelRequest = { ...buffered };
  }
  fighter.lastInput = input;
  fighter.previousInput = { ...input };
}

function resolveMoveRequest(game, fighter, input, pressedButtons, directionChanged = false) {
  if (pressedButtons.length === 0 && !directionChanged) return null;
  if (input._legacy) return resolveLegacyRequest(game, fighter, input, pressedButtons);
  const moveset = BASE_MOVESETS[fighter.templateId];
  const opponent = game.fighters[1 - fighter.id];
  const candidates = [];
  for (const move of Object.values(moveset.moves)) {
    if (!isMoveCandidateLegal(game, fighter, opponent, move)) continue;
    const routeFrom = asArray(move.routeFrom ?? move.followupFrom ?? move.from);
    const routedAirBranch = move.command?.air && routeFrom.some((source) => source === fighter.currentMove?.id || source === fighter.action);
    const matched = matchCommandInput(move, {
      input,
      previousInput: fighter.previousInput,
      pressedButtons,
      directionHistory: fighter.directionHistory,
      frame: game.frame,
      facing: fighter.facing,
      fighter,
      stance: routedAirBranch ? "air" : undefined,
      jumpType: fighter.jumpType,
      directionChanged,
    });
    if (!matched) continue;
    candidates.push({ moveId: move.id, move, motionMatch: matched.motionMatch, score: commandPriority(move, fighter) });
  }
  candidates.sort((a, b) => b.score - a.score || a.moveId.localeCompare(b.moveId));
  const selected = candidates[0];
  if (selected) return { moveId: selected.moveId, motionMatch: selected.motionMatch };
  return resolveSystemShortcut(fighter, input, pressedButtons);
}

function resolveSystemShortcut(fighter, input, pressedButtons) {
  const direction = relativeDirection(input, fighter.facing);
  const back = direction === "back" || direction === "downBack";
  if (pressedButtons.includes("throw")) {
    if (fighter.templateId === "ember" && input.lp && input.lk) {
      return { moveId: findMoveId("ember", back ? ["backRoll", "backwardRoll"] : ["forwardRoll", "rollForward", "roll"]) };
    }
    return {
      moveId: fighter.templateId === "vanguard"
        ? (back ? "somersaultThrow" : "shoulderThrow")
        : findMoveId("ember", back ? ["hatsugane", "backThrow", "throwC"] : ["issetsu", "forwardThrow", "throwD", "throw"]),
    };
  }
  if (pressedButtons.includes("system1")) {
    return {
      moveId: fighter.templateId === "vanguard"
        ? "driveParry"
        : findMoveId("ember", back ? ["backRoll", "backwardRoll"] : ["forwardRoll", "rollForward", "roll"]),
    };
  }
  if (pressedButtons.includes("system2")) {
    if (fighter.templateId === "vanguard") {
      return {
        moveId: fighter.action === "knockdown"
          ? "driveReversalWakeup"
          : fighter.action === "block" || fighter.blockstunFrames > 0
            ? "driveReversalBlock"
            : "driveImpact",
      };
    }
    return {
      moveId: findMoveId(
        "ember",
        fighter.action === "block" || fighter.blockstunFrames > 0
          ? ["guardCancelBlowback", "gcBlowback", "guardCancelCD"]
          : ["groundBlowback", "blowback", "standCD"],
      ),
    };
  }
  return null;
}

function findMoveId(templateId, preferredIds) {
  const moves = BASE_MOVESETS[templateId]?.moves ?? {};
  for (const id of preferredIds) if (moves[id]) return id;
  const lowered = preferredIds.map((value) => value.toLowerCase());
  return Object.keys(moves).find((id) => lowered.some((needle) => id.toLowerCase().includes(needle))) ?? null;
}

function resolveLegacyRequest(game, fighter, input, pressedButtons) {
  const frame = game.frame;
  const airborne = !fighter.onGround || fighter.action === "jump";
  if (pressedButtons.includes("throw")) return { moveId: "throw" };
  const heavy = pressedButtons.includes("hp");
  const light = pressedButtons.includes("lp");
  if (!heavy && !light) return null;
  if (airborne) {
    if (fighter.templateId === "vanguard" && heavy) {
      const motion = matchMotion(fighter.directionHistory, "qcb", frame);
      if (motion) return { moveId: "airTatsu", motionMatch: motion };
    }
    if (fighter.templateId === "ember" && heavy && input.down) return { moveId: "airHammer" };
    return { moveId: light ? "airLight" : "airHeavy" };
  }
  if (heavy) {
    const dp = matchMotion(fighter.directionHistory, "dp", frame);
    if (dp) return { moveId: "dragonPunch", motionMatch: dp };
  }
  const qcf = matchMotion(fighter.directionHistory, "qcf", frame);
  if (qcf) {
    if (fighter.templateId === "vanguard") return { moveId: light ? "fireballLight" : "fireballHeavy", motionMatch: qcf };
    return { moveId: light ? "rekkaLight" : "rekkaHeavy", motionMatch: qcf };
  }
  if (input.down) return { moveId: light ? "lowLight" : "lowHeavy" };
  if (relativeDirection(input, fighter.facing) === "forward") return { moveId: light ? "midLight" : "midHeavy" };
  return { moveId: light ? "highLight" : "highHeavy" };
}

function isMoveCandidateLegal(game, fighter, opponent, move) {
  if (!move || move.disabled || move.needsLab) return false;
  if (!canAffordMove(fighter, move)) return false;
  const tags = moveTags(move);
  const routeFrom = asArray(move.routeFrom ?? move.followupFrom ?? move.from);
  const currentId = fighter.currentMove?.id ?? getCanonicalMoveId(fighter.templateId, fighter.action);
  const routedFromCurrent = routeFrom.includes(currentId) || routeFrom.includes(fighter.action);
  const airborne = !fighter.onGround || fighter.action === "jump";
  const stance = move.stance ?? move.command?.stance ?? (move.command?.air ? "air" : "ground");
  if (stance === "air" && !airborne && !routedFromCurrent) return false;
  if (stance !== "air" && airborne && !moveTags(move).has("airOkay")) return false;
  if (move.command?.stance === "hop" && fighter.jumpType !== "hop") return false;
  if (move.command?.stance === "jump" && fighter.jumpType === "hop") return false;
  if (routeFrom.length > 0 && !routedFromCurrent) return false;
  if (routeFrom.length === 0 && fighter.currentMove && move.category === "targetCombo" && !moveTags(move).has("standalone")) return false;
  const distance = Math.abs(opponent.x - fighter.x);
  const proximity = move.proximity ?? (moveTags(move).has("close") ? "close" : moveTags(move).has("far") ? "far" : null);
  const closeRange = finite(move.closeRange, fighter.width * 1.85);
  if (proximity === "close" && distance > closeRange) return false;
  if (proximity === "far" && distance <= closeRange) return false;
  const resourceConditions = asArray(move.resource?.conditions ?? move.conditions).map(String);
  const requiresDenjin = tags.has("requiresDenjin") || tags.has("denjin") || resourceConditions.some((condition) => condition.includes("denjinStock>=1"));
  if (requiresDenjin && fighter.denjinStock <= 0) return false;
  if (moveTags(move).has("noDenjin") && fighter.denjinStock > 0) return false;
  if (resourceConditions.some((condition) => condition.includes("denjinStock<1")) && fighter.denjinStock >= finite(move.maxStock, 1)) return false;
  // Charged SA2 variants are selected on release by the runtime; letting the
  // ordinary resolver see them makes the alphabetically first row win.
  if (finite(move.holdThreshold) > 0 && tags.has("sa2")) return false;
  if ((tags.has("criticalArt") || tags.has("ca") || tags.has("lowHealthOnly")) && fighter.health > fighter.maxHealth * 0.25) return false;
  if (tags.has("nonCritical") && fighter.health <= fighter.maxHealth * 0.25) return false;
  if (move.condition === "corner" && !isCornered(opponent, game.arena)) return false;
  if (move.condition === "maxMode" && fighter.maxModeFrames <= 0) return false;
  if (resourceConditions.includes("inBlockstun") && fighter.blockstunFrames <= 0 && fighter.action !== "block") return false;
  if (resourceConditions.includes("wakeupRecovery") && fighter.action !== "knockdown") return false;
  if (resourceConditions.includes("insideThrowTechWindow") && fighter.throwTechWindow <= 0) return false;
  if ((tags.has("blockstunOnly") || tags.has("guardCancel")) && fighter.blockstunFrames <= 0 && fighter.action !== "block") return false;
  if (tags.has("wakeupOnly") && fighter.action !== "knockdown") return false;
  if (tags.has("parryRoute") && fighter.currentMove?.id !== "driveParry") return false;
  if (tags.has("normalCancelRoute")) {
    const source = fighter.currentMove;
    const outcome = fighter.lastContact?.actionSerial === fighter.actionSerial ? fighter.lastContact?.outcome : null;
    if (!source || !["normal", "commandNormal", "targetCombo"].includes(source.category) || !["hit", "block", "counter", "punishCounter"].includes(outcome)) return false;
  }
  if (resourceConditions.includes("sourceMoveHasDriveRushCancel") && !fighter.currentMove) return false;
  if (tags.has("parry") && fighter.maxDrive > 0 && (fighter.burnout || fighter.drive <= 0)) return false;
  if (resourceConditions.some((condition) => condition.includes("healthRatio<=0.25")) && fighter.health > fighter.maxHealth * 0.25) return false;
  if (tags.has("throwTech") && fighter.throwTechWindow <= 0) return false;
  return true;
}

function commandPriority(move, fighter) {
  const category = move.category;
  let score = {
    climax: 950,
    super: 900,
    od: 800,
    system: 750,
    special: 650,
    targetCombo: 580,
    commandNormal: 500,
    throw: 480,
    normal: 100,
  }[category] ?? 50;
  if (asArray(move.routeFrom ?? move.followupFrom ?? move.from).length > 0) score += 500;
  if (move.command?.motion) score += String(move.command.motion).includes("Qcf") || String(move.command.motion).includes("Qcb") ? 60 : 30;
  if (move.command?.chord) score += 25;
  if (moveTags(move).has("criticalArt") || moveTags(move).has("ca") || moveTags(move).has("lowHealthOnly")) score += fighter.health <= fighter.maxHealth * 0.25 ? 80 : -1000;
  if (moveTags(move).has("requiresDenjin") || moveTags(move).has("denjin")) score += fighter.denjinStock > 0 ? 90 : -1000;
  if ((moveTags(move).has("blockstunOnly") || moveTags(move).has("guardCancel")) && (fighter.blockstunFrames > 0 || fighter.action === "block")) score += 1200;
  if (moveTags(move).has("wakeupOnly") && fighter.action === "knockdown") score += 1200;
  if (moveTags(move).has("parryRoute") && fighter.currentMove?.id === "driveParry") score += 900;
  if (moveTags(move).has("normalCancelRoute") && fighter.currentMove) score += 900;
  return score + finite(move.priority);
}

function updateFighter(game, fighter, input) {
  if (fighter.action === "ko") return;
  if (fighter.action === "knockdown") {
    updateKnockdown(game, fighter, input);
    return;
  }
  if (fighter.action === "hit" || fighter.action === "guardBreak") {
    updateHitReaction(game, fighter, input);
    return;
  }
  if (fighter.action === "block" && fighter.blockstunFrames > 0) {
    ensureContextualBuffer(game, fighter, input, "blockstun");
    if (fighter.templateId !== "vanguard" && tryStartBufferedMove(game, fighter, { allowImmobilized: true })) return;
    const recovered = updateBlockstun(fighter);
    if (
      recovered &&
      fighter.commandBuffer?.contextual === "blockstun" &&
      tryStartBufferedMove(game, fighter, { allowImmobilized: true })
    ) return;
    if (recovered) setLocomotionAction(fighter, input.down ? "crouch" : "idle");
    return;
  }
  if (fighter.action === "landingRecovery") {
    fighter.actionFrame += 1;
    if (fighter.actionFrame >= fighter.actionDuration) setLocomotionAction(fighter, input.down ? "crouch" : "idle");
    return;
  }
  if (fighter.action === "throwWhiff") {
    fighter.actionFrame += 1;
    if (fighter.actionFrame >= fighter.actionDuration) setLocomotionAction(fighter, "idle");
    return;
  }
  if (fighter.currentMove) {
    updateMove(game, fighter, input);
    return;
  }
  if (!fighter.onGround || fighter.action === "jump") {
    if (tryStartBufferedMove(game, fighter)) return;
    updateJump(game, fighter, input);
    return;
  }

  fighter.vx = 0;
  fighter.vy = 0;
  if (tryStartBufferedMove(game, fighter)) return;

  const justPressedUp = input.up && !fighter.lastJumpHeld;
  fighter.lastJumpHeld = input.up;
  if (justPressedUp) {
    startJump(game, fighter, input);
    return;
  }
  if (input.down) {
    setLocomotionAction(fighter, "crouch");
    return;
  }
  const direction = axis(input.left, input.right);
  if (direction !== 0) {
    const relative = direction * fighter.facing;
    fighter.x += direction * (relative < 0 ? game.config.backWalkSpeed : game.config.walkSpeed);
    setLocomotionAction(fighter, "walk");
  } else {
    setLocomotionAction(fighter, "idle");
  }
  clampFighter(fighter, game.arena);
}

function tryStartBufferedMove(game, fighter, options = {}) {
  const request = fighter.commandBuffer;
  if (!request || fighter.currentMove || (!options.allowImmobilized && IMMOBILE_ACTIONS.has(fighter.action))) return false;
  const move = getMoveData(fighter.templateId, request.moveId);
  if (!move || !isMoveCandidateLegal(game, fighter, game.fighters[1 - fighter.id], move)) return false;
  const started = startMove(game, fighter, request.moveId, move, request.motionMatch);
  if (started) fighter.commandBuffer = null;
  return started;
}

function ensureContextualBuffer(game, fighter, input, context) {
  const heldSystem2 = input.system2 || (input.hp && input.hk);
  const heldRoll = input.system1 || input.throw || (input.lp && input.lk);
  const heldForward = relativeDirection(input, fighter.facing) === "forward";
  let moveId = null;
  if (context === "blockstun") {
    if (
      fighter.templateId === "vanguard" &&
      fighter.blockstunFrames <= REVERSAL_BUFFER_FRAMES &&
      heldForward &&
      heldSystem2
    ) moveId = "driveReversalBlock";
    if (fighter.templateId === "ember" && heldSystem2) moveId = findMoveId("ember", ["guardCancelBlowback", "gcBlowback"]);
    if (fighter.templateId === "ember" && heldRoll) {
      const back = ["back", "downBack", "upBack"].includes(relativeDirection(input, fighter.facing));
      moveId = findMoveId("ember", back ? ["guardCancelRollBackward"] : ["guardCancelRollForward"]);
    }
  } else if (
    context === "wakeup" &&
    fighter.templateId === "vanguard" &&
    fighter.knockdownFrames <= REVERSAL_BUFFER_FRAMES &&
    heldForward &&
    heldSystem2
  ) {
    moveId = "driveReversalWakeup";
  }
  if (!moveId) return false;
  fighter.commandBuffer = {
    moveId,
    motionMatch: null,
    frames: game.config.inputBufferFrames,
    requestedFrame: game.frame,
    contextual: context,
  };
  return true;
}

function startMove(game, fighter, requestedId, move = getMoveData(fighter.templateId, requestedId), motionMatch = null) {
  if (!move || !canAffordMove(fighter, move)) return false;
  const sourceMove = fighter.currentMove;
  const driveRushFollowup = Boolean(
    sourceMove &&
    moveTags(sourceMove).has("driveRush") &&
    !moveTags(move).has("nonAttack") &&
    move.hitLevel !== "none"
  );
  const consumesDenjin = finite(move.resource?.consumes?.denjin) > 0 || moveTags(move).has("requiresDenjin") || moveTags(move).has("denjin");
  if (consumesDenjin && fighter.denjinStock <= 0) return false;
  if (!spendMoveCost(fighter, move)) return false;
  if (consumesDenjin) fighter.denjinStock = Math.max(0, fighter.denjinStock - Math.max(1, finite(move.resource?.consumes?.denjin, 1)));
  if (moveTags(move).has("denjinCharge")) fighter.denjinStock = 1;
  if (moveTags(move).has("maxMode") || moveTags(move).has("quickMax")) {
    fighter.maxModeFrames = Math.max(fighter.maxModeFrames, finite(move.maxModeFrames, 600));
  }
  if (motionMatch) fighter.directionHistory = clearConsumedMotion(fighter.directionHistory, motionMatch);
  fighter.action = requestedId;
  fighter.state = requestedId;
  fighter.currentMoveId = move.id;
  fighter.currentMove = move;
  fighter.moveData = move;
  // Capture post-cost resources before any per-hit gain occurs. Rules that
  // gate a finisher on committed resources must not change merely because a
  // cinematic has many same-frame contacts that each award meter.
  fighter.moveStartResources = {
    moveId: move.id,
    superMeter: fighter.superMeter,
    drive: fighter.drive,
    maxModeFrames: fighter.maxModeFrames,
  };
  fighter.moveAnimation = move.animation ?? "highHeavy";
  fighter.actionFrame = 0;
  fighter.actionDuration = move.totalFrames;
  fighter.movePhase = phaseForMove(move, 1);
  fighter.spawnedProjectiles = Object.create(null);
  fighter.cancelRequest = null;
  fighter.vx = 0;
  fighter.chargedDamageMultiplier = 1;
  fighter.chargeState = createMoveChargeState(move);
  beginActionCombatState(fighter);
  fighter.driveRushAdvantageFrames = driveRushFollowup ? DRIVE_RUSH_ADVANTAGE_FRAMES : 0;
  fighter.driveRushAdvantageActionSerial = driveRushFollowup ? fighter.actionSerial : null;
  applyMoveStartupState(fighter, move);
  if (fighter.chargeState?.kind === "vanguardSa2") {
    recordCombatEvent(game, "chargeStart", {
      fighterId: fighter.id,
      moveId: move.id,
      resource: "sa2",
    });
  } else {
    recordMoveStart(game, fighter, move);
    processMoveFrame(game, fighter, 1);
  }
  return true;
}

function createMoveChargeState(move) {
  const tags = moveTags(move);
  if (tags.has("sa2") && tags.has("level1") && tags.has("chargeable")) {
    const level3After = finite(move.chargeFrames?.level3After, 39);
    return {
      kind: "vanguardSa2",
      holdFrames: 0,
      elapsedFrames: 0,
      maximum: level3After + 1,
      level2After: finite(move.chargeFrames?.level2After, 7),
      level3After,
      denjin: tags.has("denjin"),
    };
  }
  const damageByCharge = move.hit?.damageByCharge;
  if (move.command?.hold && Array.isArray(damageByCharge) && damageByCharge.length > 0) {
    return {
      kind: "damageCharge",
      holdFrames: 0,
      maximum: Math.max(1, finite(move.hit?.chargeStartupMax, 99)),
      damageByCharge: [...damageByCharge],
      finalized: false,
    };
  }
  return null;
}

function applyMoveStartupState(fighter, move) {
  const tags = moveTags(move);
  const invuln = move.invuln ?? {};
  const authoredInvulnerability = [
    ...asArray(move.invulnerability),
    ...asArray(move.hit?.invulnerability),
  ];
  const fullInvulnerability = authoredInvulnerability
    .filter((window) => ["full", "fullBody", "strikeThrow"].includes(window.type))
    .reduce((maximum, window) => Math.max(maximum, finite(window.end)), 0);
  const strikeInvulnerability = authoredInvulnerability
    .filter((window) => ["strike", "airStrike", "upperBody", "antiAir", "nonProjectileAirStrike", "strike+projectile"].includes(window.type))
    .reduce((maximum, window) => Math.max(maximum, finite(window.end)), 0);
  fighter.invulnFrames = Math.max(fighter.invulnFrames, finite(invuln.full ?? move.fullInvulnFrames), fullInvulnerability);
  fighter.strikeInvulnFrames = Math.max(fighter.strikeInvulnFrames, finite(invuln.strike ?? move.strikeInvulnFrames), strikeInvulnerability);
  const throwInvulnerability = authoredInvulnerability
    .filter((window) => ["throw", "full", "fullBody", "strikeThrow"].includes(window.type))
    .reduce((maximum, window) => Math.max(maximum, finite(window.end)), 0);
  fighter.throwInvulnFrames = Math.max(fighter.throwInvulnFrames, finite(invuln.throw ?? move.throwInvulnFrames), throwInvulnerability);
  const armorWindows = [...asArray(move.armor), ...asArray(move.hit?.armor)];
  fighter.armorHits = Math.max(fighter.armorHits, finite(move.armorHits ?? move.armor?.hits), armorWindows.length > 0 ? 1 : 0);
  fighter.armorThroughFrame = Math.max(finite(move.armorThroughFrame ?? move.armor?.end), ...armorWindows.map((window) => finite(window.end)));
  const airborneTag = [...tags].find((tag) => /^airborneF\d+/i.test(tag));
  const authoredTakeoff = airborneTag ? Number(airborneTag.match(/airborneF(\d+)/i)?.[1]) : NaN;
  if (tags.has("dragonPunch") || tags.has("oniyaki") || /shoryu|oniyaki/i.test(move.id)) {
    fighter.moveTakeoffFrame = Number.isFinite(authoredTakeoff) ? authoredTakeoff : Math.max(2, move.startup + 2);
    fighter.pendingSelfLaunch = {
      y: finite(move.selfLaunchY ?? move.launchVelocityY, -9.2),
      x: fighter.facing * finite(move.selfLaunchX ?? move.launchVelocityX, 2.3),
    };
  } else if (move.command?.air && fighter.onGround && asArray(move.routeFrom ?? move.followupFrom ?? move.from).length > 0) {
    // Route-only aerial branches (such as 6HK~air Tatsu) create their own
    // small hop instead of being rejected as a ground move.
    fighter.onGround = false;
    fighter.vy = finite(move.selfLaunchY, -5.2);
    fighter.vx = fighter.facing * finite(move.selfLaunchX, 2.6);
  } else if (move.selfLaunchY != null) {
    fighter.onGround = false;
    fighter.vy = finite(move.selfLaunchY);
    fighter.vx = fighter.facing * finite(move.selfLaunchX);
  }
}

function applyStateInvulnerability(fighter, move, state) {
  const windows = [
    ...asArray(move.invulnerability),
    ...asArray(move.hit?.invulnerability),
  ].filter((window) => window.state === state);
  if (windows.some((window) => ["full", "fullBody", "strikeThrow"].includes(window.type))) {
    fighter.invulnFrames = Math.max(fighter.invulnFrames, 1);
  }
  if (windows.some((window) => [
    "strike", "airStrike", "upperBody", "antiAir", "nonProjectileAirStrike", "strike+projectile",
  ].includes(window.type))) {
    fighter.strikeInvulnFrames = Math.max(fighter.strikeInvulnFrames, 1);
  }
  if (windows.some((window) => ["throw", "full", "fullBody", "strikeThrow"].includes(window.type))) {
    fighter.throwInvulnFrames = Math.max(fighter.throwInvulnFrames, 1);
  }
}

function updateMove(game, fighter, input) {
  if (fighter.chargeState?.kind === "vanguardSa2" && holdOrReleaseVanguardSa2(game, fighter, input)) return;
  const move = fighter.currentMove;
  const nextAuthoredFrame = fighter.actionFrame + 2;
  if (shouldHoldMove(game, move, fighter, input)) {
    return;
  }
  if (nextAuthoredFrame > move.totalFrames) {
    finishMove(game, fighter, input);
    return;
  }
  fighter.actionFrame += 1;
  fighter.movePhase = phaseForMove(move, fighter.actionFrame + 1);
  processMoveFrame(game, fighter, fighter.actionFrame + 1);
}

function holdOrReleaseVanguardSa2(game, fighter, input) {
  const state = fighter.chargeState;
  state.elapsedFrames += 1;
  const held = input.lp || input.mp || input.hp;
  if (held && state.holdFrames < state.maximum) {
    state.holdFrames += 1;
    fighter.movePhase = "charge";
    // The maximum threshold releases on the same frame it is reached. This
    // makes Level 3 require strictly more than 39 held frames while keeping a
    // bounded charge even if the button remains held.
    if (state.holdFrames < state.maximum) return true;
  }
  const level = state.holdFrames > state.level3After ? 3 : state.holdFrames > state.level2After ? 2 : 1;
  const targetId = `superArt2Level${level}${state.denjin ? "Denjin" : ""}`;
  const target = getMoveData(fighter.templateId, targetId);
  if (!target) return false;
  fighter.action = targetId;
  fighter.state = targetId;
  fighter.currentMoveId = target.id;
  fighter.currentMove = target;
  fighter.moveData = target;
  fighter.moveAnimation = target.animation ?? "fireballHeavy";
  // Charging and release share one absolute startup timeline. Long holds may
  // pause at the last pre-active frame, but release never restarts startup or
  // skips past the target's active window.
  fighter.actionFrame = Math.min(state.elapsedFrames, Math.max(0, target.startup - 1));
  fighter.actionDuration = target.totalFrames;
  fighter.movePhase = phaseForMove(target, fighter.actionFrame + 1);
  fighter.chargeState = null;
  recordMoveStart(game, fighter, target);
  recordCombatEvent(game, "chargeRelease", {
    fighterId: fighter.id,
    moveId: target.id,
    holdFrames: state.holdFrames,
    level,
  });
  processMoveFrame(game, fighter, fighter.actionFrame + 1);
  return true;
}

function shouldHoldMove(game, move, fighter, input) {
  if (move.holdExtension) {
    const activeEnd = Math.max(...move.activeWindows.map((window) => window.end));
    const held = asArray(move.command?.buttons).every((button) => input[button]);
    if (held && fighter.actionFrame + 1 >= activeEnd && fighter.drive > 0 && !fighter.burnout) {
      changeDrive(fighter, -1.5, 30);
      fighter.actionFrame = activeEnd - 1;
      fighter.movePhase = "active";
      return true;
    }
  }
  const charge = fighter.chargeState;
  if (charge?.kind === "damageCharge" && !charge.finalized) {
    const holdStart = Math.max(1, finite(move.holdStartFrame, move.startup - 1));
    if (fighter.actionFrame + 1 >= holdStart) {
      const held = asArray(move.command?.buttons).some((button) => input[button]);
      if (held && charge.holdFrames < charge.maximum) {
        charge.holdFrames += 1;
        fighter.movePhase = "charge";
        applyStateInvulnerability(fighter, move, "charge");
        return true;
      }
      const stride = Math.max(1, charge.maximum / Math.max(1, charge.damageByCharge.length - 1));
      const tier = Math.min(charge.damageByCharge.length - 1, Math.floor(charge.holdFrames / stride));
      const chargedDamage = finite(charge.damageByCharge[tier], move.damage);
      fighter.chargedDamageMultiplier = move.damage > 0 ? chargedDamage / move.damage : 1;
      charge.finalized = true;
      recordCombatEvent(game, "chargeRelease", {
        fighterId: fighter.id,
        moveId: move.id,
        holdFrames: charge.holdFrames,
        level: tier + 1,
        damage: chargedDamage,
      });
    }
  }
  if (!move.command?.hold && !move.maxHoldFrames) return false;
  const frame = fighter.actionFrame + 1;
  const holdStart = finite(move.holdStartFrame, move.startup);
  const maxHold = finite(move.maxHoldFrames, 0);
  if (frame < holdStart || frame >= holdStart + maxHold) return false;
  return asArray(move.command?.buttons).some((button) => input[button]);
}

function processMoveFrame(game, fighter, authoredFrame) {
  const move = fighter.currentMove;
  if (!move) return;
  const tags = moveTags(move);
  if (fighter.pendingSelfLaunch && authoredFrame >= fighter.moveTakeoffFrame) {
    fighter.onGround = false;
    fighter.vy = fighter.pendingSelfLaunch.y;
    fighter.vx = fighter.pendingSelfLaunch.x;
    fighter.pendingSelfLaunch = null;
  }
  if (move.resource?.continuousCost === "driveParry" && move.activeWindows.some((window) => authoredFrame >= window.start && authoredFrame <= window.end)) {
    changeDrive(fighter, -1.5, 30);
  }
  if (move.advance && authoredFrame >= finite(move.advance.from, 1) && authoredFrame <= finite(move.advance.to, move.totalFrames)) {
    fighter.x += fighter.facing * finite(move.advance.speed);
  }
  if (move.retreat && authoredFrame >= finite(move.retreat.from, 1) && authoredFrame <= finite(move.retreat.to, move.totalFrames)) {
    fighter.x -= fighter.facing * finite(move.retreat.speed);
  }
  if (tags.has("roll") && authoredFrame <= finite(move.invulnThroughFrame, 24)) {
    fighter.x += fighter.facing * (tags.has("backward") ? -1 : 1) * 7.2;
  } else if (tags.has("driveRush") || (tags.has("dash") && tags.has("forward"))) {
    fighter.x += fighter.facing * 8.4;
  } else if (tags.has("dash") && tags.has("back")) {
    fighter.x -= fighter.facing * 7.2;
  } else if (tags.has("driveImpact") && authoredFrame >= 8 && authoredFrame <= 27) {
    fighter.x += fighter.facing * 2.6;
  } else if (
    fighter.templateId === "ember" &&
    /aragami|dokugami|konokizu|yanosabi|munotsuchi|kai|kototsuki|redkick/i.test(move.id) &&
    authoredFrame <= Math.max(...move.activeWindows.map((window) => window.end))
  ) {
    fighter.x += fighter.facing * 1.9;
  }
  maybeSpawnProjectile(game, fighter, move, authoredFrame);
  applyTimedResourceChanges(fighter, move, authoredFrame);
  if (!fighter.onGround || move.stance === "air" || move.command?.air) {
    fighter.x += fighter.vx;
    fighter.vy += game.config.gravity * finite(move.gravityScale, 0.8);
    fighter.y += fighter.vy;
    resolveMoveAirContact(game, fighter, move);
  }
  clampHorizontal(fighter, game.arena);
}

function applyTimedResourceChanges(fighter, move, authoredFrame) {
  const gains = move.resource?.gains ?? {};
  const gainFrame = finite(gains.frame, move.totalFrames - 1);
  if (authoredFrame !== gainFrame) return;
  if (finite(gains.denjin) > 0) fighter.denjinStock = Math.min(finite(move.maxStock, 1), fighter.denjinStock + finite(gains.denjin));
  if (finite(gains.super) > 0) gainSuperMeter(fighter, finite(gains.super));
  if (finite(gains.drive) !== 0) changeDrive(fighter, finite(gains.drive));
}

function resolveMoveAirContact(game, fighter, move) {
  resolveWallContact(fighter, game.arena);
  if (fighter.y < game.arena.floorY) return;
  fighter.y = game.arena.floorY;
  fighter.vy = 0;
  fighter.vx = 0;
  fighter.onGround = true;
  const tags = moveTags(move);
  if (tags.has("dragonPunch") || tags.has("oniyaki") || move.stance === "air" || move.command?.air) {
    const recovery = finite(move.landingRecovery, finite(move.landRecovery, 3));
    clearCurrentMove(fighter);
    if (recovery > 0) setLocomotionAction(fighter, "landingRecovery", recovery);
    else setLocomotionAction(fighter, "idle");
  }
}

function finishMove(game, fighter, input) {
  const move = fighter.currentMove;
  if (move && !fighter.lastContact) {
    fighter.lastContact = { frame: game.frame, actionSerial: fighter.actionSerial, moveId: move.id, outcome: "whiff" };
    recordCombatEvent(game, "contact", { fighterId: fighter.id, defenderId: 1 - fighter.id, moveId: move.id, outcome: "whiff" });
  }
  const wasThrow = move?.category === "throw" || moveTags(move).has("throw");
  const whiffRecovery = finite(move?.whiffRecovery);
  clearCurrentMove(fighter);
  if (wasThrow && fighter.lastContact?.outcome === "whiff" && whiffRecovery > 0) {
    setLocomotionAction(fighter, "throwWhiff", whiffRecovery);
    addEffect(game, "throwWhiff", fighter.x + fighter.facing * 36, fighter.y - 54, 14, "#ff8b9f");
    return;
  }
  if (!fighter.onGround) {
    setLocomotionAction(fighter, "jump");
    return;
  }
  setLocomotionAction(fighter, input.down ? "crouch" : "idle");
  tryStartBufferedMove(game, fighter);
}

function clearCurrentMove(fighter) {
  fighter.currentMove = null;
  fighter.currentMoveId = null;
  fighter.moveData = null;
  fighter.movePhase = fighter.onGround ? "idle" : "jump";
  fighter.armorHits = 0;
  fighter.armorThroughFrame = 0;
  fighter.strikeInvulnFrames = 0;
  fighter.chargeState = null;
  fighter.chargedDamageMultiplier = 1;
  fighter.moveTakeoffFrame = 0;
  fighter.pendingSelfLaunch = null;
}

function startJump(game, fighter, input) {
  const recentDown = fighter.directionHistory.some((entry) => entry.direction === "down" && entry.frame >= game.frame - 7);
  const doubleForward = Boolean(matchMotion(fighter.directionHistory, "forwardForward", game.frame));
  fighter.jumpType = fighter.templateId === "ember" && (recentDown || doubleForward) ? "hop" : "normal";
  fighter.onGround = false;
  fighter.airAttackUsed = false;
  fighter.vy = -(fighter.jumpType === "hop" ? game.config.hopSpeed : game.config.jumpSpeed);
  const direction = axis(input.left, input.right);
  fighter.vx = direction * game.config.airSpeed * (doubleForward ? 1.35 : 1);
  setLocomotionAction(fighter, "jump");
  recordCombatEvent(game, "jump", { fighterId: fighter.id, jumpType: fighter.jumpType });
}

function updateJump(game, fighter, input) {
  fighter.actionFrame += 1;
  const direction = axis(input.left, input.right);
  fighter.vx = lerp(fighter.vx, direction * game.config.airSpeed, 0.18);
  fighter.x += fighter.vx;
  fighter.vy += game.config.gravity;
  fighter.y += fighter.vy;
  clampHorizontal(fighter, game.arena);
  if (fighter.y >= game.arena.floorY) {
    fighter.y = game.arena.floorY;
    fighter.vy = 0;
    fighter.vx = 0;
    fighter.onGround = true;
    fighter.airAttackUsed = false;
    setLocomotionAction(fighter, "idle");
  }
}

function updateBlockstun(fighter) {
  fighter.actionFrame += 1;
  fighter.blockstunFrames = Math.max(0, fighter.blockstunFrames - 1);
  fighter.blockstun = fighter.blockstunFrames;
  fighter.x += fighter.vx;
  fighter.vx *= 0.72;
  return fighter.blockstunFrames <= 0;
}

function updateHitReaction(game, fighter, input) {
  fighter.actionFrame += 1;
  fighter.hitstunFrames = Math.max(0, fighter.hitstunFrames - 1);
  fighter.hitstun = fighter.hitstunFrames;
  if (!fighter.onGround) {
    fighter.x += fighter.vx;
    fighter.vy += game.config.gravity;
    fighter.y += fighter.vy;
    const wallBounced = resolveWallContact(fighter, game.arena);
    if (wallBounced) addEffect(game, "wallBounce", fighter.x, fighter.y - fighter.height * 0.5, 18, "#ffb45d");
    const ground = resolveGroundContact(fighter, game.arena, input);
    if (ground.bounced) addEffect(game, "groundBounce", fighter.x, fighter.y - 10, 18, "#ffcf66");
    if (ground.landed && !ground.bounced) {
      fighter.vx *= 0.4;
      if (fighter.pendingKnockdown || fighter.knockdownType !== KNOCKDOWN_TYPES.none) {
        beginKnockdown(game, fighter, input);
        return;
      }
    }
  } else {
    fighter.x += fighter.vx;
    fighter.vx *= 0.72;
  }
  clampHorizontal(fighter, game.arena);
  if (fighter.hitstunFrames <= 0 && fighter.onGround && fighter.pendingKnockdown) {
    beginKnockdown(game, fighter, input);
    return;
  }
  if (fighter.hitstunFrames <= 0 && fighter.onGround && !fighter.pendingKnockdown) {
    fighter.knockdownType = KNOCKDOWN_TYPES.none;
    setLocomotionAction(fighter, input.down ? "crouch" : "idle");
  }
}

function beginKnockdown(game, fighter, input) {
  const type = fighter.knockdownType;
  const base = type === KNOCKDOWN_TYPES.hard ? 44 : type === KNOCKDOWN_TYPES.crumple ? 52 : 30;
  let duration = finite(fighter.pendingKnockdownFrames, base);
  const wakeup = chooseWakeupOption(fighter, input);
  if (type !== KNOCKDOWN_TYPES.hard) {
    if (wakeup === "quickRise") duration = Math.min(duration, 16);
    else if (wakeup === "backRoll") duration = Math.min(duration, 22);
    else if (wakeup === "delayRise") duration += Math.min(18, fighter.delayedRiseFrames ?? 0);
  }
  fighter.wakeupOption = wakeup;
  fighter.knockdownFrames = duration;
  fighter.pendingKnockdown = false;
  fighter.onGround = true;
  fighter.vy = 0;
  fighter.vx = 0;
  clearCurrentMove(fighter);
  setLocomotionAction(fighter, "knockdown", duration);
  recordCombatEvent(game, "knockdown", { fighterId: fighter.id, knockdownType: type, wakeup, duration });
}

function updateKnockdown(game, fighter, input) {
  fighter.actionFrame += 1;
  fighter.knockdownFrames = Math.max(0, fighter.knockdownFrames - 1);
  if (fighter.knockdownFrames <= 6) {
    ensureContextualBuffer(game, fighter, input, "wakeup");
  }
  if (fighter.knockdownFrames > 0) return;
  {
    const request = fighter.commandBuffer;
    const wakeupMove = request ? getMoveData(fighter.templateId, request.moveId) : null;
    if (wakeupMove && moveTags(wakeupMove).has("wakeupOnly")) {
      fighter.knockdownType = KNOCKDOWN_TYPES.none;
      fighter.pendingKnockdown = false;
      fighter.knockdownFrames = 0;
      if (tryStartBufferedMove(game, fighter, { allowImmobilized: true })) {
        recordCombatEvent(game, "wakeupAction", {
          fighterId: fighter.id,
          action: "reversal",
          option: "driveReversal",
        });
        fighter.wakeupOption = null;
        return;
      }
      setLocomotionAction(fighter, "idle");
    }
  }
  if (fighter.wakeupOption === "backRoll") {
    fighter.x -= fighter.facing * fighter.width * 1.35;
    clampHorizontal(fighter, game.arena);
  }
  fighter.invulnFrames = 7;
  fighter.throwInvulnFrames = 5;
  // Knockdown owns the remainder of the reaction once it begins. Do not let
  // stale pre-knockdown hitstun keep the combo open forever after wakeup.
  fighter.hitstunFrames = 0;
  fighter.hitstun = 0;
  fighter.knockdownType = KNOCKDOWN_TYPES.none;
  fighter.jugglePoints = 0;
  setLocomotionAction(fighter, input.down ? "crouch" : "idle");
  recordCombatEvent(game, "wakeupAction", {
    fighterId: fighter.id,
    action: input.guard ? "block" : fighter.commandBuffer ? "button" : "neutral",
    option: fighter.wakeupOption,
  });
  fighter.wakeupOption = null;
  tryStartBufferedMove(game, fighter);
}

function tickFighterTimers(fighter) {
  for (const key of ["invulnFrames", "strikeInvulnFrames", "throwInvulnFrames", "throwTechWindow"]) {
    if (fighter[key] > 0) fighter[key] -= 1;
  }
  if (fighter.maxModeFrames > 0) fighter.maxModeFrames -= 1;
}

function tickCommandBuffers(fighters) {
  for (const fighter of fighters) {
    for (const key of ["commandBuffer", "cancelRequest"]) {
      const buffer = fighter[key];
      if (!buffer) continue;
      buffer.frames -= 1;
      if (buffer.frames <= 0) fighter[key] = null;
    }
  }
}

function maybeSpawnProjectile(game, fighter, move, authoredFrame) {
  if (!isProjectileMove(move)) return;
  const projectileFrame = finite(move.projectileFrame, move.startup);
  if (authoredFrame !== projectileFrame || fighter.spawnedProjectiles[projectileFrame]) return;
  fighter.spawnedProjectiles[projectileFrame] = true;
  const definition = move.projectile ?? {};
  const scale = fighter.height / BOX_REFERENCE_HEIGHT;
  const hits = (move.hits?.length ? move.hits : [{ id: "main", damage: move.damage, hitLevel: move.hitLevel }]).map((hit) => ({ ...hit }));
  const spawnX = fighter.x + fighter.facing * finite(definition.offsetX, 68) * scale;
  const spawnY = fighter.y + finite(definition.offsetY, -63) * scale;
  const projectile = {
    id: game.nextProjectileId++,
    owner: fighter.id,
    sourceMoveId: move.id,
    sourceActionSerial: fighter.actionSerial,
    frameAdvantageBonus: fighter.driveRushAdvantageActionSerial === fighter.actionSerial
      ? fighter.driveRushAdvantageFrames
      : 0,
    move,
    hits,
    hitIndex: 0,
    nextHitFrame: 0,
    x: spawnX,
    y: spawnY,
    prevX: spawnX,
    prevY: spawnY,
    vx: fighter.facing * finite(definition.speed, projectileSpeed(move, definition)),
    facing: fighter.facing,
    width: finite(definition.width, 38) * scale,
    height: finite(definition.height, 30) * scale,
    radius: finite(definition.radius, 16) * scale,
    lifeFrames: finite(definition.lifetime, 150),
    durability: finite(definition.durability ?? definition.clashHits ?? move.clashHits, hits.length > 1 ? 2 : 1),
    alive: true,
    active: true,
    frame: 0,
    color: fighter.color,
    variant: definition.variant ?? move.strength ?? "normal",
  };
  game.projectiles.push(projectile);
  addEffect(game, "muzzle", projectile.x, projectile.y, 8, fighter.color);
}

function projectileSpeed(move, definition = {}) {
  const strength = definition.speedClass ?? move.speedClass ?? move.strength ?? "medium";
  return strength === "light" ? 6.1 : strength === "heavy" ? 9.1 : 7.5;
}

function updateProjectiles(game) {
  for (const projectile of game.projectiles) {
    if (!projectile.alive) continue;
    projectile.frame += 1;
    projectile.x += projectile.vx;
    projectile.lifeFrames -= 1;
    if (projectile.nextHitFrame > 0) projectile.nextHitFrame -= 1;
    if (projectile.lifeFrames <= 0 || projectile.x < game.arena.left - 100 || projectile.x > game.arena.right + 100) {
      projectile.alive = false;
      projectile.active = false;
    }
  }
  game.projectiles = game.projectiles.filter((projectile) => projectile.alive);
}

function resolveProjectileClashes(game) {
  for (let i = 0; i < game.projectiles.length; i += 1) {
    const a = game.projectiles[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < game.projectiles.length; j += 1) {
      const b = game.projectiles[j];
      if (!b.alive || a.owner === b.owner || !overlaps(projectileBox(a), projectileBox(b))) continue;
      const exchange = Math.min(a.durability, b.durability);
      a.durability -= exchange;
      b.durability -= exchange;
      if (a.durability <= 0) a.alive = a.active = false;
      if (b.durability <= 0) b.alive = b.active = false;
      addEffect(game, "clash", (a.x + b.x) / 2, (a.y + b.y) / 2, 12, "#ffffff");
    }
  }
  game.projectiles = game.projectiles.filter((projectile) => projectile.alive);
}

function collectContacts(game, inputs) {
  const contacts = [];
  for (const attacker of game.fighters) {
    const move = attacker.currentMove;
    if (!move || isProjectileMove(move) || moveTags(move).has("nonAttack") || move.hitLevel === "none") continue;
    const frame = attacker.actionFrame + 1;
    const defender = game.fighters[1 - attacker.id];
    for (const hit of activeHits(move, frame)) {
      if (!canHitInstance(attacker, defender, hit.id)) continue;
      if (!canStrikeDefender(attacker, defender, move, hit, inputs[defender.id])) continue;
      const hitboxes = fighterHitboxes(attacker, move, hit, frame);
      const hurtboxes = fighterHurtboxes(defender, Boolean(hit.otg ?? move.otg ?? moveTags(move).has("otg")));
      const pair = findOverlappingBoxes(hitboxes, hurtboxes);
      if (!pair) continue;
      registerHitInstance(attacker, defender, hit.id);
      contacts.push(makeContact(move.category === "throw" ? "throw" : "strike", attacker, defender, move, hit, pair));
    }
  }

  for (const projectile of game.projectiles) {
    if (!projectile.alive || projectile.nextHitFrame > 0) continue;
    const attacker = game.fighters[projectile.owner];
    const defender = game.fighters[1 - projectile.owner];
    const hit = projectile.hits[Math.min(projectile.hitIndex, projectile.hits.length - 1)];
    if (!hit || !canStrikeDefender(attacker, defender, projectile.move, hit, inputs[defender.id])) continue;
    const hitbox = projectileBox(projectile);
    const pair = findOverlappingBoxes([hitbox], fighterHurtboxes(defender, Boolean(hit.otg ?? projectile.move.otg ?? moveTags(projectile.move).has("otg"))));
    if (!pair) continue;
    contacts.push({
      ...makeContact("projectile", attacker, defender, projectile.move, hit, pair),
      projectile,
      frameAdvantageBonus: projectile.frameAdvantageBonus,
      sourceX: projectile.x,
      direction: projectile.facing,
    });
  }
  // Preserve the authored hit order for multiple contacts that become active
  // on the same frame. Sorting by the string id would place e.g. hit10 before
  // hit2, which can make a cinematic's terminal hit resolve in the middle of
  // the sequence and then be overwritten by later non-terminal hits.
  return contacts.sort((a, b) =>
    a.defenderId - b.defenderId ||
    a.sourceId - b.sourceId ||
    a.hitOrder - b.hitOrder
  );
}

function makeContact(kind, attacker, defender, move, hit, pair) {
  const [hitbox, hurtbox] = pair;
  return {
    kind,
    sourceId: attacker.id,
    sourceX: attacker.x,
    direction: attacker.facing,
    defenderId: defender.id,
    impactX: midpoint(hitbox.left, hitbox.right, hurtbox.left, hurtbox.right),
    impactY: midpoint(hitbox.top, hitbox.bottom, hurtbox.top, hurtbox.bottom),
    move,
    hit,
    frameAdvantageBonus: attacker.driveRushAdvantageActionSerial === attacker.actionSerial
      ? attacker.driveRushAdvantageFrames
      : 0,
    hitOrder: Math.max(0, (move.hits ?? []).indexOf(hit)),
  };
}

function canStrikeDefender(attacker, defender, move, hit, input) {
  if (defender.health <= 0 || defender.invulnFrames > 0) return false;
  const kind = move.category === "throw" ? "throw" : "strike";
  if (kind === "throw") {
    if (defender.throwInvulnFrames > 0) return false;
    return isThrowable(defender);
  }
  if (defender.strikeInvulnFrames > 0 || isRollInvulnerable(defender)) return false;
  if (!defender.onGround && !canJuggle(defender, hit)) return false;
  if (defender.action === "knockdown" && !(hit.otg ?? move.otg ?? moveTags(move).has("otg"))) return false;
  const level = effectiveHitLevel(attacker, defender, move, hit);
  const tags = moveTags(move);
  const whiffsCrouch = hit.whiffsCrouch ?? move.whiffsCrouch ?? (
    hit.canHitCrouch === false || tags.has("whiffsOnCrouch") || tags.has("whiffsCrouch") ||
    (tags.has("conditionalOverhead") && move.hits?.[0]?.id === hit.id)
  );
  if (level === "high" && isCrouching(defender, input) && whiffsCrouch) return false;
  return true;
}

function resolveContacts(game, contacts, inputs) {
  let largestHitstop = 0;
  for (const contact of contacts) {
    const attacker = game.fighters[contact.sourceId];
    const defender = game.fighters[contact.defenderId];
    if (!attacker || !defender || defender.health <= 0) continue;
    const { move, hit } = contact;

    if (contact.kind === "throw" && canTechThrow(defender, inputs[defender.id])) {
      resolveThrowTech(game, attacker, defender, contact);
      consumeProjectileHit(contact.projectile);
      continue;
    }

    const parry = contact.kind !== "throw" && parryOutcome(defender);
    if (parry) {
      attacker.lastContact = contactSnapshot(game, attacker, defender, move, parry);
      defender.lastContact = contactSnapshot(game, defender, attacker, move, parry);
      changeDrive(defender, parry === "perfectParry" ? 55 : 25);
      if (parry === "perfectParry") {
        defender.nextComboProration = finite(defender.currentMove?.initialProration, 0.5);
        defender.invulnFrames = Math.max(defender.invulnFrames, finite(defender.currentMove?.postRecoveryInvulnerability, 5));
      }
      addEffect(game, parry === "perfectParry" ? "perfectParry" : "parry", contact.impactX, contact.impactY, 14, "#68fff0");
      recordCombatEvent(game, "contact", { fighterId: attacker.id, defenderId: defender.id, moveId: move.id, outcome: parry });
      consumeProjectileHit(contact.projectile);
      continue;
    }

    const blocked = contact.kind !== "throw" && canBlock(defender, inputs[defender.id], contact.sourceX, effectiveHitLevel(attacker, defender, move, hit));
    if (blocked) {
      const chargedBase = resolvedAuthoredDamage(attacker, hit, move) * finite(attacker.chargedDamageMultiplier, 1);
      const chip = scaledBaseDamage(attacker, finite(hit.chipDamage, finite(move.chipDamage, chargedBase * 0.08)));
      defender.health = Math.max(moveTags(move).has("chipKO") ? 0 : 1, defender.health - Math.max(0, Math.floor(chip)));
      const remaining = Math.max(0, move.totalFrames - (attacker.actionFrame + 1));
      const authoredBlockAdvantage = finite(move.block?.advantage, finite(move.hit?.blockAdvantage, finite(move.blockAdvantage, NaN)));
      const derivedBlockstun = Number.isFinite(authoredBlockAdvantage) ? Math.max(1, remaining + authoredBlockAdvantage) : 10;
      const frameAdvantageBonus = finite(contact.frameAdvantageBonus);
      const resolvedBlockstun = finite(hit.blockstun, finite(move.blockstun, derivedBlockstun)) + frameAdvantageBonus;
      defender.blockstunFrames = Math.max(defender.blockstunFrames, resolvedBlockstun);
      defender.blockstun = defender.blockstunFrames;
      defender.hitstunFrames = 0;
      defender.hitstun = 0;
      defender.vx = contact.direction * finite(hit.blockKnockback, finite(move.blockKnockback, 1.8));
      clearCurrentMove(defender);
      setLocomotionAction(defender, "block", defender.blockstunFrames);
      awardContactResources(attacker, defender, move, "block", hit);
      applyContactRefund(attacker, move, "block");
      if (defender.templateId === "ember") {
        damageGuardGauge(defender, finite(move.guardDamage, Math.max(2, baseDamage(hit, move) / 20)));
        if (defender.guardGauge <= 0) applyGuardBreak(game, defender);
      }
      attacker.lastContact = contactSnapshot(game, attacker, defender, move, "block");
      largestHitstop = Math.max(largestHitstop, Math.max(2, finite(hit.hitstop, finite(move.hitstop, 6)) - 2));
      addEffect(game, "block", contact.impactX, contact.impactY, 10, "#7ee7ff");
      recordCombatEvent(game, "contact", { fighterId: attacker.id, defenderId: defender.id, moveId: move.id, outcome: "block" });
      consumeProjectileHit(contact.projectile);
      continue;
    }

    if (contact.kind !== "throw" && absorbWithArmor(game, defender, attacker, move, hit, contact)) {
      attacker.lastContact = contactSnapshot(game, attacker, defender, move, "armor");
      recordCombatEvent(game, "contact", { fighterId: attacker.id, defenderId: defender.id, moveId: move.id, outcome: "armor" });
      consumeProjectileHit(contact.projectile);
      continue;
    }

    const counterType = contact.kind === "throw" ? "hit" : classifyCounterHit(defender);
    const authoredHits = move.hits ?? [];
    const hitIndex = authoredHits.findIndex((candidate) => candidate.id === hit.id);
    const finalAuthoredHit = authoredHits.length <= 1 || hitIndex === authoredHits.length - 1;
    const multiHitScalingStep = authoredHits.length > 1
      ? (hit.scalingStep ?? (finalAuthoredHit ? move.scalingStep ?? 0.1 : 0))
      : hit.scalingStep ?? move.scalingStep;
    const pendingProration = Number.isFinite(attacker.nextComboProration)
      ? Number(attacker.nextComboProration)
      : NaN;
    const scaledMoveHit = {
      ...hit,
      damage: scaledBaseDamage(attacker, resolvedAuthoredDamage(attacker, hit, move) * finite(attacker.chargedDamageMultiplier, 1)),
      counterType,
      minimumScaling: hit.minimumScaling ?? move.minimumScaling,
      scalingStep: multiHitScalingStep,
      initialProration: hit.initialProration ?? move.initialProration ?? (Number.isFinite(pendingProration) ? pendingProration : undefined),
    };
    if (!defender.onGround) consumeJuggle(defender, scaledMoveHit);
    const healthBefore = defender.health;
    const combo = beginOrExtendCombo(attacker, defender, move, scaledMoveHit);
    if (!combo.continuing && Number.isFinite(pendingProration)) attacker.nextComboProration = null;
    if (!combo.continuing) {
      const comboSequence = Number.isFinite(game.nextComboId) ? game.nextComboId : 1;
      game.nextComboId = comboSequence + 1;
      defender.comboId = `r${game.roundNumber ?? game.round ?? 1}-c${comboSequence}-p${attacker.id}`;
      defender.comboStartHealth = healthBefore;
      defender.comboAppliedDamage = 0;
      defender.comboForcedDamage = 0;
    }
    const scaledDamage = Math.max(0, combo.damage);
    const healthAfter = Math.max(0, healthBefore - scaledDamage);
    const appliedDamage = healthBefore - healthAfter;
    defender.health = healthAfter;
    defender.comboAppliedDamage += appliedDamage;
    defender.stunGauge = Math.min(defender.maxStunGauge, defender.stunGauge + finite(hit.stunDamage, finite(move.stunDamage, scaledMoveHit.damage * 0.035)));
    attacker.comboCount = combo.count;
    attacker.comboDamage = combo.totalDamage;
    game.combos[attacker.id] = { hits: combo.count, damage: combo.totalDamage, active: true, attackerId: attacker.id };
    awardContactResources(attacker, defender, move, counterType, hit);
    applyContactRefund(attacker, move, "hit");
    applyResolvedHit(game, attacker, defender, move, hit, contact, combo, counterType);
    if (hit.recoverableDamage || move.hit?.recoverableDamage || moveTags(move).has("recoverableDamage")) {
      defender.recoverableHealth = Math.min(defender.maxHealth - defender.health, defender.recoverableHealth + combo.damage);
    }
    attacker.lastContact = contactSnapshot(game, attacker, defender, move, counterType);
    defender.lastHitBy = attacker.id;
    largestHitstop = Math.max(largestHitstop, finite(hit.hitstop, finite(move.hitstop, 7)));
    const effectType = counterType === "punishCounter" ? "punishCounter" : counterType === "counter" ? "counter" : move.category === "super" || move.category === "climax" ? "superHit" : "hit";
    addEffect(game, effectType, contact.impactX, contact.impactY, counterType === "punishCounter" ? 20 : 13, counterType === "punishCounter" ? "#ff704f" : "#ffffff");
    recordCombatEvent(game, "contact", {
      fighterId: attacker.id,
      defenderId: defender.id,
      moveId: move.id,
      hitId: hit.id,
      outcome: counterType,
      damage: combo.damage,
      scaledDamage,
      appliedDamage,
      healthBefore,
      healthAfter,
      damageSource: "standard",
      damageModifier: activeDamageModifier(attacker, move),
      comboScale: combo.scaling,
      comboId: defender.comboId,
      comboStartHealth: defender.comboStartHealth,
      forcedDamage: defender.comboForcedDamage,
      comboCount: combo.count,
      comboDamage: combo.totalDamage,
      whiffPunish: counterType === "punishCounter",
    });
    if (contact.kind === "throw") recordCombatEvent(game, "throw", { fighterId: attacker.id, defenderId: defender.id, moveId: move.id });
    consumeProjectileHit(contact.projectile);
    if (defender.health <= 0) resolveKO(game, attacker, defender, contact);
  }
  game.hitstopFrames = Math.max(game.hitstopFrames, largestHitstop);
  game.projectiles = game.projectiles.filter((projectile) => projectile.alive);
}

function applyContactRefund(fighter, move, outcome) {
  const refund = outcome === "block"
    ? move.hit?.refundOnHitOrBlock
    : move.hit?.refundOnHit ?? move.hit?.refundOnHitOrBlock;
  if (!refund) return;
  if (finite(refund.super) > 0) gainSuperMeter(fighter, finite(refund.super));
  if (finite(refund.drive) !== 0) changeDrive(fighter, finite(refund.drive));
}

function applyResolvedHit(game, attacker, defender, move, hit, contact, combo, counterType) {
  defender.blockstunFrames = 0;
  defender.blockstun = 0;
  defender.strikeInvulnFrames = 0;
  defender.throwInvulnFrames = 0;
  clearCurrentMove(defender);
  const authoredHits = move.hits ?? [];
  const hitIndex = authoredHits.findIndex((candidate) => candidate.id === hit.id);
  const allowMoveTerminalFallback = authoredHits.length <= 1 || hitIndex === authoredHits.length - 1;
  const knockdownType = inferKnockdownType(game, defender, move, hit, counterType, allowMoveTerminalFallback);
  const remaining = Math.max(0, move.totalFrames - (attacker.actionFrame + 1));
  const authoredHitAdvantage = finite(move.hit?.advantage, finite(move.hitAdvantage, NaN));
  const derivedHitstun = Number.isFinite(authoredHitAdvantage)
    ? Math.max(1, remaining + authoredHitAdvantage)
    : knockdownType === KNOCKDOWN_TYPES.none ? 14 : 22;
  const driveRushBonus = knockdownType === KNOCKDOWN_TYPES.none ? finite(contact.frameAdvantageBonus) : 0;
  const hitstun = scaledHitstun(
    finite(hit.hitstun, finite(move.hitstun, derivedHitstun)),
    combo.count,
    counterType === "punishCounter" ? 4 : counterType === "counter" ? 2 : 0,
  ) + driveRushBonus;
  defender.hitstunFrames = hitstun;
  defender.hitstun = hitstun;
  const reaction = {
    ...move,
    ...hit,
    knockdownType,
    launchX: hit.launchX ?? hit.knockback ?? (allowMoveTerminalFallback ? move.launchX ?? move.knockback : undefined),
    launchY: hit.launchY ?? (allowMoveTerminalFallback ? move.launchY : undefined),
    groundBounces: hit.groundBounces ?? (allowMoveTerminalFallback ? move.groundBounces ?? move.knockdown?.groundBounces : undefined),
    wallBounces: hit.wallBounces ?? (allowMoveTerminalFallback ? move.wallBounces ?? move.knockdown?.wallBounces : undefined),
  };
  applyHitReaction(defender, reaction, contact.direction);
  defender.pendingKnockdown = knockdownType !== KNOCKDOWN_TYPES.none;
  defender.pendingKnockdownFrames = finite(hit.knockdownDuration, finite(move.knockdownDuration, knockdownType === KNOCKDOWN_TYPES.hard ? 48 : 32));
  const branchCanContinue = asArray(move.routeTo).length > 0 && [KNOCKDOWN_TYPES.soft, KNOCKDOWN_TYPES.launch].includes(knockdownType);
  if (branchCanContinue) {
    defender.onGround = true;
    defender.y = game.arena.floorY;
    defender.vy = 0;
  }
  if (knockdownType === KNOCKDOWN_TYPES.none && defender.onGround) {
    defender.vy = 0;
    defender.onGround = true;
  }
  setLocomotionAction(defender, "hit", hitstun);
  if (hit.sideSwitch || move.hit?.sideSwitch || move.knockdown?.sideSwitch || moveTags(move).has("sideSwitch")) {
    const attackerX = attacker.x;
    attacker.x = defender.x;
    defender.x = attackerX;
    clampHorizontal(attacker, game.arena);
    clampHorizontal(defender, game.arena);
    attacker.facing *= -1;
    defender.facing *= -1;
  }
  if (defender.stunGauge >= defender.maxStunGauge && defender.health > 0) {
    defender.stunGauge = 0;
    defender.hitstunFrames = 90;
    defender.hitstun = 90;
    defender.knockdownType = KNOCKDOWN_TYPES.crumple;
    defender.pendingKnockdown = false;
    defender.onGround = true;
    // A KOF-style dizzy is a new confirm phase. Damage scaling partially
    // refreshes, enabling difficult full-resource stun-to-TOD routes.
    defender.comboScaling = Math.max(defender.comboScaling, 0.65);
    recordCombatEvent(game, "stun", { fighterId: defender.id, attackerId: attacker.id, comboCount: combo.count });
    addEffect(game, "stun", defender.x, defender.y - defender.height, 60, "#ffd166");
  }
}

function inferKnockdownType(game, defender, move, hit, counterType, allowMoveTerminalFallback = true) {
  const tags = moveTags(move);
  const airborne = !defender.onGround;
  const airResult = hit.airHitType ?? (allowMoveTerminalFallback ? move.knockdown?.airHitType ?? move.hit?.onAir : undefined);
  if (airborne && String(airResult ?? "").toLowerCase().includes("wallbounce")) return KNOCKDOWN_TYPES.wallBounce;
  if (tags.has("driveImpact")) {
    if (airborne) return KNOCKDOWN_TYPES.launch;
    if (counterType === "punishCounter") return KNOCKDOWN_TYPES.crumple;
    if (isCornered(defender, game.arena)) return KNOCKDOWN_TYPES.wallBounce;
  }
  if (counterType === "punishCounter" && (tags.has("punishHardKnockdown") || tags.has("sweep"))) return KNOCKDOWN_TYPES.hard;
  const authored = hit.knockdownType ?? hit.onHitState ?? hit.onHit?.kind ?? (
    allowMoveTerminalFallback
      ? move.knockdownType ?? move.onHitState ?? move.onHit?.kind ?? move.hit?.state ?? move.knockdown?.type
      : undefined
  );
  const text = String(authored ?? "").toLowerCase();
  if (text.includes("groundbounce")) return KNOCKDOWN_TYPES.groundBounce;
  if (text.includes("wallbounce") || text.includes("wallsplat")) return KNOCKDOWN_TYPES.wallBounce;
  if (text.includes("crumple") || (counterType === "punishCounter" && tags.has("punishCrumple"))) return KNOCKDOWN_TYPES.crumple;
  if (text.includes("conditional")) return counterType === "punishCounter" ? KNOCKDOWN_TYPES.crumple : KNOCKDOWN_TYPES.soft;
  if (text.includes("launch") || text.includes("juggle") || text.includes("tumble") || text.includes("spin") || text.includes("airslam")) return KNOCKDOWN_TYPES.launch;
  if (text.includes("hard") || text === "hkd" || move.hardKnockdown) return KNOCKDOWN_TYPES.hard;
  if (text.includes("soft") || text === "skd" || text === "normal" || move.knockdown === true || hit.knockdown === true) return KNOCKDOWN_TYPES.soft;
  return KNOCKDOWN_TYPES.none;
}

function resolveThrowTech(game, attacker, defender, contact) {
  clearCurrentMove(attacker);
  clearCurrentMove(defender);
  setLocomotionAction(attacker, "idle");
  setLocomotionAction(defender, "idle");
  attacker.vx = -attacker.facing * 3;
  defender.vx = attacker.facing * 3;
  attacker.lastContact = contactSnapshot(game, attacker, defender, contact.move, "throwTech");
  addEffect(game, "throwTech", contact.impactX, contact.impactY, 16, "#a6f7ff");
  recordCombatEvent(game, "throwTech", { fighterId: defender.id, attackerId: attacker.id, moveId: contact.move.id });
}

function canTechThrow(defender, input) {
  if (defender.throwInvulnFrames > 0) return false;
  return Boolean(input.throw || defender.pressedButtons.includes("throw") || (defender.currentMove?.category === "throw" && defender.actionFrame <= 6));
}

function absorbWithArmor(game, defender, attacker, move, hit, contact) {
  if (defender.armorHits <= 0 || (defender.armorThroughFrame > 0 && defender.actionFrame + 1 > defender.armorThroughFrame)) return false;
  defender.armorHits -= 1;
  const recoverable = Math.max(1, Math.floor(scaledBaseDamage(attacker, resolvedAuthoredDamage(attacker, hit, move)) * 0.5));
  defender.health = Math.max(1, defender.health - recoverable);
  defender.recoverableHealth = Math.min(defender.maxHealth - defender.health, defender.recoverableHealth + recoverable);
  addEffect(game, "armor", contact.impactX, contact.impactY, 14, "#ffb35d");
  return true;
}

function parryOutcome(defender) {
  const move = defender.currentMove;
  if (!move || !moveTags(move).has("parry")) return null;
  const frame = defender.actionFrame + 1;
  const activeStart = Math.min(...move.activeWindows.map((window) => window.start));
  const activeEnd = Math.max(...move.activeWindows.map((window) => window.end));
  if (frame < activeStart || frame > activeEnd) return null;
  return frame <= activeStart + 1 ? "perfectParry" : "parry";
}

function isRollInvulnerable(fighter) {
  const move = fighter.currentMove;
  if (!move || !moveTags(move).has("roll")) return false;
  return fighter.actionFrame + 1 <= finite(move.invulnThroughFrame, 24);
}

function applyGuardBreak(game, fighter) {
  fighter.guardGauge = fighter.maxGuardGauge * 0.55;
  fighter.blockstunFrames = 0;
  fighter.hitstunFrames = 65;
  fighter.hitstun = 65;
  clearCurrentMove(fighter);
  setLocomotionAction(fighter, "guardBreak", 65);
  recordCombatEvent(game, "guardBreak", { fighterId: fighter.id });
  addEffect(game, "guardBreak", fighter.x, fighter.y - fighter.height * 0.65, 24, "#8aa7ff");
}

function resolveKO(game, attacker, defender, contact) {
  defender.vy = -4.8;
  defender.onGround = false;
  defender.pendingKnockdown = false;
  defender.hitstunFrames = 0;
  clearCurrentMove(defender);
  setLocomotionAction(defender, "ko", 42);
  defender.actionFrame = 42;
  const combo = { count: attacker.comboCount, damage: attacker.comboDamage };
  if (combo.count > 0) {
    recordComboEnd(game, attacker.id, {
      count: combo.count,
      damage: combo.damage,
      comboId: defender.comboId,
      startHealth: defender.comboStartHealth,
      endHealth: defender.health,
      maxHealth: defender.maxHealth,
      appliedDamage: defender.comboAppliedDamage,
      forcedDamage: defender.comboForcedDamage,
      damageSource: defender.comboForcedDamage > 0 ? "mixed" : "standard",
      continuous: defender.comboOwner === attacker.id,
    });
  }
  addEffect(game, "ko", contact.impactX, contact.impactY, 24, "#fff1a8");
}

function consumeProjectileHit(projectile) {
  if (!projectile) return;
  projectile.hitIndex += 1;
  if (projectile.hitIndex >= projectile.hits.length) {
    projectile.alive = false;
    projectile.active = false;
  } else {
    projectile.nextHitFrame = 3;
  }
}

function resolvePostContactCancels(game) {
  for (const fighter of game.fighters) {
    const request = fighter.cancelRequest;
    const current = fighter.currentMove;
    if (!request || !current) continue;
    const target = getMoveData(fighter.templateId, request.moveId);
    if (!target || !canCancelInto(fighter, current, target, game.frame)) continue;
    const cancelOutcome = fighter.lastContact?.outcome ?? "whiff";
    if (startMove(game, fighter, request.moveId, target, request.motionMatch)) {
      fighter.commandBuffer = null;
      fighter.cancelRequest = null;
      recordCombatEvent(game, "cancel", {
        fighterId: fighter.id,
        fromMoveId: current.id,
        toMoveId: target.id,
        outcome: cancelOutcome,
      });
    }
  }
}

function canCancelInto(fighter, current, target, frame) {
  const authoredFrame = fighter.actionFrame + 1;
  const contact = fighter.lastContact;
  const outcome = contact && contact.actionSerial === fighter.actionSerial && frame - contact.frame <= 18 ? contact.outcome : "whiff";
  const targetRoutes = asArray(target.routeFrom ?? target.followupFrom ?? target.from);
  if (targetRoutes.includes(current.id) || targetRoutes.includes(fighter.action)) {
    if (outcome !== "whiff" || moveTags(target).has("whiffRoute") || moveTags(current).has("whiffCancel")) return true;
  }
  for (const rule of current.cancels ?? []) {
    const ruleEnd = rule.delayable ? current.totalFrames : rule.end;
    if (authoredFrame < rule.start || authoredFrame > ruleEnd) continue;
    const allowedOutcomes = asArray(rule.on);
    if (!allowedOutcomes.includes("always") && !allowedOutcomes.includes(outcome) && !(outcome === "perfectParry" && allowedOutcomes.includes("hit"))) continue;
    if (rule.requiresContact !== false && outcome === "whiff" && !allowedOutcomes.includes("whiff")) continue;
    if (rule.moves.length > 0 && !rule.moves.includes(target.id)) continue;
    if (asArray(rule.into).some((entry) => cancelEntryMatchesTarget(entry, target))) return true;
  }
  const mask = new Set(asArray(current.cancelMask ?? current.cancelTier).flatMap((value) => String(value).split(/[+/,| ]+/)).filter(Boolean));
  if (outcome === "whiff" && !mask.has("whiff")) return false;
  if (mask.has("C") || mask.has("special")) {
    if (["special", "od", "super", "climax", "system"].includes(target.category)) return true;
  }
  if (mask.has("SA3") && (moveTags(target).has("sa3") || moveTags(target).has("criticalArt") || moveTags(target).has("ca"))) return true;
  if (mask.has("SA2") && (moveTags(target).has("sa2") || moveTags(target).has("sa3"))) return true;
  if (mask.has("super") && ["super", "climax"].includes(target.category)) return true;
  if (mask.has("command") && target.category === "commandNormal") return true;
  if (moveTags(current).has("rapid") && target.category === "normal" && target.strength === "light" && outcome !== "whiff") return true;
  if (target.category === "system" && moveTags(target).has("quickMax") && outcome !== "whiff") return true;
  return false;
}

function cancelEntryMatchesTarget(entry, target) {
  const token = String(entry ?? "").toLowerCase();
  const id = String(target.id ?? "").toLowerCase();
  const category = String(target.category ?? "").toLowerCase();
  const tags = new Set([...moveTags(target)].map((tag) => String(tag).toLowerCase()));
  if (token === id || token === category || tags.has(token)) return true;
  if (token === "super2") return tags.has("sa2");
  if (token === "super3") return tags.has("sa3") || tags.has("criticalart") || tags.has("ca");
  if (token === "criticalart") return id === "criticalart" || tags.has("criticalart") || tags.has("ca");
  if (token === "driverushcancel") return id === "canceldriverush" || tags.has("normalcancelroute");
  if (token === "driveimpact") return id === "driveimpact" || tags.has("driveimpact");
  if (token === "od") return category === "od" || tags.has("ex");
  if (token === "special") return category === "special";
  if (token === "super") return category === "super" || category === "climax";
  return false;
}

function finishExpiredCombos(game) {
  for (const defender of game.fighters) {
    if (defender.comboOwner !== 0 && defender.comboOwner !== 1) continue;
    const previousCount = defender.comboCount;
    const previousDamage = defender.comboDamage;
    const previousComboId = defender.comboId;
    const previousStartHealth = defender.comboStartHealth;
    const previousAppliedDamage = defender.comboAppliedDamage;
    const previousForcedDamage = defender.comboForcedDamage;
    const owner = defender.comboOwner;
    if (!tickComboState(defender)) continue;
    if (owner === 0 || owner === 1) {
      recordComboEnd(game, owner, {
        count: previousCount,
        damage: previousDamage,
        comboId: previousComboId,
        startHealth: previousStartHealth,
        endHealth: defender.health,
        maxHealth: defender.maxHealth,
        appliedDamage: previousAppliedDamage,
        forcedDamage: previousForcedDamage,
        damageSource: previousForcedDamage > 0 ? "mixed" : "standard",
        continuous: Boolean(previousComboId),
      });
      game.combos[owner] = { hits: previousCount, damage: previousDamage, active: false, attackerId: owner };
      const attacker = game.fighters[owner];
      attacker.comboCount = 0;
      attacker.comboDamage = 0;
      defender.comboId = null;
      defender.comboStartHealth = null;
      defender.comboAppliedDamage = 0;
      defender.comboForcedDamage = 0;
    }
  }
}

function activeHits(move, frame) {
  return (move.hits ?? []).filter((hit) => {
    if (frame < hit.start || frame > hit.end) return false;
    const matchingWindows = move.activeWindows.filter((window) => window.hitId === hit.id);
    if (matchingWindows.length === 0) return true;
    return matchingWindows.some((window) => frame >= window.start && frame <= window.end);
  });
}

function fighterHitboxes(fighter, move, hit, frame) {
  const source = hit.hitboxes?.length ? hit.hitboxes : move.hitboxes ?? [];
  const authored = source.filter((box) => {
    const start = finite(box.start, hit.start);
    const end = finite(box.end, hit.end);
    return frame >= start && frame <= end;
  });
  // Once an author supplies a hitbox track, an empty frame is intentional (or
  // a data error caught by validation); never backfill it with a ghost box.
  const boxes = source.length > 0 ? authored : [fallbackHitbox(move, hit)];
  return boxes.map((definition) => fighterBox(fighter, definition));
}

function fallbackHitbox(move, hit) {
  const range = finite(hit.range, finite(move.range, estimatedMoveRange(move)));
  const animation = normalizedMoveAnimation(move);
  const profile = fallbackHitboxProfile(animation, move, hit);
  const width = Math.max(profile.minimumWidth, range * profile.widthScale);
  return {
    offsetX: Math.max(profile.minimumOffsetX, range * profile.offsetScale),
    offsetY: profile.offsetY,
    width,
    height: profile.height,
  };
}

function normalizedMoveAnimation(move) {
  return String(move?.animation ?? move?.animationAction ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function fallbackHitboxProfile(animation, move, hit) {
  const base = {
    offsetY: -62,
    height: 36,
    offsetScale: 0.58,
    widthScale: 1,
    minimumOffsetX: 28,
    minimumWidth: 44,
  };
  const profiles = {
    highlight: { offsetY: -78, height: 38 },
    highheavy: { offsetY: -94, height: 32 },
    midlight: { offsetY: -61, height: 32 },
    midheavy: { offsetY: -55, height: 34 },
    lowlight: { offsetY: -18, height: 26 },
    lowheavy: { offsetY: -11, height: 26 },
    airlight: { offsetY: -73, height: 32 },
    airheavy: { offsetY: -16, height: 30 },
    airtatsu: { offsetY: -50, height: 36 },
    airhammer: { offsetY: -27, height: 46 },
    rekkalight: { offsetY: -60, height: 38 },
    rekkaheavy: { offsetY: -46, height: 48 },
    dragonpunch: { offsetY: -91, height: 116 },
    fireballlight: { offsetY: -65, height: 38 },
    fireballheavy: { offsetY: -54, height: 46 },
  };
  const authored = profiles[animation] ?? {};
  const level = String(hit?.hitLevel ?? move?.hitLevel ?? "").toLowerCase();
  const semantic = move?.category === "throw"
    ? { offsetY: -60, height: 70, offsetScale: 0.56, widthScale: 0.92 }
    : level === "low"
      ? { offsetY: -18, height: 30 }
      : (move?.stance === "air" || move?.command?.air)
        ? { offsetY: -42, height: 44 }
        : {};
  return { ...base, ...semantic, ...authored };
}

function fighterHurtboxes(fighter, allowOTG = false) {
  if (fighter.action === "ko") return [];
  if (fighter.action === "knockdown" && !allowOTG) return [];
  if (fighter.action === "knockdown") {
    return [fighterBox(fighter, { offsetX: -5, offsetY: -26, width: 110, height: 56 })];
  }
  const airborne = !fighter.onGround || fighter.action === "jump";
  const crouching = !airborne && isCrouching(fighter);
  const base = airborne
    ? [
        { offsetX: 0, offsetY: -83, width: 46, height: 62 },
        { offsetX: 0, offsetY: -31, width: 52, height: 54 },
      ]
    : crouching
      ? [
          { offsetX: 0, offsetY: -63, width: 50, height: 62 },
          { offsetX: 0, offsetY: -17, width: 56, height: 34 },
        ]
      : [
          { offsetX: 0, offsetY: -79, width: 44, height: 70 },
          { offsetX: 0, offsetY: -26, width: 34, height: 52 },
        ];
  const frame = fighter.actionFrame + 1;
  const authored = (fighter.currentMove?.hurtboxes ?? []).filter((box) => frame >= finite(box.start, 1) && frame <= finite(box.end, fighter.currentMove.totalFrames));
  const procedural = proceduralLimbHurtboxes(fighter, frame);
  const definitions = authored.length > 0 && fighter.currentMove?.hurtboxMode !== "append"
    ? authored
    : [...base, ...procedural, ...authored];
  return definitions.map((definition) => fighterBox(fighter, definition));
}

function proceduralLimbHurtboxes(fighter, frame) {
  const move = fighter.currentMove;
  if (!move) return [];
  const animation = normalizedMoveAnimation(move);
  const profiles = {
    highlight: { offsetX: 40, offsetY: -78, width: 56, height: 30 },
    highheavy: { offsetX: 45, offsetY: -94, width: 64, height: 30 },
    midlight: { offsetX: 38, offsetY: -61, width: 56, height: 28 },
    midheavy: { offsetX: 46, offsetY: -55, width: 70, height: 30 },
    lowlight: { offsetX: 40, offsetY: -18, width: 62, height: 24 },
    lowheavy: { offsetX: 48, offsetY: -11, width: 78, height: 24 },
    airlight: { offsetX: 40, offsetY: -73, width: 62, height: 28 },
    airheavy: { offsetX: 44, offsetY: -16, width: 70, height: 28 },
    airtatsu: { offsetX: 48, offsetY: -50, width: 82, height: 32 },
    airhammer: { offsetX: 28, offsetY: -28, width: 48, height: 44 },
    rekkalight: { offsetX: 44, offsetY: -60, width: 68, height: 30 },
    rekkaheavy: { offsetX: 52, offsetY: -46, width: 84, height: 38 },
    dragonpunch: { offsetX: 18, offsetY: -116, width: 38, height: 82 },
    fireballlight: { offsetX: 34, offsetY: -64, width: 58, height: 34 },
    fireballheavy: { offsetX: 42, offsetY: -54, width: 70, height: 40 },
    throw: { offsetX: 36, offsetY: -60, width: 58, height: 38 },
    light: { offsetX: 40, offsetY: -68, width: 56, height: 30 },
    heavy: { offsetX: 45, offsetY: -70, width: 66, height: 34 },
    special: { offsetX: 36, offsetY: -64, width: 60, height: 36 },
  };
  const profile = profiles[animation];
  if (!profile) return [];
  const windows = move.activeWindows ?? [];
  const firstActive = Math.min(...windows.map((window) => window.start));
  const lastActive = Math.max(...windows.map((window) => window.end));
  let extension = 0;
  const activeWindow = windows.find((window) => frame >= window.start && frame <= window.end);
  if (activeWindow) {
    extension = 1;
  } else if (frame > firstActive && frame < lastActive) {
    const previous = [...windows].reverse().find((window) => window.end < frame);
    const next = windows.find((window) => window.start > frame);
    if (previous && next) {
      const progress = inclusiveFrameProgress(frame, previous.end + 1, next.start - 1, 0.5);
      extension = Math.abs(progress - 0.5) * 2;
    }
  } else if (frame > lastActive) {
    const progress = inclusiveFrameProgress(frame, lastActive + 1, move.totalFrames);
    extension = 1 - progress;
  }
  if (extension < 0.22) return [];
  return [{
    offsetX: profile.offsetX * extension,
    offsetY: lerp(-56, profile.offsetY, extension),
    width: Math.max(20, profile.width * extension),
    height: Math.max(20, profile.height * (0.72 + extension * 0.28)),
  }];
}

function inclusiveFrameProgress(frame, start, end, singleFrameValue = 1) {
  if (end <= start) return singleFrameValue;
  return clamp((frame - start) / (end - start), 0, 1);
}

function fighterBox(fighter, definition) {
  const scale = fighter.height / BOX_REFERENCE_HEIGHT;
  const centerX = fighter.x + fighter.facing * finite(definition.offsetX) * scale;
  const centerY = fighter.y + finite(definition.offsetY, -56) * scale;
  return boxFromCenter(centerX, centerY, finite(definition.width, 46) * scale, finite(definition.height, 46) * scale);
}

function projectileBox(projectile) {
  return boxFromCenter(projectile.x, projectile.y, projectile.width, projectile.height);
}

function resolveStageAndPushboxes(game) {
  const [a, b] = game.fighters;
  clampHorizontal(a, game.arena);
  clampHorizontal(b, game.arena);
  if (IMMOBILE_ACTIONS.has(a.action) || IMMOBILE_ACTIONS.has(b.action)) return;
  const overlap = a.width / 2 + b.width / 2 - Math.abs(b.x - a.x);
  const verticalOverlap = Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.72;
  if (overlap <= 0 || !verticalOverlap) return;
  const direction = a.x <= b.x ? 1 : -1;
  a.x -= direction * overlap / 2;
  b.x += direction * overlap / 2;
  clampHorizontal(a, game.arena);
  clampHorizontal(b, game.arena);
}

function refreshFacing(fighters) {
  const [a, b] = fighters;
  if (!a.currentMove && !IMMOBILE_ACTIONS.has(a.action)) a.facing = a.x <= b.x ? 1 : -1;
  if (!b.currentMove && !IMMOBILE_ACTIONS.has(b.action)) b.facing = b.x >= a.x ? -1 : 1;
}

function canBlock(defender, input, sourceX, hitLevel = "mid") {
  if (!defender.onGround || IMMOBILE_ACTIONS.has(defender.action) || defender.currentMove) return false;
  const sourceDirection = Math.sign(sourceX - defender.x);
  if (sourceDirection !== 0 && sourceDirection !== defender.facing) return false;
  const direction = relativeDirection(input, defender.facing);
  const guarding = input.guard || direction === "back" || direction === "downBack";
  if (!guarding) return false;
  const crouching = isCrouching(defender, input);
  const level = String(hitLevel).toLowerCase();
  if (level === "low") return crouching;
  if (["overhead", "midhigh", "jump", "air", "highoverhead"].includes(level)) return !crouching;
  return true;
}

function isCrouching(fighter, input = fighter.lastInput) {
  if (!fighter.onGround || fighter.action === "jump") return false;
  const move = fighter.currentMove;
  const animation = normalizedMoveAnimation(move);
  const authoredCrouch = move
    ? moveTags(move).has("crouching") || animation.startsWith("low")
    : false;
  return fighter.action === "crouch"
    || fighter.guardHeight === "crouching"
    || authoredCrouch
    || Boolean(input?.down);
}

function isThrowable(fighter) {
  return fighter.health > 0 && fighter.onGround && !IMMOBILE_ACTIONS.has(fighter.action);
}

function finishRoundFromHealth(game, reason) {
  const [a, b] = game.fighters;
  let winner = -1;
  if (a.health > 0 && b.health <= 0) winner = 0;
  else if (b.health > 0 && a.health <= 0) winner = 1;
  finishRound(game, winner, reason);
}

function finishRoundOnTime(game) {
  const [a, b] = game.fighters;
  let winner = -1;
  if (a.health !== b.health) winner = a.health > b.health ? 0 : 1;
  else if (a.superMeter !== b.superMeter) winner = a.superMeter > b.superMeter ? 0 : 1;
  finishRound(game, winner, "time");
}

function finishRound(game, winner, reason) {
  if (game.phase !== "fighting") return;
  game.roundWinner = winner;
  game.roundReason = reason;
  game.projectiles = [];
  game.hitstopFrames = 0;
  if (winner === 0 || winner === 1) {
    game.score[winner] += 1;
    for (let index = 0; index < 2; index += 1) {
      game.fighters[index].roundsWon = game.score[index];
      game.fighters[index].rounds = game.score[index];
    }
    if (game.score[winner] >= game.config.winsNeeded) {
      game.matchWinner = winner;
      game.phase = "matchOver";
      return;
    }
  }
  game.phase = "roundOver";
}

function setLocomotionAction(fighter, action, duration = 0) {
  if (!LOCOMOTION_ACTIONS.has(action)) throw new Error(`Unknown locomotion action: ${action}`);
  if (fighter.action === action && !fighter.currentMove) fighter.actionFrame += 1;
  else {
    fighter.action = action;
    fighter.state = action;
    fighter.actionFrame = 0;
  }
  fighter.actionDuration = duration;
  fighter.moveAnimation = action;
  fighter.movePhase = action;
}

function phaseForMove(move, authoredFrame) {
  if (authoredFrame < move.startup) return "startup";
  if (move.activeWindows.some((window) => authoredFrame >= window.start && authoredFrame <= window.end)) return "active";
  const activeEnd = Math.max(...move.activeWindows.map((window) => window.end));
  return authoredFrame <= activeEnd ? "gap" : "recovery";
}

function contactSnapshot(game, attacker, defender, move, outcome) {
  return {
    frame: game.frame,
    actionSerial: attacker.actionSerial,
    moveId: move.id,
    defenderId: defender.id,
    outcome,
  };
}

function refreshCombatSnapshot(game) {
  const hitboxes = [];
  for (const fighter of game.fighters) {
    for (const box of fighterHurtboxes(fighter, false)) hitboxes.push(debugBox(box, "hurt", fighter.id));
    const move = fighter.currentMove;
    if (
      move &&
      !isProjectileMove(move) &&
      !moveTags(move).has("nonAttack") &&
      move.hitLevel !== "none"
    ) {
      const frame = fighter.actionFrame + 1;
      for (const hit of activeHits(move, frame)) {
        for (const box of fighterHitboxes(fighter, move, hit, frame)) hitboxes.push(debugBox(box, "hit", fighter.id));
      }
    }
  }
  for (const projectile of game.projectiles) {
    if (projectile.alive) hitboxes.push(debugBox(projectileBox(projectile), "projectile", projectile.owner));
  }
  game.hitboxes = hitboxes;
  game.frameData = game.fighters.map((fighter) => {
    const move = fighter.currentMove;
    const activeEnd = move?.activeWindows?.length
      ? Math.max(...move.activeWindows.map((window) => window.end))
      : 0;
    const timelineRecovery = move ? Math.max(0, move.totalFrames - activeEnd) : 0;
    return {
      action: fighter.action,
      moveId: move?.id ?? null,
      moveName: move?.name ?? fighter.action,
      frame: move ? fighter.actionFrame + 1 : fighter.actionFrame,
      startup: move?.startup ?? 0,
      // Keep the legacy active-span field stable for replay/SDK consumers.
      // activeFrameCount is the exact union of effective attack frames.
      active: move?.active ?? 0,
      activeFrameCount: move?.activeFrameCount ?? move?.active ?? 0,
      activeSpan: move?.active ?? 0,
      gap: move ? Math.max(0, (move.active ?? 0) - (move.activeFrameCount ?? move.active ?? 0)) : 0,
      activeWindows: move?.activeWindows?.map((window) => ({
        start: window.start,
        end: window.end,
        hitId: window.hitId,
      })) ?? [],
      recovery: move?.recovery ?? 0,
      timelineRecovery,
      landingRecovery: move?.landingRecovery ?? move?.landRecovery ?? 0,
      phase: move ? phaseForMove(move, fighter.actionFrame + 1) : fighter.action,
      templateName: fighter.templateName,
    };
  });
}

function isProjectileMove(move) {
  return Boolean(move?.projectile || moveTags(move).has("projectile") || move?.kind === "projectile");
}

function baseDamage(hit, move) {
  return finite(hit.damage, finite(move.damage));
}

function resolvedAuthoredDamage(attacker, hit, move) {
  const authoredFrame = finite(attacker?.actionFrame) + 1;
  const lateWindow = hit?.lateWindow;
  let damage;
  if (
    Number.isFinite(hit?.lateDamage) && lateWindow &&
    authoredFrame >= finite(lateWindow.start, Infinity) && authoredFrame <= finite(lateWindow.end, -Infinity)
  ) {
    damage = Number(hit.lateDamage);
  } else if (Number.isFinite(hit?.nonCinematicLateDamage) && authoredFrame > finite(hit.start, move.startup)) {
    damage = Number(hit.nonCinematicLateDamage);
  } else {
    damage = baseDamage(hit, move);
  }
  return damage * activeDamageModifier(attacker, move);
}

function activeDamageModifier(attacker, move) {
  if (finite(attacker?.maxModeFrames) <= 0) return 1;
  return Math.max(0, finite(move?.maxModeDamageMultiplier, 1));
}

function effectiveHitLevel(attacker, defender, move, hit) {
  if (!hit?.overheadOnlyIfFirstWhiffs) return hit?.hitLevel ?? move?.hitLevel ?? "mid";
  const firstHitId = move?.hits?.[0]?.id;
  if (!firstHitId) return hit.hitLevel ?? move.hitLevel ?? "mid";
  const firstKey = `${attacker.actionSerial ?? 0}:${defender.id}:${firstHitId}`;
  return attacker.hitRegistry?.[firstKey] ? "high" : hit.hitLevel ?? move.hitLevel ?? "overhead";
}

function scaledBaseDamage(attacker, damage) {
  const moveset = BASE_MOVESETS[attacker.templateId];
  const scale = finite(moveset.healthDamageScale, attacker.templateId === "vanguard" ? 0.1 : 1);
  return Math.max(0, damage * scale);
}

function estimatedMoveRange(move) {
  const boxes = move.hitboxes ?? move.hits?.flatMap((hit) => hit.hitboxes ?? []) ?? [];
  return boxes.reduce((maximum, box) => Math.max(maximum, Math.abs(finite(box.offsetX)) + finite(box.width) / 2), 66);
}

function moveTags(move) {
  return new Set(asArray(move?.tags));
}

function getCanonicalMoveId(templateId, moveId) {
  const moveset = BASE_MOVESETS[normalizeTemplateId(templateId)];
  return moveset.aliases?.[moveId] ?? moveId;
}

function isCornered(fighter, arena) {
  return fighter.x <= arena.left + fighter.width || fighter.x >= arena.right - fighter.width;
}

function clampHorizontal(fighter, arena) {
  const half = fighter.width / 2;
  fighter.x = clamp(fighter.x, arena.left + half, arena.right - half);
}

function clampFighter(fighter, arena) {
  clampHorizontal(fighter, arena);
  if (fighter.y > arena.floorY) {
    fighter.y = arena.floorY;
    fighter.vy = 0;
    fighter.onGround = true;
  }
}

function boxFromCenter(x, y, width, height) {
  return { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
}

function overlaps(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function findOverlappingBoxes(hitboxes, hurtboxes) {
  for (const hitbox of hitboxes) for (const hurtbox of hurtboxes) if (overlaps(hitbox, hurtbox)) return [hitbox, hurtbox];
  return null;
}

function midpoint(a1, a2, b1, b2) {
  return (Math.max(a1, b1) + Math.min(a2, b2)) / 2;
}

function debugBox(box, type, owner) {
  return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, type, owner };
}

function addEffect(game, type, x, y, lifeFrames, color) {
  game.effects.push({
    id: game.nextEffectId++, type, x, y, frame: 0,
    lifeFrames, maxLifeFrames: lifeFrames, life: lifeFrames, maxLife: lifeFrames,
    duration: lifeFrames, color,
  });
}

function updateEffects(game) {
  for (const effect of game.effects) {
    effect.frame += 1;
    effect.lifeFrames -= 1;
    effect.life = effect.lifeFrames;
  }
  game.effects = game.effects.filter((effect) => effect.lifeFrames > 0);
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, minimum, maximum) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function assertGame(game) {
  if (!game || !Array.isArray(game.fighters) || game.fighters.length !== 2) {
    throw new TypeError("Expected a game created by createGame().");
  }
}
