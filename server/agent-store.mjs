import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

export const AGENT_STORE_SCHEMA = "agentfighter.agent-store";
export const AGENT_STORE_VERSION = 1;

const STATE_FILE_NAME = "state.json";
const MATCH_DIRECTORY_NAME = "matches";
const MATCH_ENVELOPE_SCHEMA = "agentfighter.match-envelope";
const MATCH_ENVELOPE_VERSION = 1;
const TOKEN_PREFIX = "afk_";
const TOKEN_PATTERN = /^afk_[A-Za-z0-9_-]{32,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEMPLATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PRIVATE_PAYLOAD_KEYS = new Set([
  "agentcode",
  "apikey",
  "authorization",
  "bearertoken",
  "code",
  "script",
  "sourcecode",
  "token",
  "tokenhash",
]);
const MAX_NAME_LENGTH = 80;
const MAX_LABEL_LENGTH = 120;
const MAX_CODE_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;

export class AgentStoreError extends Error {
  constructor(message, { code = "AGENT_STORE_ERROR", statusCode = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AgentStoreValidationError extends AgentStoreError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? "INVALID_AGENT_STORE_INPUT",
      statusCode: options.statusCode ?? 400,
    });
  }
}

export class AgentStoreAuthError extends AgentStoreError {
  constructor(message = "Invalid AgentFighter bearer token.") {
    super(message, { code: "INVALID_BEARER_TOKEN", statusCode: 401 });
  }
}

export class AgentStoreNotFoundError extends AgentStoreError {
  constructor(message) {
    super(message, { code: "AGENT_STORE_NOT_FOUND", statusCode: 404 });
  }
}

export class AgentStoreConflictError extends AgentStoreError {
  constructor(message) {
    super(message, { code: "AGENT_STORE_CONFLICT", statusCode: 409 });
  }
}

/**
 * Create a single-process persistent AgentFighter participant store.
 *
 * The returned API never exposes a persisted token hash. Owner-only reads,
 * authenticated by the one-time bearer token returned from createFighter(),
 * include that fighter's source versions. Public fighter/opponent listings
 * contain version metadata only.
 */
