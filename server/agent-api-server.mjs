import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentStoreError,
  createAgentStore,
} from "./agent-store.mjs";
import { listPublicTemplates, publicTemplateManifest } from "./public-manifest.mjs";
import { MatchSandboxError, runSandboxMatch } from "./run-match.mjs";
import { MAX_AGENT_CODE_BYTES } from "./sandbox-agent.mjs";
import { agentProtocolContract } from "./agent-protocol-contract.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_DATA_DIR = resolve(DEFAULT_ROOT, ".data", "agent-api");
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_COOLDOWN_MS = 2_000;
const SINGLE_FIGHTER_ID = "vanguard";
const DEFAULT_OFFICIAL_RULESET = Object.freeze({
  id: "standard-v2",
  difficulty: "normal",
  observation: "realtime",
  roundSeconds: 30,
  bestOf: 3,
  seedPolicy: "server-random",
  rankedOpponentKinds: Object.freeze(["fighter"]),
});
const BUILTIN_OPPONENTS = Object.freeze([
  Object.freeze({
    id: "builtin:balanced",
    preset: "balanced",
    name: "Echo · 均衡型",
    templateId: SINGLE_FIGHTER_ID,
    description: "中距离控场，按局势切换攻防。",
  }),
  Object.freeze({
    id: "builtin:pressure",
    preset: "pressure",
    name: "Blitz · 压迫型",
    templateId: SINGLE_FIGHTER_ID,
    description: "持续贴身、抢回合并尝试高伤连段。",
  }),
  Object.freeze({
    id: "builtin:zoner",
    preset: "zoner",
    name: "Vela · 远程型",
    templateId: SINGLE_FIGHTER_ID,
    description: "用飞行物和对空控制屏幕空间。",
  }),
]);
const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

