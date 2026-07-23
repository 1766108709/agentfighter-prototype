export const MOVE_CATEGORIES = Object.freeze([
  "normal",
  "commandNormal",
  "targetCombo",
  "throw",
  "special",
  "od",
  "super",
  "climax",
  "system",
]);

export function defineMoveset(definition) {
  if (!definition?.id || !definition?.name || !definition?.moves) {
    throw new TypeError("A moveset requires id, name, and moves");
  }
  const entries = Array.isArray(definition.moves)
    ? definition.moves.map((move) => [move.id, move])
    : Object.entries(definition.moves);
  const moves = Object.fromEntries(entries.map(([id, move]) => [id, finalizeMove({ id, ...move })]));
  const aliases = { ...(definition.aliases ?? {}) };
  for (const [alias, target] of Object.entries(aliases)) {
    if (!moves[target]) throw new Error(`Unknown move alias target: ${alias} -> ${target}`);
  }
  return deepFreeze({
    id: definition.id,
    name: definition.name,
    archetype: definition.archetype ?? "",
    controlLayout: definition.controlLayout ?? "sixButton",
    resourceModel: definition.resourceModel ?? definition.id,
    aliases,
    moves,
    catalog: buildMoveCatalog(moves),
  });
}

export function finalizeMove(raw) {
  const startup = nonNegativeInteger(raw.startup, 1);
  const authoredWindows = Array.isArray(raw.activeWindows) && raw.activeWindows.length > 0
    ? raw.activeWindows
    : [{ start: startup, end: startup + Math.max(1, nonNegativeInteger(raw.active, 1)) - 1 }];
  const activeWindows = authoredWindows.map((window, index) => ({
    id: String(window.id ?? `hit${index + 1}`),
    start: positiveInteger(window.start, startup),
    end: positiveInteger(window.end, window.start ?? startup),
    hitId: String(window.hitId ?? window.id ?? (authoredWindows.length === 1 ? "main" : `hit${index + 1}`)),
  }));
  for (const window of activeWindows) {
    if (window.end < window.start) throw new Error(`${raw.id}: active window ends before it starts`);
  }
  const activeStart = Math.min(...activeWindows.map((window) => window.start));
  const activeEnd = Math.max(...activeWindows.map((window) => window.end));
  const activeSpan = Math.max(1, activeEnd - startup + 1);
  const activeWindowFrameCount = activeWindows.reduce(
    (count, window) => count + window.end - window.start + 1,
    0,
  );
  const activeFrames = new Set();
  for (const window of activeWindows) {
    for (let frame = window.start; frame <= window.end; frame += 1) activeFrames.add(frame);
  }
  const activeFrameCount = activeFrames.size;
  const recovery = nonNegativeInteger(raw.recovery, 0);
  const totalFrames = positiveInteger(raw.totalFrames, startup + activeSpan + recovery - 1);
  const hits = normalizeHits(raw, activeWindows);
  const cancels = normalizeCancels(raw.cancels ?? raw.cancelWindows);
  const command = normalizeCommand(raw.command);
  const hitboxes = cloneBoxes(raw.hitboxes ?? hits.flatMap((hit) => hit.hitboxes ?? []));
  const hurtboxes = cloneBoxes(raw.hurtboxes);

  return {
    ...raw,
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    category: MOVE_CATEGORIES.includes(raw.category) ? raw.category : "normal",
    startup,
    firstActive: activeStart - 1,
    active: activeSpan,
    activeFrameCount,
    activeWindowFrameCount,
    activeWindows,
    recovery,
    totalFrames,
    hits,
    cancels,
    command,
    commandLabel: String(raw.commandLabel ?? command.label ?? ""),
    resourceLabel: String(raw.resourceLabel ?? formatResourceCost(raw.resourceCost ?? raw.cost)),
    hitboxes,
    hurtboxes,
    hitbox: raw.hitbox ?? hitboxes[0] ?? null,
    animation: raw.animation ?? raw.animationAction ?? inferAnimation(raw),
  };
}