export async function createAgentStore(options = {}) {
  assertPlainRecord(options, "createAgentStore options", new Set(["dataDir"]));
  if (typeof options.dataDir !== "string" || options.dataDir.trim() === "") {
    throw new AgentStoreValidationError("createAgentStore({ dataDir }) requires a non-empty dataDir.");
  }

  const dataDir = resolve(options.dataDir);
  const stateFile = join(dataDir, STATE_FILE_NAME);
  const matchesDir = join(dataDir, MATCH_DIRECTORY_NAME);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(matchesDir, { recursive: true, mode: 0o700 });

  let state = await readPersistedState(stateFile);
  if (state === null) {
    state = emptyState();
    await atomicWriteJson(stateFile, state);
  }
  state = await reconcileMatchEnvelopes({
    state,
    stateFile,
    matchesDir,
  });

  let mutationTail = Promise.resolve();

  function serializeMutation(task) {
    const operation = mutationTail.then(task, task);
    mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function afterMutations(task) {
    await mutationTail;
    return task();
  }

  async function createFighter(input) {
    return serializeMutation(async () => {
      assertPlainRecord(input, "fighter", new Set(["name", "templateId"]));
      const name = requiredText(input.name, "fighter.name", MAX_NAME_LENGTH);
      const templateId = requiredIdentifier(
        input.templateId,
        "fighter.templateId",
        TEMPLATE_PATTERN,
      );
      const createdAt = nowIso();
      const id = uniqueId("af_", state.fighters);

      let token;
      let tokenHash;
      do {
        token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        tokenHash = sha256(token);
      } while (Object.values(state.fighters).some((fighter) => fighter.tokenHash === tokenHash));

      const nextState = cloneJson(state, "agent store state");
      nextState.fighters[id] = {
        id,
        name,
        templateId,
        createdAt,
        updatedAt: createdAt,
        versions: [],
        activeVersionId: null,
        stats: emptyStats(),
        tokenHash,
      };
      await atomicWriteJson(stateFile, nextState);
      state = nextState;

      return cloneJson({
        fighter: ownerFighterView(nextState.fighters[id]),
        token,
      }, "created fighter");
    });
  }

  async function getFighterByBearerToken(authorization) {
    return afterMutations(() => {
      const fighter = findPrivateFighterByBearer(state, authorization);
      return fighter ? ownerFighterView(fighter) : null;
    });
  }

  async function getFighterById(fighterId) {
    return afterMutations(() => {
      const id = requiredIdentifier(fighterId, "fighterId", IDENTIFIER_PATTERN);
      const fighter = state.fighters[id];
      return fighter ? publicFighterView(fighter) : null;
    });
  }

  /**
   * Server-internal challenge runner view. This is deliberately separate from
   * getFighterById()/listFighters(), whose public views never contain source.
   */
  async function getFighterRuntimeById(fighterId) {
    return afterMutations(() => {
      const id = requiredIdentifier(fighterId, "fighterId", IDENTIFIER_PATTERN);
      const fighter = state.fighters[id];
      if (!fighter) return null;
      const activeVersion = fighter.activeVersionId === null
        ? null
        : fighter.versions.find((version) => version.id === fighter.activeVersionId) ?? null;
      return cloneJson({
        id: fighter.id,
        name: fighter.name,
        templateId: fighter.templateId,
        activeVersion: activeVersion ? {
          id: activeVersion.id,
          code: activeVersion.code,
          codeHash: activeVersion.codeHash,
        } : null,
      }, "fighter runtime");
    });
  }

  async function publishVersion(authorization, input) {
    return serializeMutation(async () => {
      const fighter = requirePrivateFighterByBearer(state, authorization);
      assertPlainRecord(input, "version", new Set(["code", "label", "metadata"]));
      const code = requiredTextBytes(input.code, "version.code", MAX_CODE_BYTES);
      const label = optionalText(input.label, "version.label", MAX_LABEL_LENGTH);
      const metadata = input.metadata === undefined
        ? {}
        : cloneJsonWithLimit(input.metadata, "version.metadata", MAX_METADATA_BYTES);
      const createdAt = nowIso();
      const version = {
        id: uniqueVersionId(fighter.versions),
        createdAt,
        code,
        codeHash: sha256(code),
        label,
        metadata,
      };

      const nextState = cloneJson(state, "agent store state");
      const nextFighter = nextState.fighters[fighter.id];
      nextFighter.versions.push(version);
      nextFighter.activeVersionId = version.id;
      nextFighter.updatedAt = createdAt;
      await atomicWriteJson(stateFile, nextState);
      state = nextState;

      return cloneJson({
        fighter: ownerFighterView(nextFighter),
        version,
      }, "published version");
    });
  }

  async function activateVersion(authorization, versionId) {
    return serializeMutation(async () => {
      const fighter = requirePrivateFighterByBearer(state, authorization);
      const id = requiredIdentifier(versionId, "versionId", IDENTIFIER_PATTERN);
      if (!fighter.versions.some((version) => version.id === id)) {
        throw new AgentStoreNotFoundError(`Version ${id} does not belong to fighter ${fighter.id}.`);
      }
      if (fighter.activeVersionId === id) return ownerFighterView(fighter);

      const nextState = cloneJson(state, "agent store state");
      const nextFighter = nextState.fighters[fighter.id];
      nextFighter.activeVersionId = id;
      nextFighter.updatedAt = nowIso();
      await atomicWriteJson(stateFile, nextState);
      state = nextState;
      return ownerFighterView(nextFighter);
    });
  }

  async function listFighters(optionsValue = {}) {
    return afterMutations(() => listPublicFighters(state, optionsValue));
  }

  async function listOpponents(identity, optionsValue = {}) {
    return afterMutations(() => {
      let fighterId;
      if (typeof identity === "string" && (
        identity.trim().startsWith(TOKEN_PREFIX)
        || /^Bearer\s+/i.test(identity.trim())
      )) {
        const fighter = requirePrivateFighterByBearer(state, identity);
        fighterId = fighter.id;
      } else {
        fighterId = requiredIdentifier(identity, "fighterId", IDENTIFIER_PATTERN);
        if (!state.fighters[fighterId]) {
          throw new AgentStoreNotFoundError(`Fighter ${fighterId} was not found.`);
        }
      }
      const optionsRecord = optionsValue === undefined ? {} : optionsValue;
      assertPlainRecord(optionsRecord, "listOpponents options", new Set(["activeOnly"]));
      return listPublicFighters(state, {
        ...optionsRecord,
        excludeFighterId: fighterId,
      });
    });
  }

  async function recordMatch(input) {
    return serializeMutation(async () => {
      const normalized = normalizeMatchInput(input, state);
      if (state.matches[normalized.summary.id]) {
        throw new AgentStoreConflictError(`Match ${normalized.summary.id} already exists.`);
      }

      const nextState = cloneJson(state, "agent store state");
      const { summary } = normalized;
      nextState.matches[summary.id] = summary;
      if (summary.rankEligible !== false) {
        updateMatchStats(
          nextState.fighters[summary.leftFighterId],
          nextState.fighters[summary.rightFighterId],
          summary.winnerFighterId,
          summary.createdAt,
        );
      }

      const matchFile = matchPath(matchesDir, summary.id);
      let matchFileCreated = false;
      try {
        await atomicWriteJson(
          matchFile,
          createMatchEnvelope(summary, normalized.replay),
          { createOnly: true },
        );
        matchFileCreated = true;
        await atomicWriteJson(stateFile, nextState);
      } catch (error) {
        if (matchFileCreated) await unlink(matchFile).catch(() => {});
        if (error?.code === "EEXIST") {
          throw new AgentStoreConflictError(`Match file for match ${summary.id} already exists.`);
        }
        throw error;
      }
      state = nextState;
      return cloneJson(summary, "match summary");
    });
  }

  async function listMatchesForFighter(fighterId, optionsValue = {}) {
    return afterMutations(() => {
      const id = requiredIdentifier(fighterId, "fighterId", IDENTIFIER_PATTERN);
      if (!state.fighters[id]) {
        throw new AgentStoreNotFoundError(`Fighter ${id} was not found.`);
      }
      assertPlainRecord(
        optionsValue,
        "listMatchesForFighter options",
        new Set(["limit", "offset"]),
      );
      const offset = boundedInteger(optionsValue.offset, "offset", 0, 1_000_000, 0);
      const limit = boundedInteger(optionsValue.limit, "limit", 1, 10_000, 1_000);
      return cloneJson(
        Object.values(state.matches)
          .filter((summary) => (
            summary.leftFighterId === id || summary.rightFighterId === id
          ))
          .sort(newestFirst)
          .slice(offset, offset + limit),
        "fighter matches",
      );
    });
  }

  async function getMatchSummary(matchId) {
    return afterMutations(() => {
      const id = requiredIdentifier(matchId, "matchId", IDENTIFIER_PATTERN);
      const summary = state.matches[id];
      return summary ? cloneJson(summary, "match summary") : null;
    });
  }

  async function getMatch(matchId) {
    await mutationTail;
    const id = requiredIdentifier(matchId, "matchId", IDENTIFIER_PATTERN);
    const summary = state.matches[id];
    if (!summary) return null;

    const stored = await readStoredMatchFile(matchPath(matchesDir, id), id, state.fighters);
    if (stored.kind === "envelope" && !sameJsonValue(stored.summary, summary)) {
      throw corrupt(`Match file summary for ${id} disagrees with the persisted store state.`);
    }
    return cloneJson({ summary, replay: stored.replay }, "stored match");
  }

  const api = {
    paths: Object.freeze({ dataDir, stateFile, matchesDir }),
    createFighter,
    getFighterByBearerToken,
    getFighterByToken: getFighterByBearerToken,
    authenticateBearer: getFighterByBearerToken,
    getFighterById,
    getFighterRuntimeById,
    publishVersion,
    activateVersion,
    listFighters,
    listOpponents,
    recordMatch,
    listMatchesForFighter,
    listMatchesByFighter: listMatchesForFighter,
    getMatchSummary,
    getMatch,
    getMatchById: getMatch,
  };
  return Object.freeze(api);
}

export default createAgentStore;

function emptyState() {
  return {
    schema: AGENT_STORE_SCHEMA,
    version: AGENT_STORE_VERSION,
    fighters: {},
    matches: {},
  };
}

async function readPersistedState(stateFile) {
  let raw;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new AgentStoreError(`Unable to read ${stateFile}.`, {
      code: "AGENT_STORE_IO_ERROR",
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentStoreError(`Agent store state at ${stateFile} is not valid JSON.`, {
      code: "AGENT_STORE_CORRUPT",
      cause: error,
    });
  }
  try {
    return validatePersistedState(parsed);
  } catch (error) {
    if (error instanceof AgentStoreError) throw error;
    throw new AgentStoreError(`Agent store state at ${stateFile} is invalid.`, {
      code: "AGENT_STORE_CORRUPT",
      cause: error,
    });
  }
}

function validatePersistedState(value) {
  const state = cloneJson(value, "persisted agent store");
  assertPlainRecord(
    state,
    "persisted agent store",
    new Set(["schema", "version", "fighters", "matches"]),
  );
  if (state.schema !== AGENT_STORE_SCHEMA || state.version !== AGENT_STORE_VERSION) {
    throw new AgentStoreError("Unsupported persisted AgentFighter store schema/version.", {
      code: "AGENT_STORE_CORRUPT",
    });
  }
  assertPlainRecord(state.fighters, "persisted fighters");
  assertPlainRecord(state.matches, "persisted matches");

  const tokenHashes = new Set();
  for (const [id, fighter] of Object.entries(state.fighters)) {
    requiredIdentifier(id, "persisted fighter key", IDENTIFIER_PATTERN);
    assertPlainRecord(
      fighter,
      `persisted fighter ${id}`,
      new Set([
        "id",
        "name",
        "templateId",
        "createdAt",
        "updatedAt",
        "versions",
        "activeVersionId",
        "stats",
        "tokenHash",
      ]),
    );
    if (fighter.id !== id) throw corrupt(`Persisted fighter key/id mismatch for ${id}.`);
    requiredText(fighter.name, `fighter ${id}.name`, MAX_NAME_LENGTH);
    requiredIdentifier(fighter.templateId, `fighter ${id}.templateId`, TEMPLATE_PATTERN);
    validTimestamp(fighter.createdAt, `fighter ${id}.createdAt`);
    validTimestamp(fighter.updatedAt, `fighter ${id}.updatedAt`);
    if (!HASH_PATTERN.test(fighter.tokenHash)) throw corrupt(`Invalid token hash for fighter ${id}.`);
    if (tokenHashes.has(fighter.tokenHash)) throw corrupt("Duplicate persisted fighter token hash.");
    tokenHashes.add(fighter.tokenHash);
    if (!Array.isArray(fighter.versions)) throw corrupt(`fighter ${id}.versions must be an array.`);
    const versionIds = new Set();
    for (const version of fighter.versions) {
      assertPlainRecord(
        version,
        `fighter ${id} version`,
        new Set(["id", "createdAt", "code", "codeHash", "label", "metadata"]),
      );
      requiredIdentifier(version.id, `fighter ${id} version.id`, IDENTIFIER_PATTERN);
      if (versionIds.has(version.id)) throw corrupt(`Duplicate version ${version.id} for fighter ${id}.`);
      versionIds.add(version.id);
      validTimestamp(version.createdAt, `version ${version.id}.createdAt`);
      requiredTextBytes(version.code, `version ${version.id}.code`, MAX_CODE_BYTES);
      if (!HASH_PATTERN.test(version.codeHash) || version.codeHash !== sha256(version.code)) {
        throw corrupt(`Invalid code hash for version ${version.id}.`);
      }
      optionalText(version.label, `version ${version.id}.label`, MAX_LABEL_LENGTH);
      cloneJsonWithLimit(version.metadata, `version ${version.id}.metadata`, MAX_METADATA_BYTES);
    }
    if (fighter.activeVersionId !== null && !versionIds.has(fighter.activeVersionId)) {
      throw corrupt(`fighter ${id}.activeVersionId does not exist.`);
    }
    validateStats(fighter.stats, id);
  }

  for (const [id, summary] of Object.entries(state.matches)) {
    requiredIdentifier(id, "persisted match key", IDENTIFIER_PATTERN);
    validateStoredMatchSummary(summary, id, state.fighters);
  }
  return state;
}

function validateStats(stats, fighterId) {
  assertPlainRecord(
    stats,
    `fighter ${fighterId}.stats`,
    new Set(["matches", "wins", "losses", "draws"]),
  );
  for (const key of ["matches", "wins", "losses", "draws"]) {
    if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) {
      throw corrupt(`fighter ${fighterId}.stats.${key} must be a non-negative integer.`);
    }
  }
  if (stats.matches !== stats.wins + stats.losses + stats.draws) {
    throw corrupt(`fighter ${fighterId}.stats totals are inconsistent.`);
  }
}

function validateStoredMatchSummary(summary, id, fighters) {
  assertPlainRecord(
    summary,
    `persisted match ${id}`,
    new Set([
      "id",
      "createdAt",
      "leftFighterId",
      "leftVersionId",
      "rightFighterId",
      "rightVersionId",
      "winnerFighterId",
      "outcome",
      "rankEligible",
      "details",
    ]),
  );
  if (summary.id !== id) throw corrupt(`Persisted match key/id mismatch for ${id}.`);
  validTimestamp(summary.createdAt, `match ${id}.createdAt`);
  for (const side of ["left", "right"]) {
    const fighterId = summary[`${side}FighterId`];
    const versionId = summary[`${side}VersionId`];
    if (!fighters[fighterId]) throw corrupt(`match ${id} references unknown ${side} fighter.`);
    if (versionId !== null && !fighters[fighterId].versions.some((version) => version.id === versionId)) {
      throw corrupt(`match ${id} references unknown ${side} version.`);
    }
  }
  if (summary.leftFighterId === summary.rightFighterId) {
    throw corrupt(`match ${id} cannot use the same fighter on both sides.`);
  }
  const allowedWinners = [null, summary.leftFighterId, summary.rightFighterId];
  if (!allowedWinners.includes(summary.winnerFighterId)) {
    throw corrupt(`match ${id} has an invalid winner.`);
  }
  const expectedOutcome = summary.winnerFighterId === null
    ? "draw"
    : summary.winnerFighterId === summary.leftFighterId ? "left" : "right";
  if (summary.outcome !== expectedOutcome) throw corrupt(`match ${id} has an inconsistent outcome.`);
  if (summary.rankEligible !== undefined && typeof summary.rankEligible !== "boolean") {
    throw corrupt(`match ${id}.rankEligible must be boolean.`);
  }
  cloneJsonWithLimit(summary.details, `match ${id}.details`, MAX_METADATA_BYTES);
  assertNoPrivatePayload(summary.details, `match ${id}.details`);
}

function normalizeMatchInput(input, state) {
  assertPlainRecord(
    input,
    "match",
    new Set([
      "id",
      "matchId",
      "leftFighterId",
      "rightFighterId",
      "fighterAId",
      "fighterBId",
      "leftVersionId",
      "rightVersionId",
      "versionAId",
      "versionBId",
      "winner",
      "winnerId",
      "winnerFighterId",
      "outcome",
      "draw",
      "rankEligible",
      "summary",
      "details",
      "replay",
    ]),
  );
  if (input.id !== undefined && input.matchId !== undefined && input.id !== input.matchId) {
    throw new AgentStoreValidationError("match.id and match.matchId disagree.");
  }
  const id = input.id === undefined && input.matchId === undefined
    ? uniqueId("afm_", state.matches)
    : requiredIdentifier(input.id ?? input.matchId, "match.id", IDENTIFIER_PATTERN);
  const leftFighterId = requiredIdentifier(
    input.leftFighterId ?? input.fighterAId,
    "match.leftFighterId",
    IDENTIFIER_PATTERN,
  );
  const rightFighterId = requiredIdentifier(
    input.rightFighterId ?? input.fighterBId,
    "match.rightFighterId",
    IDENTIFIER_PATTERN,
  );
  if (leftFighterId === rightFighterId) {
    throw new AgentStoreValidationError("A match requires two different fighters.");
  }
  const leftFighter = state.fighters[leftFighterId];
  const rightFighter = state.fighters[rightFighterId];
  if (!leftFighter) throw new AgentStoreNotFoundError(`Fighter ${leftFighterId} was not found.`);
  if (!rightFighter) throw new AgentStoreNotFoundError(`Fighter ${rightFighterId} was not found.`);

  const leftVersionId = matchVersionId(
    input.leftVersionId ?? input.versionAId,
    leftFighter,
    "leftVersionId",
  );
  const rightVersionId = matchVersionId(
    input.rightVersionId ?? input.versionBId,
    rightFighter,
    "rightVersionId",
  );
  const winnerFighterId = matchWinner(input, leftFighterId, rightFighterId);
  if (input.rankEligible !== undefined && typeof input.rankEligible !== "boolean") {
    throw new AgentStoreValidationError("match.rankEligible must be boolean.");
  }
  const rankEligible = input.rankEligible !== false;
  if (input.summary !== undefined && input.details !== undefined) {
    throw new AgentStoreValidationError("Provide match.summary or match.details, not both.");
  }
  const details = cloneJsonWithLimit(
    input.summary ?? input.details ?? {},
    "match.summary",
    MAX_METADATA_BYTES,
  );
  assertNoPrivatePayload(details, "match.summary");
  if (input.replay === undefined) {
    throw new AgentStoreValidationError("match.replay is required.");
  }
  const replay = cloneJsonWithLimit(input.replay, "match.replay", MAX_REPLAY_BYTES);
  if (!isPlainRecord(replay)) {
    throw new AgentStoreValidationError("match.replay must be a JSON object.");
  }
  assertNoPrivatePayload(replay, "match.replay");
  const createdAt = nowIso();
  return {
    summary: {
      id,
      createdAt,
      leftFighterId,
      leftVersionId,
      rightFighterId,
      rightVersionId,
      winnerFighterId,
      outcome: winnerFighterId === null
        ? "draw"
        : winnerFighterId === leftFighterId ? "left" : "right",
      rankEligible,
      details,
    },
    replay,
  };
}

function matchVersionId(candidate, fighter, label) {
  const id = candidate === undefined || candidate === null
    ? fighter.activeVersionId
    : requiredIdentifier(candidate, `match.${label}`, IDENTIFIER_PATTERN);
  if (id !== null && !fighter.versions.some((version) => version.id === id)) {
    throw new AgentStoreValidationError(
      `match.${label} ${id} does not belong to fighter ${fighter.id}.`,
    );
  }
  return id;
}

function matchWinner(input, leftFighterId, rightFighterId) {
  const explicitWinnerKeys = ["winnerFighterId", "winnerId", "winner"];
  const winnerKey = explicitWinnerKeys.find((key) => Object.hasOwn(input, key));
  const raw = winnerKey ? input[winnerKey] : input.outcome;
  if (
    input.draw === true
    || raw === null
    || String(raw ?? "").toLowerCase() === "draw"
  ) return null;

  const text = String(raw ?? "");
  const normalized = text.toLowerCase();
  if (text === leftFighterId || normalized === "left" || normalized === "a") {
    return leftFighterId;
  }
  if (text === rightFighterId || normalized === "right" || normalized === "b") {
    return rightFighterId;
  }
  throw new AgentStoreValidationError(
    "match winner must be a participating fighter id, left/right, A/B, or draw.",
  );
}

function updateMatchStats(left, right, winnerFighterId, timestamp) {
  left.stats.matches += 1;
  right.stats.matches += 1;
  if (winnerFighterId === null) {
    left.stats.draws += 1;
    right.stats.draws += 1;
  } else if (winnerFighterId === left.id) {
    left.stats.wins += 1;
    right.stats.losses += 1;
  } else {
    right.stats.wins += 1;
    left.stats.losses += 1;
  }
  left.updatedAt = timestamp;
  right.updatedAt = timestamp;
}

function listPublicFighters(state, optionsValue = {}) {
  assertPlainRecord(
    optionsValue,
    "listFighters options",
    new Set(["excludeFighterId", "activeOnly"]),
  );
  const excludeFighterId = optionsValue.excludeFighterId === undefined
    ? null
    : requiredIdentifier(
      optionsValue.excludeFighterId,
      "excludeFighterId",
      IDENTIFIER_PATTERN,
    );
  if (optionsValue.activeOnly !== undefined && typeof optionsValue.activeOnly !== "boolean") {
    throw new AgentStoreValidationError("activeOnly must be boolean.");
  }
  return Object.values(state.fighters)
    .filter((fighter) => fighter.id !== excludeFighterId)
    .filter((fighter) => !optionsValue.activeOnly || fighter.activeVersionId !== null)
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    ))
    .map(publicFighterView);
}

