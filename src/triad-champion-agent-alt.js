import { VANGUARD_MOVESET } from "./movesets/vanguard.js";
import { EMBER_MOVESET } from "./movesets/ember.js";

const ACTION_KEYS = Object.freeze([
  "left", "right", "up", "down",
  "lp", "mp", "hp", "lk", "mk", "hk",
  "throw", "system1", "system2", "guard",
]);

const DIRECTIONS = Object.freeze({
  qcf: Object.freeze(["down", "downForward", "forward"]),
  qcb: Object.freeze(["down", "downBack", "back"]),
  dp: Object.freeze(["forward", "down", "downForward"]),
  hcb: Object.freeze(["forward", "downForward", "down", "downBack", "back"]),
  qcfQcf: Object.freeze(["down", "downForward", "forward", "down", "downForward", "forward"]),
});

// Both sources are the public roster frame tables. Move ids are used only to
// estimate an already-visible move's timing and hit level.
const PUBLIC_MOVES = new Map([
  ...Object.entries(VANGUARD_MOVESET.moves),
  ...Object.entries(EMBER_MOVESET.moves),
]);

const EMBER_WALK_THROW = true;

export function createTriadChampionAgentAlt(templateHint = "") {
  let ownTemplate = ownTemplateValue(templateHint);
  let queue = [];
  let plan = "";
  let roundNumber = 0;
  let lastFrame = -1;
  let choiceCounter = 0;
  let airStrikeSent = false;
  let airFrames = 0;
  let wasKnockedDown = false;
  let knockdownCount = 0;
  let wakeupQueued = false;
  let guardCancelUntil = -1;

  function reset(info) {
    ownTemplate = ownTemplateValue(info?.self?.templateId) || ownTemplate;
    queue = [];
    plan = "";
    roundNumber = 0;
    lastFrame = -1;
    choiceCounter = 0;
    airStrikeSent = false;
    airFrames = 0;
    wasKnockedDown = false;
    knockdownCount = 0;
    wakeupQueued = false;
    guardCancelUntil = -1;
  }

  function act(observation) {
    if (!observation || observation.schema !== "agentfighter.observation" || observation.version !== 1) {
      return actionV1();
    }

    ownTemplate = ownTemplateValue(observation.self?.templateId) || ownTemplate;
    if (observation.phase !== "fighting") {
      clearPlan();
      return actionV1();
    }

    if (observation.round?.number !== roundNumber || observation.frame < lastFrame) {
      beginRound(observation);
    }
    lastFrame = observation.frame;

    const self = observation.self;
    const foe = observation.opponent;
    const gap = edgeDistance(self, foe);
    const inHitstun = self.state.hitstunFrames > 0;
    const inBlockstun = self.state.blockstunFrames > 0;
    const knockedDown = self.state.knockdownFrames > 0 || self.state.knockdownType !== "none";

    if (knockedDown && !wasKnockedDown) {
      knockdownCount += 1;
      wakeupQueued = false;
      clearPlan();
    }
    if (!knockedDown && wasKnockedDown) wakeupQueued = false;
    wasKnockedDown = knockedDown;

    if (inHitstun) {
      clearPlan();
      return directionAction(observation, "downBack", { guard: true, lp: true, lk: true });
    }

    if (knockedDown) {
      return knockedDownAction(observation);
    }

    if (inBlockstun) {
      clearPlan();
      if (canGuardCancel(observation, gap)) {
        guardCancelUntil = observation.frame + 90;
        return ownTemplate === "vanguard"
          ? directionAction(observation, "forward", { hp: true, hk: true, guard: true })
          : directionAction(observation, "neutral", { hp: true, hk: true, guard: true });
      }
      return defend(observation, visibleHitLevel(foe), gap);
    }

    if (self.onGround === false) {
      queue = [];
      plan = "air";
      airFrames += 1;
      if (!airStrikeSent && (airFrames >= 5 || gap < 66)) {
        airStrikeSent = true;
        return directionAction(
          observation,
          "forward",
          ownTemplate === "vanguard" ? { hk: true } : { hp: true },
        );
      }
      return directionAction(observation, gap < 44 ? "back" : "forward", { guard: gap < 44 });
    }
    airStrikeSent = false;
    airFrames = 0;

    const incoming = incomingProjectile(observation);
    if (incoming && shouldAddressProjectile(incoming, gap)) {
      const response = projectileResponse(observation, incoming, gap);
      if (response) return response;
    }

    // Once a command has begun, finish its public input sequence. The old
    // candidate's largest failure mode was discarding motions mid-command.
    if (queue.length > 0) return takeQueued(observation);

    if (!isFree(self)) {
      return directionAction(observation, gap < 118 ? "downBack" : "neutral", { guard: gap < 118 });
    }

    if (foe.onGround === false && gap < 142) {
      startAntiAir(observation);
      return takeQueued(observation);
    }

    const threat = visibleThreat(foe, gap);
    if (threat.dangerous) {
      if (threat.throwLike && gap < 62) {
        return directionAction(observation, "upBack", { lp: true, lk: true, guard: true });
      }
      if (shouldReversal(observation, threat, gap)) {
        startReversal(observation);
        return takeQueued(observation);
      }
      return defend(observation, threat.hitLevel, gap);
    }

    if (foe.state.knockdownFrames > 0 || foe.state.knockdownType !== "none") {
      chooseOkizeme(observation, gap);
      return queue.length > 0 ? takeQueued(observation) : directionAction(observation, "forward");
    }

    if (foe.state.phase === "recovery" && gap < 156) {
      startPunish(observation, gap);
      return takeQueued(observation);
    }

    if (protectLead(observation, gap)) {
      if (gap < 190) return directionAction(observation, "downBack", { guard: true });
      if (ownTemplate === "vanguard") {
        startMotion("qcf", ["lp"], "lead-projectile", 2);
        return takeQueued(observation);
      }
      return directionAction(observation, "back", { guard: true });
    }

    if (ownTemplate === "ember") chooseEmber(observation, gap);
    else chooseVanguard(observation, gap);
    return queue.length > 0 ? takeQueued(observation) : actionV1();
  }

  function beginRound(observation) {
    queue = [];
    plan = "";
    roundNumber = observation.round?.number ?? roundNumber;
    lastFrame = observation.frame;
    choiceCounter = 0;
    airStrikeSent = false;
    airFrames = 0;
    wasKnockedDown = false;
    wakeupQueued = false;
  }

  function knockedDownAction(observation) {
    const self = observation.self;
    const remaining = self.state.knockdownFrames;
    const useReversal = knockdownCount % 3 === 1 && (
      ownTemplate === "vanguard" ? self.resources.drive >= 200 : self.resources.super >= 50
    );

    if (!wakeupQueued && useReversal && remaining > 0 && remaining <= 2) {
      wakeupQueued = true;
      if (ownTemplate === "vanguard") startMotion("dp", ["lp", "mp"], "wakeup-od", 2);
      else startMotion("dp", ["lp", "hp"], "wakeup-ex", 2);
    }
    if (wakeupQueued && queue.length > 0) return takeQueued(observation);
    return directionAction(observation, "downBack", { guard: true, lp: true, lk: true });
  }

  function canGuardCancel(observation, gap) {
    if (observation.frame < guardCancelUntil || gap > 112) return false;
    const self = observation.self;
    const guardRatio = ratio(self.resources.guard, self.resources.guardMax);
    if (guardRatio > 0.56) return false;
    return ownTemplate === "vanguard" ? self.resources.drive >= 200 : self.resources.super >= 100;
  }

  function projectileResponse(observation, projectile, gap) {
    const self = observation.self;
    if (queue.length > 0) {
      // A roll or motion already in flight must not be restarted every frame
      // merely because the same public projectile remains visible.
      if (projectile.framesAway < 4 && isFree(self)) {
        clearPlan();
        return directionAction(observation, "downBack", { guard: true });
      }
      return null;
    }
    if (!isFree(self) && queue.length === 0) {
      return projectile.framesAway < 9
        ? directionAction(observation, "downBack", { guard: true })
        : null;
    }

    if (ownTemplate === "ember") {
      if (projectile.framesAway >= 17 && projectile.framesAway <= 46 && gap > 64) {
        queue = [];
        startJump("projectile-jump");
        return takeQueued(observation);
      }
      if (projectile.framesAway < 17) {
        clearPlan();
        return directionAction(observation, "downBack", { guard: true });
      }
      if (gap > 205 && projectile.framesAway > 46) {
        return directionAction(observation, "forward", { guard: false });
      }
      return null;
    }

    if (projectile.framesAway <= 13) {
      clearPlan();
      return directionAction(observation, "downBack", { mp: true, mk: true, system1: true, guard: true });
    }
    return null;
  }

  function startAntiAir(observation) {
    const self = observation.self;
    if (ownTemplate === "vanguard") {
      if (self.resources.drive >= 200) startMotion("dp", ["lp", "mp"], "anti-air-od", 2);
      else startMotion("dp", ["lp"], "anti-air", 2);
    } else if (self.resources.super >= 50) {
      startMotion("dp", ["lp", "hp"], "anti-air-ex", 2);
    } else {
      startMotion("dp", ["lp"], "anti-air", 2);
    }
  }

  function shouldReversal(observation, threat, gap) {
    if (gap > 102 || !threat.late) return false;
    const self = observation.self;
    if (ownTemplate === "ember") return self.resources.super >= 50;
    if ((choiceCounter + observation.round.number) % 4 !== 0) return false;
    return self.resources.drive >= 200;
  }

  function startReversal(observation) {
    if (ownTemplate === "vanguard") startMotion("dp", ["lp", "mp"], "od-reversal", 2);
    else startMotion("dp", ["lp", "hp"], "ex-reversal", 2);
  }

  function chooseOkizeme(observation, gap) {
    if (gap > 86) {
      enqueue("knockdown-approach", dashEntries("forward", 5));
      return;
    }
    const pick = nextChoice(4);
    if (ownTemplate === "vanguard") {
      if (pick === 0 && gap < 58) startTap("forward", { lp: true, lk: true }, "meaty-throw", 2);
      else if (pick === 1) startVanguardJabString();
      else startTap("down", { lk: true }, "meaty-low", 2);
    } else if (pick === 0 && gap < 58) {
      startTap("forward", { hp: true }, "meaty-throw", 2);
    } else if (pick === 1 && observation.self.resources.super >= 50) {
      startMotion("hcb", ["lk", "hk"], "meaty-command-grab", 2);
    } else {
      startEmberHeavyString();
    }
  }

  function startPunish(observation, gap) {
    const self = observation.self;
    if (ownTemplate === "vanguard") {
      if (gap < 72) startVanguardHeavyString();
      else if (gap < 126) startVanguardMediumString();
      else startTap("neutral", { hk: true }, "long-punish", 2);
      return;
    }
    if (gap < 62 && self.resources.super >= 50 && nextChoice(3) === 0) {
      startMotion("hcb", ["lk", "hk"], "command-grab-punish", 2);
    } else if (gap < 84) {
      startEmberHeavyString();
    } else {
      startTap("neutral", { hp: true }, "far-heavy-punish", 2);
    }
  }

  function chooseVanguard(observation, gap) {
    const self = observation.self;
    const pick = nextChoice(12);

    if (gap > 232) {
      if (pick < 6) startMotion("qcf", [pick % 3 === 0 ? "mp" : "lp"], "far-projectile", 2);
      else if (pick < 9) enqueue("far-dash", dashEntries("forward", 6));
      else startJump("far-jump");
      return;
    }

    if (gap > 132) {
      if (pick < 3) startMotion("qcf", ["lp"], "mid-projectile", 2);
      else if (pick < 6) enqueue("mid-dash", dashEntries("forward", 5));
      else if (pick < 9) startTap("forward", { hp: true }, "solar-plexus", 2);
      else startTap("neutral", { hk: true }, "standing-heavy-kick", 2);
      return;
    }

    if (gap > 70) {
      if (pick < 4) startVanguardMediumString();
      else if (pick < 7) startVanguardLowString();
      else if (pick < 9) startTap("neutral", { mk: true }, "safe-poke", 2);
      else if (pick === 9 && self.resources.drive >= 100) startTap("neutral", { hp: true, hk: true }, "impact", 3);
      else startVanguardJabString();
      return;
    }

    if (pick < 3 && gap < 56) startTap("forward", { lp: true, lk: true }, "throw", 2);
    else if (pick < 8) startVanguardJabString();
    else if (pick < 10) startTap("down", { lk: true }, "low-check", 2);
    else if (self.resources.drive >= 100) startTap("neutral", { hp: true, hk: true }, "impact", 3);
    else startVanguardMediumString();
  }

  function chooseEmber(observation, gap) {
    if (EMBER_WALK_THROW) {
      if (gap > 58) {
        enqueue("measured-walk", hold("forward", gap > 180 ? 6 : 3));
      } else if (nextChoice(4) < 3) {
        enqueue("close-throw", [
          inputStep("forward", { throw: true }),
          inputStep("neutral"),
          ...hold("downBack", 3, { guard: true }),
        ]);
      } else {
        enqueue("close-cover", hold("downBack", 3, { guard: true }));
      }
      return;
    }

    const self = observation.self;
    const pick = nextChoice(16);

    if (gap > 218) {
      if (pick < 2) startJump("far-jump");
      else if (pick < 6) startMotion("qcf", ["lk"], "advancing-kick", 2);
      else enqueue("far-dash", dashEntries("forward", 6));
      return;
    }

    if (gap > 126) {
      if (pick < 4) startJump("mid-jump");
      else if (pick < 9) startTap("neutral", { hp: true }, "far-heavy", 2);
      else if (pick < 13) startMotion("qcf", ["lk"], "kai", 2);
      else enqueue("mid-dash", dashEntries("forward", 5));
      return;
    }

    if (gap > 67) {
      if (pick < 6) startTap("down", { hk: true }, "sweep", 2);
      else if (pick < 12) startTap("neutral", { hp: true }, "heavy-poke", 2);
      else startMotion("qcf", ["lp"], "rekka-entry", 2);
      return;
    }

    const guarding = observation.opponent.state.blockstunFrames > 0
      || ["guard", "block", "parry"].some((word) => observation.opponent.state.action.includes(word));
    const throwLine = guarding ? 7 : 4;
    if (pick < throwLine && gap < 58) startTap("forward", { throw: true }, "throw", 2);
    else if (pick < 12) startEmberHeavyString();
    else if (self.resources.super >= 50 && pick < 14) startMotion("hcb", ["lk", "hk"], "command-grab", 2);
    else startEmberLowString();
  }

  function startVanguardJabString() {
    enqueue("jab-projectile", [
      inputStep("neutral", { lp: true }),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 2),
    ]);
  }

  function startVanguardMediumString() {
    enqueue("medium-projectile", [
      inputStep("down", { mp: true }),
      ...hold("neutral", 2),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 2),
    ]);
  }

  function startVanguardLowString() {
    enqueue("low-projectile", [
      inputStep("down", { mk: true }),
      ...hold("neutral", 3),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 2),
    ]);
  }

  function startVanguardHeavyString() {
    enqueue("heavy-projectile", [
      inputStep("neutral", { hp: true }),
      ...hold("neutral", 5),
      ...motionEntries("qcf", ["hp"]),
      ...hold("neutral", 3),
    ]);
  }

  function startEmberHeavyString() {
    enqueue("heavy-rekka", [
      inputStep("neutral", { hp: true }),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 7),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 7),
      inputStep("neutral", { lk: true }),
      ...hold("neutral", 2),
    ]);
  }

  function startEmberLowString() {
    enqueue("low-rekka", [
      inputStep("down", { lk: true }),
      ...hold("neutral", 2),
      inputStep("down", { lp: true }),
      ...motionEntries("qcf", ["lp"]),
      ...hold("neutral", 3),
    ]);
  }

  function startJump(label) {
    airStrikeSent = false;
    enqueue(label, [inputStep("upForward"), inputStep("upForward")]);
  }

  function startTap(direction, buttons, label, releaseFrames = 1) {
    enqueue(label, [inputStep(direction, buttons), ...hold("neutral", releaseFrames)]);
  }

  function startMotion(motion, buttons, label, releaseFrames = 1) {
    enqueue(label, [...motionEntries(motion, buttons), ...hold("neutral", releaseFrames)]);
  }

  function enqueue(label, entries) {
    plan = label;
    queue = entries.slice();
  }

  function takeQueued(observation) {
    const entry = queue.shift();
    if (!entry) return actionV1();
    return directionAction(observation, entry.direction, entry.buttons);
  }

  function clearPlan() {
    queue = [];
    plan = "";
  }

  function nextChoice(modulus) {
    const value = (choiceCounter * 7 + roundNumber * 5 + plan.length) % modulus;
    choiceCounter += 1;
    return value;
  }

  return Object.freeze({ reset, act, end() { clearPlan(); } });
}

