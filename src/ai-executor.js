import { EMPTY_COMBAT_INPUT } from "./input-schema.js";
import { MOTIONS } from "./command-resolver.js";

export function createCommandExecutor({ difficulty = "normal" } = {}) {
  const cadence = { easy: 3, normal: 2, hard: 1, expert: 1 }[difficulty] ?? 2;
  let queue = [];
  let activePlan = null;
  let completedPlans = 0;

  function start(plan, move, self, opponent) {
    activePlan = { ...plan, moveId: move?.id ?? plan?.moveId ?? null };
    queue = move ? moveCommandFrames(move, cadence) : intentFrames(plan?.intent);
    if (queue.length === 0) queue = [{}];
    return step(self, opponent);
  }

  function step(self, opponent) {
    if (queue.length === 0) {
      if (activePlan) completedPlans += 1;
      activePlan = null;
      return { ...EMPTY_COMBAT_INPUT };
    }
    const relative = queue.shift();
    return resolveRelativeInput(relative, self, opponent);
  }

  function interrupt() {
    queue = [];
    activePlan = null;
  }

  function isBusy() {
    return queue.length > 0;
  }

  function getDebugState() {
    return { activePlan, queuedFrames: queue.length, completedPlans };
  }

  return { start, step, interrupt, isBusy, getDebugState };
}

export function moveCommandFrames(move, cadence = 1) {
  const command = move?.command ?? {};
  const frames = [];
  if (command.motion) {
    const sequences = MOTIONS[command.motion];
    const sequence = Array.isArray(sequences?.[0]) ? sequences[0] : [];
    for (const direction of sequence) repeat(frames, directionIntent(direction), cadence);
  } else if (command.direction) {
    repeat(frames, directionIntent(command.direction), cadence);
  }

  const buttons = command.buttons ?? [];
  const buttonFrame = frames.pop() ?? {};
  for (const button of buttons) buttonFrame[button] = true;
  if (command.hold) repeat(frames, buttonFrame, Math.max(2, cadence * 3));
  else frames.push(buttonFrame);
  frames.push({});
  return frames;
}

export function resolveRelativeInput(intent = {}, self, opponent) {
  const facing = Number.isFinite(self?.facing)
    ? Math.sign(self.facing) || 1
    : finite(opponent?.x) >= finite(self?.x) ? 1 : -1;
  const world = { ...EMPTY_COMBAT_INPUT };
  if (intent.forward) world[facing > 0 ? "right" : "left"] = true;
  if (intent.back) world[facing > 0 ? "left" : "right"] = true;
  if (intent.up) world.up = true;
  if (intent.down) world.down = true;
  for (const button of ["lp", "mp", "hp", "lk", "mk", "hk", "throw", "system1", "system2", "guard"]) {
    world[button] = Boolean(intent[button]);
  }
  return world;
}

function intentFrames(intent) {
  switch (intent) {
    case "approach":
      return repeated({ forward: true }, 8);
    case "whiffBait":
      return [...repeated({ forward: true }, 5), ...repeated({ back: true }, 13)];
    case "shimmy":
      return [...repeated({ forward: true }, 4), ...repeated({ back: true }, 12)];
    case "reversalBait":
      return repeated({ back: true, guard: true }, 16);
    case "throw":
      return [{ throw: true }, {}];
    case "defend":
      return repeated({ back: true, guard: true }, 8);
    case "resourceBuild":
      return repeated({ back: true }, 5);
    default:
      return [{}];
  }
}

function directionIntent(direction) {
  switch (direction) {
    case "forward": return { forward: true };
    case "back": return { back: true };
    case "down": return { down: true };
    case "up": return { up: true };
    case "downForward": return { down: true, forward: true };
    case "downBack": return { down: true, back: true };
    case "upForward": return { up: true, forward: true };
    case "upBack": return { up: true, back: true };
    default: return {};
  }
}

function repeated(intent, count) {
  return Array.from({ length: Math.max(0, count) }, () => ({ ...intent }));
}

function repeat(target, intent, count) {
  target.push(...repeated(intent, count));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