function publicFighterView(fighter) {
  return cloneJson({
    id: fighter.id,
    name: fighter.name,
    templateId: fighter.templateId,
    createdAt: fighter.createdAt,
    updatedAt: fighter.updatedAt,
    versions: fighter.versions.map((version) => ({
      id: version.id,
      createdAt: version.createdAt,
      label: version.label,
      codeHash: version.codeHash,
    })),
    activeVersionId: fighter.activeVersionId,
    stats: fighter.stats,
  }, "public fighter");
}

function ownerFighterView(fighter) {
  return cloneJson({
    id: fighter.id,
    name: fighter.name,
    templateId: fighter.templateId,
    createdAt: fighter.createdAt,
    updatedAt: fighter.updatedAt,
    versions: fighter.versions,
    activeVersionId: fighter.activeVersionId,
    stats: fighter.stats,
  }, "owner fighter");
}

function findPrivateFighterByBearer(state, authorization) {
  const token = bearerToken(authorization);
  if (!token) return null;
  const candidate = Buffer.from(sha256(token), "hex");
  let match = null;
  for (const fighter of Object.values(state.fighters)) {
    const persisted = Buffer.from(fighter.tokenHash, "hex");
    if (persisted.length === candidate.length && timingSafeEqual(persisted, candidate)) {
      match = fighter;
    }
  }
  return match;
}

