import assert from "node:assert/strict";
import { createKeyboardInput } from "../src/input.js";

const target = new EventTarget();
const keyboard = createKeyboardInput(target);

function dispatch(type, code) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "code", { value: code });
  target.dispatchEvent(event);
}

// A complete tap between two 60 Hz updates must still survive for one sample.
dispatch("keydown", "KeyK");
dispatch("keyup", "KeyK");
const mediumKickTap = keyboard.sample();
assert.equal(mediumKickTap.mk, true, "K must expose the canonical medium-kick button");
assert.equal(mediumKickTap.heavy, true, "short medium-kick taps must retain the v0.6 heavy alias");
const consumedKickTap = keyboard.sample();
assert.equal(consumedKickTap.mk, false, "buffered canonical taps should be consumed once");
assert.equal(consumedKickTap.heavy, false, "buffered legacy taps should be consumed once");

// All six attack keys must survive as distinct canonical buttons.
for (const [code, button] of [
  ["KeyU", "lp"], ["KeyI", "mp"], ["KeyO", "hp"],
  ["KeyJ", "lk"], ["KeyL", "hk"],
]) {
  dispatch("keydown", code);
  dispatch("keyup", code);
  assert.equal(keyboard.sample()[button], true, `${code} must buffer canonical ${button}`);
  assert.equal(keyboard.sample()[button], false, `${button} must be consumed after one sample`);
}

for (const [code, button, legacy] of [
  ["KeyH", "throw", "special"],
  ["ShiftLeft", "system1", null],
  ["Semicolon", "system2", null],
]) {
  dispatch("keydown", code);
  dispatch("keyup", code);
  const sample = keyboard.sample();
  assert.equal(sample[button], true, `${code} must buffer ${button}`);
  if (legacy) assert.equal(sample[legacy], true, `${code} must retain legacy ${legacy}`);
  assert.equal(keyboard.sample()[button], false, `${button} must be consumed after one sample`);
}

// Direction taps are equally important for motion-command recognition.
dispatch("keydown", "KeyS");
dispatch("keyup", "KeyS");
assert.equal(keyboard.sample().down, true, "short down tap should be buffered");
assert.equal(keyboard.sample().down, false, "direction buffer should be consumed once");

dispatch("keydown", "Space");
assert.equal(keyboard.sample().guard, true, "Space must hold guard");
dispatch("keyup", "Space");
assert.equal(keyboard.sample().guard, false, "guard must release with Space");

keyboard.destroy();
process.stdout.write("input buffer ok\n");
