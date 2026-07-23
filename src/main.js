import { MOVESETS, createGame, stepGame, nextRound } from "./engine.js";
import { AI_PRESETS } from "./ai.js";
import {
  createBrowserAgent,
  createBrowserMatchSeedSequence,
  customBrowserAgentMetadata,
} from "./browser-agent-registry.js";
import { createRenderer } from "./renderer.js";
import { createKeyboardInput, neutralInput } from "./input.js";
import { createAudio } from "./audio.js";
import { createReplayPlayer, createReplayRecorder } from "./replay.js";
import {
  TOD_EXHIBITION_ROUTE_LABEL,
  createTodExhibitionDirector,
  evaluateTodExhibition,
  prepareTodExhibition,
} from "./tod-exhibition.js";

const TICK_MS = 1000 / 60;
const MAX_STEPS = 6;

const canvas = document.querySelector("#game-canvas");
const gameWrap = document.querySelector("#game-wrap");
const startOverlay = document.querySelector("#start-overlay");
const matchOverlay = document.querySelector("#match-overlay");
const roundBanner = document.querySelector("#round-banner");
const statusNode = document.querySelector("#runtime-status");
const modeSelect = document.querySelector("#mode-select");
const leftTemplateSelect = document.querySelector("#left-template-select");
const rightTemplateSelect = document.querySelector("#right-template-select");
const leftTemplateLabel = document.querySelector("#left-template-label");
const rightTemplateLabel = document.querySelector("#right-template-label");
const leftAgentRow = document.querySelector("#left-agent-row");
const leftAgentSelect = document.querySelector("#left-agent-select");
const rightAgentLabel = document.querySelector("#right-agent-label");
const agentSelect = document.querySelector("#agent-select");
const difficultySelect = document.querySelector("#difficulty-select");
const delaySelect = document.querySelector("#delay-select");
const agentDescription = document.querySelector("#agent-description");
const controlsPanel = document.querySelector("#controls-panel") || document.querySelector(".controls-panel");
const controlsTitle = document.querySelector("#controls-title");
const controlsSide = document.querySelector("#controls-side");
const controlsModeNote = document.querySelector("#controls-mode-note");
const moveDataList = document.querySelector("#move-data-list");
const pauseButton = document.querySelector("#pause-button");
const soundButton = document.querySelector("#sound-button");
const debugButton = document.querySelector("#debug-button");
const replayButton = document.querySelector("#replay-button");
const resultTitle = document.querySelector("#result-title");
const resultCopy = document.querySelector("#result-copy");
const resultKicker = document.querySelector("#result-kicker");
const rematchButton = document.querySelector("#rematch-button");
const resultReplayButton = document.querySelector("#result-replay-button");
const changeAgentButton = document.querySelector("#change-agent-button");
const todShowButton = document.querySelector("#tod-show-button");
const todStepNode = document.querySelector('[data-role="tod-step"]');
const todRouteNode = document.querySelector('[data-role="tod-route"]');
const todHitsNode = document.querySelector('[data-role="tod-hits"]');
const todDamageNode = document.querySelector('[data-role="tod-damage"]');
const todVerdictNode = document.querySelector('[data-role="tod-verdict"]');
const replayPanel = document.querySelector("#replay-panel");
const replayStatusNode = document.querySelector("#replay-status");
const replayPrevButton = document.querySelector("#replay-prev-button");
const replayPlayButton = document.querySelector("#replay-play-button");
const replayNextButton = document.querySelector("#replay-next-button");
const replaySpeedSelect = document.querySelector("#replay-speed-select");
const replayExitButton = document.querySelector("#replay-exit-button");
const replayTimeline = document.querySelector("#replay-timeline");
const replayMarkers = document.querySelector("#replay-markers");
const replayFrameLabel = document.querySelector("#replay-frame-label");
const replayTimeLabel = document.querySelector("#replay-time-label");
const replayLeftName = document.querySelector("#replay-left-name");
const replayRightName = document.querySelector("#replay-right-name");
const replayLeftHealth = document.querySelector("#replay-left-health");
const replayRightHealth = document.querySelector("#replay-right-health");
const replayLeftResource = document.querySelector("#replay-left-resource");
const replayRightResource = document.querySelector("#replay-right-resource");
const replayLeftInput = document.querySelector("#replay-left-input");
const replayRightInput = document.querySelector("#replay-right-input");
const replayLeftIntent = document.querySelector("#replay-left-intent");
const replayRightIntent = document.querySelector("#replay-right-intent");
const replayLeftReason = document.querySelector("#replay-left-reason");
const replayRightReason = document.querySelector("#replay-right-reason");
const replayEventList = document.querySelector("#replay-event-list");

const keyboard = createKeyboardInput(window);
const renderer = createRenderer(canvas);
const audio = createAudio();

let game;
let leftScriptAI;
let rightScriptAI;
let activeMatchConfig;
const browserMatchSeedSequence = createBrowserMatchSeedSequence();
let activeMatchSeeds = browserMatchSeedSequence.peek();
let playing = false;
let paused = false;
let debug = false;
let lastTime = performance.now();
let accumulator = 0;
let roundAdvanceAt = 0;
let lastPhase = "";
let effectCursor = new Set();
let bannerTimer = 0;
let todDirector;
let resultRevealTimer = 0;
let activeReplayRecorder = null;
let lastReplay = null;
let replayPlayer = null;
let replayMode = false;
let replayPlaying = false;
let replaySpeed = 1;
let replayAccumulator = 0;
let replayEvents = [];
let replayReturnState = null;
let replayEventRenderKey = "";

const REPLAY_BUTTON_LABELS = Object.freeze({
  lp: "LP", mp: "MP", hp: "HP", lk: "LK", mk: "MK", hk: "HK",
  throw: "THROW", system1: "S1", system2: "S2", guard: "GUARD",
});

function replayInputLabel(input = {}) {
  const horizontal = input.left && !input.right ? "←" : input.right && !input.left ? "→" : "";
  const vertical = input.up && !input.down ? "↑" : input.down && !input.up ? "↓" : "";
  const direction = `${vertical}${horizontal}` || "N";
  const buttons = Object.entries(REPLAY_BUTTON_LABELS)
    .filter(([key]) => Boolean(input[key]))
    .map(([, label]) => label);
  return [direction, ...buttons].join(" + ");
}

