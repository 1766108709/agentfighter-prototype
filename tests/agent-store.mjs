import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentStore } from "../server/agent-store.mjs";

const dataDir = await mkdtemp(join(tmpdir(), "agentfighter-store-test-"));
const stateFile = join(dataDir, "state.json");
const matchesDir = join(dataDir, "matches");

try {
  let store = await createAgentStore({ dataDir });
  const left = await store.createFighter({ name: "Store Left", templateId: "vanguard" });
  const right = await store.createFighter({ name: "Store Right", templateId: "ember" });

  const rankedId = "mat_ranked_recovery";
  const beforeRanked = await readFile(stateFile, "utf8");
  const rankedSummary = await store.recordMatch({
    id: rankedId,
    leftFighterId: left.fighter.id,
    rightFighterId: right.fighter.id,
    winner: "A",
    rankEligible: true,
    replay: replayFixture(rankedId),
    details: { status: "settled" },
  });

  const rankedFile = join(matchesDir, `${rankedId}.json`);
  const rankedEnvelope = JSON.parse(await readFile(rankedFile, "utf8"));
  assert.equal(rankedEnvelope.schema, "agentfighter.match-envelope");
  assert.equal(rankedEnvelope.version, 1);
  assert.deepEqual(rankedEnvelope.summary, rankedSummary);
  assert.deepEqual(rankedEnvelope.replay, replayFixture(rankedId));

  // Simulate a process exit after the durable envelope was installed but before
  // state.json was replaced.
  await writeFile(stateFile, beforeRanked, "utf8");
  store = await createAgentStore({ dataDir });

  assert.deepEqual(await store.getMatchSummary(rankedId), rankedSummary);
  assert.deepEqual((await store.getMatch(rankedId)).replay, replayFixture(rankedId));
  let leftOwner = await store.getFighterByBearerToken(`Bearer ${left.token}`);
  let rightOwner = await store.getFighterByBearerToken(`Bearer ${right.token}`);
  assert.deepEqual(leftOwner.stats, { matches: 1, wins: 1, losses: 0, draws: 0 });
  assert.deepEqual(rightOwner.stats, { matches: 1, wins: 0, losses: 1, draws: 0 });

  const unrankedId = "mat_unranked_recovery";
  const beforeUnranked = await readFile(stateFile, "utf8");
  const unrankedSummary = await store.recordMatch({
    id: unrankedId,
    leftFighterId: left.fighter.id,
    rightFighterId: right.fighter.id,
    winner: "B",
    rankEligible: false,
    replay: replayFixture(unrankedId),
    details: { status: "settled" },
  });
  assert.equal(unrankedSummary.rankEligible, false);

  leftOwner = await store.getFighterByBearerToken(`Bearer ${left.token}`);
  rightOwner = await store.getFighterByBearerToken(`Bearer ${right.token}`);
  assert.deepEqual(leftOwner.stats, { matches: 1, wins: 1, losses: 0, draws: 0 });
  assert.deepEqual(rightOwner.stats, { matches: 1, wins: 0, losses: 1, draws: 0 });

  // Recovery must restore the unranked summary without applying its outcome to
  // official stats.
  await writeFile(stateFile, beforeUnranked, "utf8");
  store = await createAgentStore({ dataDir });
  assert.deepEqual(await store.getMatchSummary(unrankedId), unrankedSummary);
  leftOwner = await store.getFighterByBearerToken(`Bearer ${left.token}`);
  rightOwner = await store.getFighterByBearerToken(`Bearer ${right.token}`);
  assert.deepEqual(leftOwner.stats, { matches: 1, wins: 1, losses: 0, draws: 0 });
  assert.deepEqual(rightOwner.stats, { matches: 1, wins: 0, losses: 1, draws: 0 });

  // Pre-envelope stores persisted only ReplayV1 in the match file and had no
  // rankEligible field in their summary. Both shapes remain readable.
  const legacyState = JSON.parse(await readFile(stateFile, "utf8"));
  delete legacyState.matches[rankedId].rankEligible;
  await writeJson(stateFile, legacyState);
  await writeJson(rankedFile, rankedEnvelope.replay);

  store = await createAgentStore({ dataDir });
  const legacyMatch = await store.getMatch(rankedId);
  assert.equal(legacyMatch.summary.rankEligible, undefined);
  assert.deepEqual(legacyMatch.replay, replayFixture(rankedId));

  console.log("agent store tests passed");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function replayFixture(matchId) {
  return {
    schema: "ReplayV1",
    version: 1,
    end: {
      completed: true,
      metadata: { matchId },
    },
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
