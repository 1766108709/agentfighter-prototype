import assert from "node:assert/strict";

import { createGame, getMoveData, nextRound, stepGame } from "../src/engine.js";
import { createScriptAI } from "../src/ai.js";

const INPUT_KEYS = [
  "left",
  "right",
  "up",
  "down",
  "light",
  "heavy",
  "special",
  "guard",
];

const CANONICAL_INPUT_KEYS = [
  "lp", "mp", "hp", "lk", "mk", "hk", "throw", "system1", "system2",
];

const NORMAL_ACTIONS = new Set([
  "highLight",
  "highHeavy",
  "midLight",
  "midHeavy",
  "lowLight",
  "lowHeavy",
]);

const neutralInput = () => Object.fromEntries(INPUT_KEYS.map((key) => [key, false]));

function validateInput(input, label) {
  assert.deepEqual(
    Object.keys(input).sort(),
    [...INPUT_KEYS].sort(),
    `${label} must emit exactly the eight controller keys`,
  );
  for (const key of INPUT_KEYS) {
    assert.equal(typeof input[key], "boolean", `${label}.${key} must be boolean`);
  }
  for (const key of CANONICAL_INPUT_KEYS) {
    assert(Object.hasOwn(input, key), `${label} must retain hidden canonical key ${key}`);
    assert.equal(typeof input[key], "boolean", `${label}.${key} must be boolean`);
  }
}

function validateFighter(fighter, label) {
  assert(Number.isFinite(fighter.x), `${label}.x must stay finite`);
  assert(Number.isFinite(fighter.y), `${label}.y must stay finite`);
  assert(Number.isFinite(fighter.health), `${label}.health must stay finite`);
  assert(fighter.health >= 0, `${label}.health must not become negative`);
  assert(fighter.health <= fighter.maxHealth, `${label}.health must not exceed maxHealth`);
}

function isFireballMove(templateId, action) {
  const move = getMoveData(templateId, action);
  return Boolean(
    move?.tags?.includes("projectile")
    || /hadoken|fireball/i.test(`${move?.id ?? ""} ${action}`),
  );
}

function actionCategories(actionsByFighter, templateIds) {
  const categories = new Set();
  for (let index = 0; index < actionsByFighter.length; index += 1) {
    for (const action of actionsByFighter[index]) {
      const move = getMoveData(templateIds[index], action);
      const moveId = move?.id ?? action;
      if (NORMAL_ACTIONS.has(action) || ["normal", "commandNormal"].includes(move?.category)) categories.add("normal");
      if (isFireballMove(templateIds[index], action)) categories.add("fireball");
      if (/shoryuken|oniyaki|dragonPunch/i.test(moveId)) categories.add("dragonPunch");
      if (action === "throw" || move?.category === "throw") categories.add("throw");
    }
  }
  return categories;
}

function runMatch() {
  const game = createGame({ roundTimeSeconds: 10, bestOf: 3 });
  const pressure = createScriptAI({
    preset: "pressure",
    difficulty: "hard",
    observationDelayFrames: 6,
    seed: 11,
  });
  const zoner = createScriptAI({
    preset: "zoner",
    difficulty: "normal",
    observationDelayFrames: 12,
    seed: 22,
  });
  const agents = [pressure, zoner];
  const actionsByFighter = [new Set(), new Set()];
  const maxFrames = 8_000;
  let simulatedFrames = 0;
  let roundsAdvanced = 0;

  while (simulatedFrames < maxFrames && game.phase !== "matchOver") {
    if (game.phase === "roundOver") {
      nextRound(game);
      for (const agent of agents) agent.reset({ preserveAdaptation: true });
      roundsAdvanced += 1;
    }

    const p1 = pressure.decide(game, 0);
    const p2 = zoner.decide(game, 1);
    validateInput(p1, "pressure input");
    validateInput(p2, "zoner input");
    stepGame(game, { p1, p2 });
    simulatedFrames += 1;

    for (let index = 0; index < game.fighters.length; index += 1) {
      const fighter = game.fighters[index];
      validateFighter(fighter, `fighter ${index}`);
      actionsByFighter[index].add(fighter.action);
    }
  }

  assert.equal(game.phase, "matchOver", `match must finish within ${maxFrames} frames`);
  assert([0, 1].includes(game.matchWinner), "match must produce a fighter winner");
  assert(roundsAdvanced >= 1, "test must exercise nextRound and adaptation-preserving reset");
  for (let index = 0; index < actionsByFighter.length; index += 1) {
    assert(
      [...actionsByFighter[index]].some((action) => action !== "idle"),
      `fighter ${index} must perform a non-idle action`,
    );
  }

  const categories = actionCategories(actionsByFighter, game.fighters.map((fighter) => fighter.templateId));
  assert(
    categories.size >= 2,
    `combined actions must cover at least two combat categories; got ${[...categories].join(", ")}`,
  );

  return {
    simulatedFrames,
    winner: game.matchWinner,
    score: game.score,
    actionsByFighter,
    categories,
  };
}