function replayClock(frame) {
  const milliseconds = Math.max(0, Math.round((Number(frame) || 0) * TICK_MS));
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function replayResourceLabel(fighter = {}) {
  const resources = [];
  const energy = Number(fighter.energy ?? fighter.superMeter ?? fighter.meter);
  const maxEnergy = Number(fighter.maxEnergy ?? fighter.maxSuperMeter ?? fighter.maxMeter);
  if (Number.isFinite(energy)) resources.push(`SUPER ${Math.round(energy)}${Number.isFinite(maxEnergy) ? `/${Math.round(maxEnergy)}` : ""}`);
  const drive = Number(fighter.drive ?? fighter.driveGauge);
  const maxDrive = Number(fighter.maxDrive ?? fighter.maxDriveGauge);
  if (Number.isFinite(drive)) resources.push(`DRIVE ${Math.round(drive)}${Number.isFinite(maxDrive) ? `/${Math.round(maxDrive)}` : ""}`);
  return resources.length ? resources.join(" · ") : "不可用";
}

function replayEventStyle(event = {}) {
  const type = String(event.type ?? event.kind ?? "").toLowerCase();
  const outcome = String(event.outcome ?? "").toLowerCase();
  const category = String(event.category ?? "").toLowerCase();
  if (event.tod || type.includes("tod") || type.includes("ko") || type.includes("matchover")) return "tod";
  if (type.includes("super") || category.includes("super") || category.includes("climax")) return "super";
  if (type.includes("knockdown") || type.includes("bounce") || type.includes("stun")) return "knockdown";
  if (type.includes("throw")) return "throw";
  if (outcome.includes("block") || type.includes("block") || type.includes("guard")) return "block";
  if (type.includes("contact") && !outcome.includes("whiff")) return "hit";
  if (type.includes("hit")) return "hit";
  return "other";
}

function replayEventLabel(event = {}) {
  const type = String(event.type ?? event.kind ?? "EVENT");
  const move = event.moveId ? ` · ${event.moveId}` : "";
  const outcome = event.outcome ? ` · ${event.outcome}` : "";
  if (event.tod) return `TOD · ${event.count ?? "?"} HIT · ${event.damage ?? "?"} DAMAGE`;
  if (type.toLowerCase().includes("ko")) return event.matchEnd ? "K.O. · 比赛结束" : "K.O. · 回合结束";
  if (type === "comboEnd") return `连击结束 · ${event.count ?? 0} HIT · ${event.damage ?? 0} DAMAGE`;
  if (type === "knockdown") return `击倒 · ${event.knockdownType ?? "KD"}`;
  if (type === "throw") return `抓投${move}`;
  if (type === "throwTech") return `拆投${move}`;
  if (type === "moveStart") return `${event.category === "super" || event.category === "climax" ? "超杀" : "出招"}${move}`;
  if (type === "contact") return `${event.outcome === "block" ? "防御" : event.outcome === "whiff" ? "挥空" : "命中"}${move}${outcome}`;
  return `${type}${move}${outcome}`;
}

function replayEventFrame(event = {}) {
  const frame = Number(event.replayCursor ?? event.cursor ?? event.frame ?? event.tick ?? event.gameFrame);
  return Number.isFinite(frame) ? Math.max(0, Math.round(frame)) : 0;
}

function replayDecision(frameRecord, index) {
  const side = index === 0 ? "p1" : "p2";
  const source = frameRecord?.decisions?.[side]
    ?? frameRecord?.decisions?.[index]
    ?? frameRecord?.decisionMetadata?.[side]
    ?? frameRecord?.decisionMetadata?.[index]
    ?? frameRecord?.metadata?.decisions?.[side]
    ?? frameRecord?.metadata?.decisions?.[index]
    ?? null;
  const plan = source?.lastPlan ?? source?.plan ?? source?.planner?.lastPlan ?? source;
  const intent = plan?.intent ?? source?.intent ?? null;
  const reason = plan?.reason ?? source?.reason ?? null;
  return {
    intent: intent != null && String(intent).trim() ? String(intent) : "不可用",
    reason: reason != null && String(reason).trim() ? String(reason) : "本帧没有 AI 决策元数据",
  };
}

function setReplayAvailability(available) {
  for (const button of [replayButton, resultReplayButton]) {
    if (!button) continue;
    button.disabled = !available;
    button.classList.toggle("is-ready", available);
  }
}

function renderReplayMarkers(events, totalFrames) {
  if (!replayMarkers) return;
  replayMarkers.replaceChildren();
  if (!Array.isArray(events) || totalFrames <= 0) return;
  const fragment = document.createDocumentFragment();
  const seen = new Set();
  for (const event of events) {
    const style = replayEventStyle(event);
    if (style === "other") continue;
    const frame = Math.min(totalFrames, replayEventFrame(event));
    const identity = `${frame}:${style}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const marker = document.createElement("span");
    marker.className = `replay-marker is-${style}`;
    marker.style.left = `${(frame / totalFrames) * 100}%`;
    marker.title = `F${frame} · ${replayEventLabel(event)}`;
    fragment.append(marker);
  }
  replayMarkers.append(fragment);
}

function renderReplayEvents(events, currentFrame) {
  if (!replayEventList) return;
  const source = Array.isArray(events) ? events : [];
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (replayEventFrame(source[middle]) <= currentFrame) low = middle + 1;
    else high = middle;
  }
  const visible = source.slice(Math.max(0, low - 7), low);
  const currentEvent = visible.some((event) => replayEventFrame(event) === currentFrame) ? currentFrame : "";
  const renderKey = `${visible.map((event) => `${replayEventFrame(event)}:${event.type}:${event.outcome ?? ""}`).join("|")}|${currentEvent}`;
  if (renderKey === replayEventRenderKey) return;
  replayEventRenderKey = renderKey;
  replayEventList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "is-empty";
    empty.textContent = "当前帧附近没有战斗事件";
    replayEventList.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const event of visible) {
    const frame = replayEventFrame(event);
    const item = document.createElement("li");
    item.classList.toggle("is-current", frame === currentFrame);
    const frameNode = document.createElement("b");
    frameNode.textContent = `F${frame}`;
    const label = document.createElement("span");
    label.textContent = replayEventLabel(event);
    item.append(frameNode, label);
    fragment.append(item);
  }
  replayEventList.append(fragment);
}

function updateReplayInspector({ replayGame, frameRecord, currentFrame = 0, totalFrames = 0, events = [] } = {}) {
  const fighters = replayGame?.fighters ?? [];
  const left = fighters[0] ?? {};
  const right = fighters[1] ?? {};
  const inputs = frameRecord?.inputs ?? frameRecord?.input ?? {};
  const p1 = inputs.p1 ?? frameRecord?.p1 ?? {};
  const p2 = inputs.p2 ?? frameRecord?.p2 ?? {};
  const leftDecision = replayDecision(frameRecord, 0);
  const rightDecision = replayDecision(frameRecord, 1);

  if (replayFrameLabel) replayFrameLabel.textContent = `FRAME ${currentFrame} / ${totalFrames}`;
  if (replayTimeLabel) replayTimeLabel.textContent = `${replayClock(currentFrame)} / ${replayClock(totalFrames)}`;
  if (replayTimeline) replayTimeline.value = String(Math.min(totalFrames, Math.max(0, currentFrame)));
  if (replayLeftName) replayLeftName.textContent = left.name ?? "P1";
  if (replayRightName) replayRightName.textContent = right.name ?? "P2";
  if (replayLeftHealth) replayLeftHealth.textContent = Number.isFinite(Number(left.health))
    ? `${Math.round(Number(left.health))}/${Math.round(Number(left.maxHealth ?? left.health))}` : "不可用";
  if (replayRightHealth) replayRightHealth.textContent = Number.isFinite(Number(right.health))
    ? `${Math.round(Number(right.health))}/${Math.round(Number(right.maxHealth ?? right.health))}` : "不可用";
  if (replayLeftResource) replayLeftResource.textContent = replayResourceLabel(left);
  if (replayRightResource) replayRightResource.textContent = replayResourceLabel(right);
  if (replayLeftInput) replayLeftInput.textContent = replayInputLabel(p1);
  if (replayRightInput) replayRightInput.textContent = replayInputLabel(p2);
  if (replayLeftIntent) replayLeftIntent.textContent = leftDecision.intent;
  if (replayRightIntent) replayRightIntent.textContent = rightDecision.intent;
  if (replayLeftReason) replayLeftReason.textContent = leftDecision.reason;
  if (replayRightReason) replayRightReason.textContent = rightDecision.reason;
  renderReplayEvents(events, currentFrame);
}

function replayAgentDecision(agent) {
  if (!agent?.getDebugState) return undefined;
  const debugState = agent.getDebugState();
  const plan = debugState?.lastPlan ?? debugState?.planner?.lastPlan ?? null;
  const decision = { agent: String(agent.name ?? "SCRIPT AI") };
  if (plan?.intent != null) decision.intent = String(plan.intent);
  if (plan?.reason != null) decision.reason = String(plan.reason);
  if (plan?.moveId != null) decision.moveId = String(plan.moveId);
  if (Number.isFinite(Number(plan?.score))) decision.score = Number(plan.score);
  if (Number.isFinite(Number(debugState?.observedFrame))) decision.observedFrame = Number(debugState.observedFrame);
  return decision;
}

function currentReplayDecisions() {
  const decisions = {};
  if (activeMatchConfig?.mode === "ai-vs-ai") {
    const p1 = replayAgentDecision(leftScriptAI);
    if (p1) decisions.p1 = p1;
  }
  const p2 = replayAgentDecision(rightScriptAI);
  if (p2) decisions.p2 = p2;
  return Object.keys(decisions).length ? decisions : undefined;
}

function refreshReplayAvailability() {
  setReplayAvailability(Boolean(lastReplay) && !playing && !replayMode && !isTodShowcase());
}

function beginReplayRecording() {
  activeReplayRecorder = null;
  if (!game || isTodShowcase()) {
    refreshReplayAvailability();
    return;
  }
  try {
    activeReplayRecorder = createReplayRecorder(game, {
      seed: activeMatchSeeds.right,
      rules: { mode: activeMatchConfig?.mode ?? "human-vs-ai" },
      metadata: {
        matchConfig: { ...activeMatchConfig },
        seeds: { ...activeMatchSeeds },
        participants: [activeLeftName(), activeRightName()],
        recordedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Unable to start replay recording", error);
  }
  refreshReplayAvailability();
}

function finishReplayRecording(reason = "stopped") {
  const recorder = activeReplayRecorder;
  activeReplayRecorder = null;
  if (!recorder || recorder.isFinalized) {
    refreshReplayAvailability();
    return lastReplay;
  }
  try {
    const replay = recorder.finish({ reason });
    if (recorder.frameCount > 0) lastReplay = replay;
  } catch (error) {
    console.error("Unable to finalize replay recording", error);
    if (statusNode && !playing) statusNode.textContent = "录像保存失败 · 可继续开始新对局";
  }
  refreshReplayAvailability();
  return lastReplay;
}

function replayTimelineEvents(data) {
  const events = (data?.events ?? []).map((record) => ({
    ...record.event,
    replayCursor: record.cursor,
  }));
  const frames = data?.frames ?? [];
  frames.forEach((frame, index) => {
    if (frame.advanceRound && index > 0) {
      events.push({ type: "KO", roundTransition: true, replayCursor: index + 1 });
    }
  });
  if (data?.end?.completed && frames.length > 0) {
    events.push({ type: "KO", matchEnd: true, replayCursor: frames.length });
  }
  return events.sort((left, right) => replayEventFrame(left) - replayEventFrame(right));
}

function setReplayPlayback(value) {
  replayPlaying = Boolean(value) && Boolean(replayPlayer) && replayPlayer.cursor < replayPlayer.totalFrames;
  if (replayPlayButton) replayPlayButton.textContent = replayPlaying ? "Ⅱ" : "▶";
  if (pauseButton) pauseButton.textContent = replayPlaying ? "Ⅱ" : "▶";
  replayAccumulator = 0;
  lastTime = performance.now();
}

function applyReplayStatus(status, { audible = false } = {}) {
  if (!status || !replayPlayer) return;
  game = status.game;
  if (audible) processEffects();
  const cursor = status.cursor ?? replayPlayer.cursor;
  const totalFrames = status.totalFrames ?? replayPlayer.totalFrames;
  const frameRecord = status.currentFrame ?? replayPlayer.currentFrame;
  updateReplayInspector({
    replayGame: game,
    frameRecord,
    currentFrame: cursor,
    totalFrames,
    events: replayEvents,
  });
  const ended = cursor >= totalFrames;
  if (ended) {
    replayPlaying = false;
    if (replayPlayButton) replayPlayButton.textContent = "▶";
    if (pauseButton) pauseButton.textContent = "▶";
  }
  const stateLabel = ended ? "复盘结束" : replayPlaying ? `${replaySpeed}× 播放中` : "已暂停";
  if (replayStatusNode) replayStatusNode.textContent = `${stateLabel} · F${cursor}/${totalFrames}`;
  if (statusNode) statusNode.textContent = `战斗复盘 · ${stateLabel} · F${cursor}/${totalFrames}`;
}

function seekReplay(targetCursor) {
  if (!replayPlayer) return;
  const target = Math.min(replayPlayer.totalFrames, Math.max(0, Math.round(Number(targetCursor) || 0)));
  try {
    effectCursor = new Set();
    applyReplayStatus(replayPlayer.seek(target));
  } catch (error) {
    setReplayPlayback(false);
    if (replayStatusNode) replayStatusNode.textContent = `校验失败 · ${error.message}`;
    if (statusNode) statusNode.textContent = "复盘校验失败";
    console.error("Replay seek failed", error);
  }
}

function stepReplay(direction = 1) {
  if (!replayPlayer) return;
  setReplayPlayback(false);
  if (direction < 0) {
    seekReplay(replayPlayer.cursor - 1);
    return;
  }
  try {
    applyReplayStatus(replayPlayer.step(), { audible: true });
  } catch (error) {
    if (replayStatusNode) replayStatusNode.textContent = `校验失败 · ${error.message}`;
    if (statusNode) statusNode.textContent = "复盘校验失败";
    console.error("Replay step failed", error);
  }
}

function enterReplay() {
  if (!lastReplay || playing || replayMode) return;
  clearResultRevealTimer();
  try {
    replayPlayer = createReplayPlayer(lastReplay);
  } catch (error) {
    if (statusNode) statusNode.textContent = `录像无法载入 · ${error.message}`;
    console.error("Unable to load replay", error);
    return;
  }
  replayReturnState = {
    game,
    playing,
    paused,
    activeMatchConfig,
    todDirector,
    lastPhase,
    roundAdvanceAt,
    effectCursor,
    statusText: statusNode?.textContent ?? "",
    startVisible: startOverlay.classList.contains("visible"),
    matchVisible: matchOverlay.classList.contains("visible"),
    showcaseActive: gameWrap.classList.contains("showcase-active"),
    statusShowcase: statusNode.classList.contains("showcase"),
  };
  replayMode = true;
  replaySpeed = Number(replaySpeedSelect?.value) || 1;
  replayEvents = replayTimelineEvents(replayPlayer.data);
  replayEventRenderKey = "";
  game = replayPlayer.game;
  playing = false;
  paused = false;
  effectCursor = new Set();
  startOverlay.classList.remove("visible");
  matchOverlay.classList.remove("visible");
  roundBanner.classList.remove("visible");
  gameWrap.classList.remove("showcase-active");
  gameWrap.classList.add("replay-active");
  statusNode.classList.remove("showcase");
  document.body.classList.add("replay-mode");
  replayPanel.hidden = false;
  if (replayTimeline) {
    replayTimeline.min = "0";
    replayTimeline.max = String(replayPlayer.totalFrames);
    replayTimeline.value = "0";
  }
  renderReplayMarkers(replayEvents, replayPlayer.totalFrames);
  setReplayPlayback(false);
  applyReplayStatus(replayPlayer.reset());
  refreshReplayAvailability();
}

function exitReplay() {
  if (!replayMode) return;
  setReplayPlayback(false);
  replayMode = false;
  replayPlayer = null;
  replayEvents = [];
  replayEventRenderKey = "";
  replayPanel.hidden = true;
  gameWrap.classList.remove("replay-active");
  document.body.classList.remove("replay-mode");
  const previous = replayReturnState;
  replayReturnState = null;
  if (previous) {
    game = previous.game;
    playing = previous.playing;
    paused = previous.paused;
    activeMatchConfig = previous.activeMatchConfig;
    todDirector = previous.todDirector;
    lastPhase = previous.lastPhase;
    roundAdvanceAt = previous.roundAdvanceAt;
    effectCursor = previous.effectCursor;
    statusNode.textContent = previous.statusText;
    startOverlay.classList.toggle("visible", previous.startVisible);
    matchOverlay.classList.toggle("visible", previous.matchVisible);
    gameWrap.classList.toggle("showcase-active", previous.showcaseActive);
    statusNode.classList.toggle("showcase", previous.statusShowcase);
  }
  keyboard.clear();
  accumulator = 0;
  replayAccumulator = 0;
  lastTime = performance.now();
  pauseButton.textContent = paused ? "▶" : "Ⅱ";
  if (activeMatchConfig) applyActiveModePresentation();
  else updateAgentDescription();
  refreshReplayAvailability();
}

function updateReplayPlayback(elapsed) {
  if (!replayMode || !replayPlayer || !replayPlaying) return;
  replayAccumulator += elapsed * replaySpeed;
  let steps = 0;
  let status = null;
  try {
    while (replayAccumulator >= TICK_MS && steps < MAX_STEPS * 2 && replayPlayer.cursor < replayPlayer.totalFrames) {
      status = replayPlayer.step();
      replayAccumulator -= TICK_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS * 2) replayAccumulator = 0;
    if (status) applyReplayStatus(status, { audible: true });
  } catch (error) {
    setReplayPlayback(false);
    if (replayStatusNode) replayStatusNode.textContent = `校验失败 · ${error.message}`;
    if (statusNode) statusNode.textContent = "复盘校验失败";
    console.error("Replay playback failed", error);
  }
}

function clearResultRevealTimer() {
  if (!resultRevealTimer) return;
  clearTimeout(resultRevealTimer);
  resultRevealTimer = 0;
}

function revealMatchOverlay(delay = 0) {
  clearResultRevealTimer();
  if (delay <= 0) {
    matchOverlay.classList.add("visible");
    return;
  }
  const scheduledGame = game;
  resultRevealTimer = window.setTimeout(() => {
    resultRevealTimer = 0;
    if (game === scheduledGame && game?.phase === "matchOver" && isTodShowcase()) {
      matchOverlay.classList.add("visible");
    }
  }, delay);
}

function presetDescription(key) {
  const custom = customBrowserAgentMetadata(key);
  if (custom?.description) return custom.description;
  const source = AI_PRESETS?.[key];
  if (source?.description) return source.description;
  return {
    balanced: "中距离控场，按局势切换攻防。",
    pressure: "持续接近，用轻击和重击制造压迫。",
    zoner: "保持距离，用飞行物逼迫你冒险。",
  }[key] || "脚本格斗 Agent";
}

function presetName(key) {
  return customBrowserAgentMetadata(key)?.name || AI_PRESETS?.[key]?.name || key || "SCRIPT AI";
}

function templateName(key) {
  return {
    vanguard: "苍流",
    ember: "赤锋",
  }[key] || key || "角色";
}

const MOVE_CATEGORY_ORDER = Object.freeze(["normal", "special", "ex", "super", "throw", "system", "other"]);
const MOVE_CATEGORY_LABELS = Object.freeze({
  normal: "普通技",
  special: "必杀技",
  ex: "EX / OD",
  super: "超必杀",
  throw: "投技",
  system: "系统技",
  other: "其他",
});
const FALLBACK_COMMAND_LABELS = Object.freeze({
  highLight: "LP / LK",
  highHeavy: "HP / HK",
  midLight: "→ + MP",
  midHeavy: "→ + HP",
  lowLight: "↓ + LK",
  lowHeavy: "↓ + HK",
  airLight: "空中 LP / LK",
  airHeavy: "空中 HP / HK",
  fireballLight: "↓ ↘ → + LP",
  fireballHeavy: "↓ ↘ → + HP",
  dragonPunch: "→ ↓ ↘ + HP",
  rekkaLight: "↓ ↘ → + LP",
  rekkaHeavy: "↓ ↘ → + HP",
  airTatsu: "空中 ↓ ↙ ← + HK",
  airHammer: "空中 ↓ + HP / HK",
  throw: "H / LP + LK",
});

function moveCategory(action, move) {
  const authored = String(move?.category ?? move?.group ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (authored.includes("super") || authored.includes("climax")) return "super";
  if (authored === "ex" || authored.includes("overdrive") || authored === "od") return "ex";
  if (authored.includes("throw") || move?.kind === "throw") return "throw";
  if (authored.includes("system") || authored.includes("universal")) return "system";
  if (authored.includes("normal") || authored.includes("command")) return "normal";
  if (authored.includes("special")) return "special";
  const id = String(action).toLowerCase();
  if (id.includes("super") || id.includes("climax")) return "super";
  if (id.includes("ex") || id.includes("overdrive")) return "ex";
  if (id.includes("throw")) return "throw";
  if (/^(high|mid|low|air)(light|heavy)$/.test(id)) return "normal";
  if (/^(stand|crouch|jump|air|close|far)(lp|mp|hp|lk|mk|hk)/.test(id)) return "normal";
  if (move?.kind === "strike" || move?.kind === "projectile") return "special";
  return "other";
}

function commandLabelFor(action, move) {
  const label = move?.commandLabel ?? move?.input?.label ?? move?.command?.label;
  if (label != null && String(label).trim()) return String(label);
  return FALLBACK_COMMAND_LABELS[action] ?? String(action);
}

function resourceLabelFor(move) {
  const explicit = move?.resourceLabel ?? move?.resource?.label;
  if (explicit != null && String(explicit).trim()) return String(explicit);
  const cost = move?.resourceCost ?? move?.cost;
  if (Number.isFinite(cost) && cost > 0) return `消耗 ${cost}`;
  if (cost && typeof cost === "object") {
    const amount = cost.amount ?? cost.value;
    const name = cost.resource ?? cost.type ?? cost.name ?? "资源";
    if (Number.isFinite(amount) && amount > 0) return `${name} ${amount}`;
  }
  return "";
}

function activeWindowLabel(move) {
  const windows = Array.isArray(move?.activeWindows)
    ? move.activeWindows
      .map((window) => ({ start: Number(window?.start), end: Number(window?.end) }))
      .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
      .sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  if (windows.length === 0) return Number.isFinite(move?.activeFrameCount)
    ? String(move.activeFrameCount)
    : String(move?.active ?? "–");
  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end + 1) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged.map((window, index) => {
    const duration = Math.max(1, window.end - window.start + 1);
    if (index === 0) return String(duration);
    const gap = Math.max(0, window.start - merged[index - 1].end - 1);
    return `${gap > 0 ? `(${gap})` : ""}${duration}`;
  }).join("");
}

function frameLabelFor(move) {
  const startup = Number(move?.startup);
  const recovery = Number(move?.recovery);
  if (!Number.isFinite(startup) || !Number.isFinite(recovery)) return "";
  const landingRecovery = Number(move?.landingRecovery ?? move?.landRecovery);
  const recoveryLabel = landingRecovery > 0
    ? `${recovery}+L${landingRecovery}`
    : String(recovery);
  return `S${startup} · A${activeWindowLabel(move)} · R${recoveryLabel}`;
}

function renderMoveDataList(config = readMatchConfig()) {
  if (!moveDataList) return;
  moveDataList.replaceChildren();
  const templateIds = [...new Set([config.leftTemplate, config.rightTemplate])]
    .filter((templateId) => MOVESETS?.[templateId] && typeof MOVESETS[templateId] === "object");

  if (templateIds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "move-data-empty";
    empty.textContent = "暂无可用出招数据";
    moveDataList.append(empty);
    return;
  }

  for (const templateId of templateIds) {
    const section = document.createElement("section");
    section.className = `move-data-template ${templateId === "ember" ? "is-ember" : "is-vanguard"}`;
    const heading = document.createElement("h3");
    heading.textContent = `${templateName(templateId)} · ${String(templateId).toUpperCase()}`;
    section.append(heading);

    const groups = new Map();
    const authoredMoves = MOVESETS[templateId].moves ?? MOVESETS[templateId];
    for (const [action, move] of Object.entries(authoredMoves)) {
      if (!move || typeof move !== "object") continue;
      const category = moveCategory(action, move);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push({ action, move });
    }

    for (const category of MOVE_CATEGORY_ORDER) {
      const moves = groups.get(category);
      if (!moves?.length) continue;
      moves.sort((a, b) => {
        const orderA = Number.isFinite(a.move?.order) ? a.move.order : Number.MAX_SAFE_INTEGER;
        const orderB = Number.isFinite(b.move?.order) ? b.move.order : Number.MAX_SAFE_INTEGER;
        return orderA - orderB || a.action.localeCompare(b.action);
      });
      const group = document.createElement("div");
      group.className = "move-data-group";
      const label = document.createElement("h4");
      label.textContent = MOVE_CATEGORY_LABELS[category] ?? MOVE_CATEGORY_LABELS.other;
      group.append(label);

      for (const { action, move } of moves) {
        const row = document.createElement("div");
        row.className = "move-data-row";
        const command = document.createElement("code");
        command.textContent = commandLabelFor(action, move);
        const details = document.createElement("span");
        details.className = "move-data-details";
        const name = document.createElement("strong");
        name.textContent = String(move.name ?? action);
        const meta = document.createElement("small");
        meta.textContent = [frameLabelFor(move), resourceLabelFor(move)].filter(Boolean).join(" · ");
        details.append(name);
        if (meta.textContent) details.append(meta);
        row.append(command, details);
        group.append(row);
      }
      section.append(group);
    }
    moveDataList.append(section);
  }
}

function selectedMode() {
  return modeSelect?.value === "ai-vs-ai" ? "ai-vs-ai" : "human-vs-ai";
}

function isTodShowcase(config = activeMatchConfig) {
  return config?.showcase === "ember-tod";
}

function readMatchConfig() {
  const mode = selectedMode();
  return {
    mode,
    showcase: null,
    leftTemplate: leftTemplateSelect?.value || "vanguard",
    rightTemplate: rightTemplateSelect?.value || "ember",
    leftPreset: mode === "ai-vs-ai" ? (leftAgentSelect?.value || "balanced") : null,
    rightPreset: agentSelect?.value || "balanced",
    difficulty: difficultySelect?.value || "normal",
    delay: Number(delaySelect?.value) || 0,
    bestOf: 3,
    roundTimeSeconds: 60,
  };
}

function sameMatchConfig(a, b) {
  return Boolean(
    a && b &&
    a.mode === b.mode &&
    a.showcase === b.showcase &&
    a.leftTemplate === b.leftTemplate &&
    a.rightTemplate === b.rightTemplate &&
    a.leftPreset === b.leftPreset &&
    a.rightPreset === b.rightPreset &&
    a.difficulty === b.difficulty &&
    a.delay === b.delay &&
    a.bestOf === b.bestOf &&
    a.roundTimeSeconds === b.roundTimeSeconds
  );
}

function createSelectedAI(preset, seed, config, templateId) {
  return createBrowserAgent(preset, {
    templateId,
    difficulty: config.difficulty,
    observationDelayFrames: config.delay,
    seed,
  });
}

function resetMatchAgents(options) {
  const resetAgent = (agent, selfIndex, seed) => {
    if (!agent) return;
    if (typeof agent.resetForMatch === "function") {
      if (!options?.preserveAdaptation) agent.resetForMatch(game, selfIndex, { seed });
      return;
    }
    agent.reset?.(options);
  };
  resetAgent(leftScriptAI, 0, activeMatchSeeds.left);
  resetAgent(rightScriptAI, 1, activeMatchSeeds.right);
}

function activeLeftName() {
  if (isTodShowcase()) return "赤锋 · TOD SCRIPT";
  return activeMatchConfig?.mode === "ai-vs-ai"
    ? (leftScriptAI?.name || game?.fighters?.[0]?.name || "LEFT AI")
    : "YOU";
}

function activeRightName() {
  if (isTodShowcase()) return "训练假人";
  return rightScriptAI?.name || game?.fighters?.[1]?.name || "SCRIPT AI";
}

function runtimeStatusText() {
  if (isTodShowcase()) return "真实十割表演赛 · 逐击验真中";
  const delay = activeMatchConfig?.delay ?? 0;
  if (activeMatchConfig?.mode === "ai-vs-ai") {
    return `${activeLeftName()} vs ${activeRightName()} · ${delay}F 延迟 · 观战中`;
  }
  return `${activeRightName()} · ${delay}F 延迟`;
}

function applyActiveModePresentation(mode = activeMatchConfig?.mode) {
  const showcase = isTodShowcase();
  const spectator = mode === "ai-vs-ai" || showcase;
  controlsPanel?.classList.toggle("spectator", spectator);
  if (controlsTitle) controlsTitle.textContent = showcase ? "十割路线导演" : spectator ? "AI 对战观战" : "玩家控制";
  if (controlsSide) controlsSide.textContent = showcase ? "TRUE TOD" : spectator ? "AI vs AI" : "YOU · LEFT SIDE";
  if (controlsModeNote) {
    controlsModeNote.textContent = showcase
      ? "固定满血、满资源与角落条件；每一帧仍通过真实控制器输入。"
      : spectator
      ? "双方均由独立脚本 Agent 逐帧决策。"
      : "左侧使用键盘，右侧由脚本 Agent 控制。";
  }
}

function createFreshGame(config = readMatchConfig(), matchSeeds = browserMatchSeedSequence.next()) {
  activeMatchConfig = { ...config };
  activeMatchSeeds = matchSeeds;
  todDirector = null;
  gameWrap.classList.remove("showcase-active");
  statusNode.classList.remove("showcase");
  if (rematchButton) rematchButton.textContent = "再来一局";
  if (changeAgentButton) changeAgentButton.textContent = "换个 Agent";
  rightScriptAI = createSelectedAI(config.rightPreset, matchSeeds.right, config, config.rightTemplate);
  leftScriptAI = config.mode === "ai-vs-ai"
    ? createSelectedAI(config.leftPreset, matchSeeds.left, config, config.leftTemplate)
    : null;
  game = createGame({
    bestOf: config.bestOf ?? 3,
    roundTimeSeconds: config.roundTimeSeconds ?? 60,
    playerName: config.mode === "ai-vs-ai" ? (leftScriptAI?.name || "LEFT AI") : "YOU",
    aiName: rightScriptAI?.name || "SCRIPT AI",
    playerTemplate: config.leftTemplate,
    aiTemplate: config.rightTemplate,
  });
  resetMatchAgents();
  effectCursor = new Set();
  lastPhase = game.phase || "ready";
  roundAdvanceAt = 0;
  applyActiveModePresentation();
  renderer.flash?.("ROUND 1", "#ffffff");
}

function createFreshTodExhibition() {
  const config = {
    mode: "tod-exhibition",
    showcase: "ember-tod",
    leftTemplate: "ember",
    rightTemplate: "ember",
    leftPreset: null,
    rightPreset: null,
    difficulty: "expert",
    delay: 0,
    bestOf: 1,
    roundTimeSeconds: 30,
  };
  activeMatchConfig = config;
  leftScriptAI = null;
  rightScriptAI = null;
  game = createGame({
    bestOf: 1,
    roundTimeSeconds: 30,
    playerName: "赤锋 · TOD SCRIPT",
    aiName: "训练假人",
    playerTemplate: "ember",
    aiTemplate: "ember",
  });
  prepareTodExhibition(game);
  todDirector = createTodExhibitionDirector();
  effectCursor = new Set();
  lastPhase = game.phase || "ready";
  roundAdvanceAt = 0;
  gameWrap.classList.add("showcase-active");
  statusNode.classList.add("showcase");
  if (rematchButton) rematchButton.textContent = "重播十割";
  if (changeAgentButton) changeAgentButton.textContent = "返回大厅";
  if (todRouteNode) todRouteNode.textContent = TOD_EXHIBITION_ROUTE_LABEL;
  applyActiveModePresentation();
  updateTodShowcaseHud();
}

function updateTodShowcaseHud() {
  if (!isTodShowcase() || !todDirector || !game) return;
  const state = todDirector.status(game);
  if (todStepNode) todStepNode.textContent = state.success ? "十割成立 · VERIFIED" : state.label;
  if (todHitsNode) todHitsNode.textContent = `${state.hits} HIT`;
  if (todDamageNode) todDamageNode.textContent = `${state.damage} / ${game.fighters[1].maxHealth} DAMAGE`;
  if (todVerdictNode) {
    todVerdictNode.textContent = state.success
      ? "✓ 自然伤害 · 无强制补伤"
      : state.stage === "failed" ? `✕ ${state.failedReason || state.reason}` : "标准伤害验算中";
  }
}

function showBanner(message, duration = 850) {
  clearTimeout(bannerTimer);
  roundBanner.textContent = message;
  roundBanner.classList.add("visible");
  bannerTimer = setTimeout(() => roundBanner.classList.remove("visible"), duration);
}

function startMatch() {
  audio.unlock();
  clearResultRevealTimer();
  finishReplayRecording("new-match");
  createFreshGame(readMatchConfig());
  playing = true;
  paused = false;
  accumulator = 0;
  lastTime = performance.now();
  startOverlay.classList.remove("visible");
  matchOverlay.classList.remove("visible");
  pauseButton.textContent = "Ⅱ";
  statusNode.textContent = runtimeStatusText();
  keyboard.clear();
  showBanner("FIGHT", 950);
  audio.play("round");
  beginReplayRecording();
}

function startTodExhibition() {
  audio.unlock();
  clearResultRevealTimer();
  finishReplayRecording("tod-exhibition");
  createFreshTodExhibition();
  playing = true;
  paused = false;
  accumulator = 0;
  lastTime = performance.now();
  startOverlay.classList.remove("visible");
  matchOverlay.classList.remove("visible");
  pauseButton.textContent = "Ⅱ";
  statusNode.textContent = runtimeStatusText();
  keyboard.clear();
  showBanner("TRUE TOD", 1200);
  audio.play("round");
  refreshReplayAvailability();
}

function restart() {
  audio.unlock();
  clearResultRevealTimer();
  if (isTodShowcase()) return startTodExhibition();
  if (!game) return startMatch();
  finishReplayRecording("restart");
  const selectedConfig = readMatchConfig();
  createFreshGame(selectedConfig);
  playing = true;
  paused = false;
  accumulator = 0;
  lastTime = performance.now();
  pauseButton.textContent = "Ⅱ";
  statusNode.textContent = runtimeStatusText();
  matchOverlay.classList.remove("visible");
  startOverlay.classList.remove("visible");
  keyboard.clear();
  roundAdvanceAt = 0;
  lastPhase = game.phase;
  showBanner("FIGHT", 850);
  beginReplayRecording();
}

function togglePause(force) {
  if (replayMode && replayPlayer) {
    if (!replayPlaying && replayPlayer.cursor >= replayPlayer.totalFrames) seekReplay(0);
    const shouldPause = typeof force === "boolean" ? force : replayPlaying;
    setReplayPlayback(!shouldPause);
    applyReplayStatus({
      game: replayPlayer.game,
      cursor: replayPlayer.cursor,
      totalFrames: replayPlayer.totalFrames,
      currentFrame: replayPlayer.currentFrame,
    });
    return;
  }
  if (!playing || game?.phase === "matchOver") return;
  paused = typeof force === "boolean" ? force : !paused;
  pauseButton.textContent = paused ? "▶" : "Ⅱ";
  statusNode.textContent = paused ? `已暂停 · ${runtimeStatusText()}` : runtimeStatusText();
  if (!paused) lastTime = performance.now();
}

function toggleDebug() {
  debug = !debug;
  renderer.setDebug?.(debug);
  debugButton.classList.toggle("active", debug);
}

function toggleSound() {
  audio.setEnabled(!audio.enabled);
  soundButton.classList.toggle("active", audio.enabled);
}

function updateAgentDescription() {
  const pending = readMatchConfig();
  if (isTodShowcase()) {
    agentDescription.textContent = `真实十割表演 · ${TOD_EXHIBITION_ROUTE_LABEL}`;
    renderMoveDataList({ leftTemplate: "ember", rightTemplate: "ember" });
    applyActiveModePresentation();
    return;
  }
  const spectator = pending.mode === "ai-vs-ai";
  if (leftAgentRow) {
    leftAgentRow.hidden = !spectator;
    leftAgentRow.classList.toggle("is-hidden", !spectator);
    leftAgentRow.classList.toggle("visible", spectator);
  }
  if (rightAgentLabel) rightAgentLabel.textContent = spectator ? "右侧 Agent" : "对手 Agent";
  if (leftTemplateLabel) leftTemplateLabel.textContent = spectator ? "左侧模板" : "玩家模板";
  if (rightTemplateLabel) rightTemplateLabel.textContent = spectator ? "右侧模板" : "对手模板";

  const templateMatchup = `${templateName(pending.leftTemplate)} vs ${templateName(pending.rightTemplate)}`;

  if (spectator) {
    agentDescription.textContent = `${templateMatchup} · ${presetName(pending.leftPreset)} vs ${presetName(pending.rightPreset)}`;
  } else {
    agentDescription.textContent = `${templateMatchup} · ${presetDescription(pending.rightPreset)}`;
  }
  renderMoveDataList(pending);

  const pendingChange = playing && !sameMatchConfig(pending, activeMatchConfig);
  if (pendingChange) {
    if (controlsModeNote) controlsModeNote.textContent = "设置已更新，将在下一局或重新开始后生效。";
  } else if (!playing) {
    applyActiveModePresentation(pending.mode);
  } else {
    applyActiveModePresentation();
  }
}

function effectIdentity(effect, index) {
  return effect?.id ?? `${effect?.type || "fx"}:${effect?.frame ?? game?.frame}:${index}`;
}

function processEffects() {
  const current = game?.events || game?.frameEvents || game?.effects || [];
  const nextCursor = new Set();
  current.forEach((event, index) => {
    const id = effectIdentity(event, index);
    nextCursor.add(id);
    if (effectCursor.has(id)) return;
    const type = String(event?.type || event?.kind || "").toLowerCase();
    const compactType = type.replace(/[^a-z0-9]/g, "");
    if (compactType.includes("super")) { audio.play("heavy"); renderer.shake?.(12); }
    else if (compactType.includes("groundbounce") || compactType.includes("wallbounce")) { audio.play("heavy"); renderer.shake?.(10); }
    else if (compactType.includes("punishcounter") || compactType.includes("counter")) { audio.play("heavy"); renderer.shake?.(8); }
    else if (compactType === "ex" || compactType.startsWith("ex") || compactType.includes("overdrive")) { audio.play("heavy"); renderer.shake?.(7); }
    else if (type.includes("block")) audio.play("block");
    else if (type.includes("throw") && (type.includes("whiff") || type.includes("miss"))) audio.play("whiff");
    else if (type.includes("throw")) { audio.play("throw"); renderer.shake?.(7); }
    else if (type.includes("dragon") || type.includes("uppercut") || type.includes("rising")) { audio.play("dragon"); renderer.shake?.(6); }
    else if (type.includes("projectile") || type.includes("fireball") || type.includes("muzzle")) audio.play("projectile");
    else if (type.includes("heavy")) { audio.play("heavy"); renderer.shake?.(8); }
    else if (type.includes("hit")) { audio.play("hit"); renderer.shake?.(4); }
    else if (type.includes("jump")) audio.play("jump");
    else if (type.includes("ko")) { audio.play("ko"); renderer.shake?.(12); }
  });
  effectCursor = nextCursor;
}

function winnerIndex(value) {
  if (value === 0 || value === "p1" || value === "player" || value === "left") return 0;
  if (value === 1 || value === "p2" || value === "ai" || value === "right") return 1;
  return -1;
}

function winnerName(value) {
  const index = winnerIndex(value);
  if (index === 0) return game?.fighters?.[0]?.name || activeLeftName();
  if (index === 1) return game?.fighters?.[1]?.name || activeRightName();
  return "DRAW";
}

function handlePhase(now) {
  const phase = game?.phase || "fight";
  if (phase !== lastPhase) {
    if (phase === "roundOver") {
      const index = winnerIndex(game.roundWinner);
      const winner = winnerName(game.roundWinner);
      const message = isTodShowcase()
        ? "100% DAMAGE"
        : activeMatchConfig?.mode === "ai-vs-ai"
        ? (winner === "DRAW" ? "DRAW" : `${winner} WINS`)
        : (index === 0 ? "ROUND WON" : index < 0 ? "DRAW" : "ROUND LOST");
      showBanner(message, 1200);
      roundAdvanceAt = now + 1650;
    } else if (phase === "matchOver") {
      const index = winnerIndex(game.matchWinner ?? game.winner);
      const winner = winnerName(game.matchWinner ?? game.winner);
      playing = false;
      finishReplayRecording("match-complete");
      if (isTodShowcase()) {
        const proof = evaluateTodExhibition(game);
        resultKicker.textContent = proof.success ? "TRUE TOD EXHIBITION · VERIFIED" : "TOD EXHIBITION · FAILED";
        resultTitle.textContent = proof.success ? `${proof.hits} HIT · 100%` : "十割未成立";
        resultCopy.textContent = proof.success
          ? `${TOD_EXHIBITION_ROUTE_LABEL}；${proof.damage}/${proof.maxHealth} 实际伤害。满血起手、连段未断、资源合法，逐击均为标准伤害，无动态补血量。`
          : `${proof.damage}/${proof.maxHealth} 实际伤害：${proof.reason}。本局不会把普通 KO 冒充十割。`;
        statusNode.textContent = proof.success ? "真实十割成立 · 无强制补伤" : "十割表演失败";
        updateTodShowcaseHud();
      } else if (activeMatchConfig?.mode === "ai-vs-ai") {
        resultKicker.textContent = winner === "DRAW" ? "AI EXHIBITION · DRAW" : "AI EXHIBITION · MATCH COMPLETE";
        resultTitle.textContent = winner === "DRAW" ? "两名 Agent 战成平局" : `${winner} 获胜`;
        resultCopy.textContent = `${activeLeftName()} ${game.score?.[0] ?? 0} : ${game.score?.[1] ?? 0} ${activeRightName()}。更换双方风格、难度或观测延迟可开始下一场模拟。`;
        statusNode.textContent = winner === "DRAW" ? "AI 对战结束 · 平局" : `AI 对战结束 · ${winner} 获胜`;
      } else {
        resultKicker.textContent = index === 0 ? "HUMAN WINS" : winner === "DRAW" ? "DRAW" : "SCRIPT WINS";
        resultTitle.textContent = index === 0 ? "你击败了这个 Agent" : winner === "DRAW" ? "势均力敌" : `${activeRightName()} 获胜`;
        resultCopy.textContent = index === 0
          ? "它的脚本已经暴露出弱点。换个风格，或者降低它的观测延迟再试一次。"
          : "观察它的距离选择和出招节奏，再用格挡与挥空惩罚破解脚本。";
        statusNode.textContent = index === 0 ? "比赛结束 · 玩家获胜" : winner === "DRAW" ? "比赛结束 · 平局" : `比赛结束 · ${activeRightName()} 获胜`;
      }
      // Let the terminal impact, KO pose, health bar and 16 HIT counter remain
      // visible before the result card covers the stage.
      revealMatchOverlay(isTodShowcase() ? 720 : 0);
    } else if (phase === "fight" || phase === "fighting") {
      showBanner(`ROUND ${game.round || 1}`, 700);
      audio.play("round");
    }
    lastPhase = phase;
  }

  if (phase === "roundOver" && roundAdvanceAt && now >= roundAdvanceAt) {
    const result = activeReplayRecorder
      ? activeReplayRecorder.advanceRound()
      : nextRound?.(game);
    if (result && result !== game) game = result;
    resetMatchAgents({ preserveAdaptation: true });
    effectCursor = new Set();
    roundAdvanceAt = 0;
    lastPhase = game.phase || "fight";
    showBanner(`ROUND ${game.round || 1}`, 700);
    audio.play("round");
  }
}

function fixedUpdate() {
  if (!playing || paused || !game || game.phase === "matchOver") return;
  const p1 = isTodShowcase()
    ? (todDirector?.next?.(game) || neutralInput())
    : activeMatchConfig?.mode === "ai-vs-ai"
    ? (leftScriptAI?.decide?.(game, 0) || neutralInput())
    : keyboard.sample();
  const p2 = isTodShowcase()
    ? neutralInput()
    : rightScriptAI?.decide?.(game, 1) || neutralInput();
  if (activeReplayRecorder) {
    const decisions = currentReplayDecisions();
    const result = activeReplayRecorder.recordFrame(
      { p1, p2 },
      decisions ? { decisions } : {},
    );
    game = result.game;
  } else {
    const result = stepGame(game, { p1, p2 });
    if (result && result !== game && result.fighters) game = result;
  }
  processEffects();
  if (isTodShowcase()) {
    updateTodShowcaseHud();
    const state = todDirector?.status?.(game);
    if (state?.stage === "failed" && game.phase === "fighting") {
      playing = false;
      resultKicker.textContent = "TOD EXHIBITION · FAILED";
      resultTitle.textContent = "十割未成立";
      resultCopy.textContent = `${state.damage}/${game.fighters[1].maxHealth} 实际伤害：${state.failedReason || state.reason}。未使用强制补伤。`;
      statusNode.textContent = "十割表演失败";
      matchOverlay.classList.add("visible");
    }
  }
}

function frame(now) {
  const elapsed = Math.min(100, now - lastTime);
  lastTime = now;
  if (replayMode) {
    updateReplayPlayback(elapsed);
    // Replay snapshots already represent an exact logic frame. Rendering
    // alpha=0 showed the previous position while BOX mode drew current-frame
    // collision data, creating a permanent one-frame visual offset.
    renderer.render(game, 1);
    requestAnimationFrame(frame);
    return;
  }
  if (!paused) accumulator += elapsed;

  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS) {
    fixedUpdate();
    accumulator -= TICK_MS;
    steps += 1;
  }
  if (steps === MAX_STEPS) accumulator = 0;

  handlePhase(now);
  renderer.render(game, accumulator / TICK_MS);
  requestAnimationFrame(frame);
}

document.querySelector("#start-button").addEventListener("click", startMatch);
todShowButton?.addEventListener("click", startTodExhibition);
document.querySelector("#random-button").addEventListener("click", () => {
  const randomize = (select) => {
    if (!select || select.options.length < 2) return;
    const options = [...select.options];
    const current = options.findIndex((option) => option.value === select.value);
    const offset = 1 + Math.floor(Math.random() * (options.length - 1));
    select.value = options[(current + offset) % options.length].value;
  };
  randomize(agentSelect);
  if (selectedMode() === "ai-vs-ai") randomize(leftAgentSelect);
  updateAgentDescription();
  startMatch();
});
rematchButton.addEventListener("click", () => isTodShowcase() ? startTodExhibition() : startMatch());
changeAgentButton.addEventListener("click", () => {
  clearResultRevealTimer();
  finishReplayRecording("return-to-lobby");
  matchOverlay.classList.remove("visible");
  startOverlay.classList.add("visible");
  playing = false;
  todDirector = null;
  activeMatchConfig = null;
  gameWrap.classList.remove("showcase-active");
  statusNode.classList.remove("showcase");
  if (rematchButton) rematchButton.textContent = "再来一局";
  if (changeAgentButton) changeAgentButton.textContent = "换个 Agent";
  updateAgentDescription();
  statusNode.textContent = "选择模式后开始";
  refreshReplayAvailability();
});
document.querySelector("#restart-button").addEventListener("click", restart);
pauseButton.addEventListener("click", () => togglePause());
soundButton.addEventListener("click", toggleSound);
debugButton.addEventListener("click", toggleDebug);
replayButton?.addEventListener("click", enterReplay);
resultReplayButton?.addEventListener("click", enterReplay);
replayPrevButton?.addEventListener("click", () => stepReplay(-1));
replayPlayButton?.addEventListener("click", () => togglePause());
replayNextButton?.addEventListener("click", () => stepReplay(1));
replayExitButton?.addEventListener("click", exitReplay);
replaySpeedSelect?.addEventListener("change", () => {
  replaySpeed = Number(replaySpeedSelect.value) || 1;
  if (replayPlayer) applyReplayStatus({
    game: replayPlayer.game,
    cursor: replayPlayer.cursor,
    totalFrames: replayPlayer.totalFrames,
    currentFrame: replayPlayer.currentFrame,
  });
});
replayTimeline?.addEventListener("input", () => {
  if (!replayPlayer) return;
  setReplayPlayback(false);
  const preview = Number(replayTimeline.value) || 0;
  if (replayFrameLabel) replayFrameLabel.textContent = `SEEK FRAME ${preview} / ${replayPlayer.totalFrames}`;
  if (replayTimeLabel) replayTimeLabel.textContent = `${replayClock(preview)} / ${replayClock(replayPlayer.totalFrames)}`;
});
replayTimeline?.addEventListener("change", () => seekReplay(Number(replayTimeline.value) || 0));
agentSelect.addEventListener("change", updateAgentDescription);
modeSelect?.addEventListener("change", updateAgentDescription);
leftAgentSelect?.addEventListener("change", updateAgentDescription);
leftTemplateSelect?.addEventListener("change", updateAgentDescription);
rightTemplateSelect?.addEventListener("change", updateAgentDescription);
difficultySelect?.addEventListener("change", updateAgentDescription);
delaySelect?.addEventListener("change", updateAgentDescription);

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (replayMode) {
    if (event.code === "Space" || event.code === "KeyP") {
      event.preventDefault();
      togglePause();
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      stepReplay(-1);
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      stepReplay(1);
    } else if (event.code === "Escape") {
      event.preventDefault();
      exitReplay();
    }
    return;
  }
  if (event.code === "Enter" && startOverlay.classList.contains("visible")) startMatch();
  else if (event.code === "KeyP" || event.code === "Escape") togglePause();
  else if (event.code === "KeyR") restart();
  else if (event.code === "F1") { event.preventDefault(); toggleDebug(); }
});

new ResizeObserver(() => renderer.resize?.()).observe(gameWrap);
updateAgentDescription();
createFreshGame(readMatchConfig(), browserMatchSeedSequence.peek());
statusNode.textContent = runtimeStatusText();
renderer.resize?.();
requestAnimationFrame(frame);
