const EMPTY_INPUT = Object.freeze({});
const ACTION_INPUT_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);
// Defensive lookup copied from the roster's public frame tables.  It is keyed
// by the move currently visible in ObservationV1, never by the opposing agent.
const PUBLIC_FRAME_TABLE = new Map([
  ["standLightPunch", frameData(4, 3, "high", "normal", 76)],
  ["standMediumPunch", frameData(6, 4, "high", "normal", 105)],
  ["standHeavyPunch", frameData(10, 5, "high", "normal", 118)],
  ["standLightKick", frameData(5, 3, "high", "normal", 82)],
  ["standMediumKick", frameData(9, 3, "high", "normal", 126)],
  ["standHeavyKick", frameData(12, 4, "high", "normal", 142)],
  ["crouchLightPunch", frameData(4, 2, "high", "normal", 74)],
  ["crouchMediumPunch", frameData(6, 4, "high", "normal", 101)],
  ["crouchHeavyPunch", frameData(9, 6, "high", "normal", 105)],
  ["crouchLightKick", frameData(5, 2, "low", "normal", 72)],
  ["crouchMediumKick", frameData(8, 3, "low", "normal", 127)],
  ["crouchHeavyKick", frameData(9, 3, "low", "normal", 145)],
  ["shoulderThrow", frameData(5, 3, "throw", "throw", 52)],
  ["somersaultThrow", frameData(5, 3, "throw", "throw", 52)],
  ["hadokenLight", frameData(16, 1, "high", "special", 500)],
  ["hadokenMedium", frameData(14, 1, "high", "special", 500)],
  ["hadokenHeavy", frameData(12, 1, "high", "special", 500)],
  ["hadokenOD", frameData(12, 2, "high", "od", 500)],
  ["shoryukenLight", frameData(5, 10, "high", "special", 112)],
  ["shoryukenMedium", frameData(6, 10, "high", "special", 116)],
  ["shoryukenHeavy", frameData(7, 10, "high", "special", 120)],
  ["shoryukenOD", frameData(6, 10, "high", "od", 123)],
  ["tatsuLight", frameData(12, 3, "high", "special", 145)],
  ["tatsuMedium", frameData(14, 17, "high", "special", 164)],
  ["tatsuHeavy", frameData(16, 32, "high", "special", 182)],
  ["driveImpact", frameData(26, 2, "high", "system", 126)],
  ["closeA", frameData(4, 2, "mid", "normal", 74)],
  ["farA", frameData(6, 2, "mid", "normal", 112)],
  ["closeC", frameData(4, 3, "mid", "normal", 83)],
  ["farC", frameData(10, 3, "mid", "normal", 139)],
  ["crouchA", frameData(4, 3, "mid", "normal", 76)],
  ["crouchB", frameData(5, 3, "low", "normal", 78)],
  ["crouchC", frameData(7, 4, "mid", "normal", 108)],
  ["sweep", frameData(7, 4, "low", "normal", 143)],
  ["blowbackGround", frameData(16, 5, "mid", "commandNormal", 132)],
  ["hatsugane", frameData(1, 1, "throw", "throw", 50)],
  ["issetsuSeoiNage", frameData(1, 1, "throw", "throw", 50)],
  ["oniyakiLight", frameData(4, 9, "mid", "special", 116)],
  ["oniyakiHeavy", frameData(7, 15, "mid", "special", 124)],
  ["oniyakiEx", frameData(4, 30, "mid", "od", 130)],
  ["kaiLight", frameData(15, 4, "mid", "special", 153)],
  ["kaiHeavy", frameData(20, 5, "mid", "special", 174)],
  ["aragami", frameData(11, 6, "mid", "special", 133)],
  ["konokizu", frameData(9, 8, "mid", "targetCombo", 130)],
  ["yanosabi2", frameData(24, 4, "overhead", "targetCombo", 125)],
  ["munotsuchi", frameData(21, 2, "low", "targetCombo", 124)],
  ["dokugami", frameData(18, 6, "mid", "special", 142)],
  ["kototsukiYoLight", frameData(15, 3, "mid", "special", 172)],
  ["kototsukiYoHeavy", frameData(15, 3, "mid", "special", 183)],
  ["kototsukiYoEx", frameData(3, 1, "throw", "od", 63)],
  ["shatterStrike", frameData(15, 6, "mid", "system", 142)],
  ["advanceStrike", frameData(28, 6, "mid", "system", 169)],
]);