function ownTemplateValue(value) {
  return value === "ember" || value === "vanguard" ? value : "";
}

function visibleThreat(fighter, gap) {
  const move = PUBLIC_MOVES.get(fighter.state.moveId);
  const phase = fighter.state.phase;
  const startup = Math.max(1, Number(move?.startup) || 8);
  const activeEnd = Math.max(startup, ...((move?.activeWindows ?? []).map((window) => Number(window.end) || startup)));
  const frame = Number(fighter.state.actionFrame) || 0;
  const hitLevel = move?.hitLevel ?? move?.hit?.level ?? "mid";
  const throwLike = move?.category === "throw" || hitLevel === "throw";
  const inReach = gap <= estimatedReach(move);
  const startupThreat = phase === "startup" && frame >= Math.max(0, startup - 13);
  const activeThreat = phase === "active" || (frame >= startup && frame <= activeEnd + 2);
  return {
    dangerous: inReach && (startupThreat || activeThreat),
    late: activeThreat || frame >= Math.max(0, startup - 5),
    throwLike,
    hitLevel,
  };
}

function estimatedReach(move) {
  if (!move) return 112;
  const tags = new Set(move.tags ?? []);
  if (move.category === "throw" || move.hitLevel === "throw") return 62;
  // The authored projectile move's body is not a full-screen hitbox. Its
  // separately visible projectile is handled from ObservationV1.projectiles.
  if (tags.has("projectile")) return 0;
  if (tags.has("runGrab") || tags.has("advancing")) return 184;
  if (tags.has("dragonPunch")) return 122;
  if (tags.has("light")) return 80;
  if (tags.has("medium")) return 124;
  if (tags.has("heavy") || move.category === "commandNormal") return 150;
  if (["special", "od", "system"].includes(move.category)) return 152;
  return 118;
}

