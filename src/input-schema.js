/** Canonical controller shared by humans, agents, browser play, and headless play. */
export const ATTACK_BUTTONS = Object.freeze(["lp", "mp", "hp", "lk", "mk", "hk"]);
export const SYSTEM_BUTTONS = Object.freeze(["throw", "system1", "system2", "guard"]);
export const COMBAT_BUTTONS = Object.freeze([...ATTACK_BUTTONS, ...SYSTEM_BUTTONS]);

export const EMPTY_COMBAT_INPUT = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
  lp: false,
  mp: false,
  hp: false,
  lk: false,
  mk: false,
  hk: false,
  throw: false,
  system1: false,
  system2: false,
  guard: false,
});

const BUTTON_ALIASES = Object.freeze({
  lp: ["lp", "lightPunch", "punchLight"],
  mp: ["mp", "mediumPunch", "punchMedium"],
  hp: ["hp", "heavyPunch", "punchHeavy"],
  lk: ["lk", "lightKick", "kickLight"],
  mk: ["mk", "mediumKick", "kickMedium"],
  hk: ["hk", "heavyKick", "kickHeavy"],
});

const SYSTEM_BUTTON_ALIASES = Object.freeze({
  throw: ["throw", "grab"],
  system1: ["system1", "parry", "roll"],
  system2: ["system2", "driveImpact", "blowback"],
  guard: ["guard"],
});

const AIR_STANCES = new Set([
  "air",
  "airborne",
  "jump",
  "normaljump",
  "hyperjump",
  "hop",
  "hyperhop",
]);

export function normalizeCombatInput(value = EMPTY_COMBAT_INPUT) {
  const source = value ?? EMPTY_COMBAT_INPUT;
  const explicitButtons = ATTACK_BUTTONS.some((button) =>
    BUTTON_ALIASES[button].some((alias) => Object.hasOwn(source, alias)),
  );
  const buttons = Object.fromEntries(
    ATTACK_BUTTONS.map((button) => [
      button,
      BUTTON_ALIASES[button].some((alias) => Boolean(source[alias])),
    ]),
  );

  // v0.6/headless compatibility. Explicit canonical buttons always win, so a
  // six-button keyboard press cannot accidentally become a legacy chord.
  if (!explicitButtons) {
    buttons.lp = Boolean(source.light);
    buttons.hp = Boolean(source.heavy);
  }

  const throwChord = buttons.lp && buttons.lk;
  const system1Chord = buttons.mp && buttons.mk;
  const system2Chord = buttons.hp && buttons.hk;
  return {
    left: Boolean(source.left),
    right: Boolean(source.right),
    up: Boolean(source.up),
    down: Boolean(source.down),
    ...buttons,
    throw: Boolean(source.throw || source.grab || source.special) || throwChord,
    system1: Boolean(source.system1 || source.parry || source.roll) || system1Chord,
    system2: Boolean(source.system2 || source.driveImpact || source.blowback) || system2Chord,
    guard: Boolean(source.guard),
  };
}

export function pressedCombatButtons(current, previous = EMPTY_COMBAT_INPUT) {
  const now = normalizeCombatInput(current);
  const before = normalizeCombatInput(previous);
  return [...ATTACK_BUTTONS, ...SYSTEM_BUTTONS].filter(
    (button) => now[button] && !before[button],
  );
}

export function releasedCombatButtons(current, previous = EMPTY_COMBAT_INPUT) {
  const now = normalizeCombatInput(current);
  const before = normalizeCombatInput(previous);
  return [...ATTACK_BUTTONS, ...SYSTEM_BUTTONS].filter(
    (button) => !now[button] && before[button],
  );
}

export function heldCombatButtons(current = EMPTY_COMBAT_INPUT) {
  const normalized = normalizeCombatInput(current);
  return COMBAT_BUTTONS.filter((button) => normalized[button]);
}

/** Convert authored/UI button names to the canonical six-button schema. */
export function canonicalCombatButton(value) {
  const token = compactToken(value);
  if (!token) return null;
  for (const [button, aliases] of Object.entries(BUTTON_ALIASES)) {
    if (aliases.some((alias) => compactToken(alias) === token)) return button;
  }
  for (const [button, aliases] of Object.entries(SYSTEM_BUTTON_ALIASES)) {
    if (aliases.some((alias) => compactToken(alias) === token)) return button;
  }
  return null;
}