const MOTION_STEPS = Object.freeze({
  qcf: ["down", "downForward", "forward"],
  qcb: ["down", "downBack", "back"],
  dp: ["forward", "down", "downForward"],
  hcb: ["forward", "down", "back"],
  qcfQcf: ["down", "downForward", "forward", "down", "downForward", "forward"],
  qcbHcf: ["down", "downBack", "back", "down", "downForward", "forward"],
});

const DEFAULT_TUNING = Object.freeze({
  closeGap: 67,
  pokeGap: 126,
  farGap: 218,
  antiAirGap: 142,
  projectileGuardFrames: 23,
  throwRate: 0.25,
  jumpRate: 0.075,
  reversalRate: 0.7,
  resourceRate: 0.66,
  retreatHealthLead: 0.16,
  closeGuardRate: 0,
  midGuardRate: 0,
  backdashRate: 0,
  parryRate: 0,
  guardHoldFrames: 7,
});

/**
 * A deterministic AgentV1 controller.  It consumes only the public match info
 * and ObservationV1 snapshots supplied to reset/act.
 */
export function createTriadChampionAgent(options = {}) {
  const tuning = normalizeTuning(options);
  let randomState = 1;
  let queue = [];
  let lastRound = 0;
  let lastFrame = -1;
  let selfTemplate = "unknown";
  let mode = "ready";
  let lastCommand = "neutral";
  let framesActed = 0;
  let commandsStarted = 0;
  let queueFlushes = 0;
  let lastResult = "none";
  let eventCursor = -1;
  let opponentJumpEvents = 0;
  let opponentThrowEvents = 0;

  function reset() {
    randomState = 0x6d2b79f5;
    queue = [];
    lastRound = 0;
    lastFrame = -1;
    selfTemplate = "unknown";
    mode = "ready";
    lastCommand = "neutral";
    framesActed = 0;
    commandsStarted = 0;
    queueFlushes = 0;
    lastResult = "none";
    eventCursor = -1;
    opponentJumpEvents = 0;
    opponentThrowEvents = 0;
  }

  function act(observation) {
    framesActed += 1;
    selfTemplate = text(observation?.self?.templateId, selfTemplate);

    if (!observation || observation.phase !== "fighting") {
      flushQueue("inactive");
      return createActionV1();
    }

    if (observation.round?.number !== lastRound || observation.frame < lastFrame) {
      queue = [];
      lastRound = observation.round?.number ?? lastRound;
      eventCursor = -1;
    }
    lastFrame = observation.frame;
    learnPublicEvents(observation);

    const self = observation.self;
    const opponent = observation.opponent;
    const gap = edgeGap(self, opponent);
    const stunned = self.state.hitstunFrames > 0;
    const knockedDown = self.state.knockdownFrames > 0 || self.state.knockdownType !== "none";

    if (stunned || knockedDown) {
      flushQueue(stunned ? "hitstun" : "knockdown");
      mode = stunned ? "recovering" : "wakeup-cover";
      return actionFor(observation, "downBack", { guard: true });
    }

    if (self.state.blockstunFrames > 0) {
      flushQueue("blockstun");
      mode = "guarding";
      if (shouldGuardCancel(self, opponent, gap)) {
        lastCommand = "guard-cancel";
        return actionFor(observation, "forward", { system2: true, guard: true });
      }
      return defensiveAction(observation, gap);
    }

    const projectile = nearestIncomingProjectile(observation);
    if (projectile && projectile.framesAway <= tuning.projectileGuardFrames) {
      flushQueue("projectile");
      mode = "projectile-cover";
      if (projectile.framesAway > 11 && gap > tuning.pokeGap && random() < 0.22) {
        return actionFor(observation, "upForward");
      }
      if (isVanguard(self) && self.resources.drive >= 120 && random() < 0.3) {
        return actionFor(observation, "neutral", { system1: true });
      }
      if (!isVanguard(self)) {
        startNormal("forward", "system1", "projectile-roll");
        return nextQueuedAction(observation);
      }
      return actionFor(observation, "downBack", { guard: true });
    }

    if (opponent.onGround === false && self.onGround !== false && gap <= tuning.antiAirGap) {
      flushQueue("anti-air");
      mode = "anti-air";
      if (isActionable(self)) {
        if (isVanguard(self) && self.resources.drive >= 200 && random() < tuning.resourceRate) {
          startMotion("dp", ["lp", "mp"], "od-anti-air");
        } else {
          startMotion("dp", ["lp"], "anti-air");
        }
        return nextQueuedAction(observation);
      }
      return actionFor(observation, "back", { guard: true });
    }

    if (self.onGround === false) {
      mode = "air-control";
      if (queue.length > 0) return nextQueuedAction(observation);
      if (gap < tuning.pokeGap + 25) {
        lastCommand = "air-strike";
        return actionFor(observation, "forward", isVanguard(self) ? { hk: true } : { hp: true });
      }
      return actionFor(observation, "forward");
    }

    const threat = publicThreat(opponent, gap);
    if (threat.dangerous) {
      flushQueue("threat");
      mode = "defending";
      if (isActionable(self) && threat.canReversal && random() < tuning.reversalRate) {
        if (isVanguard(self) && self.resources.drive >= 200) {
          startMotion("dp", ["lp", "mp"], "od-reversal");
        } else if (!isVanguard(self) && self.resources.super >= 50) {
          startMotion("dp", ["lp", "hp"], "ex-reversal");
        } else {
          startMotion("dp", ["lp"], "reversal");
        }
        return nextQueuedAction(observation);
      }
      return defensiveAction(observation, gap, threat.hitLevel);
    }

    if (queue.length > 0) return nextQueuedAction(observation);

    if (!isActionable(self)) {
      mode = "locked";
      return createActionV1();
    }

    if (opponent.state.phase === "recovery" && gap < tuning.pokeGap + 24) {
      mode = "punishing";
      startPunish(observation, gap);
      return nextQueuedAction(observation);
    }

    if (shouldRetreat(observation, gap)) {
      mode = "life-lead";
      if (gap < tuning.farGap) return actionFor(observation, "back", { guard: true });
      if (isVanguard(self) && random() < 0.42) {
        startMotion("qcf", ["lp"], "life-lead-projectile");
        return nextQueuedAction(observation);
      }
      return actionFor(observation, "downBack", { guard: true });
    }

    if (isVanguard(self)) {
      chooseVanguard(observation, gap);
    } else {
      chooseEmber(observation, gap);
    }
    return queue.length > 0 ? nextQueuedAction(observation) : createActionV1();
  }

  function end(result = {}) {
    queue = [];
    lastResult = ["win", "loss", "draw"].includes(result.outcome) ? result.outcome : "none";
    mode = "ended";
  }

  function chooseVanguard(observation, gap) {
    const { self, opponent } = observation;
    if (gap <= tuning.pokeGap && opponent.state.phase !== "recovery") {
      const coverRate = gap <= tuning.closeGap ? tuning.closeGuardRate : tuning.midGuardRate;
      const coverRoll = random();
      if (coverRoll < coverRate) {
        startGuard(tuning.guardHoldFrames, "guard-cover");
        return;
      }
      if (coverRoll < coverRate + tuning.backdashRate && hasBackSpace(observation)) {
        startDash("back", "escape-dash");
        return;
      }
      if (coverRoll < coverRate + tuning.backdashRate + tuning.parryRate) {
        startParry(tuning.guardHoldFrames, "parry-cover");
        return;
      }
    }
    if (gap > tuning.farGap) {
      mode = "space-control";
      if (random() < 0.58 && opponent.state.phase !== "startup") {
        startMotion("qcf", [random() < 0.58 ? "lp" : "hp"], "projectile");
      } else if (random() < tuning.jumpRate * 1.45) {
        startJumpIn("hk", "jump-in");
      } else {
        startDash("forward", "advance-dash");
      }
      return;
    }

    if (gap > tuning.pokeGap) {
      mode = "mid-range";
      const roll = random();
      if (roll < 0.2) startMotion("qcf", ["lp"], "mid-projectile");
      else if (roll < 0.2 + tuning.jumpRate) startJumpIn("hk", "jump-in");
      else if (roll < 0.62) startNormal("down", "mk", "low-poke");
      else startDash("forward", "close-distance");
      return;
    }

    if (gap > tuning.closeGap) {
      mode = "footsies";
      const roll = random();
      if (roll < 0.43) startLowFireballConfirm();
      else if (roll < 0.68) startNormal("neutral", "mk", "standing-poke");
      else if (roll < 0.84 && self.resources.drive >= 100) startNormal("neutral", "system2", "drive-impact");
      else startNormal("down", "hk", "sweep");
      return;
    }

    mode = "close-range";
    const guarded = opponent.state.blockstunFrames > 0 || actionLooksDefensive(opponent.state.action);
    const throwBoost = guarded ? 0.18 : 0;
    const roll = random();
    if (roll < tuning.throwRate + throwBoost) startNormal("forward", "throw", "throw");
    else if (roll < 0.72) startVanguardJabConfirm();
    else if (self.resources.drive >= 100 && roll < 0.84) startNormal("neutral", "system2", "drive-impact");
    else startNormal("down", "lk", "low-check");
  }

  function chooseEmber(observation, gap) {
    const { self, opponent } = observation;
    if (gap > tuning.farGap) {
      mode = "closing";
      const roll = random();
      if (roll < tuning.jumpRate * 1.8) startJumpIn("hp", "jump-in");
      else if (roll < 0.38) startMotion("qcf", ["lk"], "advancing-kick");
      else startDash("forward", "run-in");
      return;
    }

    if (gap > tuning.pokeGap) {
      mode = "mid-range";
      const roll = random();
      if (roll < 0.24) startJumpIn("hp", "jump-in");
      else if (roll < 0.54) startNormal("neutral", "hp", "far-heavy");
      else if (roll < 0.76) startMotion("qcf", ["lk"], "kai");
      else startDash("forward", "run-in");
      return;
    }

    if (gap > tuning.closeGap) {
      mode = "footsies";
      const roll = random();
      if (roll < 0.38) startNormal("down", "hk", "sweep");
      else if (roll < 0.72) startNormal("neutral", "hp", "heavy-poke");
      else startMotion("qcf", ["lp"], "rekka-entry");
      return;
    }

    mode = "close-range";
    const guarded = opponent.state.blockstunFrames > 0 || actionLooksDefensive(opponent.state.action);
    const throwBoost = guarded ? 0.2 : 0;
    const roll = random();
    if (roll < tuning.throwRate + throwBoost) startNormal("forward", "throw", "throw");
    else if (roll < 0.76) startEmberHeavyConfirm();
    else if (self.resources.super >= 50 && roll < 0.86) startMotion("hcb", ["lk", "hk"], "ex-command-grab");
    else startEmberLowConfirm();
  }

  function startPunish(observation, gap) {
    if (isVanguard(observation.self)) {
      if (observation.self.resources.super >= 100 && gap < tuning.closeGap && random() < tuning.resourceRate) {
        startMotion("qcfQcf", ["hp"], "super-punish");
      } else if (gap < tuning.closeGap + 12) {
        startVanguardHeavyConfirm();
      } else {
        startLowFireballConfirm();
      }
    } else if (observation.self.resources.super >= 100 && gap < tuning.closeGap && random() < tuning.resourceRate) {
      startEmberHeavySuperConfirm();
    } else if (gap < tuning.closeGap + 12) {
      startEmberHeavyConfirm();
    } else {
      startNormal("neutral", "hp", "far-heavy-punish");
    }
  }

  function startVanguardJabConfirm() {
    begin("jab-confirm", [
      step("down", { lp: true }),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(2),
    ]);
  }

  function startVanguardHeavyConfirm() {
    begin("heavy-confirm", [
      step("neutral", { hp: true }),
      step("down"),
      step("downForward"),
      step("forward", { hp: true }),
      wait(3),
    ]);
  }

  function startLowFireballConfirm() {
    begin("low-special-confirm", [
      step("down", { mk: true }),
      wait(3),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(2),
    ]);
  }

  function startEmberHeavyConfirm() {
    begin("heavy-rekka-confirm", [
      step("neutral", { hp: true }),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(7),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(7),
      step("neutral", { lk: true }),
      wait(2),
    ]);
  }

  function startEmberLowConfirm() {
    begin("low-confirm", [
      step("down", { lk: true }),
      wait(2),
      step("down", { lp: true }),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(3),
    ]);
  }

  function startEmberHeavySuperConfirm() {
    begin("heavy-super-confirm", [
      step("neutral", { hp: true }),
      step("down"),
      step("downForward"),
      step("forward", { lp: true }),
      wait(7),
      ...motionEntries("qcfQcf", ["lp"]),
      wait(3),
    ]);
  }

  function startMotion(motion, buttons, label) {
    begin(label, [...motionEntries(motion, buttons), wait(2)]);
  }

  function startNormal(direction, button, label) {
    begin(label, [step(direction, { [button]: true }), wait(2)]);
  }

  function startJumpIn(button, label) {
    begin(label, [step("upForward"), step("upForward"), wait(5), step("forward", { [button]: true }), wait(2)]);
  }

  function startDash(direction, label) {
    begin(label, [step(direction), step("neutral"), step(direction), wait(5)]);
  }

  function startGuard(frames, label) {
    begin(label, Array.from(
      { length: Math.max(2, Math.round(frames)) },
      () => step("downBack", { guard: true }),
    ));
  }

  function startParry(frames, label) {
    begin(label, Array.from(
      { length: Math.max(2, Math.round(frames)) },
      () => step("neutral", { system1: true }),
    ));
  }

  function begin(label, entries) {
    queue = entries.flatMap(expandEntry);
    lastCommand = label;
    commandsStarted += 1;
  }

  function nextQueuedAction(observation) {
    const entry = queue.shift();
    if (!entry) return createActionV1();
    return actionFor(observation, entry.direction, entry.buttons);
  }

  function flushQueue(nextMode) {
    if (queue.length > 0) queueFlushes += 1;
    queue = [];
    if (nextMode) mode = nextMode;
  }

  function learnPublicEvents(observation) {
    for (const event of observation.recentEvents ?? []) {
      if (event.frame <= eventCursor) continue;
      const actor = event.fighterId ?? event.attackerId ?? event.sourceId ?? event.ownerId;
      if (actor === observation.selfIndex) continue;
      if (event.type === "jump") opponentJumpEvents += 1;
      if (event.type === "throw") opponentThrowEvents += 1;
    }
    eventCursor = Math.max(eventCursor, ...((observation.recentEvents ?? []).map((event) => event.frame)), -1);
  }

  function random() {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    randomState >>>= 0;
    return randomState / 0x100000000;
  }

  function debugState() {
    return Object.freeze({
      version: 1,
      selfTemplate,
      mode,
      lastCommand,
      queueDepth: queue.length,
      framesActed,
      commandsStarted,
      queueFlushes,
      lastResult,
    });
  }

  return Object.freeze({
    name: "Triad Champion",
    description: "ObservationV1-only deterministic spacing and defense controller",
    reset,
    act,
    end,
    getDebugState: debugState,
  });
}