export async function createAgentApiServer(options = {}) {
  const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
  const dataDir = resolve(options.dataDir ?? DEFAULT_DATA_DIR);
  const store = options.store ?? await createAgentStore({ dataDir });
  const publicBaseUrl = normalizeOptionalBaseUrl(options.publicBaseUrl);
  const cooldownMs = boundedInteger(options.cooldownMs, 0, 60_000, DEFAULT_COOLDOWN_MS);
  const matchTimeoutMs = boundedInteger(options.matchTimeoutMs, 250, 120_000, 20_000);
  const officialRuleset = normalizeOfficialRuleset(options.officialRuleset);
  const guide = await readFile(resolve(rootDir, "AGENT_GUIDE.md"), "utf8");
  const builtinStorage = await ensureBuiltinStorageFighters(store);
  const cooldowns = new Map();

  const server = createServer(async (request, response) => {
    applyCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    try {
      await route(request, response);
    } catch (error) {
      sendError(response, error);
    }
  });

  async function route(request, response) {
    const url = new URL(request.url ?? "/", "http://agentfighter.invalid");
    const path = decodeURIComponent(url.pathname);

    if (request.method === "GET" && path === "/api/status") {
      sendJson(response, 200, {
        service: "agentfighter-agent-api",
        version: 1,
        protocolVersion: 1,
        sandbox: "worker+vm local reference",
        productionReady: false,
        guidePath: "/agent-guide",
      });
      return;
    }

    if (request.method === "GET" && (path === "/agent-guide" || path === "/AGENT_GUIDE.md")) {
      sendText(response, 200, guide, "text/markdown; charset=utf-8");
      return;
    }

    const templateMatch = /^\/api\/templates\/([^/]+)$/.exec(path);
    if (request.method === "GET" && templateMatch) {
      const manifest = publicTemplateManifest(templateMatch[1]);
      if (!manifest) throw new ApiError(404, "TEMPLATE_NOT_FOUND", "Unknown fighter template.");
      sendJson(response, 200, manifest);
      return;
    }

    if (request.method === "GET" && path === "/api/schemas/agent-v1") {
      sendJson(response, 200, agentProtocolContract());
      return;
    }

    if (request.method === "POST" && path === "/api/fighters") {
      const body = await readJsonBody(request);
      assertAllowedKeys(body, ["name", "templateId"]);
      const name = requiredText(body.name, "name", 48);
      if (name.toLowerCase().startsWith("[system]")) {
        throw new ApiError(400, "RESERVED_NAME", "Fighter names beginning with [system] are reserved.");
      }
      const templateId = templateIdentifier(body.templateId);
      const created = await store.createFighter({ name, templateId });
      const base = requestBaseUrl(request, publicBaseUrl);
      sendJson(response, 201, {
        fighter: created.fighter,
        onboarding: {
          fighterKey: created.token,
          guideUrl: `${base}/agent-guide`,
          apiBaseUrl: base,
          warning: "This full Fighter Key is shown once. Store it privately; it is not a model-provider API key.",
        },
      });
      return;
    }

    const publicMatch = /^\/api\/matches\/([^/]+)\/(agent|replay)\.json$/.exec(path);
    if (request.method === "GET" && publicMatch) {
      const match = await store.getMatch(publicMatch[1]);
      if (!match) throw new ApiError(404, "MATCH_NOT_FOUND", "Match was not found.");
      if (publicMatch[2] === "replay") {
        sendJson(response, 200, match.replay);
      } else if (url.searchParams.get("view") === "events") {
        const base = requestBaseUrl(request, publicBaseUrl);
        const events = Array.isArray(match.replay.events) ? match.replay.events : [];
        sendJson(response, 200, {
          matchId: match.summary.id,
          count: events.length,
          events,
          links: matchResourceLinks(match.summary.id, base),
        });
      } else {
        const base = requestBaseUrl(request, publicBaseUrl);
        sendJson(response, 200, decorateMatchSummary(match.summary, base));
      }
      return;
    }

    const publicFrameSlice = /^\/api\/matches\/([^/]+)\/agent\/frames$/.exec(path);
    if (request.method === "GET" && publicFrameSlice) {
      const match = await store.getMatch(publicFrameSlice[1]);
      if (!match) throw new ApiError(404, "MATCH_NOT_FOUND", "Match was not found.");
      const frames = Array.isArray(match.replay.frames) ? match.replay.frames : [];
      const from = boundedInteger(url.searchParams.get("from"), 0, frames.length, 0);
      const defaultTo = Math.min(frames.length, from + 300);
      const to = boundedInteger(url.searchParams.get("to"), from, frames.length, defaultTo);
      if (to - from > 600) {
        throw new ApiError(400, "FRAME_SLICE_TOO_LARGE", "A frame slice may contain at most 600 frames.");
      }
      const base = requestBaseUrl(request, publicBaseUrl);
      sendJson(response, 200, {
        matchId: match.summary.id,
        from,
        to,
        totalFrames: frames.length,
        frames: frames.slice(from, to),
        links: matchResourceLinks(match.summary.id, base),
      });
      return;
    }

    if (path.startsWith("/api/agent/")) {
      const authorization = String(request.headers.authorization ?? "");
      if (!/^Bearer\s+\S+$/i.test(authorization)) {
        throw new ApiError(401, "INVALID_FIGHTER_KEY", "Use Authorization: Bearer <Fighter Key>.");
      }
      const fighter = await store.getFighterByBearerToken(authorization);
      if (!fighter) throw new ApiError(401, "INVALID_FIGHTER_KEY", "A valid Fighter Key is required.");

      if (request.method === "GET" && path === "/api/agent/fighter") {
        const base = requestBaseUrl(request, publicBaseUrl);
        sendJson(response, 200, {
          fighter: ownerApiFighter(fighter),
          activeVersion: activeOwnerVersion(fighter),
          templates: listPublicTemplates().map((template) => ({
            ...template,
            manifestUrl: `${base}${template.manifestPath}`,
          })),
          builtInOpponents: BUILTIN_OPPONENTS,
          limits: {
            maxCodeBytes: MAX_AGENT_CODE_BYTES,
            sharedMatchCooldownMs: cooldownMs,
            nextMatchAt: cooldowns.get(fighter.id)
              ? new Date(cooldowns.get(fighter.id)).toISOString()
              : null,
            observation: { mode: "realtime", delayFrames: 0 },
            simulation: {
              seed: { minimum: 0, maximum: 0xffffffff },
              roundSeconds: { minimum: 10, maximum: 300, default: 30 },
              bestOf: { allowed: [1, 3, 5, 7, 9], default: 3 },
              difficulty: ["easy", "normal", "hard", "expert"],
            },
          },
          officialRuleset,
          links: {
            self: `${base}/api/agent/fighter`,
            guide: `${base}/agent-guide`,
            schemas: `${base}/api/schemas/agent-v1`,
            simulate: `${base}/api/agent/fighter/simulate`,
            publish: `${base}/api/agent/fighter/code`,
            challenge: `${base}/api/agent/fighter/challenge`,
            opponents: `${base}/api/agent/opponents`,
            leaderboard: `${base}/api/agent/leaderboard`,
            matches: `${base}/api/agent/fighter/matches`,
          },
        });
        return;
      }

      if (request.method === "POST" && path === "/api/agent/fighter/code") {
        const body = await readJsonBody(request);
        assertAllowedKeys(body, ["code", "notes", "submittedBy"]);
        const code = agentCode(body.code);
        const submittedBy = requiredText(body.submittedBy, "submittedBy", 80);
        await validatePublishedCode(code, {
          timeoutMs: Math.min(matchTimeoutMs, 5_000),
        });
        const published = await store.publishVersion(authorization, {
          code,
          label: optionalText(body.notes, "notes", 120),
          metadata: {
            submittedBy,
          },
        });
        sendJson(response, 201, {
          fighter: ownerApiFighter(published.fighter),
          version: versionMetadata(published.version),
        });
        return;
      }

      const versionRoute = /^\/api\/agent\/fighter\/versions\/([^/]+)$/.exec(path);
      if (versionRoute && request.method === "GET") {
        const version = fighter.versions.find((candidate) => candidate.id === versionRoute[1]);
        if (!version) throw new ApiError(404, "VERSION_NOT_FOUND", "Version was not found.");
        sendJson(response, 200, { version });
        return;
      }

      const activateVersionRoute = /^\/api\/agent\/fighter\/versions\/([^/]+)\/activate$/.exec(path);
      if (activateVersionRoute && request.method === "POST") {
        const body = await readJsonBody(request);
        assertAllowedKeys(body, []);
        const activated = await store.activateVersion(authorization, activateVersionRoute[1]);
        sendJson(response, 200, {
          fighter: ownerApiFighter(activated),
          activeVersion: activeOwnerVersion(activated),
        });
        return;
      }

      if (request.method === "POST" && path === "/api/agent/fighter/simulate") {
        const body = await readJsonBody(request);
        assertMatchRequestKeys(body, { allowCode: true });
        const active = activeOwnerVersion(fighter);
        const code = body.code === undefined ? active?.code : agentCode(body.code);
        if (!code) {
          throw new ApiError(409, "NO_ACTIVE_CODE", "Provide candidate code or publish an active version first.");
        }
        const opponent = await resolveOpponent(store, builtinStorage, fighter.id, body.opponentId);
        const settings = matchSettings(body);
        enforceCooldown(cooldowns, fighter.id, cooldownMs);
        const completed = await runSandboxMatch({
          matchId: `sim_${randomIdentifier()}`,
          codeA: code,
          codeB: opponent.code,
          opponentPreset: opponent.preset,
          ...settings,
          timeoutMs: matchTimeoutMs,
          recordReplay: true,
        });
        const result = completed.summary.results[0];
        const { replay } = result;
        sendJson(response, 200, {
          mode: "simulation",
          persisted: false,
          fighter: compactFighter(fighter),
          opponent: opponent.public,
          settings: completed.summary.settings,
          result: compactMatchResult(result),
          telemetry: completed.summary.telemetry,
          diagnostics: completed.summary.diagnostics,
          replay,
        });
        return;
      }

      if (request.method === "GET" && path === "/api/agent/opponents") {
        const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
        const limit = boundedInteger(url.searchParams.get("limit"), 1, 100, 20);
        const published = await store.listOpponents(fighter.id, { activeOnly: true });
        const opponents = [
          ...BUILTIN_OPPONENTS.map((builtin) => ({ ...builtin, kind: "builtin" })),
          ...published.map((candidate) => ({
            ...candidate,
            templateId: SINGLE_FIGHTER_ID,
            kind: "fighter",
            activeVersion: candidate.versions.find((version) => version.id === candidate.activeVersionId) ?? null,
          })),
        ].filter((candidate) => (
          !q || `${candidate.id} ${candidate.name} ${candidate.templateId}`.toLowerCase().includes(q)
        )).slice(0, limit);
        sendJson(response, 200, { opponents, count: opponents.length });
        return;
      }

      if (request.method === "GET" && path === "/api/agent/leaderboard") {
        const fighters = (await store.listFighters({ activeOnly: true }))
          .filter((candidate) => !candidate.name.startsWith("[system]"))
          .map((candidate) => ({
            ...candidate,
            templateId: SINGLE_FIGHTER_ID,
            winRate: candidate.stats.matches > 0
              ? candidate.stats.wins / candidate.stats.matches
              : 0,
          }))
          .sort((left, right) => (
            right.stats.wins - left.stats.wins
            || right.winRate - left.winRate
            || left.name.localeCompare(right.name)
          ));
        sendJson(response, 200, { fighters, count: fighters.length });
        return;
      }

      if (request.method === "POST" && path === "/api/agent/fighter/challenge") {
        const body = await readJsonBody(request);
        assertAllowedKeys(body, ["opponentId"]);
        const active = activeOwnerVersion(fighter);
        if (!active) throw new ApiError(409, "NO_ACTIVE_CODE", "Publish a version before challenging.");
        const opponent = await resolveOpponent(store, builtinStorage, fighter.id, body.opponentId);
        const settings = {
          difficulty: officialRuleset.difficulty,
          roundSeconds: officialRuleset.roundSeconds,
          bestOf: officialRuleset.bestOf,
          seed: randomBytes(4).readUInt32BE(0),
        };
        enforceCooldown(cooldowns, fighter.id, cooldownMs);
        const matchId = `mat_${randomIdentifier()}`;
        const completed = await runSandboxMatch({
          matchId,
          codeA: active.code,
          codeB: opponent.code,
          opponentPreset: opponent.preset,
          ...settings,
          timeoutMs: matchTimeoutMs,
          recordReplay: true,
        });
        const result = completed.summary.results[0];
        const replay = result.replay;
        const compactResult = compactMatchResult(result);
        const rankEligible = opponent.public.kind === "fighter";
        const outcome = challengerOutcome(result.winner);
        const winnerRole = challengeWinnerRole(result.winner);
        const reason = result.roundResults.at(-1)?.reason ?? result.termination;
        const stored = await store.recordMatch({
          id: matchId,
          leftFighterId: fighter.id,
          leftVersionId: active.id,
          rightFighterId: opponent.storageFighterId,
          rightVersionId: opponent.versionId,
          winner: result.winner,
          rankEligible,
          replay,
          details: {
            status: "settled",
            opponent: opponent.public,
            rulesetId: officialRuleset.id,
            rankEligible,
            outcome,
            winnerRole,
            reason,
            codeHashes: {
              A: active.codeHash,
              B: opponent.codeHash,
            },
            settings: completed.summary.settings,
            result: compactResult,
            telemetry: completed.summary.telemetry,
            diagnostics: completed.summary.diagnostics,
          },
        });
        const base = requestBaseUrl(request, publicBaseUrl);
        sendJson(response, 201, {
          match: decorateMatchSummary(stored, base),
          outcome,
          winnerRole,
          winnerFighterId: stored.winnerFighterId,
          reason,
          rankEligible,
          result: compactResult,
        });
        return;
      }

      if (request.method === "GET" && path === "/api/agent/fighter/matches") {
        const limit = boundedInteger(url.searchParams.get("limit"), 1, 100, 20);
        const offset = boundedInteger(url.searchParams.get("offset"), 0, 1_000_000, 0);
        const base = requestBaseUrl(request, publicBaseUrl);
        const matches = await store.listMatchesForFighter(fighter.id, { limit, offset });
        sendJson(response, 200, {
          matches: matches.map((match) => decorateMatchSummary(match, base)),
          count: matches.length,
        });
        return;
      }

      throw new ApiError(404, "AGENT_ROUTE_NOT_FOUND", "Unknown Agent API route.");
    }

    if (path.startsWith("/api/")) {
      throw new ApiError(404, "API_ROUTE_NOT_FOUND", "Unknown API route.");
    }
    await serveStatic(request, response, rootDir, path);
  }

  return Object.freeze({
    server,
    store,
    dataDir,
    async listen({ port = 4173, host = "127.0.0.1" } = {}) {
      await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          server.off("error", rejectPromise);
          resolvePromise();
        });
      });
      const address = server.address();
      const displayHost = typeof address === "object" && address?.address === "::" ? "127.0.0.1" : host;
      return {
        address,
        url: `http://${displayHost}:${typeof address === "object" ? address.port : port}`,
      };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    },
  });
}

