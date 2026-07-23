import vm from "node:vm";

import { EMPTY_COMBAT_INPUT } from "../src/input-schema.js";

export const MAX_AGENT_CODE_BYTES = 64 * 1024;
export const DEFAULT_COMPILE_TIMEOUT_MS = 50;
export const DEFAULT_CALL_TIMEOUT_MS = 10;

const INPUT_KEYS = Object.freeze(Object.keys(EMPTY_COMBAT_INPUT));

/**
 * Compile uploaded AgentFighter code inside a restricted VM context.
 *
 * This is one layer of the local reference sandbox. The caller must still run
 * it in a disposable Worker/process with memory and wall-time limits. Node's
 * vm module is not, by itself, a production-grade multi-tenant security
 * boundary.
 */
export function createSandboxAgent({
  code,
  filename = "uploaded-agent.js",
  seed = 1,
  compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
} = {}) {
  assertCode(code);
  const safeSeed = Number(seed) >>> 0 || 1;
  const context = vm.createContext({
    __bootstrapSeed: safeSeed,
    console: undefined,
    process: undefined,
    require: undefined,
    module: undefined,
    Buffer: undefined,
    fetch: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    XMLHttpRequest: undefined,
    Date: undefined,
    performance: undefined,
    crypto: undefined,
    SharedArrayBuffer: undefined,
    Atomics: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    queueMicrotask: undefined,
  }, {
    name: `agentfighter:${filename}`,
    codeGeneration: { strings: false, wasm: false },
  });

  const bootstrap = new vm.Script(buildBootstrapSource(code), {
    filename,
    displayErrors: true,
  });
  bootstrap.runInContext(context, { timeout: boundedTimeout(compileTimeoutMs, 1, 1_000) });

  const readIdentity = new vm.Script(`JSON.stringify({
    name: typeof __agent.name === "string" ? __agent.name.slice(0, 80) : "Uploaded Agent",
    description: typeof __agent.description === "string" ? __agent.description.slice(0, 240) : ""
  })`, { filename: `${filename}:identity` });
  const identity = JSON.parse(readIdentity.runInContext(context, {
    timeout: boundedTimeout(callTimeoutMs, 1, 1_000),
  }));
  const calls = Object.fromEntries(["reset", "act", "end"].map((method) => [
    method,
    new vm.Script(buildCallSource(method), { filename: `${filename}:${method}` }),
  ]));

  function invoke(method, payload) {
    context.__hostPayload = JSON.stringify(payload ?? null);
    try {
      const serialized = calls[method].runInContext(context, {
        timeout: boundedTimeout(callTimeoutMs, 1, 1_000),
      });
      return serialized === undefined ? undefined : JSON.parse(serialized);
    } finally {
      context.__hostPayload = undefined;
    }
  }

  return {
    name: identity.name,
    description: identity.description,
    reset(info) {
      invoke("reset", info);
    },
    act(observation) {
      return invoke("act", observation);
    },
    end(result) {
      invoke("end", result);
    },
  };
}

function buildBootstrapSource(code) {
  return `(() => {
    "use strict";
    let __rngState = (__bootstrapSeed >>> 0) || 1;
    Math.random = () => {
      __rngState ^= __rngState << 13;
      __rngState ^= __rngState >>> 17;
      __rngState ^= __rngState << 5;
      return (__rngState >>> 0) / 4294967296;
    };
    Object.freeze(Math);

    const __inputKeys = Object.freeze(${JSON.stringify(INPUT_KEYS)});
    const __action = (input = {}) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("action(input) expects an object");
      }
      const unknown = Object.keys(input).filter((key) => !__inputKeys.includes(key));
      if (unknown.length) throw new TypeError("unknown input fields: " + unknown.join(", "));
      const normalized = {};
      for (const key of __inputKeys) {
        const value = input[key];
        if (value !== undefined && typeof value !== "boolean") {
          throw new TypeError("input." + key + " must be boolean");
        }
        normalized[key] = value === true;
      }
      if (normalized.left && normalized.right) throw new TypeError("left and right conflict");
      if (normalized.up && normalized.down) throw new TypeError("up and down conflict");
      return { schema: "agentfighter.action", version: 1, input: normalized };
    };
    const api = Object.freeze({
      action: __action,
      protocolVersion: 1,
      inputKeys: __inputKeys
    });

    ${code}

    if (typeof createAgent !== "function") {
      throw new TypeError("uploaded code must declare function createAgent(api)");
    }
    const candidate = createAgent(api);
    if (!candidate || typeof candidate !== "object" || typeof candidate.act !== "function") {
      throw new TypeError("createAgent(api) must return an object with act(observation)");
    }
    globalThis.__agent = candidate;
    globalThis.__bootstrapSeed = undefined;
  })()`;
}

function buildCallSource(method) {
  const required = method === "act";
  return `(() => {
    "use strict";
    const callback = __agent[${JSON.stringify(method)}];
    if (typeof callback !== "function") {
      ${required ? `throw new TypeError("agent.${method} must be a function");` : "return undefined;"}
    }
    const value = callback.call(__agent, JSON.parse(__hostPayload));
    if (value && typeof value.then === "function") {
      throw new TypeError("async agent callbacks are not supported");
    }
    return JSON.stringify(value);
  })()`;
}

function assertCode(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new TypeError("code must be a non-empty JavaScript string");
  }
  if (Buffer.byteLength(code, "utf8") > MAX_AGENT_CODE_BYTES) {
    throw new RangeError(`code exceeds ${MAX_AGENT_CODE_BYTES} bytes`);
  }
}

function boundedTimeout(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}
