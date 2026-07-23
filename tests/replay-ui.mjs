import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, main] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/main.js", import.meta.url), "utf8"),
]);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "replay UI must not introduce duplicate DOM ids");

for (const id of [
  "replay-button", "result-replay-button", "replay-panel", "replay-prev-button",
  "replay-play-button", "replay-next-button", "replay-speed-select", "replay-exit-button",
  "replay-timeline", "replay-markers", "replay-event-list", "replay-left-input",
  "replay-right-input", "replay-left-intent", "replay-right-intent",
]) {
  assert(ids.includes(id), `missing replay UI node #${id}`);
}

for (const speed of ["0.25", "0.5", "1", "2"]) {
  assert(html.includes(`value="${speed}"`), `missing replay speed ${speed}x`);
}

assert.match(main, /createReplayRecorder\(game,/u, "live matches must create a replay recorder");
assert.match(main, /activeReplayRecorder\.recordFrame\(/u, "live simulation must advance through the recorder");
assert.match(main, /decisions\s*\?\s*\{ decisions \}/u, "recorded AI decisions must be attached to frames");
assert.match(main, /createReplayPlayer\(lastReplay\)/u, "the last replay must load through the deterministic player");
assert.match(main, /if \(replayMode\) \{\s*updateReplayPlayback\(elapsed\)/u, "replay mode must own the animation-frame branch");
assert.match(main, /replayTimeline\?\.addEventListener\("change"/u, "timeline seeking must be committed on change");
assert.match(css, /@media \(max-width: 560px\)/u, "replay controls need a narrow-screen layout");

process.stdout.write("replay UI smoke ok · controls + inspector + isolated playback branch\n");