async function validatePublishedCode(code, { timeoutMs }) {
  const completed = await runSandboxMatch({
    matchId: `validate_${randomIdentifier()}`,
    codeA: code,
    bestOf: 1,
    roundSeconds: 10,
    maxFramesPerMatch: 60,
    recordReplay: false,
    timeoutMs,
  });
  const diagnostics = completed.summary.diagnostics.A;
  if (diagnostics.total > 0) {
    throw new ApiError(422, "AGENT_VALIDATION_FAILED", "Agent failed its sandbox validation frame.", {
      diagnostics,
    });
  }
}

async function resolveOpponent(store, builtinStorage, fighterId, requestedId) {
  const opponentId = String(requestedId ?? "builtin:balanced");
  const builtin = BUILTIN_OPPONENTS.find((candidate) => candidate.id === opponentId);
  if (builtin) {
    const storage = builtinStorage.get(builtin.id);
    return {
      public: { ...builtin, kind: "builtin" },
      preset: builtin.preset,
      templateId: SINGLE_FIGHTER_ID,
      code: null,
      codeHash: `builtin:${builtin.preset}`,
      storageFighterId: storage.id,
      versionId: null,
    };
  }
  if (opponentId === fighterId) {
    throw new ApiError(400, "SELF_CHALLENGE", "A fighter cannot challenge itself.");
  }
  const runtime = await store.getFighterRuntimeById(opponentId);
  if (!runtime) throw new ApiError(404, "OPPONENT_NOT_FOUND", "Opponent was not found.");
  if (!runtime.activeVersion) {
    throw new ApiError(409, "OPPONENT_HAS_NO_CODE", "Opponent has no active published version.");
  }
  const publicFighter = await store.getFighterById(opponentId);
  return {
    public: { ...publicFighter, templateId: SINGLE_FIGHTER_ID, kind: "fighter" },
    preset: "balanced",
    templateId: SINGLE_FIGHTER_ID,
    code: runtime.activeVersion.code,
    codeHash: runtime.activeVersion.codeHash,
    storageFighterId: runtime.id,
    versionId: runtime.activeVersion.id,
  };
}