function verifyIndependentAgentState() {
  const options = {
    preset: "zoner",
    difficulty: "normal",
    observationDelayFrames: 0,
    seed: 9,
  };
  const first = createScriptAI(options);
  const second = createScriptAI(options);
  const firstGame = createGame({ roundTimeSeconds: 10 });
  const secondGame = createGame({ roundTimeSeconds: 10 });
  const firstTrace = [];
  const secondTrace = [];

  // Calls are deliberately interleaved. If commandQueue, RNG, or temporal
  // state leaked between instances, the second agent would consume the next
  // QCF phase instead of matching the first one.
  for (let frame = 0; frame < 10; frame += 1) {
    const firstInput = first.decide(firstGame, 0);
    const secondInput = second.decide(secondGame, 0);
    validateInput(firstInput, "first isolated input");
    validateInput(secondInput, "second isolated input");
    firstTrace.push(firstInput);
    secondTrace.push(secondInput);
    assert.deepEqual(secondInput, firstInput, `same-seed agents diverged at interleaved frame ${frame}`);
    for (const key of CANONICAL_INPUT_KEYS) {
      assert.equal(
        secondInput[key],
        firstInput[key],
        `same-seed canonical input ${key} diverged at interleaved frame ${frame}`,
      );
    }

    stepGame(firstGame, { p1: firstInput, p2: neutralInput() });
    stepGame(secondGame, { p1: secondInput, p2: neutralInput() });
  }

  assert(firstTrace.some((input) => input.down), "independence trace must enter a QCF direction");
  assert(
    firstTrace.some((input) => input.light || input.heavy),
    "independence trace must reach the QCF attack edge",
  );
  assert.deepEqual(secondTrace, firstTrace, "same-seed command queues must remain independent");
  assert(
    isFireballMove(
      firstGame.fighters[0].templateId,
      firstGame.fighters[0].currentMove?.id ?? firstGame.fighters[0].action,
    ),
    "first isolated agent must resolve its QCF into a fireball",
  );
  if (firstGame.fighters[0].currentMove?.id === "hadokenOD") {
    assert(
      firstTrace.some((input) => input.lp && input.mp),
      "an OD fireball must come from the AI's preserved canonical LP+MP chord",
    );
  }
  assert.equal(
    secondGame.fighters[0].action,
    firstGame.fighters[0].action,
    "second isolated agent must resolve the same independent command",
  );
}

verifyIndependentAgentState();
const result = runMatch();

process.stdout.write(
  `ai-vs-ai ok · frames=${result.simulatedFrames} · winner=${result.winner}`
  + ` · score=${result.score.join("-")}`
  + ` · categories=${[...result.categories].join(",")}`
  + ` · p1=${[...result.actionsByFighter[0]].join(",")}`
  + ` · p2=${[...result.actionsByFighter[1]].join(",")}\n`,
);
