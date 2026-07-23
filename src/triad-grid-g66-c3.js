import { createTriadBlackboxChampionAgent } from "./triad-blackbox-champion-agent.js";

export default function createAgent() {
  return createTriadBlackboxChampionAgent({ gapThreshold: 66, throwCadence: 3 });
}
