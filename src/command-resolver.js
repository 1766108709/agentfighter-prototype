import {
  EMPTY_COMBAT_INPUT,
  canonicalCombatButton,
  directionMatches,
  inputAlternativeButtons,
  isAirStance,
  normalizeCombatInput,
  normalizeCombatStance,
  pressedCombatButtons,
  relativeDirection,
} from "./input-schema.js";

export const MOTIONS = Object.freeze({
  qcf: [
    ["down", "downForward", "forward"],
    ["down", "forward"],
  ],
  qcb: [
    ["down", "downBack", "back"],
    ["down", "back"],
  ],
  dp: [
    ["forward", "down", "downForward"],
    ["forward", "downForward"],
  ],
  rdp: [
    ["back", "down", "downBack"],
    ["back", "downBack"],
  ],
  hcf: [
    ["back", "downBack", "down", "downForward", "forward"],
    ["back", "down", "forward"],
  ],
  hcb: [
    ["forward", "downForward", "down", "downBack", "back"],
    ["forward", "down", "back"],
  ],
  qcfQcf: [["down", "downForward", "forward", "down", "downForward", "forward"]],
  qcbQcb: [["down", "downBack", "back", "down", "downBack", "back"]],
  qcbHcf: [["down", "downBack", "back", "downBack", "down", "downForward", "forward"]],
  qcfHcb: [["down", "downForward", "forward", "downForward", "down", "downBack", "back"]],
  downDown: [
    ["down", "neutral", "down"],
    ["down", "downForward", "down"],
    ["down", "downBack", "down"],
  ],
  forwardForward: [["forward", "neutral", "forward"]],
  backBack: [["back", "neutral", "back"]],
});

export const COMMAND_WINDOWS = Object.freeze({
  normal: 24,
  long: 32,
  super: 45,
  finalDirectionGrace: 7,
  history: 54,
});

export function recordDirection(history, direction, frame, maxAge = COMMAND_WINDOWS.history) {
  const entries = Array.isArray(history) ? history : [];
  const last = entries[entries.length - 1];
  if (!last || last.direction !== direction) entries.push({ direction, frame });
  while (entries.length > 0 && entries[0].frame < frame - maxAge) entries.shift();
  return entries;
}

export function matchMotion(history, motion, frame, options = {}) {
  const sequences = Array.isArray(motion)
    ? (Array.isArray(motion[0]) ? motion : [motion])
    : MOTIONS[motion];
  if (!Array.isArray(sequences)) return null;
  const windowFrames = options.windowFrames ?? inferredWindow(motion);
  const finalGrace = options.finalDirectionGrace ?? COMMAND_WINDOWS.finalDirectionGrace;
  const recent = (history ?? []).filter((entry) => entry.frame >= frame - windowFrames);

  let best = null;
  for (const sequence of sequences) {
    const matchedEntries = matchLatestSequence(recent, sequence);
    if (matchedEntries.length !== sequence.length) continue;
    const completedFrame = matchedEntries[matchedEntries.length - 1].frame;
    if (frame - completedFrame > finalGrace) continue;
    const candidate = {
      motion: typeof motion === "string" ? motion : "custom",
      sequence: [...sequence],
      matchedDirections: matchedEntries.map((entry) => entry.direction),
      startFrame: matchedEntries[0].frame,
      completedFrame,
      duration: completedFrame - matchedEntries[0].frame,
    };
    if (!best || candidate.sequence.length > best.sequence.length || candidate.duration < best.duration) {
      best = candidate;
    }
  }
  return best;
}

export function hasMotion(history, motion, frame, options) {
  return Boolean(matchMotion(history, motion, frame, options));
}

export function clearConsumedMotion(history, match) {
  if (!Array.isArray(history) || !match) return history ?? [];
  return history.filter((entry) => entry.frame > match.completedFrame);
}

/**
 * Expand a move/command into canonical input candidates. Passing the whole move
 * is preferred because `inputAlternatives` is authored beside `command` in the
 * current roster data.
 */
export function commandInputCandidates(commandOrMove = {}, options = {}) {
  const move = isMoveDescriptor(commandOrMove) ? commandOrMove : null;
  const normalizedCommand = normalizeCommand(move ? move.command : commandOrMove);
  const authored = move && normalizedCommand.heldChord == null && normalizedCommand.allowHeldChord == null
    ? {
        ...normalizedCommand,
        heldChord: move.heldChord,
        allowHeldChord: move.allowHeldChord,
      }
    : normalizedCommand;
  const alternatives = asArray(
    options.inputAlternatives
      ?? move?.inputAlternatives
      ?? authored.inputAlternatives,
  );
  const candidates = [makeInputCandidate(authored, null, -1)];
  alternatives.forEach((alternative, index) => {
    const candidate = makeInputCandidate(authored, alternative, index);
    if (candidate) candidates.push(candidate);
  });
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate) return false;
    const signature = JSON.stringify([
      candidate.motion,
      candidate.direction,
      candidate.buttons,
      candidate.chord,
      candidate.air,
      candidate.stance,
      candidate.heldChord,
    ]);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/**
 * Canonical command matcher for direct use by the combat engine.
 *
 * `commandOrMove` accepts either a command object (legacy-compatible) or the
 * whole normalized move (required when its `inputAlternatives` are top-level).
 * Engine context fields are: input, previousInput, pressedButtons,
 * directionHistory, frame, facing, fighter/stance, jumpType, directionChanged,
 * motionOptions, and allowHeldChord.
 * The return value preserves the old `{ motionMatch }` contract and adds the
 * exact candidate/activation information needed for buffered commands.
 */
