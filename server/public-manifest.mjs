import { CHARACTER_TEMPLATES, MOVESETS } from "../src/engine.js";

const TEMPLATE_IDS = Object.freeze(Object.keys(CHARACTER_TEMPLATES));
const manifests = new Map();

export function listPublicTemplates() {
  return TEMPLATE_IDS.map((templateId) => {
    const template = CHARACTER_TEMPLATES[templateId];
    return {
      id: template.id,
      name: template.name,
      archetype: template.archetype,
      controlLayout: template.controlLayout,
      manifestPath: `/api/templates/${template.id}`,
    };
  });
}

export function publicTemplateManifest(templateId) {
  const id = String(templateId ?? "").toLowerCase();
  if (!TEMPLATE_IDS.includes(id)) return null;
  if (manifests.has(id)) return manifests.get(id);

  const template = CHARACTER_TEMPLATES[id];
  const moveset = MOVESETS[id];
  const manifest = deepFreeze({
    schema: "agentfighter.template-manifest",
    version: 1,
    id: template.id,
    name: template.name,
    archetype: template.archetype,
    controlLayout: template.controlLayout,
    resourceModel: jsonClone(moveset.resourceModel ?? {}),
    aliases: jsonClone(moveset.aliases ?? {}),
    moves: template.moves
      .map((moveId) => moveset.moves?.[moveId])
      .filter(Boolean)
      .map(publicMove),
  });
  manifests.set(id, manifest);
  return manifest;
}

function publicMove(move) {
  return {
    id: move.id,
    name: move.name,
    category: move.category ?? null,
    command: jsonClone(move.command ?? null),
    commandLabel: move.commandLabel ?? move.command?.label ?? null,
    stance: move.stance ?? null,
    strength: move.strength ?? null,
    startup: finiteOrNull(move.startup),
    firstActive: finiteOrNull(move.firstActive),
    active: finiteOrNull(move.active ?? move.activeFrameCount),
    activeWindows: jsonClone(move.activeWindows ?? []),
    recovery: finiteOrNull(move.recovery),
    totalFrames: finiteOrNull(move.totalFrames),
    damage: finiteOrNull(move.damage),
    hitLevel: move.hitLevel ?? move.hit?.level ?? null,
    hitAdvantage: finiteOrNull(move.hit?.advantage),
    blockAdvantage: finiteOrNull(move.block?.advantage ?? move.hit?.blockAdvantage),
    resourceCost: jsonClone(move.resourceCost ?? move.resource?.cost ?? move.cost ?? {}),
    knockdown: jsonClone(move.knockdown ?? null),
    juggle: jsonClone(move.juggle ?? null),
    cancels: (move.cancels ?? []).map((cancel) => ({
      start: finiteOrNull(cancel.start),
      end: finiteOrNull(cancel.end),
      on: jsonClone(cancel.on ?? []),
      into: jsonClone(cancel.into ?? []),
      moves: jsonClone(cancel.moves ?? []),
    })),
    tags: jsonClone(move.tags ?? []),
  };
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
