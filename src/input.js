const EMPTY_INPUT = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
  lp: false,
  mp: false,
  hp: false,
  lk: false,
  mk: false,
  hk: false,
  throw: false,
  system1: false,
  system2: false,
  guard: false,
  // Deprecated aliases keep the v0.6 engine and external controller adapters
  // usable while command resolution migrates to the canonical button set.
  light: false,
  heavy: false,
  special: false,
});

const DIRECTION_CODES = Object.freeze([
  "KeyA", "KeyD", "KeyW", "KeyS",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
]);
const ATTACK_CODES = Object.freeze(["KeyU", "KeyI", "KeyO", "KeyJ", "KeyK", "KeyL"]);
const SYSTEM_CODES = Object.freeze(["KeyH", "ShiftLeft", "ShiftRight", "Semicolon"]);

export function createKeyboardInput(target = window) {
  const held = new Set();
  const pressed = new Set();
  const prevented = new Set([...DIRECTION_CODES, ...ATTACK_CODES, ...SYSTEM_CODES, "Space"]);
  const buffered = new Set([...DIRECTION_CODES, ...ATTACK_CODES, ...SYSTEM_CODES]);

  function onKeyDown(event) {
    if (prevented.has(event.code)) event.preventDefault();
    if (!held.has(event.code) && buffered.has(event.code)) pressed.add(event.code);
    held.add(event.code);
  }

  function onKeyUp(event) {
    if (prevented.has(event.code)) event.preventDefault();
    held.delete(event.code);
  }

  function onBlur() {
    held.clear();
    pressed.clear();
  }
  target.addEventListener("keydown", onKeyDown, { passive: false });
  target.addEventListener("keyup", onKeyUp, { passive: false });
  target.addEventListener("blur", onBlur);

  return {
    sample() {
      const active = (...codes) => codes.some((code) => held.has(code) || pressed.has(code));
      const lp = active("KeyU");
      const mp = active("KeyI");
      const hp = active("KeyO");
      const lk = active("KeyJ");
      const mk = active("KeyK");
      const hk = active("KeyL");
      const throwPressed = active("KeyH");
      const input = {
        left: active("KeyA", "ArrowLeft"),
        right: active("KeyD", "ArrowRight"),
        up: active("KeyW", "ArrowUp"),
        down: active("KeyS", "ArrowDown"),
        lp,
        mp,
        hp,
        lk,
        mk,
        hk,
        throw: throwPressed,
        system1: active("ShiftLeft", "ShiftRight"),
        system2: active("Semicolon"),
        guard: held.has("Space"),
        // v0.6 aliases: either light button becomes light, while every medium
        // or heavy button remains a usable heavy attack until the engine's
        // data-driven command resolver takes ownership of all six buttons.
        light: lp || lk,
        heavy: mp || hp || mk || hk,
        special: throwPressed,
      };
      // Keep very short taps alive until the next 60 Hz simulation sample.
      pressed.clear();
      return input;
    },
    clear() {
      held.clear();
      pressed.clear();
    },
    destroy() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

export function neutralInput() { return { ...EMPTY_INPUT }; }
