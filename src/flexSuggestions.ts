import type { BuildResult, Decoration, DesiredSkill, NormalizedData, SlotSize } from "./types";

export type FlexPreset = "comfort" | "balanced" | "damage";
export type FlexPresetMode = FlexPreset | "auto";
export type HuntElement = "fire" | "water" | "thunder" | "ice" | "dragon";
export type HuntStatus = "poison" | "blast" | "paralysis" | "sleep" | "stun";

export type HuntFocus =
  | null
  | {
      element?: HuntElement;
      status?: HuntStatus[];
    };

export type LeftoverSlot = {
  slotIndex: number;
  slotLevel: SlotSize;
  pieceLabel: string;
  pieceName: string;
};

export type FlexSuggestionLoadoutItem = {
  slotIndex: number;
  slotLevel: SlotSize;
  pieceLabel: string;
  pieceName: string;
  decorationId: number;
  decorationName: string;
};

export type FlexSuggestion = {
  decorationLoadout: FlexSuggestionLoadoutItem[];
  score: number;
  explanation: string;
};

export const HUNT_ELEMENT_OPTIONS: HuntElement[] = ["fire", "water", "thunder", "ice", "dragon"];
export const HUNT_STATUS_OPTIONS: HuntStatus[] = ["poison", "blast", "paralysis", "sleep", "stun"];

type SuggestedEntry = {
  idsBySlot: number[];
  score: number;
  explanation: string;
};

type ScoreContext = {
  data: NormalizedData;
  build: BuildResult;
  preset: FlexPreset;
  huntFocus: HuntFocus;
  worstElement: HuntElement | null;
  worstElementValue: number;
};

type ElementUsageCaps = Record<HuntElement, number>;

type PresetWeights = {
  survivability: number;
  multiplayer: number;
  damage: number;
  utility: number;
  nicheStatus: number;
};

type DecorationSignal = {
  score: number;
  matchedWorstElement: boolean;
  matchedHuntElement: HuntElement | null;
  matchedHuntStatuses: Set<HuntStatus>;
  survivabilityHits: number;
  damageHits: number;
  utilityHits: number;
  multiplayerHits: number;
  wastedPoints: number;
};

const BRUTE_FORCE_MAX_COMBINATIONS = 220000;
const BEAM_WIDTH = 220;
const MAX_BEAM_CANDIDATES_PER_SLOT = 18;

const MULTIPLAYER_PATTERNS = ["flinch free", "wide-range", "free meal", "speed eating", "mushroomancer", "brace"];
const SURVIVABILITY_PATTERNS = [
  "divine blessing",
  "defense",
  "recovery",
  "health boost",
  "stun resistance",
  "evade",
  "satiated",
  "medicine",
  "guard",
  "resistance",
];
const DAMAGE_PATTERNS = [
  "attack boost",
  "critical eye",
  "weakness exploit",
  "critical boost",
  "burst",
  "agitator",
  "peak performance",
  "offensive guard",
  "critical status",
  "critical element",
  "counterstrike",
];

const ELEMENT_RES_PATTERNS: Record<HuntElement, string[]> = {
  fire: ["fire resistance", "fire res"],
  water: ["water resistance", "water res"],
  thunder: ["thunder resistance", "thunder res"],
  ice: ["ice resistance", "ice res"],
  dragon: ["dragon resistance", "dragon res"],
};

const STATUS_RES_PATTERNS: Record<HuntStatus, string[]> = {
  poison: ["poison resistance", "poison res"],
  blast: ["blast resistance", "blastblight resistance", "blast res"],
  paralysis: ["paralysis resistance", "paralysis res", "para resistance"],
  sleep: ["sleep resistance", "sleep res"],
  stun: ["stun resistance", "stun res"],
};

function lower(text: string): string {
  return text.toLowerCase();
}