function publicThreat(opponent, gap) {
  const phase = opponent.state.phase;
  const move = PUBLIC_FRAME_TABLE.get(opponent.state.moveId) ?? null;
  const hitLevel = move?.hitLevel ?? "mid";
  const startup = Math.max(1, move?.startup ?? 10);
  const active = Math.max(1, move?.active ?? 4);
  const frame = opponent.state.actionFrame;
  const closeEnough = gap <= threatReach(move);
  const dangerous = closeEnough && (
    phase === "active"
    || (phase === "startup" && frame >= Math.max(1, startup - 8))
  );
  return {
    dangerous,
    hitLevel,
    canReversal: dangerous && (phase === "active" || frame >= Math.max(1, startup - Math.min(5, active))),
  };
}

function threatReach(move) {
  if (!move) return 108;
  return move.reach;
}

function defensiveAction(observation, gap, explicitHitLevel = null) {
  const opponent = observation.opponent;
  const move = PUBLIC_FRAME_TABLE.get(opponent.state.moveId) ?? null;
  const hitLevel = explicitHitLevel ?? move?.hitLevel ?? "mid";
  if ((hitLevel === "throw" || move?.category === "throw") && gap < 58) {
    return actionFor(observation, "upBack", { throw: true });
  }
  if (hitLevel === "overhead") return actionFor(observation, "back", { guard: true });
  return actionFor(observation, "downBack", { guard: true });
}