function requirePrivateFighterByBearer(state, authorization) {
  const fighter = findPrivateFighterByBearer(state, authorization);
  if (!fighter) throw new AgentStoreAuthError();
  return fighter;
}

function bearerToken(authorization) {
  if (typeof authorization !== "string" || authorization.length > 512) return null;
  const trimmed = authorization.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  const token = (bearer?.[1] ?? trimmed).trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

function matchPath(matchesDir, matchId) {
  const id = requiredIdentifier(matchId, "matchId", IDENTIFIER_PATTERN);
  return join(matchesDir, `${id}.json`);
}

function createMatchEnvelope(summary, replay) {
  return {
    schema: MATCH_ENVELOPE_SCHEMA,
    version: MATCH_ENVELOPE_VERSION,
    summary,
    replay,
  };
}

async function reconcileMatchEnvelopes({ state, stateFile, matchesDir }) {
  const entries = await readdir(matchesDir, { withFileTypes: true });
  const orphanEnvelopes = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const matchId = entry.name.slice(0, -".json".length);
    if (!IDENTIFIER_PATTERN.test(matchId) || BLOCKED_OBJECT_KEYS.has(matchId)) continue;

    const stored = await readStoredMatchFile(join(matchesDir, entry.name), matchId, state.fighters);
    if (stored.kind !== "envelope") continue;

    const persistedSummary = state.matches[matchId];
    if (persistedSummary) {
      if (!sameJsonValue(stored.summary, persistedSummary)) {
        throw corrupt(`Match file summary for ${matchId} disagrees with the persisted store state.`);
      }
      continue;
    }
    orphanEnvelopes.push(stored);
  }

  if (orphanEnvelopes.length === 0) return state;
  orphanEnvelopes.sort((left, right) => (
    left.summary.createdAt.localeCompare(right.summary.createdAt)
    || left.summary.id.localeCompare(right.summary.id)
  ));

  const nextState = cloneJson(state, "agent store recovery state");
  for (const { summary } of orphanEnvelopes) {
    nextState.matches[summary.id] = summary;
    if (summary.rankEligible !== false) {
      updateMatchStats(
        nextState.fighters[summary.leftFighterId],
        nextState.fighters[summary.rightFighterId],
        summary.winnerFighterId,
        summary.createdAt,
      );
    }
  }
  await atomicWriteJson(stateFile, nextState);
  return nextState;
}