async function ensureBuiltinStorageFighters(store) {
  const fighters = await store.listFighters();
  const mapping = new Map();
  for (const builtin of BUILTIN_OPPONENTS) {
    const systemName = `[system] ${builtin.id}`;
    let fighter = fighters.find((candidate) => candidate.name === systemName);
    if (!fighter) {
      const created = await store.createFighter({
        name: systemName,
        templateId: SINGLE_FIGHTER_ID,
      });
      fighter = created.fighter;
    }
    mapping.set(builtin.id, fighter);
  }
  return mapping;
}

function matchSettings(body) {
  const roundSeconds = boundedInteger(body.roundSeconds, 10, 300, 30);
  const bestOf = boundedInteger(body.bestOf, 1, 9, 3);
  if (bestOf % 2 === 0) throw new ApiError(400, "INVALID_BEST_OF", "bestOf must be odd.");
  return {
    seed: boundedInteger(body.seed, 0, 0xffffffff, randomBytes(4).readUInt32BE(0)),
    roundSeconds,
    bestOf,
    difficulty: enumValue(body.difficulty, ["easy", "normal", "hard", "expert"], "normal"),
  };
}

function assertMatchRequestKeys(body, { allowCode }) {
  const keys = [
    "opponentId", "seed", "roundSeconds", "bestOf", "difficulty",
    ...(allowCode ? ["code"] : []),
  ];
  assertAllowedKeys(body, keys);
}

