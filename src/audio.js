export function createAudio() {
  let context = null;
  let enabled = true;

  function ensure() {
    if (!enabled) return null;
    if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === "suspended") context.resume();
    return context;
  }

  function tone({ frequency = 220, endFrequency = frequency, duration = 0.08, type = "square", gain = 0.06 }) {
    const ctx = ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const amp = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(amp).connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  return {
    unlock: ensure,
    setEnabled(value) { enabled = Boolean(value); if (enabled) ensure(); },
    get enabled() { return enabled; },
    play(kind) {
      if (kind === "hit") tone({ frequency: 120, endFrequency: 55, duration: 0.12, type: "sawtooth", gain: 0.09 });
      else if (kind === "heavy") tone({ frequency: 92, endFrequency: 35, duration: 0.18, type: "square", gain: 0.11 });
      else if (kind === "block") tone({ frequency: 420, endFrequency: 180, duration: 0.07, type: "triangle", gain: 0.045 });
      else if (kind === "projectile") tone({ frequency: 180, endFrequency: 640, duration: 0.16, type: "sine", gain: 0.05 });
      else if (kind === "throw") tone({ frequency: 145, endFrequency: 48, duration: 0.22, type: "square", gain: 0.09 });
      else if (kind === "dragon") tone({ frequency: 190, endFrequency: 820, duration: 0.2, type: "sawtooth", gain: 0.075 });
      else if (kind === "whiff") tone({ frequency: 340, endFrequency: 120, duration: 0.07, type: "triangle", gain: 0.025 });
      else if (kind === "jump") tone({ frequency: 260, endFrequency: 430, duration: 0.08, type: "triangle", gain: 0.035 });
      else if (kind === "ko") tone({ frequency: 160, endFrequency: 42, duration: 0.65, type: "sawtooth", gain: 0.1 });
      else if (kind === "round") tone({ frequency: 480, endFrequency: 740, duration: 0.16, type: "square", gain: 0.045 });
    },
  };
}
