import {
  createInProcessAgentRunner,
  createMatchInfoV1,
  createScriptAIAgent,
} from "./agent-sdk.js";
import createTriadChampionAgentAlt from "./triad-champion-agent-alt.js";

export const TRIAD_CHAMPION_AGENT_ID = "triad-champion";
export const BROWSER_MATCH_SEED_BASE = 20260719;

export const CUSTOM_BROWSER_AGENTS = Object.freeze({
  [TRIAD_CHAMPION_AGENT_ID]: Object.freeze({
    id: TRIAD_CHAMPION_AGENT_ID,
    name: "黑盒冠军 · Triad",
    description: "只读取公开观测，在均衡、压迫与远程三类对手间自适应作战。",
  }),
});

function attachBrowserMatchReset(runner, id) {
  runner.browserAgentId = id;
  runner.resetForMatch = (game, selfIndex, matchMetadata = {}) => {
    runner.reset(createMatchInfoV1(game, selfIndex, matchMetadata));
  };
  return runner;
}

export function createCustomBrowserAgent(id, options = {}) {
  if (id !== TRIAD_CHAMPION_AGENT_ID) return null;

  const metadata = CUSTOM_BROWSER_AGENTS[id];
  const runner = createInProcessAgentRunner(
    createTriadChampionAgentAlt(options.templateId),
    { observationDelayFrames: options.observationDelayFrames ?? 0 },
  );

  runner.name = metadata.name;
  runner.description = metadata.description;
  return attachBrowserMatchReset(runner, id);
}

/**
 * Create every browser-controlled fighter behind the same Agent V1 boundary.
 * Built-in scripts receive public observations and platform delay exactly like
 * custom candidates instead of reading the mutable engine game directly.
 */
export function createBrowserAgent(id, options = {}) {
  const custom = createCustomBrowserAgent(id, options);
  if (custom) return custom;

  const agent = createScriptAIAgent({
    preset: id,
    difficulty: options.difficulty,
    observationDelayFrames: 0,
    seed: options.seed,
  });
  const runner = createInProcessAgentRunner(agent, {
    observationDelayFrames: options.observationDelayFrames ?? 0,
  });
  return attachBrowserMatchReset(runner, id);
}

export function createBrowserMatchSeeds(matchIndex = 0) {
  if (!Number.isSafeInteger(matchIndex) || matchIndex < 0) {
    throw new RangeError("matchIndex must be a non-negative safe integer");
  }
  const left = (BROWSER_MATCH_SEED_BASE + matchIndex * 2) >>> 0;
  return Object.freeze({
    matchIndex,
    left,
    right: (left + 1) >>> 0,
  });
}

export function createBrowserMatchSeedSequence(startIndex = 0) {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new RangeError("startIndex must be a non-negative safe integer");
  }
  let nextIndex = startIndex;
  return Object.freeze({
    peek: () => createBrowserMatchSeeds(nextIndex),
    next: () => createBrowserMatchSeeds(nextIndex++),
  });
}

export function customBrowserAgentMetadata(id) {
  return CUSTOM_BROWSER_AGENTS[id] ?? null;
}