function includesAny(text: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (text.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function findElementResSkill(skillNameLower: string): HuntElement | null {
  for (const element of HUNT_ELEMENT_OPTIONS) {
    if (includesAny(skillNameLower, ELEMENT_RES_PATTERNS[element])) {
      return element;
    }
  }
  return null;
}

function findStatusResSkill(skillNameLower: string): HuntStatus | null {
  for (const status of HUNT_STATUS_OPTIONS) {
    if (includesAny(skillNameLower, STATUS_RES_PATTERNS[status])) {
      return status;
    }
  }
  return null;
}

function resolveElementUsageCaps(context: ScoreContext): ElementUsageCaps {
  const caps: ElementUsageCaps = {
    fire: 1,
    water: 1,
    thunder: 1,
    ice: 1,
    dragon: 1,
  };

  if (context.worstElement) {
    caps[context.worstElement] = 2;
  }
  if (context.huntFocus?.element) {
    caps[context.huntFocus.element] = Math.max(caps[context.huntFocus.element], 3);
  }
  return caps;
}

function buildElementTagsByDecorationId(
  decorations: Decoration[],
  data: NormalizedData,
): Record<number, HuntElement[]> {
  const output: Record<number, HuntElement[]> = {};
  for (const decoration of decorations) {
    const tags = new Set<HuntElement>();
    for (const rawSkillId in decoration.skills) {
      const skillId = Number(rawSkillId);
      if ((decoration.skills[skillId] ?? 0) <= 0) {
        continue;
      }
      const skillName = lower(data.skillsById[skillId]?.name ?? "");
      const tag = findElementResSkill(skillName);
      if (tag) {
        tags.add(tag);
      }
    }
    output[decoration.id] = [...tags];
  }
  return output;
}

function countElementUsage(
  idsBySlot: number[],
  elementTagsByDecorationId: Record<number, HuntElement[]>,
): Record<HuntElement, number> {
  const counts: Record<HuntElement, number> = {
    fire: 0,
    water: 0,
    thunder: 0,
    ice: 0,
    dragon: 0,
  };
  for (const decoId of idsBySlot) {
    for (const element of elementTagsByDecorationId[decoId] ?? []) {
      counts[element] += 1;
    }
  }
  return counts;
}

function exceedsElementUsageCaps(
  idsBySlot: number[],
  caps: ElementUsageCaps,
  elementTagsByDecorationId: Record<number, HuntElement[]>,
): boolean {
  const usage = countElementUsage(idsBySlot, elementTagsByDecorationId);
  for (const element of HUNT_ELEMENT_OPTIONS) {
    if (usage[element] > caps[element]) {
      return true;
    }
  }
  return false;
}

function inferPresetFromDesiredSkills(desiredSkills: DesiredSkill[], data: NormalizedData): FlexPreset {
  const desiredNames = desiredSkills
    .map((desired) => lower(data.skillsById[desired.skillId]?.name ?? ""))
    .filter((name) => name.length > 0);

  const hasConstitutionLike = desiredNames.some((name) => name.includes("constitution") || name.includes("stamina surge"));
  const hasBalancedDamage = desiredNames.some((name) => name.includes("weakness exploit") || name.includes("burst"));
  const hasComfort = desiredNames.some((name) => name.includes("divine blessing") || name.includes("stun resistance"));

  if (hasConstitutionLike) return "damage";
  if (hasBalancedDamage) return "balanced";
  if (hasComfort) return "comfort";
  return "balanced";
}

function resolvePreset(mode: FlexPresetMode, desiredSkills: DesiredSkill[], data: NormalizedData): FlexPreset {
  if (mode !== "auto") {
    return mode;
  }
  return inferPresetFromDesiredSkills(desiredSkills, data);
}

function getPresetWeights(preset: FlexPreset): PresetWeights {
  if (preset === "comfort") {
    return {
      survivability: 22,
      multiplayer: 12,
      damage: 8,
      utility: 10,
      nicheStatus: 12,
    };
  }
  if (preset === "damage") {
    return {
      survivability: 8,
      multiplayer: 4,
      damage: 24,
      utility: 8,
      nicheStatus: 6,
    };
  }
  return {
    survivability: 15,
    multiplayer: 10,
    damage: 14,
    utility: 10,
    nicheStatus: 8,
  };
}

function getWorstElementResist(build: BuildResult): { element: HuntElement | null; value: number } {
  const values: Array<{ element: HuntElement; value: number }> = [
    { element: "fire", value: build.resist.fire },
    { element: "water", value: build.resist.water },
    { element: "thunder", value: build.resist.thunder },
    { element: "ice", value: build.resist.ice },
    { element: "dragon", value: build.resist.dragon },
  ];
  values.sort((a, b) => a.value - b.value);
  const worst = values[0];
  if (worst.value <= -10) {
    return { element: worst.element, value: worst.value };
  }
  return { element: null, value: worst.value };
}

function capAwareGain(current: number, gain: number, max: number): number {
  const cappedCurrent = Math.min(current, max);
  const cappedNext = Math.min(current + gain, max);
  return Math.max(0, cappedNext - cappedCurrent);
}

function scoreDecorationSignal(
  decoration: Decoration,
  runningSkillTotals: Record<number, number>,
  context: ScoreContext,
): DecorationSignal {
  const signal: DecorationSignal = {
    score: 0,
    matchedWorstElement: false,
    matchedHuntElement: null,
    matchedHuntStatuses: new Set<HuntStatus>(),
    survivabilityHits: 0,
    damageHits: 0,
    utilityHits: 0,
    multiplayerHits: 0,
    wastedPoints: 0,
  };

  const weights = getPresetWeights(context.preset);
  const huntStatuses = new Set(context.huntFocus?.status ?? []);

  for (const rawSkillId in decoration.skills) {
    const skillId = Number(rawSkillId);
    const baseGain = decoration.skills[skillId] ?? 0;
    if (baseGain <= 0) {
      continue;
    }

    const current = runningSkillTotals[skillId] ?? 0;
    const maxLevel = context.data.skillsById[skillId]?.maxLevel ?? 99;
    const effectiveGain = capAwareGain(current, baseGain, maxLevel);
    runningSkillTotals[skillId] = current + baseGain;

    if (effectiveGain <= 0) {
      signal.wastedPoints += baseGain;
      continue;
    }

    const skillNameLower = lower(context.data.skillsById[skillId]?.name ?? "");
    const elementMatch = findElementResSkill(skillNameLower);
    if (elementMatch) {
      if (context.worstElement && elementMatch === context.worstElement) {
        signal.matchedWorstElement = true;
      }
      if (context.huntFocus?.element && elementMatch === context.huntFocus.element) {
        signal.matchedHuntElement = elementMatch;
      }
      signal.survivabilityHits += effectiveGain;
      signal.score += weights.survivability * effectiveGain;
      continue;
    }

    const statusMatch = findStatusResSkill(skillNameLower);
    if (statusMatch) {
      if (huntStatuses.has(statusMatch)) {
        signal.matchedHuntStatuses.add(statusMatch);
        signal.score += (20 + weights.nicheStatus) * effectiveGain;
      } else if (huntStatuses.size === 0) {
        signal.utilityHits += effectiveGain;
        signal.score += Math.max(1, weights.nicheStatus - 6) * effectiveGain;
      }
      continue;
    }

    if (includesAny(skillNameLower, MULTIPLAYER_PATTERNS)) {
      signal.multiplayerHits += effectiveGain;
      signal.score += weights.multiplayer * effectiveGain;
      continue;
    }

    if (includesAny(skillNameLower, DAMAGE_PATTERNS)) {
      signal.damageHits += effectiveGain;
      signal.score += weights.damage * effectiveGain;
      continue;
    }

    if (includesAny(skillNameLower, SURVIVABILITY_PATTERNS)) {
      signal.survivabilityHits += effectiveGain;
      signal.score += weights.survivability * effectiveGain;
      continue;
    }

    signal.utilityHits += effectiveGain;
    signal.score += weights.utility * effectiveGain;
  }

  return signal;
}

function explainSuggestion(
  context: ScoreContext,
  signalTotals: {
    matchedWorstElement: boolean;
    matchedHuntElement: HuntElement | null;
    matchedHuntStatuses: Set<HuntStatus>;
    survivabilityHits: number;
    damageHits: number;
    utilityHits: number;
    multiplayerHits: number;
  },
): string {
  const lines: string[] = [];

  if (signalTotals.matchedWorstElement && context.worstElement) {
    const elementName = context.worstElement[0].toUpperCase() + context.worstElement.slice(1);
    lines.push(`Patches low ${elementName} resistance (${context.worstElementValue}).`);
  }
  if (signalTotals.matchedHuntElement) {
    const elementName = signalTotals.matchedHuntElement[0].toUpperCase() + signalTotals.matchedHuntElement.slice(1);
    lines.push(`Matches hunt focus with extra ${elementName} resistance.`);
  }
  if (signalTotals.matchedHuntStatuses.size > 0) {
    const statusText = [...signalTotals.matchedHuntStatuses].sort().join(", ");
    lines.push(`Adds hunt-specific status coverage: ${statusText}.`);
  }

  if (lines.length < 2 && signalTotals.damageHits > 0 && context.preset === "damage") {
    lines.push("Adds extra damage-oriented value without changing required skills.");
  }
  if (lines.length < 2 && signalTotals.survivabilityHits + signalTotals.utilityHits > 0) {
    lines.push("Improves general comfort and survivability in leftover slots.");
  }
  if (lines.length < 2 && signalTotals.multiplayerHits > 0) {
    lines.push("Includes multiplayer quality-of-life utility.");
  }
  if (lines.length === 0) {
    lines.push("Fills leftover slots with non-conflicting utility options.");
  }

  return lines.slice(0, 2).join(" ");
}

function scoreAssignment(
  idsBySlot: number[],
  slotPlan: LeftoverSlot[],
  context: ScoreContext,
  elementUsageCaps: ElementUsageCaps,
  elementTagsByDecorationId: Record<number, HuntElement[]>,
): { score: number; explanation: string } {
  const runningSkillTotals: Record<number, number> = { ...context.build.skillTotals };
  let score = 0;
  let totalWasted = 0;
  let matchedWorstElement = false;
  let matchedHuntElement: HuntElement | null = null;
  const matchedHuntStatuses = new Set<HuntStatus>();
  let survivabilityHits = 0;
  let damageHits = 0;
  let utilityHits = 0;
  let multiplayerHits = 0;
  const decoUsage: Record<number, number> = {};
  const elementUsage: Record<HuntElement, number> = {
    fire: 0,
    water: 0,
    thunder: 0,
    ice: 0,
    dragon: 0,
  };

  for (let i = 0; i < idsBySlot.length; i += 1) {
    const decoId = idsBySlot[i];
    const decoration = context.data.decorationsById[decoId];
    if (!decoration) {
      continue;
    }

    const duplicateCount = decoUsage[decoId] ?? 0;
    if (duplicateCount > 0) {
      score -= duplicateCount * 7;
    }
    decoUsage[decoId] = duplicateCount + 1;

    for (const element of elementTagsByDecorationId[decoId] ?? []) {
      elementUsage[element] += 1;
      const overflow = elementUsage[element] - elementUsageCaps[element];
      if (overflow > 0) {
        score -= overflow * 18;
      }
    }

    const signal = scoreDecorationSignal(decoration, runningSkillTotals, context);
    score += signal.score;
    totalWasted += signal.wastedPoints;
    matchedWorstElement = matchedWorstElement || signal.matchedWorstElement;
    matchedHuntElement = matchedHuntElement ?? signal.matchedHuntElement;
    for (const status of signal.matchedHuntStatuses) {
      matchedHuntStatuses.add(status);
    }
    survivabilityHits += signal.survivabilityHits;
    damageHits += signal.damageHits;
    utilityHits += signal.utilityHits;
    multiplayerHits += signal.multiplayerHits;
  }

  if (matchedWorstElement) {
    score += 30;
  }
  if (matchedHuntElement) {
    score += 25;
  }
  if (matchedHuntStatuses.size > 0) {
    score += 20;
  }

  if (totalWasted > 0) {
    score -= totalWasted * 2;
  }

  const explanation = explainSuggestion(context, {
    matchedWorstElement,
    matchedHuntElement,
    matchedHuntStatuses,
    survivabilityHits,
    damageHits,
    utilityHits,
    multiplayerHits,
  });

  void slotPlan;
  return { score, explanation };
}

function quickSingleDecorationScore(
  decoration: Decoration,
  context: ScoreContext,
): number {
  const score = scoreDecorationSignal(decoration, { ...context.build.skillTotals }, context).score;
  return score;
}

function enumerateByBruteforce(
  candidatesBySlot: Decoration[][],
  callback: (idsBySlot: number[]) => void,
): void {
  const current: number[] = [];

  function walk(depth: number): void {
    if (depth >= candidatesBySlot.length) {
      callback(current.slice());
      return;
    }
    for (const deco of candidatesBySlot[depth]) {
      current.push(deco.id);
      walk(depth + 1);
      current.pop();
    }
  }

  walk(0);
}

function enumerateByBeam(
  candidatesBySlot: Decoration[][],
  quickScoreById: Record<number, number>,
  elementUsageCaps: ElementUsageCaps,
  elementTagsByDecorationId: Record<number, HuntElement[]>,
): number[][] {
  let states: Array<{ idsBySlot: number[]; score: number }> = [{ idsBySlot: [], score: 0 }];

  for (let depth = 0; depth < candidatesBySlot.length; depth += 1) {
    const nextStates: Array<{ idsBySlot: number[]; score: number }> = [];
    const candidates = candidatesBySlot[depth];
    for (const state of states) {
      for (const deco of candidates) {
        const duplicateCount = state.idsBySlot.reduce((count, decoId) => count + (decoId === deco.id ? 1 : 0), 0);
        const duplicatePenalty = duplicateCount * 4;

        let elementOverflowPenalty = 0;
        for (const element of elementTagsByDecorationId[deco.id] ?? []) {
          let existingElementCount = 0;
          for (const placedId of state.idsBySlot) {
            if ((elementTagsByDecorationId[placedId] ?? []).includes(element)) {
              existingElementCount += 1;
            }
          }
          const overflow = existingElementCount + 1 - elementUsageCaps[element];
          if (overflow > 0) {
            elementOverflowPenalty += overflow * 12;
          }
        }

        nextStates.push({
          idsBySlot: [...state.idsBySlot, deco.id],
          score: state.score + (quickScoreById[deco.id] ?? 0) - duplicatePenalty - elementOverflowPenalty,
        });
      }
    }
    nextStates.sort((a, b) => b.score - a.score || a.idsBySlot.length - b.idsBySlot.length);
    states = nextStates.slice(0, BEAM_WIDTH);
    if (states.length === 0) {
      break;
    }
  }

  return states.map((state) => state.idsBySlot);
}

function buildDecorationLoadout(
  idsBySlot: number[],
  slotPlan: LeftoverSlot[],
  data: NormalizedData,
): FlexSuggestionLoadoutItem[] {
  const output: FlexSuggestionLoadoutItem[] = [];
  for (let i = 0; i < idsBySlot.length; i += 1) {
    const decoId = idsBySlot[i];
    const slot = slotPlan[i];
    const decoName = data.decorationsById[decoId]?.name || `Decoration #${decoId}`;
    output.push({
      slotIndex: slot.slotIndex,
      slotLevel: slot.slotLevel,
      pieceLabel: slot.pieceLabel,
      pieceName: slot.pieceName,
      decorationId: decoId,
      decorationName: decoName,
    });
  }
  return output.sort((a, b) => a.slotIndex - b.slotIndex);
}

export function suggestFlexDecorations(input: {
  build: BuildResult;
  leftoverSlots: LeftoverSlot[];
  data: NormalizedData;
  desiredSkills: DesiredSkill[];
  presetMode: FlexPresetMode;
  huntFocus: HuntFocus;
  allowedDecorationIds: Set<number> | null;
}): FlexSuggestion[] {
  if (input.leftoverSlots.length === 0) {
    return [];
  }

  const preset = resolvePreset(input.presetMode, input.desiredSkills, input.data);
  const worst = getWorstElementResist(input.build);
  const context: ScoreContext = {
    data: input.data,
    build: input.build,
    preset,
    huntFocus: input.huntFocus,
    worstElement: worst.element,
    worstElementValue: worst.value,
  };
  const elementUsageCaps = resolveElementUsageCaps(context);

  const allArmorDecorations = input.data.decorations.filter((deco) => {
    if (lower(deco.kind) !== "armor") return false;
    if (input.allowedDecorationIds && !input.allowedDecorationIds.has(deco.id)) return false;
    return true;
  });
  if (allArmorDecorations.length === 0) {
    return [];
  }
  const elementTagsByDecorationId = buildElementTagsByDecorationId(allArmorDecorations, input.data);

  const quickScoreById: Record<number, number> = {};
  for (const deco of allArmorDecorations) {
    quickScoreById[deco.id] = quickSingleDecorationScore(deco, context);
  }

  const sortedSlots = [...input.leftoverSlots].sort((a, b) => b.slotLevel - a.slotLevel || a.slotIndex - b.slotIndex);
  const fullCandidatesBySlot = sortedSlots.map((slot) =>
    allArmorDecorations
      .filter((deco) => slot.slotLevel >= deco.slotReq)
      .sort((a, b) => (quickScoreById[b.id] ?? 0) - (quickScoreById[a.id] ?? 0) || a.id - b.id),
  );
  if (fullCandidatesBySlot.some((candidates) => candidates.length === 0)) {
    return [];
  }

  let estimatedCombinations = 1;
  for (const candidates of fullCandidatesBySlot) {
    estimatedCombinations *= candidates.length;
    if (estimatedCombinations > BRUTE_FORCE_MAX_COMBINATIONS) break;
  }

  const useBruteforce = sortedSlots.length <= 4 && estimatedCombinations <= BRUTE_FORCE_MAX_COMBINATIONS;
  const candidatesBySlot = useBruteforce
    ? fullCandidatesBySlot
    : fullCandidatesBySlot.map((candidates) => candidates.slice(0, MAX_BEAM_CANDIDATES_PER_SLOT));

  const topEntries: SuggestedEntry[] = [];
  const seen = new Set<string>();

  function consider(idsBySlot: number[]): void {
    if (exceedsElementUsageCaps(idsBySlot, elementUsageCaps, elementTagsByDecorationId)) {
      return;
    }

    const key = idsBySlot
      .map((decoId, index) => `${sortedSlots[index].slotLevel}-${decoId}`)
      .sort()
      .join("|");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const scored = scoreAssignment(idsBySlot, sortedSlots, context, elementUsageCaps, elementTagsByDecorationId);
    const entry: SuggestedEntry = {
      idsBySlot,
      score: scored.score,
      explanation: scored.explanation,
    };

    topEntries.push(entry);
    topEntries.sort((a, b) => b.score - a.score || a.idsBySlot.join(",").localeCompare(b.idsBySlot.join(",")));
    if (topEntries.length > 18) {
      topEntries.length = 18;
    }
  }

  if (useBruteforce) {
    enumerateByBruteforce(candidatesBySlot, consider);
  } else {
    const beamAssignments = enumerateByBeam(
      candidatesBySlot,
      quickScoreById,
      elementUsageCaps,
      elementTagsByDecorationId,
    );
    for (const idsBySlot of beamAssignments) {
      consider(idsBySlot);
    }
  }

  return topEntries.slice(0, 3).map((entry) => ({
    decorationLoadout: buildDecorationLoadout(entry.idsBySlot, sortedSlots, input.data),
    score: Math.round(entry.score * 10) / 10,
    explanation: entry.explanation,
  }));
}
