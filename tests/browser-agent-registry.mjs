import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createGame, nextRound, stepGame } from "../src/engine.js";
import {
  CUSTOM_BROWSER_AGENTS,
  TRIAD_CHAMPION_AGENT_ID,
  createBrowserAgent,
  createBrowserMatchSeedSequence,
  createCustomBrowserAgent,
  customBrowserAgentMetadata,
} from "../src/browser-agent-registry.js";

const EXPECTED_CHAMPION_SHA256 = "4ef71745242caa02d8ada982e1456a179282604b413a418e39dc1dfb0edc9f46";
const BUILT_IN_IDS = ["balanced", "pressure", "zoner"];

function optionValues(html, selectId) {
  const select = html.match(new RegExp(`<select id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`));
  assert(select, `${selectId} must exist`);
  return [...select[1].matchAll(/<option\s+value=["']([^"']+)["']/g)].map((match) => match[1]);
}

const metadata = customBrowserAgentMetadata(TRIAD_CHAMPION_AGENT_ID);
assert.equal(metadata, CUSTOM_BROWSER_AGENTS[TRIAD_CHAMPION_AGENT_ID]);
assert.equal(metadata.name, "自适应型 · Triad");
assert.equal(customBrowserAgentMetadata("balanced"), null);
assert.equal(createCustomBrowserAgent("balanced"), null);

const game = createGame({
  bestOf: 3,
  roundTimeSeconds: 60,
  playerTemplate: "vanguard",
  aiTemplate: "vanguard",
});
const agent = createCustomBrowserAgent(TRIAD_CHAMPION_AGENT_ID);
assert.equal(agent.name, "自适应型 · Triad");
assert.equal(agent.browserAgentId, TRIAD_CHAMPION_AGENT_ID);
assert.equal(Object.hasOwn(agent, "observationDelayFrames"), false);
assert.equal(typeof agent.decide, "function");
assert.equal(typeof agent.resetForMatch, "function");
agent.resetForMatch(game, 1, { seed: 20260720 });
assert.equal(agent.matchInfo.self.templateId, "vanguard");
const input = agent.decide(game, 1);
assert.equal(typeof input, "object");
assert.equal(Object.keys(input).length, 14);

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
for (const selectId of ["left-agent-select", "agent-select"]) {
  assert.deepEqual(optionValues(html, selectId), [...BUILT_IN_IDS, TRIAD_CHAMPION_AGENT_ID]);
}

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
assert.match(mainSource, /createBrowserAgent\(preset,/);
assert.doesNotMatch(mainSource, /\bcreateScriptAI\s*\(/, "browser must not bypass the Agent V1 boundary");
assert.doesNotMatch(mainSource, /observationDelayFrames|delay-select/, "browser runtime must not expose observation delay");
assert.doesNotMatch(mainSource, /#(?:left|right)-template-select/, "browser must not expose a fighter picker");

function runRealtimeBrowserMatch(seeds) {
  const left = createBrowserAgent("pressure", {
    difficulty: "normal",
    seed: seeds.left,
  });
  const right = createBrowserAgent(TRIAD_CHAMPION_AGENT_ID, {
    difficulty: "normal",
    seed: seeds.right,
  });
  let match = createGame({
    bestOf: 3,
    roundTimeSeconds: 60,
    playerName: left.name,
    aiName: right.name,
    playerTemplate: "vanguard",
    aiTemplate: "vanguard",
  });
  left.resetForMatch(match, 0, { seed: seeds.left });
  right.resetForMatch(match, 1, { seed: seeds.right });

  let frames = 0;
  while (match.phase !== "matchOver" && frames < 50000) {
    const p1 = left.decide(match, 0);
    const p2 = right.decide(match, 1);
    const stepped = stepGame(match, { p1, p2 });
    if (stepped && stepped !== match) match = stepped;
    frames += 1;
    if (match.phase === "roundOver") {
      const advanced = nextRound(match);
      if (advanced && advanced !== match) match = advanced;
    }
  }
  assert.equal(match.phase, "matchOver", "fair browser match must terminate");
  return {
    match,
    frames,
    decisions: [left.getLastDecision(), right.getLastDecision()],
    matchInfo: [left.matchInfo, right.matchInfo],
  };
}

const seedSequence = createBrowserMatchSeedSequence();
const oldFixedSeeds = seedSequence.next();
assert.deepEqual(oldFixedSeeds, { matchIndex: 0, left: 20260719, right: 20260720 });
const fairMatch = runRealtimeBrowserMatch(oldFixedSeeds);
assert([0, 1].includes(fairMatch.match.matchWinner), "realtime browser match must produce a winner");
assert.deepEqual(fairMatch.matchInfo.map((info) => info.seed), [oldFixedSeeds.left, oldFixedSeeds.right]);
for (const decision of fairMatch.decisions) {
  assert.equal(decision.opponentObservedFrame, decision.decisionFrame);
}

const rematchSeeds = seedSequence.next();
assert.deepEqual(rematchSeeds, { matchIndex: 1, left: 20260721, right: 20260722 });
const rematch = runRealtimeBrowserMatch(rematchSeeds);
assert.deepEqual(rematch.matchInfo.map((info) => info.seed), [rematchSeeds.left, rematchSeeds.right]);
assert.notDeepEqual(rematchSeeds, oldFixedSeeds, "rematch must rebuild runners with a fresh deterministic seed pair");

for (const id of [...BUILT_IN_IDS, TRIAD_CHAMPION_AGENT_ID]) {
  const runner = createBrowserAgent(id, {
    difficulty: "normal",
    seed: 7,
  });
  assert.equal(typeof runner.act, "function", `${id} must expose Agent V1 act`);
  assert.equal(typeof runner.decide, "function", `${id} must expose the engine bridge`);
  assert.equal(typeof runner.resetForMatch, "function", `${id} must expose browser match reset`);
  assert.equal(Object.hasOwn(runner, "observationDelayFrames"), false, `${id} must expose no delay setting`);
}
for (const observationDelayFrames of [0, 1]) {
  assert.throws(
    () => createBrowserAgent("balanced", { observationDelayFrames }),
    /取消|removed/i,
    "browser Agent construction must reject the removed delay option",
  );
}

const championSource = await readFile(new URL("../src/triad-champion-agent-alt.js", import.meta.url));
assert.equal(createHash("sha256").update(championSource).digest("hex"), EXPECTED_CHAMPION_SHA256);

process.stdout.write("browser-agent-registry ok · realtime V1 roster, fresh rematch seeds, frozen hash\n");
