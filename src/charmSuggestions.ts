import type {
  BuildResult,
  Charm,
  CharmSuggestion,
  DesiredSkill,
  NormalizedData,
} from "./types";

export type CharmTargetConfig = {
  requiredSkills: DesiredSkill[];
  comfortSkills?: DesiredSkill[];
};

export type CharmSuggestionOptions = {
  suggestCount: number;
  maxSuggestedSkills: number;
  allowSlotPatterns: Array<[number, number, number]>;
  maxSkillLevelPerCharmSkill: number;
  slotWeight: number;
  suggestSlotForwardWhenComplete: boolean;
};

export type SkillWeightMap = Record<number, number>;

type MissingSkill = {
  skillId: number;
  missing: number;
  weight: number;
  priority: number;
};

type SkillTemplate = {
  skills: Record<number, number>;
};

type ScoredTemplate = {
  charm: Charm;
  score: number;
  explains: string[];
  skillScore: number;
  slotScore: number;
  breakpointBonus: number;
};

export const DEFAULT_CHARM_SLOT_PATTERNS: Array<[number, number, number]> = [
  [3, 0, 0],
  [2, 1, 0],
  [2, 0, 0],
  [1, 1, 0],
  [1, 0, 0],
  [0, 0, 0],
];

export const DEFAULT_CHARM_SUGGESTION_OPTIONS: CharmSuggestionOptions = {
  suggestCount: 5,
  maxSuggestedSkills: 6,
  allowSlotPatterns: DEFAULT_CHARM_SLOT_PATTERNS,
  maxSkillLevelPerCharmSkill: 3,
  slotWeight: 0.6,
  suggestSlotForwardWhenComplete: true,
};

