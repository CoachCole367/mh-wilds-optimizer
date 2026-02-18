import type {
  ArmorKind,
  ArmorPiece,
  ArmorSetBonusRank,
  BuildResult,
  CharmRank,
  Decoration,
  DecorationPlacement,
  OptimizeWorkerRequest,
  OptimizeWorkerProgress,
  OptimizeWorkerResponse,
  SkillPoints,
  SlotSize,
  WorkerStats,
} from "./types";

const ARMOR_ORDER: ArmorKind[] = ["head", "chest", "arms", "waist", "legs"];

type SkillIndexById = Record<number, number>;

type DecorationData = {
  bySkill: Record<number, Decoration[]>;
  byId: Record<number, Decoration>;
};

type DeficitState = {
  deficits: number[];
  slotCounts: number[];
};

type OptimizeProgressPayload = Omit<OptimizeWorkerProgress, "type" | "workerIndex">;

type SetBonusProvider = {
  setId: number;
  thresholds: Array<{ pieces: number; level: number }>;
};

function nowMs(): number {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

function addSkillPoints(target: SkillPoints, source: SkillPoints): void {
  for (const key in source) {
    const skillId = Number(key);
    const value = source[skillId] ?? 0;
    if (value === 0) {
      continue;
    }
    target[skillId] = (target[skillId] ?? 0) + value;
  }
}

function cloneSkillPoints(points: SkillPoints): SkillPoints {
  return { ...points };
}

function hasRequestedIntersection(skills: SkillPoints, requestedSkillIds: number[]): boolean {
  for (const skillId of requestedSkillIds) {
    if ((skills[skillId] ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function armorAllowed(piece: ArmorPiece, allowAlpha: boolean, allowGamma: boolean): boolean {
  if (piece.isAlpha && !allowAlpha) {
    return false;
  }
  if (piece.isGamma && !allowGamma) {
    return false;
  }
  return true;
}

function sortedSlotsDesc(slots: number[]): number[] {
  return [...slots].sort((a, b) => b - a);
}

function slotsAtLeast(a: number[], b: number[]): boolean {
  if (a.length < b.length) {
    return false;
  }
  const sortedA = sortedSlotsDesc(a);
  const sortedB = sortedSlotsDesc(b);
  for (let i = 0; i < sortedB.length; i += 1) {
    if ((sortedA[i] ?? 0) < (sortedB[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

function slotsStrictlyBetter(a: number[], b: number[]): boolean {
  const sortedA = sortedSlotsDesc(a);
  const sortedB = sortedSlotsDesc(b);
  if (sortedA.length > sortedB.length) {
    return true;
  }
  for (let i = 0; i < sortedB.length; i += 1) {
    const valueA = sortedA[i] ?? 0;
    const valueB = sortedB[i] ?? 0;
    if (valueA > valueB) {
      return true;
    }
  }
  return false;
}

function dominatesArmor(
  a: ArmorPiece,
  b: ArmorPiece,
  requestedSkillIds: number[],
  relevantSetIds: Set<number>,
): boolean {
  const aRelevant = a.armorSetId !== null && relevantSetIds.has(a.armorSetId);
  const bRelevant = b.armorSetId !== null && relevantSetIds.has(b.armorSetId);
  if ((aRelevant || bRelevant) && a.armorSetId !== b.armorSetId) {
    return false;
  }

  let strictlyBetter = false;

  if (a.defenseMax < b.defenseMax) {
    return false;
  }
  if (a.defenseMax > b.defenseMax) {
    strictlyBetter = true;
  }

  if (!slotsAtLeast(a.slots, b.slots)) {
    return false;
  }
  if (slotsStrictlyBetter(a.slots, b.slots)) {
    strictlyBetter = true;
  }

  for (const skillId of requestedSkillIds) {
    const aSkill = a.skills[skillId] ?? 0;
    const bSkill = b.skills[skillId] ?? 0;
    if (aSkill < bSkill) {
      return false;
    }
    if (aSkill > bSkill) {
      strictlyBetter = true;
    }
  }

  return strictlyBetter;
}

function pruneDominatedArmor(
  pieces: ArmorPiece[],
  requestedSkillIds: number[],
  relevantSetIds: Set<number>,
): ArmorPiece[] {
  if (pieces.length <= 1) {
    return pieces;
  }
  const kept: ArmorPiece[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const candidate = pieces[i];
    let dominated = false;
    for (let j = 0; j < pieces.length; j += 1) {
      if (i === j) {
        continue;
      }
      if (dominatesArmor(pieces[j], candidate, requestedSkillIds, relevantSetIds)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      kept.push(candidate);
    }
  }
  kept.sort((a, b) => a.id - b.id);
  return kept;
}

function collectSetAndGroupBonusSkillIds(
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
): Set<number> {
  const skillIds = new Set<number>();
  for (const key in armorSetsById) {
    const armorSet = armorSetsById[Number(key)];
    const ranks = [...armorSet.bonusRanks, ...armorSet.groupBonusRanks];
    for (const rank of ranks) {
      for (const skillKey in rank.skills) {
        const skillId = Number(skillKey);
        if ((rank.skills[skillId] ?? 0) > 0) {
          skillIds.add(skillId);
        }
      }
    }
  }
  return skillIds;
}

function collectRelevantSetIdsForRequestedSkills(
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
  requestedSkillIds: number[],
): Set<number> {
  const requested = new Set(requestedSkillIds);
  const setIds = new Set<number>();
  for (const key in armorSetsById) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    const ranks = [...armorSet.bonusRanks, ...armorSet.groupBonusRanks];
    let matches = false;
    for (const rank of ranks) {
      for (const skillKey in rank.skills) {
        const skillId = Number(skillKey);
        if (requested.has(skillId) && (rank.skills[skillId] ?? 0) > 0) {
          matches = true;
          break;
        }
      }
      if (matches) {
        break;
      }
    }
    if (matches) {
      setIds.add(setId);
    }
  }
  return setIds;
}

function dominatesCharm(a: CharmRank, b: CharmRank, requestedSkillIds: number[]): boolean {
  let strictlyBetter = false;
  for (const skillId of requestedSkillIds) {
    const aSkill = a.skills[skillId] ?? 0;
    const bSkill = b.skills[skillId] ?? 0;
    if (aSkill < bSkill) {
      return false;
    }
    if (aSkill > bSkill) {
      strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

function pruneDominatedCharms(charms: CharmRank[], requestedSkillIds: number[]): CharmRank[] {
  if (charms.length <= 1) {
    return charms;
  }
  const kept: CharmRank[] = [];
  for (let i = 0; i < charms.length; i += 1) {
    const candidate = charms[i];
    let dominated = false;
    for (let j = 0; j < charms.length; j += 1) {
      if (i === j) {
        continue;
      }
      if (dominatesCharm(charms[j], candidate, requestedSkillIds)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      kept.push(candidate);
    }
  }
  kept.sort((a, b) => a.id - b.id);
  return kept;
}

function buildSkillIndexById(skillIds: number[]): SkillIndexById {
  const indexById: SkillIndexById = {};
  for (let i = 0; i < skillIds.length; i += 1) {
    indexById[skillIds[i]] = i;
  }
  return indexById;
}

function mapRequestedSkillLevels(skillIds: number[], points: SkillPoints): number[] {
  return skillIds.map((skillId) => points[skillId] ?? 0);
}

function slotCountsFromSlots(slots: number[]): number[] {
  const slotCounts = [0, 0, 0, 0, 0];
  for (const slot of slots) {
    if (slot >= 1 && slot <= 4) {
      slotCounts[slot] += 1;
    }
  }
  return slotCounts;
}

function serializeDeficitState(state: DeficitState): string {
  return `${state.deficits.join(",")}|${state.slotCounts[1]},${state.slotCounts[2]},${state.slotCounts[3]},${state.slotCounts[4]}`;
}

function mostUrgentSkillIndex(deficits: number[]): number {
  let bestIndex = -1;
  let bestValue = 0;
  for (let i = 0; i < deficits.length; i += 1) {
    const value = deficits[i];
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function buildDecorationData(
  allDecorations: Decoration[],
  requestedSkillIds: number[],
  useAllDecorations: boolean,
  allowedDecorationIds: number[],
): DecorationData {
  const requestedSkillSet = new Set(requestedSkillIds);
  const allowedSet = new Set(allowedDecorationIds);
  const bySkill: Record<number, Decoration[]> = {};
  const byId: Record<number, Decoration> = {};

  for (const skillId of requestedSkillIds) {
    bySkill[skillId] = [];
  }

  for (const decoration of allDecorations) {
    if (decoration.kind !== "armor") {
      continue;
    }
    if (!useAllDecorations && !allowedSet.has(decoration.id)) {
      continue;
    }
    if (!hasRequestedIntersection(decoration.skills, requestedSkillIds)) {
      continue;
    }
    byId[decoration.id] = decoration;
    for (const skillId of requestedSkillSet) {
      if ((decoration.skills[skillId] ?? 0) > 0) {
        bySkill[skillId].push(decoration);
      }
    }
  }

  for (const skillId of requestedSkillIds) {
    bySkill[skillId].sort((a, b) => {
      const coverageA = requestedSkillIds.reduce(
        (sum, requestSkillId) => sum + ((a.skills[requestSkillId] ?? 0) > 0 ? 1 : 0),
        0,
      );
      const coverageB = requestedSkillIds.reduce(
        (sum, requestSkillId) => sum + ((b.skills[requestSkillId] ?? 0) > 0 ? 1 : 0),
        0,
      );
      if (coverageA !== coverageB) {
        return coverageB - coverageA;
      }
      if (a.slotReq !== b.slotReq) {
        return a.slotReq - b.slotReq;
      }
      return a.id - b.id;
    });
  }

  return { bySkill, byId };
}

function findSmallestFittingSlot(slotCounts: number[], slotReq: SlotSize): SlotSize | null {
  for (let slot = slotReq; slot <= 4; slot += 1) {
    const slotSize = slot as SlotSize;
    if (slotCounts[slotSize] > 0) {
      return slotSize;
    }
  }
  return null;
}

function allDeficitsResolved(deficits: number[]): boolean {
  for (const value of deficits) {
    if (value > 0) {
      return false;
    }
  }
  return true;
}

function assignDecorations(
  skillIds: number[],
  skillIndexById: SkillIndexById,
  deficits: number[],
  slotCounts: number[],
  decorationData: DecorationData,
  memo: Map<string, DecorationPlacement[] | null>,
): DecorationPlacement[] | null {
  if (allDeficitsResolved(deficits)) {
    return [];
  }

  const state: DeficitState = { deficits, slotCounts };
  const key = serializeDeficitState(state);
  if (memo.has(key)) {
    return memo.get(key) ?? null;
  }

  const urgentIndex = mostUrgentSkillIndex(deficits);
  if (urgentIndex < 0) {
    memo.set(key, []);
    return [];
  }

  const urgentSkillId = skillIds[urgentIndex];
  const candidates = decorationData.bySkill[urgentSkillId] ?? [];

  for (const decoration of candidates) {
    const slotToUse = findSmallestFittingSlot(slotCounts, decoration.slotReq);
    if (slotToUse === null) {
      continue;
    }

    const nextDeficits = deficits.slice();
    let improved = false;
    for (const skillKey in decoration.skills) {
      const skillId = Number(skillKey);
      const skillIndex = skillIndexById[skillId];
      if (skillIndex === undefined) {
        continue;
      }
      const amount = decoration.skills[skillId] ?? 0;
      if (amount <= 0) {
        continue;
      }
      const current = nextDeficits[skillIndex];
      if (current <= 0) {
        continue;
      }
      const next = current - amount;
      nextDeficits[skillIndex] = next > 0 ? next : 0;
      improved = true;
    }
    if (!improved) {
      continue;
    }

    const nextSlotCounts = slotCounts.slice();
    nextSlotCounts[slotToUse] -= 1;

    const subPlacement = assignDecorations(
      skillIds,
      skillIndexById,
      nextDeficits,
      nextSlotCounts,
      decorationData,
      memo,
    );
    if (subPlacement !== null) {
      const placement: DecorationPlacement = {
        slotSizeUsed: slotToUse,
        decorationId: decoration.id,
      };
      const solved = [placement, ...subPlacement];
      memo.set(key, solved);
      return solved;
    }
  }

  memo.set(key, null);
  return null;
}

function accumulateBonusRanks(target: SkillPoints, ranks: ArmorSetBonusRank[], pieceCount: number): void {
  for (const rank of ranks) {
    if (pieceCount >= rank.pieces) {
      addSkillPoints(target, rank.skills);
    }
  }
}

function computeSetAndGroupBonusSkills(
  armorPieces: ArmorPiece[],
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
): SkillPoints {
  const setCounts: Record<number, number> = {};
  const groupCounts: Record<number, number> = {};
  const groupRanksById: Record<number, ArmorSetBonusRank[]> = {};

  for (const piece of armorPieces) {
    if (piece.armorSetId === null) {
      continue;
    }
    setCounts[piece.armorSetId] = (setCounts[piece.armorSetId] ?? 0) + 1;
  }

  for (const key in setCounts) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    if (!armorSet || armorSet.groupBonusId === null) {
      continue;
    }
    const groupId = armorSet.groupBonusId;
    groupCounts[groupId] = (groupCounts[groupId] ?? 0) + (setCounts[setId] ?? 0);
    const existingRanks = groupRanksById[groupId];
    if (!existingRanks || existingRanks.length < armorSet.groupBonusRanks.length) {
      groupRanksById[groupId] = armorSet.groupBonusRanks;
    }
  }

  const bonusSkills: SkillPoints = {};

  for (const key in setCounts) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    if (!armorSet) {
      continue;
    }
    accumulateBonusRanks(bonusSkills, armorSet.bonusRanks, setCounts[setId]);
  }

  for (const key in groupCounts) {
    const groupId = Number(key);
    const ranks = groupRanksById[groupId] ?? [];
    accumulateBonusRanks(bonusSkills, ranks, groupCounts[groupId]);
  }

  return bonusSkills;
}

function computeRequestedSetBonusUpperBound(
  skillIds: number[],
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
): number[] {
  const contributionBuckets: number[][] = skillIds.map(() => []);

  for (const key in armorSetsById) {
    const armorSet = armorSetsById[Number(key)];
    const ranks = [...armorSet.bonusRanks, ...armorSet.groupBonusRanks];
    for (const rank of ranks) {
      for (let i = 0; i < skillIds.length; i += 1) {
        const amount = rank.skills[skillIds[i]] ?? 0;
        if (amount > 0) {
          contributionBuckets[i].push(amount);
        }
      }
    }
  }

  return contributionBuckets.map((bucket) => {
    bucket.sort((a, b) => b - a);
    return bucket.slice(0, 5).reduce((sum, value) => sum + value, 0);
  });
}

function buildTieKey(
  armor: Record<ArmorKind, number>,
  charmRankId: number,
  placements: DecorationPlacement[],
): string {
  const placementBits = placements
    .map((placement) => `${placement.slotSizeUsed}-${placement.decorationId}`)
    .sort()
    .join(",");
  return `${armor.head}|${armor.chest}|${armor.arms}|${armor.waist}|${armor.legs}|${charmRankId}|${placementBits}`;
}

export function compareBuildResults(a: BuildResult, b: BuildResult): number {
  if (a.defenseMax !== b.defenseMax) {
    return b.defenseMax - a.defenseMax;
  }
  if (a.leftoverSlotCapacity !== b.leftoverSlotCapacity) {
    return b.leftoverSlotCapacity - a.leftoverSlotCapacity;
  }
  if (a.wastedRequestedPoints !== b.wastedRequestedPoints) {
    return a.wastedRequestedPoints - b.wastedRequestedPoints;
  }
  if (a.defenseBase !== b.defenseBase) {
    return b.defenseBase - a.defenseBase;
  }
  return a.tieKey.localeCompare(b.tieKey);
}

function tryInsertResult(results: BuildResult[], candidate: BuildResult, maxResults: number): void {
  if (maxResults <= 0) {
    return;
  }
  if (results.length < maxResults) {
    results.push(candidate);
    results.sort(compareBuildResults);
    return;
  }
  const worst = results[results.length - 1];
  if (compareBuildResults(candidate, worst) < 0) {
    results[results.length - 1] = candidate;
    results.sort(compareBuildResults);
  }
}

function toRequestedTargets(desiredSkills: OptimizeWorkerRequest["desiredSkills"], skillIds: number[]): number[] {
  const byId: Record<number, number> = {};
  for (const desired of desiredSkills) {
    if (desired.level > 0) {
      byId[desired.skillId] = desired.level;
    }
  }
  return skillIds.map((skillId) => byId[skillId] ?? 0);
}

function buildMaxSkillByKind(
  armorByKind: Record<ArmorKind, ArmorPiece[]>,
  skillIds: number[],
): Record<ArmorKind, number[]> {
  const maxByKind: Record<ArmorKind, number[]> = {
    head: skillIds.map(() => 0),
    chest: skillIds.map(() => 0),
    arms: skillIds.map(() => 0),
    waist: skillIds.map(() => 0),
    legs: skillIds.map(() => 0),
  };
  for (const kind of ARMOR_ORDER) {
    for (const piece of armorByKind[kind]) {
      for (let i = 0; i < skillIds.length; i += 1) {
        const value = piece.skills[skillIds[i]] ?? 0;
        if (value > maxByKind[kind][i]) {
          maxByKind[kind][i] = value;
        }
      }
    }
  }
  return maxByKind;
}

function buildMaxCharmContribution(charms: CharmRank[], skillIds: number[]): number[] {
  const maxBySkill = skillIds.map(() => 0);
  for (const charm of charms) {
    for (let i = 0; i < skillIds.length; i += 1) {
      const value = charm.skills[skillIds[i]] ?? 0;
      if (value > maxBySkill[i]) {
        maxBySkill[i] = value;
      }
    }
  }
  return maxBySkill;
}

function buildRemainingSkillUpperBounds(
  maxByKind: Record<ArmorKind, number[]>,
  skillIds: number[],
): number[][] {
  const upperBounds: number[][] = [];
  for (let i = 0; i <= ARMOR_ORDER.length; i += 1) {
    upperBounds.push(skillIds.map(() => 0));
  }
  for (let i = ARMOR_ORDER.length - 1; i >= 0; i -= 1) {
    const kind = ARMOR_ORDER[i];
    for (let s = 0; s < skillIds.length; s += 1) {
      upperBounds[i][s] = upperBounds[i + 1][s] + maxByKind[kind][s];
    }
  }
  return upperBounds;
}

function buildSetBonusProvidersBySkill(
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
  requestedSkillIds: number[],
): Record<number, SetBonusProvider[]> {
  const requested = new Set(requestedSkillIds);
  const providersBySkill: Record<number, SetBonusProvider[]> = {};

  for (const skillId of requestedSkillIds) {
    providersBySkill[skillId] = [];
  }

  for (const key in armorSetsById) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    if (armorSet.bonusRanks.length === 0) {
      continue;
    }

    const thresholdsBySkill: Record<number, Array<{ pieces: number; level: number }>> = {};
    for (const rank of armorSet.bonusRanks) {
      for (const skillKey in rank.skills) {
        const skillId = Number(skillKey);
        if (!requested.has(skillId)) {
          continue;
        }
        const level = rank.skills[skillId] ?? 0;
        if (level <= 0) {
          continue;
        }
        if (!thresholdsBySkill[skillId]) {
          thresholdsBySkill[skillId] = [];
        }
        thresholdsBySkill[skillId].push({ pieces: rank.pieces, level });
      }
    }

    for (const skillIdKey in thresholdsBySkill) {
      const skillId = Number(skillIdKey);
      const thresholds = thresholdsBySkill[skillId].sort((a, b) => a.pieces - b.pieces);
      providersBySkill[skillId].push({ setId, thresholds });
    }
  }

  return providersBySkill;
}

export function optimizeBuilds(
  request: OptimizeWorkerRequest,
  workerIndex = 0,
  onProgress?: (progress: OptimizeProgressPayload) => void,
): OptimizeWorkerResponse {
  const startedAt = nowMs();
  const stats: WorkerStats = {
    branchesVisited: 0,
    prunedByBound: 0,
    completedArmorCombos: 0,
    feasibleBuilds: 0,
    durationMs: 0,
  };

  const desiredById = new Map<number, number>();
  for (const desired of request.desiredSkills) {
    if (desired.level > 0) {
      desiredById.set(desired.skillId, desired.level);
    }
  }
  const requestedSkillIds = [...desiredById.keys()].sort((a, b) => a - b);
  if (requestedSkillIds.length === 0) {
    stats.durationMs = nowMs() - startedAt;
    return {
      workerIndex,
      results: [],
      stats,
      error: "At least one target skill is required.",
    };
  }

  const allowedHeadSet = new Set<number>(request.allowedHeadIds);
  const setAndGroupBonusSkillIds = collectSetAndGroupBonusSkillIds(request.data.armorSetsById);
  const requestedHasSetOrGroupBonusSkill = requestedSkillIds.some((skillId) => setAndGroupBonusSkillIds.has(skillId));
  const relevantSetIds = requestedHasSetOrGroupBonusSkill
    ? collectRelevantSetIdsForRequestedSkills(request.data.armorSetsById, requestedSkillIds)
    : new Set<number>();

  const filteredByKind: Record<ArmorKind, ArmorPiece[]> = {
    head: [],
    chest: [],
    arms: [],
    waist: [],
    legs: [],
  };

  for (const kind of ARMOR_ORDER) {
    const allowed = request.data.armorByKind[kind].filter((piece) => armorAllowed(piece, request.allowAlpha, request.allowGamma));
    const constrained = kind === "head" ? allowed.filter((piece) => allowedHeadSet.has(piece.id)) : allowed;
    filteredByKind[kind] = pruneDominatedArmor(
      constrained,
      requestedSkillIds,
      relevantSetIds,
    );
    if (filteredByKind[kind].length === 0) {
      stats.durationMs = nowMs() - startedAt;
      return {
        workerIndex,
        results: [],
        stats,
      };
    }
  }

  const prunedCharms = pruneDominatedCharms(request.data.charmRanks, requestedSkillIds);
  if (prunedCharms.length === 0) {
    stats.durationMs = nowMs() - startedAt;
    return {
      workerIndex,
      results: [],
      stats,
    };
  }

  const totalArmorCombos =
    filteredByKind.head.length *
    filteredByKind.chest.length *
    filteredByKind.arms.length *
    filteredByKind.waist.length *
    filteredByKind.legs.length;
  const totalCandidates = totalArmorCombos * prunedCharms.length;
  let lastProgressSentAt = startedAt;

  function emitProgress(force = false): void {
    if (!onProgress) {
      return;
    }
    const currentTime = nowMs();
    if (!force) {
      const dueToTime = currentTime - lastProgressSentAt >= 120;
      const dueToCombos = stats.completedArmorCombos > 0 && stats.completedArmorCombos % 100 === 0;
      if (!dueToTime && !dueToCombos) {
        return;
      }
    }
    lastProgressSentAt = currentTime;
    onProgress({
      completedArmorCombos: stats.completedArmorCombos,
      totalArmorCombos,
      evaluatedCandidates: stats.completedArmorCombos * prunedCharms.length,
      totalCandidates,
      feasibleBuilds: stats.feasibleBuilds,
      branchesVisited: stats.branchesVisited,
      prunedByBound: stats.prunedByBound,
      elapsedMs: currentTime - startedAt,
    });
  }

  const targets = toRequestedTargets(request.desiredSkills, requestedSkillIds);
  const skillIndexById = buildSkillIndexById(requestedSkillIds);

  const maxByKind = buildMaxSkillByKind(filteredByKind, requestedSkillIds);
  const maxCharm = buildMaxCharmContribution(prunedCharms, requestedSkillIds);
  const maxSetBonus = computeRequestedSetBonusUpperBound(requestedSkillIds, request.data.armorSetsById);
  const setBonusProvidersBySkill = buildSetBonusProvidersBySkill(request.data.armorSetsById, requestedSkillIds);
  const remainingUpperBounds = buildRemainingSkillUpperBounds(maxByKind, requestedSkillIds);

  const decorationData = buildDecorationData(
    request.data.decorations,
    requestedSkillIds,
    request.useAllDecorations,
    request.allowedDecorationIds,
  );

  for (const skillId of requestedSkillIds) {
    const hasCoverage = (decorationData.bySkill[skillId]?.length ?? 0) > 0;
    const canMeetWithoutDeco =
      maxCharm[skillIndexById[skillId]] +
        maxSetBonus[skillIndexById[skillId]] +
        remainingUpperBounds[0][skillIndexById[skillId]] >=
      targets[skillIndexById[skillId]];
    if (!hasCoverage && !canMeetWithoutDeco) {
      stats.durationMs = nowMs() - startedAt;
      return {
        workerIndex,
        results: [],
        stats,
      };
    }
  }

  const decorationMemo = new Map<string, DecorationPlacement[] | null>();
  const topResults: BuildResult[] = [];
  const selected: Partial<Record<ArmorKind, ArmorPiece>> = {};
  const currentRequested = requestedSkillIds.map(() => 0);
  const selectedSetCounts: Record<number, number> = {};
  const setBonusUpperMemo = new Map<string, number>();
  emitProgress(true);

  function maxSetBonusFromCurrentCounts(skillId: number, remainingPieces: number): number {
    const providers = setBonusProvidersBySkill[skillId];
    if (!providers || providers.length === 0) {
      return 0;
    }

    const countsKey = providers.map((provider) => selectedSetCounts[provider.setId] ?? 0).join(",");
    const memoKey = `${skillId}|${remainingPieces}|${countsKey}`;
    const cached = setBonusUpperMemo.get(memoKey);
    if (cached !== undefined) {
      return cached;
    }

    let dp = new Array(remainingPieces + 1).fill(Number.NEGATIVE_INFINITY);
    dp[0] = 0;

    for (const provider of providers) {
      const next = new Array(remainingPieces + 1).fill(Number.NEGATIVE_INFINITY);
      for (let used = 0; used <= remainingPieces; used += 1) {
        if (!Number.isFinite(dp[used])) {
          continue;
        }
        for (let add = 0; used + add <= remainingPieces; add += 1) {
          const pieceCount = (selectedSetCounts[provider.setId] ?? 0) + add;
          let level = 0;
          for (const threshold of provider.thresholds) {
            if (pieceCount >= threshold.pieces && threshold.level > level) {
              level = threshold.level;
            }
          }
          const value = dp[used] + level;
          if (value > next[used + add]) {
            next[used + add] = value;
          }
        }
      }
      dp = next;
    }

    let best = 0;
    for (const value of dp) {
      if (Number.isFinite(value) && value > best) {
        best = value;
      }
    }
    setBonusUpperMemo.set(memoKey, best);
    return best;
  }

  function canStillHitTargets(kindIndex: number): boolean {
    const remainingPieces = ARMOR_ORDER.length - kindIndex;
    for (let i = 0; i < requestedSkillIds.length; i += 1) {
      const skillId = requestedSkillIds[i];
      const setBonusUpper =
        (setBonusProvidersBySkill[skillId]?.length ?? 0) > 0
          ? maxSetBonusFromCurrentCounts(skillId, remainingPieces)
          : maxSetBonus[i];
      const upperBound = currentRequested[i] + remainingUpperBounds[kindIndex][i] + maxCharm[i] + setBonusUpper;
      if (upperBound < targets[i]) {
        return false;
      }
    }
    return true;
  }

  function evaluateCompleteArmorSet(): void {
    stats.completedArmorCombos += 1;
    const armorPieces: ArmorPiece[] = ARMOR_ORDER.map((kind) => selected[kind]).filter(
      (piece): piece is ArmorPiece => piece !== undefined,
    );
    if (armorPieces.length !== ARMOR_ORDER.length) {
      return;
    }

    const baseSkills: SkillPoints = {};
    const slots: number[] = [];
    const armorIds: Record<ArmorKind, number> = {
      head: armorPieces[0].id,
      chest: armorPieces[1].id,
      arms: armorPieces[2].id,
      waist: armorPieces[3].id,
      legs: armorPieces[4].id,
    };
    const resist = {
      fire: 0,
      water: 0,
      ice: 0,
      thunder: 0,
      dragon: 0,
    };
    let defenseBase = 0;
    let defenseMax = 0;

    for (const piece of armorPieces) {
      addSkillPoints(baseSkills, piece.skills);
      for (const slot of piece.slots) {
        slots.push(slot);
      }
      defenseBase += piece.defenseBase;
      defenseMax += piece.defenseMax;
      resist.fire += piece.resist.fire;
      resist.water += piece.resist.water;
      resist.ice += piece.resist.ice;
      resist.thunder += piece.resist.thunder;
      resist.dragon += piece.resist.dragon;
    }

    const setBonusSkills = computeSetAndGroupBonusSkills(armorPieces, request.data.armorSetsById);
    addSkillPoints(baseSkills, setBonusSkills);
    const requestedBase = mapRequestedSkillLevels(requestedSkillIds, baseSkills);

    for (const charm of prunedCharms) {
      const totalsBeforeDecos = cloneSkillPoints(baseSkills);
      addSkillPoints(totalsBeforeDecos, charm.skills);

      const deficits = requestedSkillIds.map((skillId, index) => {
        const total = requestedBase[index] + (charm.skills[skillId] ?? 0);
        const deficit = targets[index] - total;
        return deficit > 0 ? deficit : 0;
      });

      const allSlots = [...slots, ...charm.slots];
      const slotCounts = slotCountsFromSlots(allSlots);
      const placement = assignDecorations(
        requestedSkillIds,
        skillIndexById,
        deficits,
        slotCounts,
        decorationData,
        decorationMemo,
      );
      if (placement === null) {
        continue;
      }

      const totalsAfterDecos = cloneSkillPoints(totalsBeforeDecos);
      for (const item of placement) {
        const decoration = decorationData.byId[item.decorationId];
        if (!decoration) {
          continue;
        }
        addSkillPoints(totalsAfterDecos, decoration.skills);
      }

      let allTargetsMet = true;
      let wastedRequestedPoints = 0;
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        const skillId = requestedSkillIds[i];
        const total = totalsAfterDecos[skillId] ?? 0;
        const target = targets[i];
        if (total < target) {
          allTargetsMet = false;
          break;
        }
        if (total > target) {
          wastedRequestedPoints += total - target;
        }
      }
      if (!allTargetsMet) {
        continue;
      }

      const totalSlotCapacity = allSlots.reduce((sum, value) => sum + value, 0);
      const usedSlotCapacity = placement.reduce((sum, value) => sum + value.slotSizeUsed, 0);
      const leftoverSlotCapacity = totalSlotCapacity - usedSlotCapacity;

      const tieKey = buildTieKey(armorIds, charm.id, placement);
      const result: BuildResult = {
        armor: armorIds,
        charmRankId: charm.id,
        placements: placement,
        skillTotals: totalsAfterDecos,
        defenseBase,
        defenseMax,
        resist,
        leftoverSlotCapacity,
        wastedRequestedPoints,
        tieKey,
      };

      stats.feasibleBuilds += 1;
      tryInsertResult(topResults, result, request.maxResults);
    }

    emitProgress();
  }

  function dfs(kindIndex: number): void {
    stats.branchesVisited += 1;
    if (!canStillHitTargets(kindIndex)) {
      stats.prunedByBound += 1;
      return;
    }
    if (kindIndex >= ARMOR_ORDER.length) {
      evaluateCompleteArmorSet();
      return;
    }

    const kind = ARMOR_ORDER[kindIndex];
    for (const piece of filteredByKind[kind]) {
      selected[kind] = piece;
      if (piece.armorSetId !== null) {
        selectedSetCounts[piece.armorSetId] = (selectedSetCounts[piece.armorSetId] ?? 0) + 1;
      }
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        currentRequested[i] += piece.skills[requestedSkillIds[i]] ?? 0;
      }
      dfs(kindIndex + 1);
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        currentRequested[i] -= piece.skills[requestedSkillIds[i]] ?? 0;
      }
      if (piece.armorSetId !== null) {
        selectedSetCounts[piece.armorSetId] -= 1;
        if (selectedSetCounts[piece.armorSetId] <= 0) {
          delete selectedSetCounts[piece.armorSetId];
        }
      }
    }
  }

  dfs(0);

  topResults.sort(compareBuildResults);
  stats.durationMs = nowMs() - startedAt;
  emitProgress(true);
  return {
    workerIndex,
    results: topResults,
    stats,
  };
}
