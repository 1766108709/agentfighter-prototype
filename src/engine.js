/**
 * Stable public facade for the v0.7 data-driven combat runtime.
 *
 * Keeping the facade small lets browser play, headless simulation, tests, and
 * external Agent controllers share exactly the same deterministic 60 Hz core.
 */
export * from "./combat-engine.js";