export function matchCommandInput(commandOrMove = {}, context = {}) {
  const input = normalizeCombatInput(context.input ?? context.currentInput ?? EMPTY_COMBAT_INPUT);
  const hasPreviousInput = Object.hasOwn(context, "previousInput");
  const previousInput = normalizeCombatInput(context.previousInput ?? EMPTY_COMBAT_INPUT);
  const facing = finite(context.facing, 1) >= 0 ? 1 : -1;
  const frame = finite(context.frame);
  const history = context.directionHistory ?? context.history ?? [];
  const pressedButtons = normalizePressedButtons(
    context.pressedButtons ?? pressedCombatButtons(input, previousInput),
  );
  const currentDirection = context.currentDirection ?? relativeDirection(input, facing);
  const previousDirection = context.previousDirection ?? relativeDirection(previousInput, facing);
  const directionChanged = context.directionChanged ?? currentDirection !== previousDirection;
  const stanceSource = context.stance ?? context.fighter ?? context;
  const actualStance = normalizeCombatStance(stanceSource);
  const move = isMoveDescriptor(commandOrMove) ? commandOrMove : null;

  for (const candidate of commandInputCandidates(commandOrMove, context)) {
    const requiredStance = requiredCommandStance(move, candidate);
    if (!commandStanceMatches(requiredStance, actualStance, context)) continue;
    const airDirectionNotation = isAirStance(requiredStance) && candidate.direction === "up";
    if (!airDirectionNotation && !directionMatches(currentDirection, candidate.direction)) continue;

    const motionMatch = candidate.motion
      ? matchMotion(history, candidate.motion, frame, context.motionOptions)
      : null;
    if (candidate.motion && !motionMatch) continue;

    const buttonMatch = matchCandidateButtons({
      candidate,
      input,
      previousInput,
      hasPreviousInput,
      pressedButtons,
      motionMatch,
      directionChanged,
      frame,
      context,
    });
    if (!buttonMatch) continue;

    return {
      motionMatch,
      currentDirection,
      actualStance,
      requiredStance,
      matchedButtons: [...candidate.buttons],
      inputAlternative: candidate.inputAlternative,
      matchedAlternative: candidate.inputAlternative,
      inputAlternativeIndex: candidate.inputAlternativeIndex,
      usedHeldChord: buttonMatch.usedHeldChord,
      activation: buttonMatch.activation,
      ignoredAirDirectionNotation: airDirectionNotation,
      command: candidate,
    };
  }
  return null;
}

export function hasCommandInput(commandOrMove, context) {
  return Boolean(matchCommandInput(commandOrMove, context));
}

/** Drop-in adapter for the combat engine's former local matcher signature. */
export function commandMatches(
  fighter,
  input,
  pressedButtons,
  commandOrMove = {},
  frame = 0,
  directionChanged = false,
  options = {},
) {
  const context = {
    ...options,
    fighter,
    input,
    pressedButtons,
    directionHistory: options.directionHistory ?? fighter?.directionHistory,
    frame,
    facing: options.facing ?? fighter?.facing,
    jumpType: options.jumpType ?? fighter?.jumpType,
    directionChanged,
  };
  if (fighter && Object.hasOwn(fighter, "previousInput") && !Object.hasOwn(options, "previousInput")) {
    context.previousInput = fighter.previousInput;
  }
  return matchCommandInput(commandOrMove, context);
}

function inferredWindow(motion) {
  if (["qcfQcf", "qcbQcb", "qcbHcf", "qcfHcb"].includes(motion)) {
    return COMMAND_WINDOWS.super;
  }
  if (["hcf", "hcb"].includes(motion)) return COMMAND_WINDOWS.long;
  return COMMAND_WINDOWS.normal;
}