/**
 * Extract canonical buttons from move-data alternatives such as `LP+HP`,
 * `236236LK`, an authored button array, or an alternative descriptor object.
 */
export function inputAlternativeButtons(value) {
  if (Array.isArray(value)) return uniqueButtons(value);
  if (value && typeof value === "object") {
    return uniqueButtons(Array.isArray(value.buttons) ? value.buttons : [value.button]);
  }
  const tokens = String(value ?? "").match(/system[12]|throw|guard|lp|mp|hp|lk|mk|hk/gi) ?? [];
  return uniqueButtons(tokens);
}

export function buttonFamily(button) {
  if (["lp", "mp", "hp"].includes(button)) return "punch";
  if (["lk", "mk", "hk"].includes(button)) return "kick";
  return "system";
}

export function buttonStrength(button) {
  if (button === "lp" || button === "lk") return "light";
  if (button === "mp" || button === "mk") return "medium";
  if (button === "hp" || button === "hk") return "heavy";
  return "system";
}

export function relativeDirection(input, facing = 1) {
  const normalized = normalizeCombatInput(input);
  const horizontal = axis(normalized.left, normalized.right) * (facing >= 0 ? 1 : -1);
  if (normalized.down && !normalized.up) {
    if (horizontal > 0) return "downForward";
    if (horizontal < 0) return "downBack";
    return "down";
  }
  if (normalized.up && !normalized.down) {
    if (horizontal > 0) return "upForward";
    if (horizontal < 0) return "upBack";
    return "up";
  }
  if (horizontal > 0) return "forward";
  if (horizontal < 0) return "back";
  return "neutral";
}

/**
 * Match an authored relative direction. Down accepts either diagonal so a
 * crouching move still works while the player is holding down-back to block or
 * down-forward to advance. Other cardinal requirements retain their old exact
 * semantics.
 */
export function directionMatches(current, requirement) {
  if (Array.isArray(requirement)) {
    return requirement.some((candidate) => directionMatches(current, candidate));
  }
  if (!requirement || requirement === "any") return true;
  if (requirement === "down") return ["down", "downBack", "downForward"].includes(current);
  if (requirement === "neutralOrForward") return ["neutral", "forward"].includes(current);
  if (requirement === "backOrForward") return ["back", "forward"].includes(current);
  return current === requirement;
}

// Descriptive alias for callers that keep all direction helpers together.
export const matchesRelativeDirection = directionMatches;

/** Resolve fighter state without consulting the current Up input. */
export function normalizeCombatStance(value) {
  if (typeof value === "string") {
    const stance = compactToken(value);
    if (stance.includes("hop")) return stance.includes("hyper") ? "hyperhop" : "hop";
    if (stance.includes("jump")) return stance.includes("hyper") ? "hyperjump" : "jump";
    if (stance.includes("air")) return "air";
    return stance || "unknown";
  }
  if (!value || typeof value !== "object") return "unknown";
  if (typeof value.stance === "string") return normalizeCombatStance(value.stance);
  if (value.airborne === true || value.onGround === false) {
    const jumpType = compactToken(value.jumpType);
    if (!jumpType || jumpType === "normal") return "jump";
    if (jumpType === "hyper") return "hyperjump";
    return normalizeCombatStance(jumpType);
  }
  const action = compactToken(value.action ?? value.state);
  if (action.includes("hop")) return action.includes("hyper") ? "hyperhop" : "hop";
  if (action.includes("jump")) return action.includes("hyper") ? "hyperjump" : "jump";
  if (action.includes("air")) return "air";
  if (action === "crouch" || action === "crouching") return "crouch";
  if (value.onGround === true) return "ground";
  return "unknown";
}

export function isAirStance(value) {
  return AIR_STANCES.has(normalizeCombatStance(value));
}

export function axis(negative, positive) {
  if (Boolean(negative) === Boolean(positive)) return 0;
  return positive ? 1 : -1;
}

function uniqueButtons(values) {
  return [...new Set((values ?? []).map(canonicalCombatButton).filter(Boolean))];
}

function compactToken(value) {
  return String(value ?? "").trim().replace(/[\s_-]+/g, "").toLowerCase();
}