function visibleHitLevel(fighter) {
  const move = PUBLIC_MOVES.get(fighter.state.moveId);
  return move?.hitLevel ?? move?.hit?.level ?? "mid";
}

function defend(observation, hitLevel, gap) {
  if (hitLevel === "throw" && gap < 64) {
    return directionAction(observation, "upBack", { lp: true, lk: true, guard: true });
  }
  if (hitLevel === "overhead") return directionAction(observation, "back", { guard: true });
  return directionAction(observation, "downBack", { guard: true });
}

function incomingProjectile(observation) {
  const selfX = observation.self.position.x;
  let closest = null;
  for (const projectile of observation.projectiles ?? []) {
    if (projectile.owner !== "opponent") continue;
    const delta = selfX - projectile.position.x;
    const velocity = projectile.velocity.x;
    if (!Number.isFinite(velocity) || velocity === 0 || Math.sign(delta) !== Math.sign(velocity)) continue;
    const framesAway = Math.abs(delta / velocity);
    if (!closest || framesAway < closest.framesAway) closest = { framesAway };
  }
  return closest;
}

function shouldAddressProjectile(projectile, gap) {
  return projectile.framesAway < (gap > 180 ? 55 : 34);
}

function protectLead(observation, gap) {
  const seconds = observation.timerFrames / Math.max(1, observation.tickRate);
  const lead = ratio(observation.self.health, observation.self.maxHealth)
    - ratio(observation.opponent.health, observation.opponent.maxHealth);
  return seconds < 9 && lead > 0.1 && gap > 64;
}