function makeInputCandidate(authored, alternative, index) {
  if (alternative == null) {
    return {
      ...authored,
      buttons: normalizeButtons(authored.buttons),
      chord: Boolean(authored.chord || normalizeButtons(authored.buttons).length > 1),
      inputAlternative: null,
      inputAlternativeIndex: -1,
    };
  }
  const override = alternative && typeof alternative === "object" && !Array.isArray(alternative)
    ? alternative
    : {};
  const buttons = inputAlternativeButtons(alternative);
  if (buttons.length === 0 && !override.buttons && !override.button) return null;
  const merged = { ...authored, ...override };
  const normalizedButtons = buttons.length > 0 ? buttons : normalizeButtons(merged.buttons ?? merged.button);
  return {
    ...merged,
    buttons: normalizedButtons,
    chord: override.chord ?? normalizedButtons.length > 1,
    inputAlternative: typeof alternative === "string"
      ? alternative
      : String(override.label ?? `alternative${index + 1}`),
    inputAlternativeIndex: index,
  };
}

function matchCandidateButtons({
  candidate,
  input,
  previousInput,
  hasPreviousInput,
  pressedButtons,
  motionMatch,
  directionChanged,
  frame,
  context,
}) {
  const buttons = candidate.buttons;
  if (buttons.length === 0) {
    if (!candidate.motion || !directionChanged) return null;
    return { usedHeldChord: false, activation: "directionMotion" };
  }
  const chord = Boolean(candidate.chord || buttons.length > 1);
  if (!chord) {
    if (!buttons.some((button) => pressedButtons.includes(button))) return null;
    return { usedHeldChord: false, activation: "buttonPress" };
  }
  if (!buttons.every((button) => input[button])) return null;
  if (buttons.some((button) => pressedButtons.includes(button))) {
    return { usedHeldChord: false, activation: "buttonPress" };
  }

  const canonicalDriveRush = candidate.motion === "forwardForward"
    && sameButtons(buttons, ["mp", "mk"]);
  const allowsHeldChord = context.allowHeldChord === true
    || candidate.heldChord === true
    || candidate.allowHeldChord === true
    || canonicalDriveRush;
  if (!allowsHeldChord || !motionMatch || !directionChanged) return null;
  const wasHeld = hasPreviousInput
    ? buttons.every((button) => previousInput[button])
    : buttons.every((button) => !pressedButtons.includes(button));
  if (!wasHeld || motionMatch.completedFrame !== frame) return null;
  return { usedHeldChord: true, activation: "heldChordMotion" };
}

function requiredCommandStance(move, command) {
  const commandStance = command.stance ?? null;
  if (isAirStance(commandStance)) return commandStance;
  if (command.air) return "air";
  const authored = commandStance ?? move?.stance ?? null;
  if (isAirStance(authored)) return authored;
  return authored;
}

function commandStanceMatches(required, actual, context) {
  if (!required) return true;
  const normalizedRequired = normalizeCombatStance(required);
  if (actual === "unknown") return !isAirStance(normalizedRequired);
  if (isAirStance(normalizedRequired)) {
    if (!isAirStance(actual)) return false;
    const jumpType = normalizeCombatStance(context.jumpType ?? context.fighter?.jumpType ?? actual);
    if (normalizedRequired.includes("hop") && jumpType !== "unknown") return jumpType.includes("hop");
    if (normalizedRequired.includes("jump") && jumpType !== "unknown") return !jumpType.includes("hop");
    return true;
  }
  if (["ground", "crouch", "crouching", "close", "far"].includes(normalizedRequired)) {
    return !isAirStance(actual);
  }
  return normalizedRequired === actual;
}

function normalizeCommand(value) {
  if (!value || typeof value === "string") {
    return { motion: null, buttons: [], label: String(value ?? "") };
  }
  return {
    ...value,
    motion: value.motion ?? null,
    buttons: normalizeButtons(value.buttons ?? value.button),
    chord: Boolean(value.chord),
    air: Boolean(value.air),
    stance: value.stance ?? null,
    direction: value.direction ?? null,
  };
}

function normalizeButtons(value) {
  return [...new Set(asArray(value).map(canonicalCombatButton).filter(Boolean))];
}

function normalizePressedButtons(value) {
  return normalizeButtons(value);
}

function sameButtons(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((button, index) => button === b[index]);
}

function isMoveDescriptor(value) {
  return Boolean(value && typeof value === "object" && value.command && typeof value.command === "object");
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function matchLatestSequence(entries, sequence) {
  let cursor = entries.length;
  const matched = Array(sequence.length);
  for (let sequenceIndex = sequence.length - 1; sequenceIndex >= 0; sequenceIndex -= 1) {
    const requiredDirection = sequence[sequenceIndex];
    let entryIndex = cursor - 1;
    while (entryIndex >= 0 && !directionMatches(entries[entryIndex].direction, requiredDirection)) {
      entryIndex -= 1;
    }
    if (entryIndex < 0) return [];
    matched[sequenceIndex] = entries[entryIndex];
    cursor = entryIndex;
  }
  return matched;
}
