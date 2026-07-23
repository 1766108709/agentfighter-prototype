import { createTriadBlackboxChampionAgent } from "./triad-blackbox-champion-agent.js";

export default function createAgent() {
  return createTriadBlackboxChampionAgent({ gapThreshold: 58, throwCadence: 2 });
}