function shouldGuardCancel(self, opponent, gap) {
  if (gap > 105 || opponent.state.phase === "recovery") return false;
  if (isVanguard(self)) return self.resources.drive >= 260 && self.resources.guard < self.resources.guardMax * 0.42;
  return self.resources.super >= 100 && self.resources.guard < self.resources.guardMax * 0.38;
}

function shouldRetreat(observation, gap) {
  const selfRatio = ratio(observation.self.health, observation.self.maxHealth);
  const opponentRatio = ratio(observation.opponent.health, observation.opponent.maxHealth);
  const lifeLead = selfRatio - opponentRatio;
  const seconds = observation.timerFrames / Math.max(1, observation.tickRate);
  return lifeLead > DEFAULT_TUNING.retreatHealthLead && seconds < 12 && gap > 70;
}

function nearestIncomingProjectile(observation) {
  const selfX = observation.self.position.x;
  let nearest = null;
  for (const projectile of observation.projectiles ?? []) {
    if (projectile.owner !== "opponent") continue;
    const delta = selfX - projectile.position.x;
    const velocity = projectile.velocity.x;
    if (velocity === 0 || Math.sign(delta) !== Math.sign(velocity)) continue;
    const framesAway = Math.abs(delta / velocity);
    if (!nearest || framesAway < nearest.framesAway) nearest = { projectile, framesAway };
  }
  return nearest;
}

