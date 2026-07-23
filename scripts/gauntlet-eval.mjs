#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createActionV1 } from "../src/agent-sdk.js";
import { runHeadlessTournament } from "../src/headless.js";

export const OPPONENT_IDS = Object.freeze(["balanced", "pressure", "zoner"]);
export const TEMPLATE_LEGS = Object.freeze([
  Object.freeze({ candidateTemplate: "vanguard", opponentTemplate: "ember" }),
  Object.freeze({ candidateTemplate: "ember", opponentTemplate: "vanguard" }),
]);
export const GAUNTLET_RULES = Object.freeze({
  difficulty: "hard",
  delay: 12,
  bestOf: 3,
  roundSeconds: 60,
  swapSides: true,
});
export const SEED_SPLITS = Object.freeze({
  training: Object.freeze({ minimum: 10_000, maximum: 29_999, defaultSeed: 10_000 }),
  holdout: Object.freeze({ minimum: 70_000, maximum: 0xffff_ffff, defaultSeed: 70_000 }),
});

const DEFAULT_SAMPLES = 20;
const FORMATS = Object.freeze(["text", "json"]);
const CANDIDATE_EXPORTS = Object.freeze(["default", "createAgent", "candidateFactory", "makeAgent"]);

export class GauntletArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "GauntletArgumentError";
  }
}

export const GAUNTLET_HELP = `AgentFighter black-box gauntlet

Usage:
  node scripts/gauntlet-eval.mjs --candidate <module> [options]

Options:
  --candidate <path>       Local ESM module exporting default/createAgent/candidateFactory/makeAgent
  --samples <even n>       Total matches per opponent; half use each template leg (default: ${DEFAULT_SAMPLES})
  --split <name>           training (seed 10000-29999) or holdout (seed 70000+)
  --seed <uint32>          Tournament seed inside the selected split (split default if omitted)
  --format <text|json>     Output format (default: text)
  --help, -h               Show this help

The candidate factory is called with no arguments when its declared arity is 0,
or with only the public candidate template string when its declared arity is 1.
Factories declaring two or more parameters are rejected.
`;

export function parseGauntletArgs(argv = []) {
  if (!Array.isArray(argv)) {
    throw new GauntletArgumentError("argv must be an array of strings");
  }

  const parsed = {
    candidate: undefined,
    samples: DEFAULT_SAMPLES,
    split: "training",
    seed: undefined,
    format: "text",
    help: false,
  };
  const valueOptions = new Map([
    ["--candidate", "candidate"],
    ["--samples", "samples"],
    ["--split", "split"],
    ["--seed", "seed"],
    ["--format", "format"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    if (raw === "--help" || raw === "-h") {
      parsed.help = true;
      continue;
    }

    const separator = raw.indexOf("=");
    const flag = separator >= 0 ? raw.slice(0, separator) : raw;
    const property = valueOptions.get(flag);
    if (!property) throw new GauntletArgumentError(`unknown option: ${raw}`);

    let value = separator >= 0 ? raw.slice(separator + 1) : undefined;
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new GauntletArgumentError(`missing value for: ${flag}`);
      }
      index += 1;
    }
    if (String(value).length === 0) throw new GauntletArgumentError(`empty value for: ${flag}`);
    parsed[property] = String(value);
  }

  if (parsed.help) return parsed;
  if (!parsed.candidate) throw new GauntletArgumentError("--candidate is required");
  return { ...parsed, ...validateGauntletOptions(parsed) };
}

export function validateGauntletOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new GauntletArgumentError("options must be an object");
  }

  const split = String(options.split ?? "training").toLowerCase();
  const seedRange = SEED_SPLITS[split];
  if (!seedRange) {
    throw new GauntletArgumentError(`split must be one of: ${Object.keys(SEED_SPLITS).join("|")}`);
  }

  const samples = Number(options.samples ?? DEFAULT_SAMPLES);
  if (!Number.isInteger(samples) || samples < 2 || samples > 100_000) {
    throw new GauntletArgumentError("samples must be an integer from 2 to 100000");
  }
  if (samples % 2 !== 0) {
    throw new GauntletArgumentError("samples must be even so both template legs receive exactly half");
  }

  const seed = options.seed === undefined ? seedRange.defaultSeed : Number(options.seed);
  if (!Number.isInteger(seed) || seed < seedRange.minimum || seed > seedRange.maximum) {
    throw new GauntletArgumentError(
      `${split} seed must be an integer from ${seedRange.minimum} to ${seedRange.maximum}`,
    );
  }

  const format = String(options.format ?? "text").toLowerCase();
  if (!FORMATS.includes(format)) {
    throw new GauntletArgumentError(`format must be one of: ${FORMATS.join("|")}`);
  }

  return { samples, split, seed, format };
}

/**
 * Run all six black-box legs. Participant A is always the candidate; physical
 * left/right placement is alternated by the public tournament runner.
 */
