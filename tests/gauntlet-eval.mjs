import assert from "node:assert/strict";

import {
  GAUNTLET_RULES,
  OPPONENT_IDS,
  TEMPLATE_LEGS,
  createNeutralAgent,
  evaluateGauntlet,
  formatGauntletText,
  parseGauntletArgs,
  validateGauntletOptions,
} from "../scripts/gauntlet-eval.mjs";
import { validateActionV1 } from "../src/agent-sdk.js";

function testOptionValidation() {
  const parsed = parseGauntletArgs([
    "--candidate", "./candidate.mjs",
    "--samples", "8",
    "--split", "holdout",
    "--seed", "70042",
    "--format", "json",
  ]);
  assert.equal(parsed.candidate, "./candidate.mjs");
  assert.equal(parsed.samples, 8);
  assert.equal(parsed.split, "holdout");
  assert.equal(parsed.seed, 70042);
  assert.equal(parsed.format, "json");

  assert.equal(validateGauntletOptions({ split: "training", samples: 2 }).seed, 10_000);
  assert.equal(validateGauntletOptions({ split: "holdout", samples: 2 }).seed, 70_000);

  for (const options of [
    { split: "training", seed: 9_999, samples: 2 },
    { split: "training", seed: 30_000, samples: 2 },
    { split: "holdout", seed: 69_999, samples: 2 },
    { split: "holdout", seed: 0x1_0000_0000, samples: 2 },
    { split: "training", seed: 10_000, samples: 3 },
  ]) {
    assert.throws(() => validateGauntletOptions(options));
  }
  assert.throws(() => parseGauntletArgs(["--samples", "2"]), /candidate/i);
}

function testAggregationAndIsolation() {
  const factoryCalls = [];
  function candidateFactory(template) {
    factoryCalls.push([...arguments]);
    return { act() {} };
  }

  const runnerCalls = [];
  const tournamentRunner = (options, runtime) => {
    runnerCalls.push({ options, runtime });
    const matches = options.matches;
    const candidateWins = options.agentB === "balanced"
      ? (options.templateA === "vanguard" ? 1 : 2)
      : options.agentB === "pressure"
        ? 0
        : matches;
    const draws = options.agentB === "pressure" ? 1 : 0;
    return {
      matches,
      wins: {
        A: candidateWins,
        B: matches - candidateWins - draws,
        draw: draws,
      },
    };
  };

  const report = evaluateGauntlet(
    candidateFactory,
    { samples: 8, split: "training", seed: 10_123 },
    { tournamentRunner },
  );

  assert.equal(runnerCalls.length, OPPONENT_IDS.length * TEMPLATE_LEGS.length);
  assert.deepEqual(factoryCalls, [
    ["vanguard"], ["ember"],
    ["vanguard"], ["ember"],
    ["vanguard"], ["ember"],
  ]);
  for (const { options, runtime } of runnerCalls) {
    assert.equal(options.matches, 4);
    assert.equal(options.difficulty, "hard");
    assert.equal(Object.hasOwn(options, "delay"), false);
    assert.equal(options.bestOf, 3);
    assert.equal(options.roundSeconds, 60);
    assert.equal(options.swapSides, true);
    assert.equal(options.seed, 10_123);
    assert(OPPONENT_IDS.includes(options.agentB));
    assert.deepEqual(Object.keys(runtime.agents), ["A"]);
  }

  assert.deepEqual(report.opponents.balanced.templates.vanguard, {
    candidateTemplate: "vanguard",
    opponentTemplate: "ember",
    wins: 1,
    losses: 3,
    draws: 0,
    matches: 4,
    strictWinRate: 0.25,
  });
  assert.equal(report.opponents.pressure.wins, 0);
  assert.equal(report.opponents.pressure.losses, 6);
  assert.equal(report.opponents.pressure.draws, 2);
  assert.equal(report.opponents.pressure.strictWinRate, 0);
  assert.equal(report.opponents.zoner.strictWinRate, 1);
  assert.equal(report.overall.matches, 24);
  assert.equal(report.overall.wins, 11);
  assert.equal(report.overall.losses, 11);
  assert.equal(report.overall.draws, 2);
  assert.equal(report.overall.strictWinRate, 0.458333);

  const rendered = formatGauntletText(report);
  for (const opponent of OPPONENT_IDS) assert(rendered.includes(opponent));
  assert(rendered.includes("candidate vanguard vs ember"));
  assert(rendered.includes("candidate ember vs vanguard"));
}

function testNoArgumentFactory() {
  const argumentCounts = [];
  function noArgumentFactory() {
    argumentCounts.push(arguments.length);
    return { act() {} };
  }
  evaluateGauntlet(
    noArgumentFactory,
    { samples: 2, split: "holdout", seed: 70_000 },
    { tournamentRunner: (options) => ({ matches: options.matches, wins: { A: 0, B: 0, draw: options.matches } }) },
  );
  assert.deepEqual(argumentCounts, [0, 0, 0, 0, 0, 0]);
  assert.throws(
    () => evaluateGauntlet(function invalidFactory(first, second) { return { act() {} }; }),
    /zero parameters or one template parameter/,
  );
}

function testPublicNeutralAgent() {
  const agent = createNeutralAgent();
  assert.equal(typeof agent.act, "function");
  assert.equal(validateActionV1(agent.act()).valid, true);

  const report = evaluateGauntlet(createNeutralAgent, {
    samples: 2,
    split: "training",
    seed: 10_000,
  });
  assert.deepEqual(report.rules, GAUNTLET_RULES);
  assert.equal(report.overall.matches, 6);
  assert.equal(report.overall.wins, 0, "a neutral candidate must not be credited with opponent victories");
  assert(report.overall.losses > 0, "black-box opponents must be credited as candidate losses");
  for (const opponent of OPPONENT_IDS) {
    const entry = report.opponents[opponent];
    assert.equal(entry.matches, 2);
    assert.equal(entry.wins + entry.losses + entry.draws, 2);
    for (const leg of TEMPLATE_LEGS) {
      const stats = entry.templates[leg.candidateTemplate];
      assert.equal(stats.matches, 1);
      assert.equal(stats.wins + stats.losses + stats.draws, 1);
      assert.equal(stats.strictWinRate, stats.wins);
    }
  }
}

testOptionValidation();
testAggregationAndIsolation();
testNoArgumentFactory();
testPublicNeutralAgent();

process.stdout.write("gauntlet-eval ok\n");