function actionFor(observation, direction = "neutral", buttons = EMPTY_INPUT) {
  const facing = observation.self.facing >= 0 ? 1 : -1;
  const input = { ...buttons };
  if (["down", "downForward", "downBack"].includes(direction)) input.down = true;
  if (["up", "upForward", "upBack"].includes(direction)) input.up = true;
  if (["forward", "downForward", "upForward"].includes(direction)) {
    input[facing > 0 ? "right" : "left"] = true;
  }
  if (["back", "downBack", "upBack"].includes(direction)) {
    input[facing > 0 ? "left" : "right"] = true;
  }
  return createActionV1(input);
}

function createActionV1(input = EMPTY_INPUT) {
  const complete = Object.fromEntries(ACTION_INPUT_KEYS.map((key) => [key, input[key] === true]));
  return deepFreeze({ schema: "agentfighter.action", version: 1, input: complete });
}

function motionEntries(motion, buttons) {
  const directions = MOTION_STEPS[motion] ?? [];
  return directions.map((direction, index) => step(
    direction,
    index === directions.length - 1
      ? Object.fromEntries(buttons.map((button) => [button, true]))
      : EMPTY_INPUT,
  ));
}

function step(direction = "neutral", buttons = EMPTY_INPUT) {
  return { direction, buttons };
}