function activeOwnerVersion(fighter) {
  return fighter.versions.find((version) => version.id === fighter.activeVersionId) ?? null;
}

function compactFighter(fighter) {
  return {
    id: fighter.id,
    name: fighter.name,
    templateId: SINGLE_FIGHTER_ID,
    activeVersionId: fighter.activeVersionId,
    stats: fighter.stats,
  };
}

function ownerApiFighter(fighter) {
  return {
    id: fighter.id,
    name: fighter.name,
    templateId: SINGLE_FIGHTER_ID,
    createdAt: fighter.createdAt,
    updatedAt: fighter.updatedAt,
    versions: fighter.versions.map(versionMetadata),
    activeVersionId: fighter.activeVersionId,
    stats: fighter.stats,
  };
}

function versionMetadata(version) {
  return {
    id: version.id,
    createdAt: version.createdAt,
    codeHash: version.codeHash,
    label: version.label,
    metadata: version.metadata,
  };
}

function decorateMatchSummary(summary, base) {
  const links = matchResourceLinks(summary.id, base);
  return {
    ...summary,
    status: summary.details?.status ?? "settled",
    sideOutcome: summary.outcome,
    outcome: summary.details?.outcome ?? summary.outcome,
    winnerRole: summary.details?.winnerRole
      ?? (summary.outcome === "left" ? "challenger" : summary.outcome === "right" ? "opponent" : "draw"),
    reason: summary.details?.reason ?? null,
    rankEligible: summary.rankEligible !== false,
    ...links,
  };
}

