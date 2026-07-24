import { createGame } from "../src/engine.js";
import { EMPTY_COMBAT_INPUT } from "../src/input-schema.js";
import {
  ACTION_V1_SCHEMA,
  AGENT_PROTOCOL_VERSION,
  MATCH_INFO_V1_SCHEMA,
  MATCH_RESULT_V1_SCHEMA,
  OBSERVATION_EVENT_LIMIT,
  OBSERVATION_EVENT_WINDOW_FRAMES,
  OBSERVATION_V1_SCHEMA,
  createActionV1,
  createMatchInfoV1,
  createMatchResultV1,
  createObservationV1,
} from "../src/agent-sdk.js";

const PUBLIC_EVENT_TYPES = Object.freeze([
  "bait",
  "cancel",
  "chargeRelease",
  "chargeStart",
  "comboEnd",
  "contact",
  "guard",
  "guardBreak",
  "jump",
  "knockdown",
  "moveStart",
  "stun",
  "throw",
  "throwTech",
  "wakeupAction",
]);

let cachedContract;

export function agentProtocolContract() {
  if (!cachedContract) cachedContract = buildContract();
  return structuredClone(cachedContract);
}

function buildContract() {
  const game = createGame({
    roundSeconds: 30,
    bestOf: 3,
    players: [
      { name: "苍流 A", templateId: "vanguard" },
      { name: "苍流 B", templateId: "vanguard" },
    ],
  });
  game.projectiles.push({
    id: 1,
    owner: 1,
    sourceMoveId: "fireballLight",
    x: 770,
    y: 480,
    vx: -7,
    vy: 0,
    width: 30,
    height: 18,
    radius: 14,
    facing: -1,
    lifeFrames: 72,
    variant: "normal",
    alive: true,
  });
  game.combatEvents.push({
    frame: 0,
    type: "moveStart",
    fighterId: 1,
    opponentId: 0,
    moveId: "fireballLight",
    category: "special",
    range: 310,
  });

  const observation = createObservationV1(game, 0);
  const matchInfo = createMatchInfoV1(game, 0, {
    matchId: "example-match",
    seed: 123456789,
  });
  const action = createActionV1({ right: true, lp: true });
  game.matchWinner = 0;
  game.score = [2, 1];
  game.phase = "matchOver";
  const matchResult = createMatchResultV1(game, 0, {
    matchId: "example-match",
    frames: 4_238,
    rounds: 3,
    termination: "matchOver",
  });

  return deepFreeze({
    schema: "agentfighter.agent-contract",
    version: AGENT_PROTOCOL_VERSION,
    runtime: {
      language: "JavaScript",
      execution: "synchronous",
      tickRate: 60,
      entryPoint: "function createAgent(api)",
      lifecycle: [
        "createAgent(api) is evaluated once for each sandboxed match",
        "agent.reset(matchInfo) is called once before the first frame when provided",
        "agent.act(observation) is called on decision frames and must return ActionV1 synchronously",
        "agent.end(matchResult) is called once after the match when provided",
      ],
      unavailableGlobals: [
        "process",
        "require",
        "fetch",
        "XMLHttpRequest",
        "WebSocket",
        "Date",
        "performance",
        "crypto",
        "SharedArrayBuffer",
        "Atomics",
        "setTimeout",
        "setInterval",
      ],
    },
    schemas: {
      observationV1: {
        schema: OBSERVATION_V1_SCHEMA,
        description: "The real-time, player-visible combat state passed to act().",
        example: observation,
      },
      actionV1: {
        schema: ACTION_V1_SCHEMA,
        description: "A complete strict controller state. Every input value is boolean.",
        inputKeys: Object.keys(EMPTY_COMBAT_INPUT),
        constraints: [
          "left and right cannot both be true",
          "up and down cannot both be true",
          "unknown fields and non-boolean values are rejected",
          "Promise/async actions are rejected",
        ],
        example: action,
      },
      matchInfoV1: {
        schema: MATCH_INFO_V1_SCHEMA,
        description: "The immutable value passed to reset().",
        example: matchInfo,
      },
      matchResultV1: {
        schema: MATCH_RESULT_V1_SCHEMA,
        description: "The immutable self-relative result passed to end().",
        example: matchResult,
      },
    },
    perception: {
      mode: "realtime",
      frameAlignment: "perception.delayFrames is always 0 and perception.opponentFrame always equals observation.frame.",
      recentEventWindowFrames: OBSERVATION_EVENT_WINDOW_FRAMES,
      recentEventLimit: OBSERVATION_EVENT_LIMIT,
      recentEventTypes: PUBLIC_EVENT_TYPES,
      recentEventOptionalFields: [
        "fighterId",
        "opponentId",
        "attackerId",
        "defenderId",
        "sourceId",
        "ownerId",
        "moveId",
        "category",
        "outcome",
        "result",
        "action",
        "baited",
        "jumpType",
        "knockdownType",
        "wakeup",
        "hitLevel",
        "crouching",
        "tags",
        "range",
      ],
    },
    authoringApi: {
      action: "api.action(input) returns a canonical ActionV1",
      protocolVersion: "api.protocolVersion is 1",
      inputKeys: "api.inputKeys lists every accepted controller input",
      randomness: "Math.random() is deterministic and seeded for each sandboxed participant",
    },
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