function wait(frames = 1) {
  return { direction: "neutral", buttons: EMPTY_INPUT, frames };
}

function expandEntry(entry) {
  return Array.from({ length: Math.max(1, Math.floor(entry.frames ?? 1)) }, () => ({
    direction: entry.direction,
    buttons: entry.buttons,
  }));
}

function isActionable(fighter) {
  if (!fighter.onGround) return false;
  if (fighter.state.hitstunFrames > 0 || fighter.state.blockstunFrames > 0 || fighter.state.knockdownFrames > 0) return false;
  return fighter.state.phase === "idle" || ["idle", "walk", "crouch", "guard"].includes(fighter.state.action);
}

function isVanguard(fighter) {
  return fighter.templateId === "vanguard";
}

function edgeGap(left, right) {
  return Math.max(0, Math.abs(left.position.x - right.position.x) - (left.size.width + right.size.width) / 2);
}

function hasBackSpace(observation) {
  const self = observation.self;
  const wall = self.facing >= 0 ? observation.arena.left : observation.arena.right;
  return Math.abs(self.position.x - wall) > self.size.width * 1.45;
}

function actionLooksDefensive(action) {
  const token = text(action).toLowerCase();
  return token.includes("guard") || token.includes("block") || token.includes("parry");
}

function normalizeTuning(options) {
  const source = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  return Object.freeze(Object.fromEntries(
    Object.entries(DEFAULT_TUNING).map(([key, fallback]) => {
      const value = Number(source[key]);
      return [key, Number.isFinite(value) ? value : fallback];
    }),
  ));
}

function ratio(value, maximum) {
  return maximum > 0 ? value / maximum : 0;
}

function text(value, fallback = "") {
  return typeof value === "string" && value ? value : fallback;
}

function frameData(startup, active, hitLevel, category, reach) {
  return Object.freeze({ startup, active, hitLevel, category, reach });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createCandidate(options = {}) {
  return createTriadChampionAgent(options);
}

export function createAgent(options = {}) {
  return createTriadChampionAgent(options);
}

export default createTriadChampionAgent;