function matchResourceLinks(matchId, base) {
  const id = encodeURIComponent(matchId);
  return {
    humanReplayUrl: `${base}/?match=${id}`,
    agentResultUrl: `${base}/api/matches/${id}/agent.json`,
    eventsUrl: `${base}/api/matches/${id}/agent.json?view=events`,
    framesUrl: `${base}/api/matches/${id}/agent/frames?from=0&to=300`,
    replayUrl: `${base}/api/matches/${id}/replay.json`,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ApiError(413, "BODY_TOO_LARGE", `JSON body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  if (!isPlainObject(value)) throw new ApiError(400, "INVALID_BODY", "JSON body must be an object.");
  return value;
}

async function serveStatic(request, response, rootDir, path) {
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  }
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (!["index.html", "styles.css"].includes(relative) && !relative.startsWith("src/")) {
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }
  const filePath = resolve(rootDir, relative);
  if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${sep}`)) {
    throw new ApiError(403, "FORBIDDEN", "Forbidden.");
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }
  if (!info.isFile()) throw new ApiError(404, "NOT_FOUND", "Not found.");
  const bytes = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function enforceCooldown(cooldowns, fighterId, cooldownMs) {
  if (cooldownMs <= 0) return;
  const now = Date.now();
  const readyAt = cooldowns.get(fighterId) ?? 0;
  if (now < readyAt) {
    throw new ApiError(429, "RATE_LIMITED", "Simulation/challenge cooldown is active.", {
      retryAfterMs: readyAt - now,
    });
  }
  cooldowns.set(fighterId, now + cooldownMs);
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Internal server error.";
  let details;
  if (error instanceof ApiError) {
    ({ status, code, message, details } = error);
  } else if (error instanceof AgentStoreError) {
    status = error.statusCode ?? 500;
    code = error.code;
    message = error.message;
  } else if (error instanceof MatchSandboxError) {
    status = error.code === "MATCH_TIMEOUT" ? 504 : 422;
    code = error.code;
    message = error.message;
  } else if (error instanceof TypeError || error instanceof RangeError) {
    status = 400;
    code = "INVALID_REQUEST";
    message = error.message;
  }
  const headers = status === 429 && details?.retryAfterMs
    ? { "Retry-After": String(Math.max(1, Math.ceil(details.retryAfterMs / 1_000))) }
    : {};
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }, headers);
}

