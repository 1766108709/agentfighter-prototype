const INPUT_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);

const EMPTY_INPUT = Object.freeze({});

export function createTriadBlackboxChampionAgent(options = EMPTY_INPUT) {
  const gapThreshold = finite(options?.gapThreshold, 58);
  const throwCadence = Math.max(1, Math.floor(finite(options?.throwCadence, 3)));
  let resets = 0;
  let decisions = 0;
  let neutralActions = 0;
  let forwardActions = 0;
  let guardActions = 0;
  let throwActions = 0;
  let endings = 0;

  function reset() {
    resets += 1;
    decisions = 0;
    neutralActions = 0;
    forwardActions = 0;
    guardActions = 0;
    throwActions = 0;
    endings = 0;
  }

  function act(observation) {
    decisions += 1;
    if (!isFightingObservation(observation)) {
      neutralActions += 1;
      return createAction();
    }

    const gap = edgeGap(observation.self, observation.opponent);
    if (gap > gapThreshold) {
      forwardActions += 1;
      return relativeAction(observation.self, "forward");
    }
    if (observation.frame % throwCadence === 0) {
      throwActions += 1;
      return relativeAction(observation.self, "forward", { throw: true });
    }

    guardActions += 1;
    return relativeAction(observation.self, "downBack", { guard: true });
  }

  function end() {
    endings += 1;
  }

  function getDebugState() {
    return Object.freeze({
      resets,
      decisions,
      neutralActions,
      forwardActions,
      guardActions,
      throwActions,
      endings,
    });
  }

  return Object.freeze({
    name: "Triad Blackbox Champion",
    description: "ObservationV1-only deterministic spacing, throw, and guard controller",
    reset,
    act,
    end,
    getDebugState,
  });
}

function isFightingObservation(value) {
  return value?.schema === "agentfighter.observation"
    && value.version === 1
    && value.phase === "fighting"
    && value.self
    && value.opponent;
}

function edgeGap(self, other) {
  const centerDistance = Math.abs(finite(self?.position?.x) - finite(other?.position?.x));
  const halfWidths = (nonNegative(self?.size?.width) + nonNegative(other?.size?.width)) / 2;
  return Math.max(0, centerDistance - halfWidths);
}

function relativeAction(self, direction, buttons = EMPTY_INPUT) {
  const input = { ...buttons };
  const facing = finite(self?.facing, 1) >= 0 ? 1 : -1;
  if (direction === "forward") input[facing > 0 ? "right" : "left"] = true;
  if (direction === "downBack") {
    input.down = true;
    input[facing > 0 ? "left" : "right"] = true;
  }
  return createAction(input);
}

function createAction(input = EMPTY_INPUT) {
  const complete = Object.fromEntries(INPUT_KEYS.map((key) => [key, input[key] === true]));
  return deepFreeze({ schema: "agentfighter.action", version: 1, input: complete });
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const createAgent = createTriadBlackboxChampionAgent;
export default createTriadBlackboxChampionAgent;