export function getMovesetMove(moveset, moveId) {
  if (!moveset || !moveId) return null;
  const id = moveset.aliases?.[moveId] ?? moveId;
  return moveset.moves?.[id] ?? null;
}

export function buildMoveCatalog(moves) {
  const groups = Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, []]));
  for (const move of Object.values(moves ?? {})) {
    const category = MOVE_CATEGORIES.includes(move.category) ? move.category : "normal";
    groups[category].push({
      id: move.id,
      name: move.name,
      commandLabel: move.commandLabel,
      resourceLabel: move.resourceLabel,
      stance: move.stance ?? "ground",
      strength: move.strength ?? "",
    });
  }
  return groups;
}

export function validateMoveset(moveset) {
  const errors = [];
  if (!moveset?.id) errors.push("missing moveset id");
  if (!moveset?.moves || Object.keys(moveset.moves).length === 0) errors.push("moveset has no moves");
  for (const move of Object.values(moveset?.moves ?? {})) {
    if (!move.name) errors.push(`${move.id}: missing name`);
    if (!move.commandLabel && move.category !== "system") errors.push(`${move.id}: missing commandLabel`);
    if (!Number.isFinite(move.totalFrames) || move.totalFrames <= 0) errors.push(`${move.id}: invalid totalFrames`);
    if (!Array.isArray(move.hits)) errors.push(`${move.id}: missing hits`);
  }
  return errors;
}

function normalizeHits(raw, activeWindows) {
  if (Array.isArray(raw.hits) && raw.hits.length > 0) {
    return raw.hits.map((hit, index) => {
      const fallbackWindow = activeWindows[Math.min(index, activeWindows.length - 1)];
      const inheritsTerminalState = raw.hits.length === 1 || index === raw.hits.length - 1;
      const terminalValue = (hitValue, moveValue) => hitValue ?? (inheritsTerminalState ? moveValue : undefined);
      return {
        // Keep authored, engine-specific hit metadata (late damage, crouch
        // rules, recoverable damage, etc.) while ensuring canonical fields
        // below are normalized and take precedence over the raw values.
        ...hit,
        id: String(hit.id ?? fallbackWindow.hitId ?? `hit${index + 1}`),
        start: positiveInteger(hit.start, fallbackWindow.start),
        end: positiveInteger(hit.end, fallbackWindow.end),
        damage: finite(hit.damage, finite(raw.damage)),
        chipDamage: finite(hit.chipDamage, finite(raw.chipDamage)),
        hitstun: optionalFinite(hit.hitstun, raw.hitstun),
        blockstun: optionalFinite(hit.blockstun, raw.blockstun),
        hitLevel: hit.hitLevel ?? raw.hitLevel ?? "mid",
        knockdownType: terminalValue(hit.knockdownType, raw.knockdownType),
        launchX: terminalValue(hit.launchX, raw.launchX),
        launchY: terminalValue(hit.launchY, raw.launchY),
        juggleCost: hit.juggleCost ?? raw.juggleCost,
        juggleLimit: hit.juggleLimit ?? raw.juggleLimit,
        groundBounces: terminalValue(hit.groundBounces, raw.groundBounces),
        wallBounces: terminalValue(hit.wallBounces, raw.wallBounces),
        initialProration: hit.initialProration ?? raw.initialProration,
        scalingStep: hit.scalingStep ?? raw.scalingStep,
        minimumScaling: hit.minimumScaling ?? raw.minimumScaling,
        hitboxes: cloneBoxes(hit.hitboxes),
      };
    });
  }
  return activeWindows.map((window, index) => {
    const inheritsTerminalState = activeWindows.length === 1 || index === activeWindows.length - 1;
    return ({
    id: window.hitId,
    start: window.start,
    end: window.end,
    damage: finite(raw.damage),
    chipDamage: finite(raw.chipDamage),
    hitstun: optionalFinite(raw.hitstun),
    blockstun: optionalFinite(raw.blockstun),
    hitLevel: raw.hitLevel ?? "mid",
    knockdownType: inheritsTerminalState ? raw.knockdownType : undefined,
    launchX: inheritsTerminalState ? raw.launchX : undefined,
    launchY: inheritsTerminalState ? raw.launchY : undefined,
    juggleCost: raw.juggleCost,
    juggleLimit: raw.juggleLimit,
    groundBounces: inheritsTerminalState ? raw.groundBounces : undefined,
    wallBounces: inheritsTerminalState ? raw.wallBounces : undefined,
    initialProration: raw.initialProration,
    scalingStep: raw.scalingStep,
    minimumScaling: raw.minimumScaling,
    hitboxes: cloneBoxes(raw.hitboxes),
    });
  });
}