async function readStoredMatchFile(filePath, matchId, fighters) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AgentStoreError(`Match file for match ${matchId} is missing.`, {
        code: "AGENT_STORE_CORRUPT",
        cause: error,
      });
    }
    throw new AgentStoreError(`Match file for match ${matchId} is invalid.`, {
      code: "AGENT_STORE_CORRUPT",
      cause: error,
    });
  }

  if (isPlainRecord(parsed) && parsed.schema === MATCH_ENVELOPE_SCHEMA) {
    return validateMatchEnvelope(parsed, matchId, fighters);
  }
  return {
    kind: "legacy-replay",
    replay: validateStoredReplay(parsed, `stored replay for match ${matchId}`),
  };
}

function validateMatchEnvelope(value, matchId, fighters) {
  try {
    assertPlainRecord(
      value,
      `match envelope ${matchId}`,
      new Set(["schema", "version", "summary", "replay"]),
    );
    if (
      value.schema !== MATCH_ENVELOPE_SCHEMA
      || value.version !== MATCH_ENVELOPE_VERSION
    ) {
      throw corrupt(`Unsupported match envelope schema/version for ${matchId}.`);
    }
    const summary = cloneJson(value.summary, `match envelope ${matchId}.summary`);
    validateStoredMatchSummary(summary, matchId, fighters);
    return {
      kind: "envelope",
      summary,
      replay: validateStoredReplay(
        value.replay,
        `match envelope ${matchId}.replay`,
      ),
    };
  } catch (error) {
    if (error instanceof AgentStoreError && error.code === "AGENT_STORE_CORRUPT") {
      throw error;
    }
    throw new AgentStoreError(`Match envelope for ${matchId} is invalid.`, {
      code: "AGENT_STORE_CORRUPT",
      cause: error,
    });
  }
}