export function evaluateGauntlet(candidateFactory, options = {}, dependencies = {}) {
  if (typeof candidateFactory !== "function") {
    throw new GauntletArgumentError("candidateFactory must be a function");
  }
  if (candidateFactory.length > 1) {
    throw new GauntletArgumentError("candidateFactory may declare zero parameters or one template parameter");
  }

  const settings = validateGauntletOptions(options);
  const tournamentRunner = dependencies.tournamentRunner ?? runHeadlessTournament;
  if (typeof tournamentRunner !== "function") {
    throw new GauntletArgumentError("tournamentRunner must be a function");
  }

  const perLegSamples = settings.samples / TEMPLATE_LEGS.length;
  const opponents = {};
  const overall = emptyStats();

  for (const opponent of OPPONENT_IDS) {
    const templates = {};
    const opponentTotals = emptyStats();

    for (const leg of TEMPLATE_LEGS) {
      const candidate = instantiateCandidate(candidateFactory, leg.candidateTemplate);
      const summary = tournamentRunner(
        {
          matches: perLegSamples,
          agentA: "balanced",
          agentB: opponent,
          templateA: leg.candidateTemplate,
          templateB: leg.opponentTemplate,
          difficulty: GAUNTLET_RULES.difficulty,
          delay: GAUNTLET_RULES.delay,
          bestOf: GAUNTLET_RULES.bestOf,
          roundSeconds: GAUNTLET_RULES.roundSeconds,
          swapSides: GAUNTLET_RULES.swapSides,
          seed: settings.seed,
        },
        { agents: { A: candidate } },
      );
      const stats = candidateStats(summary, perLegSamples);
      templates[leg.candidateTemplate] = {
        candidateTemplate: leg.candidateTemplate,
        opponentTemplate: leg.opponentTemplate,
        ...stats,
      };
      addStats(opponentTotals, stats);
      addStats(overall, stats);
    }

    opponents[opponent] = {
      ...finishStats(opponentTotals),
      templates,
    };
  }

  return {
    schema: "agentfighter-gauntlet-eval-v1",
    split: settings.split,
    seed: settings.seed,
    samplesPerOpponent: settings.samples,
    samplesPerTemplateLeg: perLegSamples,
    rules: { ...GAUNTLET_RULES },
    opponents,
    overall: finishStats(overall),
  };
}

export function formatGauntletText(report) {
  const lines = [
    "AgentFighter black-box gauntlet",
    `split=${report.split} seed=${report.seed} samples/opponent=${report.samplesPerOpponent}`,
    `rules=${report.rules.difficulty} ${report.rules.delay}F BO${report.rules.bestOf} ${report.rules.roundSeconds}s swapSides=${report.rules.swapSides}`,
    `overall ${formatStats(report.overall)}`,
  ];

  for (const opponent of OPPONENT_IDS) {
    const entry = report.opponents[opponent];
    lines.push(`${opponent} ${formatStats(entry)}`);
    for (const leg of TEMPLATE_LEGS) {
      const stats = entry.templates[leg.candidateTemplate];
      lines.push(
        `  candidate ${stats.candidateTemplate} vs ${stats.opponentTemplate}: ${formatStats(stats)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A public-interface-only legal agent useful for smoke-checking the harness. */
export function createNeutralAgent() {
  const neutral = createActionV1();
  return {
    name: "public-neutral",
    act() {
      return neutral;
    },
  };
}

export async function loadCandidateFactory(specifier, cwd = process.cwd()) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw new GauntletArgumentError("candidate module path must be a non-empty string");
  }
  const url = specifier.startsWith("file:")
    ? specifier
    : pathToFileURL(resolve(cwd, specifier)).href;
  const module = await import(url);
  for (const key of CANDIDATE_EXPORTS) {
    if (typeof module[key] === "function") return module[key];
  }
  throw new GauntletArgumentError(
    `candidate module must export one function as ${CANDIDATE_EXPORTS.join(", ")}`,
  );
}

function instantiateCandidate(candidateFactory, template) {
  const candidate = candidateFactory.length === 0
    ? candidateFactory()
    : candidateFactory(template);
  if (candidate && typeof candidate.then === "function") {
    throw new GauntletArgumentError("candidateFactory must return synchronously");
  }
  if (!candidate || typeof candidate !== "object" || typeof candidate.act !== "function") {
    throw new GauntletArgumentError("candidateFactory must return an Agent V1 object with act(observation)");
  }
  return candidate;
}

function candidateStats(summary, expectedMatches) {
  if (!summary || typeof summary !== "object" || summary.matches !== expectedMatches) {
    throw new Error("tournament summary did not contain the expected match count");
  }
  const wins = outcomeCount(summary.wins?.A, "candidate wins");
  const losses = outcomeCount(summary.wins?.B, "candidate losses");
  const draws = outcomeCount(summary.wins?.draw, "draws");
  if (wins + losses + draws !== expectedMatches) {
    throw new Error("tournament outcomes did not add up to the expected match count");
  }
  return finishStats({ wins, losses, draws, matches: expectedMatches });
}

function outcomeCount(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function emptyStats() {
  return { wins: 0, losses: 0, draws: 0, matches: 0 };
}

function addStats(target, source) {
  target.wins += source.wins;
  target.losses += source.losses;
  target.draws += source.draws;
  target.matches += source.matches;
  return target;
}

function finishStats(stats) {
  return {
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    matches: stats.matches,
    strictWinRate: stats.matches > 0 ? rounded(stats.wins / stats.matches, 6) : 0,
  };
}

function formatStats(stats) {
  return `${stats.wins}W ${stats.losses}L ${stats.draws}D strict=${rounded(stats.strictWinRate * 100, 2)}%`;
}

function rounded(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function main() {
  const parsed = parseGauntletArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(GAUNTLET_HELP);
    return;
  }
  const candidateFactory = await loadCandidateFactory(parsed.candidate);
  const report = evaluateGauntlet(candidateFactory, parsed);
  process.stdout.write(parsed.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatGauntletText(report));
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`gauntlet-eval: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
