import { createTriadBlackboxChampionAgent } from "./triad-blackbox-champion-agent.js";

export default function createAgent() {
  return createTriadBlackboxChampionAgent({ gapThreshold: 50, throwCadence: 3 });
}
