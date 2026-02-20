export type SkillId = number;
export type SkillPoints = Record<SkillId, number>;

export type SlotSize = 1 | 2 | 3 | 4;
export type Slots = SlotSize[];
export type CharmMode = "off" | "suggest" | "owned";

export type ArmorKind = "head" | "chest" | "arms" | "waist" | "legs";

export type Resistances = {
  fire: number;
  water: number;
  ice: number;
  thunder: number;
  dragon: number;
};

export type ArmorPiece = {
  id: number;
  name: string;
  kind: ArmorKind;
  rarity: number;
  defenseBase: number;
  defenseMax: number;
  resist: Resistances;
  slots: Slots;
  skills: SkillPoints;
  armorSetId: number | null;
  armorSetName: string | null;
  isAlpha: boolean;
  isGamma: boolean;
};

export type Decoration = {
  id: number;
  name: string;
  slotReq: SlotSize;
  kind: string;
  skills: SkillPoints;
};

export type CharmRank = {
  id: number;
  charmId: number;
  name: string;
  level: number;
  rarity: number;
  skills: SkillPoints;
  slots: Slots;
};

export type ArmorSetBonusRank = {
  pieces: number;
  skills: SkillPoints;
};

export type ArmorSetInfo = {
  id: number;
  name: string;
  bonusId: number | null;
  groupBonusId: number | null;
  bonusRanks: ArmorSetBonusRank[];
  groupBonusRanks: ArmorSetBonusRank[];
};

export type SkillInfo = {
  id: number;
  name: string;
  kind: string;
  maxLevel: number;
};

export type NormalizedData = {
  locale: string;
  version: string;
  fetchedAt: number;
  skills: SkillInfo[];
  skillsById: Record<number, SkillInfo>;
  armorByKind: Record<ArmorKind, ArmorPiece[]>;
  armorById: Record<number, ArmorPiece>;
  armorSetsById: Record<number, ArmorSetInfo>;
  decorations: Decoration[];
  decorationsById: Record<number, Decoration>;
  charmRanks: CharmRank[];
  charmRankById: Record<number, CharmRank>;
};

export type DesiredSkill = {
  skillId: SkillId;
  level: number;
};

export type Charm = {
  id: string;
  name: string;
  rarity?: number;
  skills: Record<string, number>;
  slots: [number, number, number];
  weaponSlot?: number;
};

export type CharmSuggestion = {
  charm: Charm;
  score: number;
  explains: string[];
};

export type DecorationPlacement = {
  slotSizeUsed: SlotSize;
  decorationId: number;
};

export type BuildResult = {
  armor: Record<ArmorKind, number>;
  charmRankId: number;
  charmName: string;
  charmSlots: Slots;
  placements: DecorationPlacement[];
  skillTotals: SkillPoints;
  defenseBase: number;
  defenseMax: number;
  resist: Resistances;
  leftoverSlotCapacity: number;
  wastedRequestedPoints: number;
  missingRequestedPoints?: number;
  tieKey: string;
  suggestedCharms?: CharmSuggestion[];
  charmSuggestions?: CharmSuggestion[];
  bestSuggestedCharm?: CharmSuggestion | null;
  charmBonusScore?: number;
  totalScoreWithCharm?: number;
  charmRequirementSummary?: string;
  meetsTargetsBase?: boolean;
  meetsTargetsWithBestCharm?: boolean;
  charmDependence?: "NONE" | "LOW" | "MED" | "HIGH";
  baseScore?: number;
  charmDeficitPoints?: number;
  charmCoveredPoints?: number;
};

export type OptimizeWorkerRequest = {
  data: NormalizedData;
  desiredSkills: DesiredSkill[];
  allowAlpha: boolean;
  allowGamma: boolean;
  useAllDecorations: boolean;
  allowedDecorationIds: number[];
  maxResults: number;
  includeNearMissResults?: boolean;
  maxMissingPoints?: number;
  allowedHeadIds: number[];
};

export type WorkerStats = {
  branchesVisited: number;
  prunedByBound: number;
  completedArmorCombos: number;
  feasibleBuilds: number;
  durationMs: number;
};

export type OptimizeWorkerResponse = {
  workerIndex: number;
  results: BuildResult[];
  stats: WorkerStats;
  error?: string;
};

export type OptimizeWorkerProgress = {
  type: "progress";
  workerIndex: number;
  completedArmorCombos: number;
  totalArmorCombos: number;
  evaluatedCandidates: number;
  totalCandidates: number;
  feasibleBuilds: number;
  branchesVisited: number;
  prunedByBound: number;
  elapsedMs: number;
};

export type OptimizeWorkerDone = OptimizeWorkerResponse & {
  type: "done";
};

export type OptimizeWorkerMessage = OptimizeWorkerProgress | OptimizeWorkerDone;

export type LoadDataSource = "network" | "cache" | "cache-fallback";

export type LoadDataResult = {
  data: NormalizedData;
  source: LoadDataSource;
};
