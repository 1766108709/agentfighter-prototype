import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentApiServer } from "../server/agent-api-server.mjs";

const AGENT_CODE = `
function createAgent(api) {
  return {
    name: "API Test Agent",
    act(observation) {
      const towardRight = observation.self.position.x < observation.opponent.position.x;
      return api.action({
        left: !towardRight,
        right: towardRight,
        lp: observation.frame % 16 === 0,
      });
    },
  };
}`;

const dataDir = await mkdtemp(join(tmpdir(), "agentfighter-api-test-"));
let application = await createAgentApiServer({
  dataDir,
  cooldownMs: 0,
  matchTimeoutMs: 10_000,
});
let listening = await application.listen({ port: 0 });
let base = listening.url;

try {
  const status = await jsonRequest("/api/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.service, "agentfighter-agent-api");

  const guideResponse = await fetch(`${base}/agent-guide`);
  assert.equal(guideResponse.status, 200);
  assert.match(guideResponse.headers.get("content-type"), /text\/markdown/);
  assert.match(await guideResponse.text(), /Fighter Key/);

  const manifest = await jsonRequest("/api/templates/vanguard");
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.body.schema, "agentfighter.template-manifest");
  assert(manifest.body.moves.length > 50);
  assert(!JSON.stringify(manifest.body).includes('"hitboxes"'));

  const contract = await jsonRequest("/api/schemas/agent-v1");
  assert.equal(contract.response.status, 200);
  assert.equal(contract.body.schema, "agentfighter.agent-contract");
  assert.equal(contract.body.schemas.observationV1.example.schema, "agentfighter.observation");
  assert.equal(contract.body.schemas.actionV1.example.schema, "agentfighter.action");
  assert(contract.body.schemas.observationV1.example.projectiles.length > 0);
  assert.equal(contract.body.perception.mode, "realtime");
  assert.equal(contract.body.schemas.observationV1.example.perception.delayFrames, 0);
  assert.equal(
    contract.body.schemas.observationV1.example.perception.opponentFrame,
    contract.body.schemas.observationV1.example.frame,
  );

  const first = await createFighter("API Alpha", "vanguard");
  const second = await createFighter("API Beta", "ember");
  assert.match(first.key, /^afk_/);
  assert.notEqual(first.key, second.key);
  assert.equal(first.apiBaseUrl, base);
  assert.equal(first.guideUrl, `${base}/agent-guide`);

  const stateText = await readFile(join(dataDir, "state.json"), "utf8");
  assert(!stateText.includes(first.key), "plaintext Fighter Key must not be persisted");
  assert(!stateText.includes(second.key), "plaintext Fighter Key must not be persisted");
  assert(stateText.includes("tokenHash"), "store must persist only a token hash");

  const missingAuth = await jsonRequest("/api/agent/fighter");
  assert.equal(missingAuth.response.status, 401);
  assert.equal(missingAuth.body.error.code, "INVALID_FIGHTER_KEY");
  const bareKeyAuth = await jsonRequest("/api/agent/fighter", {
    headers: { Authorization: first.key },
  });
  assert.equal(bareKeyAuth.response.status, 401, "API must require the Bearer scheme");

  const firstHeaders = authHeaders(first.key);
  const secondHeaders = authHeaders(second.key);
  const firstRead = await jsonRequest("/api/agent/fighter", { headers: firstHeaders });
  assert.equal(firstRead.response.status, 200);
  assert.equal(firstRead.body.fighter.id, first.id);
  assert.equal(firstRead.body.activeVersion, null);
  assert.equal(firstRead.body.officialRuleset.id, "standard-v2");
  assert.equal(firstRead.body.officialRuleset.observation, "realtime");
  assert.equal(firstRead.body.officialRuleset.seedPolicy, "server-random");
  assert.deepEqual(firstRead.body.officialRuleset.rankedOpponentKinds, ["fighter"]);
  assert.equal(Object.hasOwn(firstRead.body.officialRuleset, "delay"), false);
  assert.equal(Object.hasOwn(firstRead.body.limits, "observationDelayFrames"), false);
  assert.deepEqual(firstRead.body.limits.observation, { mode: "realtime", delayFrames: 0 });
  assert.equal(firstRead.body.limits.sharedMatchCooldownMs, 0);
  assert(!JSON.stringify(firstRead.body).includes("tokenHash"));

  const firstPublish = await publish(firstHeaders, "alpha v1");
  const secondPublish = await publish(secondHeaders, "beta v1");
  assert.equal(firstPublish.response.status, 201);
  assert.equal(secondPublish.response.status, 201);
  assert(!Object.hasOwn(firstPublish.body.version, "code"), "publish response should not echo full source");

  const firstWithCode = await jsonRequest("/api/agent/fighter", { headers: firstHeaders });
  assert.equal(firstWithCode.body.activeVersion.code, AGENT_CODE);
  assert(!Object.hasOwn(firstWithCode.body.fighter.versions[0], "code"));

  const firstV2 = await jsonRequest("/api/agent/fighter/code", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({
      code: AGENT_CODE.replace("API Test Agent", "API Test Agent v2"),
      notes: "alpha v2",
      submittedBy: "agent-api-test",
    }),
  });
  assert.equal(firstV2.response.status, 201);
  const firstV1Id = firstPublish.body.version.id;
  const firstV1 = await jsonRequest(
    `/api/agent/fighter/versions/${encodeURIComponent(firstV1Id)}`,
    { headers: firstHeaders },
  );
  assert.equal(firstV1.response.status, 200);
  assert.equal(firstV1.body.version.code, AGENT_CODE);
  const rollback = await jsonRequest(
    `/api/agent/fighter/versions/${encodeURIComponent(firstV1Id)}/activate`,
    { method: "POST", headers: firstHeaders, body: "{}" },
  );
  assert.equal(rollback.response.status, 200);
  assert.equal(rollback.body.activeVersion.id, firstV1Id);
  assert.equal(rollback.body.activeVersion.code, AGENT_CODE);

  const opponents = await jsonRequest("/api/agent/opponents", { headers: firstHeaders });
  assert.equal(opponents.response.status, 200);
  assert(opponents.body.opponents.some((opponent) => opponent.id === "builtin:balanced"));
  assert(opponents.body.opponents.some((opponent) => opponent.id === second.id));
  assert(!JSON.stringify(opponents.body).includes(AGENT_CODE), "opponent listings must hide source code");

  const removedDelaySimulation = await jsonRequest("/api/agent/fighter/simulate", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ delay: 0 }),
  });
  assert.equal(removedDelaySimulation.response.status, 400);
  assert.equal(removedDelaySimulation.body.error.code, "UNKNOWN_FIELDS");

  const simulation = await jsonRequest("/api/agent/fighter/simulate", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({
      code: AGENT_CODE,
      opponentId: "builtin:balanced",
      bestOf: 1,
      roundSeconds: 10,
      seed: 9,
    }),
  });
  assert.equal(simulation.response.status, 200);
  assert.equal(simulation.body.persisted, false);
  assert(simulation.body.replay, "simulation must return a replay");
  assert(!Object.hasOwn(simulation.body.result, "replay"));
  assert(Object.values(simulation.body.result.actions.A).every((count) => count > 0));

  const manipulatedChallenge = await jsonRequest("/api/agent/fighter/challenge", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ opponentId: second.id, seed: 10 }),
  });
  assert.equal(manipulatedChallenge.response.status, 400);
  assert.equal(manipulatedChallenge.body.error.code, "UNKNOWN_FIELDS");
  const removedDelayChallenge = await jsonRequest("/api/agent/fighter/challenge", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ opponentId: second.id, delay: 0 }),
  });
  assert.equal(removedDelayChallenge.response.status, 400);
  assert.equal(removedDelayChallenge.body.error.code, "UNKNOWN_FIELDS");

  const challenge = await jsonRequest("/api/agent/fighter/challenge", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ opponentId: second.id }),
  });
  assert.equal(challenge.response.status, 201);
  assert.match(challenge.body.match.id, /^mat_/);
  assert.match(challenge.body.match.humanReplayUrl, /\?match=mat_/);
  assert(["win", "loss", "draw"].includes(challenge.body.outcome));
  assert(["challenger", "opponent", "draw"].includes(challenge.body.winnerRole));
  assert.equal(challenge.body.match.outcome, challenge.body.outcome);
  assert.equal(challenge.body.rankEligible, true);
  assert.equal(challenge.body.match.rankEligible, true);
  assert.match(challenge.body.match.eventsUrl, /view=events$/);
  assert.match(challenge.body.match.framesUrl, /\/agent\/frames\?/);
  assert(!JSON.stringify(challenge.body).includes(AGENT_CODE));

  const matches = await jsonRequest("/api/agent/fighter/matches", { headers: firstHeaders });
  assert.equal(matches.response.status, 200);
  assert.equal(matches.body.count, 1);
  assert.equal(matches.body.matches[0].id, challenge.body.match.id);

  const publicResultPath = new URL(challenge.body.match.agentResultUrl).pathname;
  const replayPath = new URL(challenge.body.match.replayUrl).pathname;
  const publicResult = await jsonRequest(publicResultPath);
  const replay = await jsonRequest(replayPath);
  assert.equal(publicResult.response.status, 200);
  assert.equal(publicResult.body.status, "settled");
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.schema, "ReplayV1");
  assert.equal(replay.body.end.metadata.matchId, challenge.body.match.id);
  assert(
    replay.body.frames.every((frame) => (
      frame.decisions?.p1?.observedFrame === frame.sequence
      && frame.decisions?.p2?.observedFrame === frame.sequence
      && frame.decisions.p1.opponentObservedFrame === frame.sequence
      && frame.decisions.p2.opponentObservedFrame === frame.sequence
    )),
    "official replays must record realtime observations for both participants",
  );

  const eventView = await jsonRequest(
    `${new URL(challenge.body.match.agentResultUrl).pathname}?view=events`,
  );
  assert.equal(eventView.response.status, 200);
  assert.equal(eventView.body.matchId, challenge.body.match.id);
  assert(Array.isArray(eventView.body.events));
  const frameSlice = await jsonRequest(
    `${new URL(challenge.body.match.framesUrl).pathname}?from=0&to=10`,
  );
  assert.equal(frameSlice.response.status, 200);
  assert.equal(frameSlice.body.frames.length, 10);
  assert.equal(frameSlice.body.from, 0);
  assert.equal(frameSlice.body.to, 10);

  const deniedSource = await jsonRequest("/server/agent-store.mjs");
  assert.equal(deniedSource.response.status, 404, "static server must not expose server source");

  const firstAfter = await jsonRequest("/api/agent/fighter", { headers: firstHeaders });
  const secondAfter = await jsonRequest("/api/agent/fighter", { headers: secondHeaders });
  assert.equal(firstAfter.body.fighter.stats.matches, 1);
  assert.equal(secondAfter.body.fighter.stats.matches, 1);
  assert.equal(
    firstAfter.body.fighter.stats.matches,
    firstAfter.body.fighter.stats.wins
      + firstAfter.body.fighter.stats.losses
      + firstAfter.body.fighter.stats.draws,
  );

  const builtInChallenge = await jsonRequest("/api/agent/fighter/challenge", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ opponentId: "builtin:zoner" }),
  });
  assert.equal(builtInChallenge.response.status, 201);
  assert.equal(builtInChallenge.body.rankEligible, false);

  await application.close();
  application = await createAgentApiServer({
    dataDir,
    cooldownMs: 0,
    matchTimeoutMs: 10_000,
  });
  listening = await application.listen({ port: 0 });
  base = listening.url;

  const restored = await jsonRequest("/api/agent/fighter", { headers: firstHeaders });
  const restoredMatches = await jsonRequest("/api/agent/fighter/matches", { headers: firstHeaders });
  assert.equal(restored.response.status, 200, "Fighter Key must survive a service restart");
  assert.equal(restored.body.activeVersion.code, AGENT_CODE, "active code must survive a service restart");
  assert.equal(restored.body.fighter.stats.matches, 1, "only ranked fighter matches count after restart");
  assert.equal(restoredMatches.body.count, 2, "official match list must survive a service restart");
  const restoredBuiltinReplay = await jsonRequest(
    new URL(builtInChallenge.body.match.replayUrl).pathname,
  );
  assert.equal(restoredBuiltinReplay.response.status, 200);
  assert.equal(restoredBuiltinReplay.body.end.metadata.matchId, builtInChallenge.body.match.id);
  const systemFighters = (await application.store.listFighters())
    .filter((fighter) => fighter.name.startsWith("[system]"));
  assert.equal(systemFighters.length, 3, "restart must reuse, not duplicate, built-in storage fighters");

  await application.close();
  application = await createAgentApiServer({
    dataDir,
    cooldownMs: 10_000,
    matchTimeoutMs: 10_000,
  });
  listening = await application.listen({ port: 0 });
  base = listening.url;

  const invalidBeforeCooldown = await jsonRequest("/api/agent/fighter/simulate", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ unknownSetting: true }),
  });
  assert.equal(invalidBeforeCooldown.response.status, 400);
  const validAfterInvalid = await jsonRequest("/api/agent/fighter/simulate", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({
      opponentId: "builtin:balanced",
      bestOf: 1,
      roundSeconds: 10,
      seed: 19,
    }),
  });
  assert.equal(
    validAfterInvalid.response.status,
    200,
    "invalid requests must not consume the match cooldown",
  );
  const sharedCooldown = await jsonRequest("/api/agent/fighter/challenge", {
    method: "POST",
    headers: firstHeaders,
    body: JSON.stringify({ opponentId: second.id }),
  });
  assert.equal(sharedCooldown.response.status, 429);
  assert.equal(sharedCooldown.body.error.code, "RATE_LIMITED");
  assert(sharedCooldown.body.error.details.retryAfterMs > 0);
  assert(sharedCooldown.response.headers.get("retry-after"));
} finally {
  await application.close();
  await rm(dataDir, { recursive: true, force: true });
}

console.log("agent API tests passed");

async function createFighter(name, templateId) {
  const created = await jsonRequest("/api/fighters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, templateId }),
  });
  assert.equal(created.response.status, 201);
  return {
    id: created.body.fighter.id,
    key: created.body.onboarding.fighterKey,
    apiBaseUrl: created.body.onboarding.apiBaseUrl,
    guideUrl: created.body.onboarding.guideUrl,
  };
}

async function publish(headers, notes) {
  return jsonRequest("/api/agent/fighter/code", {
    method: "POST",
    headers,
    body: JSON.stringify({
      code: AGENT_CODE,
      notes,
      submittedBy: "agent-api-test",
    }),
  });
}

function authHeaders(key) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  return { response, body };
}