function normalizeCancels(value) {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((cancel) => ({
    start: positiveInteger(cancel.start ?? cancel.from, 1),
    end: positiveInteger(cancel.end ?? cancel.to, cancel.start ?? cancel.from ?? 1),
    on: Array.isArray(cancel.on) ? [...cancel.on] : [cancel.on ?? "hit"],
    into: Array.isArray(cancel.into) ? [...cancel.into] : [cancel.into ?? "special"],
    moves: Array.isArray(cancel.moves) ? [...cancel.moves] : cancel.moves ? [cancel.moves] : [],
    requiresContact: cancel.requiresContact !== false,
    delayable: Boolean(cancel.delayable),
  }));
}

function normalizeCommand(value) {
  if (!value) return { motion: null, buttons: [], label: "" };
  if (typeof value === "string") return { motion: null, buttons: [], label: value };
  return {
    motion: value.motion ?? null,
    buttons: Array.isArray(value.buttons) ? [...value.buttons] : value.button ? [value.button] : [],
    chord: Boolean(value.chord),
    hold: Boolean(value.hold),
    air: Boolean(value.air),
    stance: value.stance ?? null,
    direction: value.direction ?? null,
    label: String(value.label ?? ""),
  };
}

function cloneBoxes(value) {
  return Array.isArray(value) ? value.map((box) => ({ ...box })) : [];
}

function formatResourceCost(value = {}) {
  const parts = [];
  const superCost = finite(value.super ?? value.meter ?? value.power);
  const driveCost = finite(value.drive);
  if (superCost > 0) parts.push(`${superCost / 100}气`);
  if (driveCost > 0) parts.push(`${driveCost / 100}Drive`);
  return parts.join(" · ");
}

function inferAnimation(move) {
  const text = `${move.id ?? ""} ${move.name ?? ""} ${move.tags?.join?.(" ") ?? ""}`.toLowerCase();
  if (text.includes("throw") || text.includes("nage")) return "throw";
  if (text.includes("shoryu") || text.includes("oniyaki") || text.includes("upper")) return "dragonPunch";
  if (text.includes("hadoken") || text.includes("fireball") || text.includes("orochinagi")) return "fireballHeavy";
  if (text.includes("rekka") || text.includes("aragami") || text.includes("dokugami")) return "rekkaHeavy";
  if (move.stance === "air") return move.strength === "heavy" ? "airHeavy" : "airLight";
  if (move.hitLevel === "low") return move.strength === "heavy" ? "lowHeavy" : "lowLight";
  if (move.hitLevel === "overhead") return move.strength === "heavy" ? "midHeavy" : "midLight";
  return move.strength === "heavy" ? "highHeavy" : "highLight";
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.floor(finite(value, fallback)));
}

function nonNegativeInteger(value, fallback) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFinite(value, fallback) {
  const preferred = value ?? fallback;
  if (preferred == null) return undefined;
  const number = Number(preferred);
  return Number.isFinite(number) ? number : undefined;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