function isCharmRollableSkill(data: NormalizedData, skillId: number): boolean {
  const kind = (data.skillsById[skillId]?.kind ?? "").toLowerCase();
  return kind === "armor";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizePattern(pattern: [number, number, number]): [number, number, number] {
  return [
    clamp(Math.floor(pattern[0] || 0), 0, 3),
    clamp(Math.floor(pattern[1] || 0), 0, 3),
    clamp(Math.floor(pattern[2] || 0), 0, 3),
  ];
}

function mergeOptions(options?: Partial<CharmSuggestionOptions>): CharmSuggestionOptions {
  const merged: CharmSuggestionOptions = {
    ...DEFAULT_CHARM_SUGGESTION_OPTIONS,
    ...options,
  };
  const dedupedPatterns = new Map<string, [number, number, number]>();
  for (const rawPattern of merged.allowSlotPatterns ?? DEFAULT_CHARM_SLOT_PATTERNS) {
    const pattern = normalizePattern(rawPattern);
    dedupedPatterns.set(pattern.join("-"), pattern);
  }
  merged.allowSlotPatterns = [...dedupedPatterns.values()];
  merged.suggestCount = clamp(Math.floor(merged.suggestCount), 1, 20);
  merged.maxSuggestedSkills = clamp(Math.floor(merged.maxSuggestedSkills), 1, 12);
  merged.maxSkillLevelPerCharmSkill = clamp(Math.floor(merged.maxSkillLevelPerCharmSkill), 1, 7);
  merged.slotWeight = Number.isFinite(merged.slotWeight) ? merged.slotWeight : DEFAULT_CHARM_SUGGESTION_OPTIONS.slotWeight;
  return merged;
}

function toRequiredTargetMap(targetConfig: CharmTargetConfig): Record<number, number> {
  const required: Record<number, number> = {};
  for (const desired of targetConfig.requiredSkills) {
    if (desired.level <= 0) {
      continue;
    }
    required[desired.skillId] = Math.max(required[desired.skillId] ?? 0, desired.level);
  }
  return required;
}

export function buildDefaultSkillWeights(
  data: NormalizedData,
  targetConfig: CharmTargetConfig,
): SkillWeightMap {
  const weights: SkillWeightMap = {};
  for (const desired of targetConfig.requiredSkills) {
    if (desired.level <= 0) {
      continue;
    }
    const kind = (data.skillsById[desired.skillId]?.kind ?? "").toLowerCase();
    const baseWeight = kind === "set" || kind === "group" ? 1.45 : 1.0;
    const targetScale = desired.level >= 3 ? 1.2 : 1.0;
    weights[desired.skillId] = Math.max(weights[desired.skillId] ?? 0, baseWeight * targetScale);
  }
  for (const comfort of targetConfig.comfortSkills ?? []) {
    if (comfort.level <= 0) {
      continue;
    }
    weights[comfort.skillId] = Math.max(weights[comfort.skillId] ?? 0, 0.6);
  }
  return weights;
}

function computeMissingSkills(
  build: BuildResult,
  requiredTargets: Record<number, number>,
  data: NormalizedData,
  weights: SkillWeightMap,
): MissingSkill[] {
  const missing: MissingSkill[] = [];
  for (const rawSkillId in requiredTargets) {
    const skillId = Number(rawSkillId);
    if (!isCharmRollableSkill(data, skillId)) {
      continue;
    }
    const targetLevel = requiredTargets[skillId] ?? 0;
    const currentLevel = build.skillTotals[skillId] ?? 0;
    const gap = targetLevel - currentLevel;
    if (gap <= 0) {
      continue;
    }
    const weight = weights[skillId] ?? 1;
    missing.push({
      skillId,
      missing: gap,
      weight,
      priority: gap * weight,
    });
  }
  missing.sort((a, b) => b.priority - a.priority || b.weight - a.weight || b.missing - a.missing || a.skillId - b.skillId);
  return missing;
}

function buildSingleSkillTemplates(
  focusMissing: MissingSkill[],
  data: NormalizedData,
  options: CharmSuggestionOptions,
): SkillTemplate[] {
  const templates: SkillTemplate[] = [];
  for (const item of focusMissing) {
    const skillCap = Math.min(
      options.maxSkillLevelPerCharmSkill,
      data.skillsById[item.skillId]?.maxLevel ?? options.maxSkillLevelPerCharmSkill,
      item.missing,
    );
    for (let level = 1; level <= skillCap; level += 1) {
      templates.push({
        skills: {
          [item.skillId]: level,
        },
      });
    }
  }
  return templates;
}

function buildDualSkillTemplates(
  focusMissing: MissingSkill[],
  data: NormalizedData,
  options: CharmSuggestionOptions,
): SkillTemplate[] {
  const templates: SkillTemplate[] = [];
  for (let i = 0; i < focusMissing.length; i += 1) {
    for (let j = i + 1; j < focusMissing.length; j += 1) {
      const first = focusMissing[i];
      const second = focusMissing[j];
      const firstCap = Math.min(
        options.maxSkillLevelPerCharmSkill,
        data.skillsById[first.skillId]?.maxLevel ?? options.maxSkillLevelPerCharmSkill,
        first.missing,
      );
      const secondCap = Math.min(
        options.maxSkillLevelPerCharmSkill,
        data.skillsById[second.skillId]?.maxLevel ?? options.maxSkillLevelPerCharmSkill,
        second.missing,
      );
      for (let firstLevel = 1; firstLevel <= firstCap; firstLevel += 1) {
        for (let secondLevel = 1; secondLevel <= secondCap; secondLevel += 1) {
          templates.push({
            skills: {
              [first.skillId]: firstLevel,
              [second.skillId]: secondLevel,
            },
          });
        }
      }
    }
  }
  return templates;
}

function slotPatternScore(pattern: [number, number, number], slotWeight: number): number {
  const [slot3, slot2, slot1] = pattern;
  return (slot3 * 1.8 + slot2 * 1.25 + slot1 * 0.8) * slotWeight;
}

function explainTemplate(
  charm: Charm,
  data: NormalizedData,
  missingBySkillId: Record<number, number>,
): string[] {
  const explains: string[] = [];
  const skillEntries = Object.entries(charm.skills)
    .map(([skillIdText, level]) => ({ skillId: Number(skillIdText), level }))
    .sort((a, b) => b.level - a.level || a.skillId - b.skillId);

  for (const entry of skillEntries) {
    const name = data.skillsById[entry.skillId]?.name ?? `Skill #${entry.skillId}`;
    const missing = missingBySkillId[entry.skillId] ?? 0;
    if (missing > 0 && entry.level >= missing) {
      explains.push(`Finishes ${name} target (+${missing}).`);
      continue;
    }
    explains.push(`Covers remaining ${name} +${entry.level}.`);
  }

  const [slot3, slot2, slot1] = charm.slots;
  explains.push(`Adds slot pattern ${slot3}-${slot2}-${slot1} for comfort decorations.`);
  return explains.slice(0, 3);
}

function scoreTemplate(
  template: SkillTemplate,
  slotPattern: [number, number, number],
  missingBySkillId: Record<number, number>,
  weights: SkillWeightMap,
  options: CharmSuggestionOptions,
): { score: number; skillScore: number; slotScore: number; breakpointBonus: number } {
  let skillScore = 0;
  let breakpointBonus = 0;

  for (const rawSkillId in template.skills) {
    const skillId = Number(rawSkillId);
    const level = template.skills[skillId] ?? 0;
    const missing = missingBySkillId[skillId] ?? 0;
    if (level <= 0 || missing <= 0) {
      continue;
    }
    const weight = weights[skillId] ?? 1;
    skillScore += Math.min(missing, level) * weight;
    if (level >= missing) {
      breakpointBonus += 0.75 * weight;
    }
  }

  const slotScore = slotPatternScore(slotPattern, options.slotWeight);
  return {
    score: skillScore + slotScore + breakpointBonus,
    skillScore,
    slotScore,
    breakpointBonus,
  };
}

function serializeTemplate(template: SkillTemplate, slotPattern: [number, number, number]): string {
  const skillBits = Object.entries(template.skills)
    .map(([skillId, level]) => ({ skillId: Number(skillId), level }))
    .filter((entry) => entry.level > 0)
    .sort((a, b) => a.skillId - b.skillId)
    .map((entry) => `${entry.skillId}:${entry.level}`)
    .join(",");
  return `${skillBits}|${slotPattern.join("-")}`;
}

function serializeCharmKey(charm: Charm): string {
  const skillBits = Object.entries(charm.skills)
    .map(([skillId, level]) => ({ skillId: Number(skillId), level }))
    .filter((entry) => entry.level > 0)
    .sort((a, b) => a.skillId - b.skillId)
    .map((entry) => `${entry.skillId}:${entry.level}`)
    .join(",");
  return `${skillBits}|${charm.slots.join("-")}`;
}

function topSlotForwardSuggestions(
  options: CharmSuggestionOptions,
  suggestCount: number,
): CharmSuggestion[] {
  return [...options.allowSlotPatterns]
    .sort((a, b) => slotPatternScore(b, options.slotWeight) - slotPatternScore(a, options.slotWeight) || a.join("-").localeCompare(b.join("-")))
    .slice(0, suggestCount)
    .map((pattern, index) => ({
      charm: {
        id: `slot-only-${index + 1}`,
        name: "Suggested RNG Charm",
        skills: {},
        slots: pattern,
        weaponSlot: 0,
      },
      score: Math.round(slotPatternScore(pattern, options.slotWeight) * 10) / 10,
      explains: [`Slot-forward option with pattern ${pattern.join("-")}.`],
    }));
}

export function suggestCharmsForBuild(input: {
  build: BuildResult;
  data: NormalizedData;
  targetConfig: CharmTargetConfig;
  weights?: SkillWeightMap;
  options?: Partial<CharmSuggestionOptions>;
}): CharmSuggestion[] {
  const options = mergeOptions(input.options);
  const requiredTargets = toRequiredTargetMap(input.targetConfig);
  const weights = input.weights ?? buildDefaultSkillWeights(input.data, input.targetConfig);
  const missing = computeMissingSkills(input.build, requiredTargets, input.data, weights);

  if (missing.length === 0) {
    if (!options.suggestSlotForwardWhenComplete) {
      return [];
    }
    return topSlotForwardSuggestions(options, options.suggestCount);
  }

  const focusMissing = missing.slice(0, options.maxSuggestedSkills);
  const missingBySkillId: Record<number, number> = {};
  for (const item of focusMissing) {
    missingBySkillId[item.skillId] = item.missing;
  }

  const templates = [
    ...buildSingleSkillTemplates(focusMissing, input.data, options),
    ...buildDualSkillTemplates(focusMissing, input.data, options),
  ];

  const scored: ScoredTemplate[] = [];
  const seen = new Set<string>();
  let nextId = 1;

  for (const template of templates) {
    for (const slotPattern of options.allowSlotPatterns) {
      const key = serializeTemplate(template, slotPattern);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const score = scoreTemplate(template, slotPattern, missingBySkillId, weights, options);
      const charm: Charm = {
        id: `suggested-rng-${nextId}`,
        name: "Suggested RNG Charm",
        skills: Object.fromEntries(
          Object.entries(template.skills)
            .filter(([, level]) => level > 0)
            .map(([skillId, level]) => [skillId, level]),
        ),
        slots: slotPattern,
        weaponSlot: 0,
      };
      nextId += 1;

      scored.push({
        charm,
        score: score.score,
        skillScore: score.skillScore,
        slotScore: score.slotScore,
        breakpointBonus: score.breakpointBonus,
        explains: explainTemplate(charm, input.data, missingBySkillId),
      });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.skillScore !== b.skillScore) {
      return b.skillScore - a.skillScore;
    }
    if (a.breakpointBonus !== b.breakpointBonus) {
      return b.breakpointBonus - a.breakpointBonus;
    }
    if (a.slotScore !== b.slotScore) {
      return b.slotScore - a.slotScore;
    }
    return serializeCharmKey(a.charm).localeCompare(serializeCharmKey(b.charm));
  });

  return scored.slice(0, options.suggestCount).map((entry) => ({
    charm: entry.charm,
    score: Math.round(entry.score * 10) / 10,
    explains: entry.explains,
  }));
}