function validateStoredReplay(value, label) {
  const replay = cloneJsonWithLimit(value, label, MAX_REPLAY_BYTES);
  if (!isPlainRecord(replay)) {
    throw corrupt(`${label} must be a JSON object.`);
  }
  assertNoPrivatePayload(replay, label);
  return replay;
}

function sameJsonValue(left, right) {
  return isDeepStrictEqual(left, right);
}

async function atomicWriteJson(filePath, value, { createOnly = false } = {}) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = join(
    dirname(filePath),
    `.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (createOnly) {
      await link(temporary, filePath);
      await unlink(temporary);
    } else {
      await rename(temporary, filePath);
    }
    await syncDirectory(dirname(filePath));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some filesystems do not allow fsync on directories. The file itself has
    // already been flushed and atomically installed, so this is best effort.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertPlainRecord(value, label, allowedKeys = null) {
  if (!isPlainRecord(value)) {
    throw new AgentStoreValidationError(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new AgentStoreValidationError(`${label} cannot contain Symbol keys.`);
    }
    if (BLOCKED_OBJECT_KEYS.has(key)) {
      throw new AgentStoreValidationError(`${label}.${key} is not allowed.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new AgentStoreValidationError(`${label}.${key} must be an enumerable data property.`);
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new AgentStoreValidationError(`${label}.${key} is not supported.`);
    }
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonWithLimit(value, label, maximumBytes) {
  const cloned = cloneJson(value, label);
  const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
  if (bytes > maximumBytes) {
    throw new AgentStoreValidationError(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return cloned;
}

function cloneJson(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentStoreValidationError(`${label} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new AgentStoreValidationError(`${label} is not JSON-safe.`);
  }
  if (seen.has(value)) throw new AgentStoreValidationError(`${label} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
          throw new AgentStoreValidationError(`${label} contains an invalid array property.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new AgentStoreValidationError(`${label}[${key}] must be a data property.`);
        }
      }
      return value.map((entry, index) => cloneJson(entry, `${label}[${index}]`, seen));
    }

    assertPlainRecord(value, label);
    const output = {};
    for (const key of Object.keys(value)) {
      output[key] = cloneJson(value[key], `${label}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function assertNoPrivatePayload(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (PRIVATE_PAYLOAD_KEYS.has(normalized)) {
      throw new AgentStoreValidationError(`${label}.${key} may expose credentials or Agent code.`);
    }
    assertNoPrivatePayload(child, `${label}.${key}`, seen);
  }
}

function requiredText(value, label, maximumLength) {
  if (typeof value !== "string") throw new AgentStoreValidationError(`${label} must be a string.`);
  const text = value.trim();
  if (!text) throw new AgentStoreValidationError(`${label} cannot be empty.`);
  if (text.length > maximumLength) {
    throw new AgentStoreValidationError(`${label} exceeds ${maximumLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new AgentStoreValidationError(`${label} contains control characters.`);
  }
  return text;
}

function requiredTextBytes(value, label, maximumBytes) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentStoreValidationError(`${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new AgentStoreValidationError(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return value;
}

function optionalText(value, label, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, maximumLength);
}

function requiredIdentifier(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value) || BLOCKED_OBJECT_KEYS.has(value)) {
    throw new AgentStoreValidationError(`${label} is not a valid identifier.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AgentStoreValidationError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function validTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw corrupt(`${label} is not a valid timestamp.`);
  }
  return value;
}

function uniqueId(prefix, record) {
  let id;
  do id = `${prefix}${randomBytes(12).toString("hex")}`;
  while (Object.hasOwn(record, id));
  return id;
}

function uniqueVersionId(versions) {
  const ids = new Set(versions.map((version) => version.id));
  let id;
  do id = `afv_${randomBytes(12).toString("hex")}`;
  while (ids.has(id));
  return id;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function emptyStats() {
  return { matches: 0, wins: 0, losses: 0, draws: 0 };
}

function newestFirst(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function corrupt(message) {
  return new AgentStoreError(message, { code: "AGENT_STORE_CORRUPT" });
}