function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

function sendText(response, status, body, contentType) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

function applyCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Expose-Headers", "Retry-After");
  response.setHeader("Vary", "Origin");
}

function requestBaseUrl(request, configured) {
  if (configured) return configured;
  const host = String(request.headers.host ?? "127.0.0.1:4173").replace(/[^A-Za-z0-9.:[\]-]/g, "");
  return `http://${host || "127.0.0.1:4173"}`;
}

function normalizeOptionalBaseUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("publicBaseUrl must use http or https");
  return url.href.replace(/\/+$/, "");
}

function assertAllowedKeys(value, keys) {
  if (!isPlainObject(value)) throw new ApiError(400, "INVALID_BODY", "Body must be a plain object.");
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELDS", `Unknown fields: ${unknown.join(", ")}`);
  }
}

function requiredText(value, label, maximum) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "INVALID_FIELD", `${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maximum) throw new ApiError(400, "INVALID_FIELD", `${label} is too long.`);
  return text;
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > maximum) {
    throw new ApiError(400, "INVALID_FIELD", `${label} must be a string up to ${maximum} characters.`);
  }
  return value;
}

function agentCode(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "INVALID_CODE", "code must be a non-empty JavaScript string.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_AGENT_CODE_BYTES) {
    throw new ApiError(413, "CODE_TOO_LARGE", `code exceeds ${MAX_AGENT_CODE_BYTES} bytes.`);
  }
  return value;
}

function templateIdentifier(value) {
  const id = String(value ?? SINGLE_FIGHTER_ID).toLowerCase();
  if (!publicTemplateManifest(id)) {
    throw new ApiError(400, "INVALID_TEMPLATE", "templateId must be vanguard (苍流).");
  }
  return id;
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? fallback).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ApiError(400, "INVALID_FIELD", `Expected ${allowed.join("|")}.`);
  }
  return normalized;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ApiError(400, "INVALID_INTEGER", `Expected an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function randomIdentifier() {
  return randomBytes(16).toString("hex");
}

function normalizeOfficialRuleset(value) {
  if (value === undefined || value === null) return DEFAULT_OFFICIAL_RULESET;
  if (!isPlainObject(value)) throw new TypeError("officialRuleset must be a plain object");
  const allowed = new Set(["id", "difficulty", "roundSeconds", "bestOf"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown officialRuleset fields: ${unknown.join(", ")}`);
  }
  const bestOf = boundedInteger(value.bestOf, 1, 9, DEFAULT_OFFICIAL_RULESET.bestOf);
  if (bestOf % 2 === 0) throw new TypeError("officialRuleset.bestOf must be odd");
  return Object.freeze({
    id: requiredText(value.id ?? DEFAULT_OFFICIAL_RULESET.id, "officialRuleset.id", 64),
    difficulty: enumValue(
      value.difficulty,
      ["easy", "normal", "hard", "expert"],
      DEFAULT_OFFICIAL_RULESET.difficulty,
    ),
    observation: "realtime",
    roundSeconds: boundedInteger(
      value.roundSeconds,
      10,
      300,
      DEFAULT_OFFICIAL_RULESET.roundSeconds,
    ),
    bestOf,
    seedPolicy: "server-random",
    rankedOpponentKinds: Object.freeze(["fighter"]),
  });
}

function compactMatchResult(result) {
  const {
    replay: _replay,
    telemetry: _telemetry,
    diagnostics: _diagnostics,
    actions,
    ...summary
  } = result ?? {};
  return {
    ...summary,
    actions: {
      A: nonZeroCounts(actions?.A),
      B: nonZeroCounts(actions?.B),
    },
  };
}

function nonZeroCounts(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, count]) => Number(count) !== 0),
  );
}

function challengerOutcome(winner) {
  return winner === "A" ? "win" : winner === "B" ? "loss" : "draw";
}

function challengeWinnerRole(winner) {
  return winner === "A" ? "challenger" : winner === "B" ? "opponent" : "draw";
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