function isFree(fighter) {
  if (fighter.onGround === false) return false;
  if (fighter.state.hitstunFrames > 0 || fighter.state.blockstunFrames > 0 || fighter.state.knockdownFrames > 0) {
    return false;
  }
  return fighter.state.phase === "idle"
    || ["idle", "walk", "crouch", "guard"].includes(fighter.state.action);
}

function edgeDistance(first, second) {
  return Math.max(
    0,
    Math.abs(first.position.x - second.position.x) - (first.size.width + second.size.width) / 2,
  );
}

function motionEntries(motion, buttons) {
  const directions = DIRECTIONS[motion] ?? [];
  return directions.map((direction, index) => inputStep(
    direction,
    index === directions.length - 1
      ? Object.fromEntries(buttons.map((button) => [button, true]))
      : {},
  ));
}

function dashEntries(direction, travelFrames) {
  return [
    inputStep(direction),
    inputStep("neutral"),
    inputStep(direction),
    ...hold(direction, travelFrames),
  ];
}

function inputStep(direction = "neutral", buttons = {}) {
  return { direction, buttons };
}

function hold(direction, frames, buttons = {}) {
  return Array.from({ length: Math.max(0, Math.floor(frames)) }, () => inputStep(direction, buttons));
}

function directionAction(observation, direction = "neutral", buttons = {}) {
  const facing = observation.self.facing >= 0 ? 1 : -1;
  const input = { ...buttons };
  if (direction === "down" || direction === "downForward" || direction === "downBack") input.down = true;
  if (direction === "up" || direction === "upForward" || direction === "upBack") input.up = true;
  if (direction === "forward" || direction === "downForward" || direction === "upForward") {
    input[facing > 0 ? "right" : "left"] = true;
  }
  if (direction === "back" || direction === "downBack" || direction === "upBack") {
    input[facing > 0 ? "left" : "right"] = true;
  }
  return actionV1(input);
}

function actionV1(input = {}) {
  return Object.freeze({
    schema: "agentfighter.action",
    version: 1,
    input: Object.freeze(Object.fromEntries(ACTION_KEYS.map((key) => [key, input[key] === true]))),
  });
}

function ratio(value, maximum) {
  return maximum > 0 ? value / maximum : 0;
}

export const createAgent = createTriadChampionAgentAlt;
export default createTriadChampionAgentAlt;
