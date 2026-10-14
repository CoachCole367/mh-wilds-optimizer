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
  WeaponSetBonusPieces,
} from "./types";
import { normalizeWeaponSetBonusPieces } from "./weaponSetBonus";

const ARMOR_ORDER: ArmorKind[] = ["head", "chest", "arms", "waist", "legs"];
const MIN_DECORATION_MEMO_ENTRIES = 20_000;
const BASE_DECORATION_MEMO_ENTRIES = 100_000;
const MIN_SET_BONUS_MEMO_ENTRIES = 6_000;
const BASE_SET_BONUS_MEMO_ENTRIES = 30_000;

type SkillIndexById = Record<number, number>;

type DecorationData = {
  bySkill: Record<number, Decoration[]>;
  byId: Record<number, Decoration>;
};

type DecorationUpperBound = Record<number, [0, number, number, number, number]>;
type DecorationTotalUpperBound = [0, number, number, number, number];
type SlotCountVector = [0, number, number, number, number];

type CharmEvalData = {
  charm: CharmRank;
  requestedLevels: number[];
  slotCounts: SlotCountVector;
  slotCapacity: number;
};

type DeficitState = {
  deficits: number[];
  slotCounts: number[];
};

type OptimizeProgressPayload = Omit<
  OptimizeWorkerProgress,
  "type" | "workerIndex"
>;

type SetBonusProvider = {
  setId: number;
  thresholds: Array<{ pieces: number; level: number }>;
};

type SetPieceCounts = Record<string, number>;

function resolveDecorationMemoLimit(
  skillCount: number,
  includeNearMissResults: boolean,
): number {
  const pressureScale = includeNearMissResults ? 0.7 : 1;
  const skillScale = Math.min(1, 8 / Math.max(1, skillCount));
  return Math.max(
    MIN_DECORATION_MEMO_ENTRIES,
    Math.floor(BASE_DECORATION_MEMO_ENTRIES * pressureScale * skillScale),
  );
}

function resolveSetBonusMemoLimit(
  skillCount: number,
  includeNearMissResults: boolean,
): number {
  const pressureScale = includeNearMissResults ? 0.8 : 1;
  const skillScale = Math.min(1, 8 / Math.max(1, skillCount));
  return Math.max(
    MIN_SET_BONUS_MEMO_ENTRIES,
    Math.floor(BASE_SET_BONUS_MEMO_ENTRIES * pressureScale * skillScale),
  );
}

function memoSetWithCap<T>(
  memo: Map<string, T>,
  key: string,
  value: T,
  maxEntries: number,
): void {
  if (maxEntries > 0) {
    while (memo.size >= maxEntries) {
      const oldestKey = memo.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      memo.delete(oldestKey);
    }
  }
  memo.set(key, value);
}

function buildDecorationUpperBounds(
  decorationData: DecorationData,
  requestedSkillIds: number[],
): DecorationUpperBound {
  const bySkill: DecorationUpperBound = {};
  for (const skillId of requestedSkillIds) {
    const maxGainBySlot: [0, number, number, number, number] = [0, 0, 0, 0, 0];
    const candidates = decorationData.bySkill[skillId] ?? [];
    for (const decoration of candidates) {
      const gain = decoration.skills[skillId] ?? 0;
      if (gain <= 0) {
        continue;
      }
      for (let slotSize = decoration.slotReq; slotSize <= 4; slotSize += 1) {
        if (gain > maxGainBySlot[slotSize as SlotSize]) {
          maxGainBySlot[slotSize as SlotSize] = gain;
        }
      }
    }
    bySkill[skillId] = maxGainBySlot;
  }
  return bySkill;
}

function buildDecorationTotalUpperBound(
  decorationData: DecorationData,
  requestedSkillIds: number[],
): DecorationTotalUpperBound {
  const maxTotalGainBySlot: DecorationTotalUpperBound = [0, 0, 0, 0, 0];
  const seenDecorationIds = new Set<number>();

  for (const skillId of requestedSkillIds) {
    for (const decoration of decorationData.bySkill[skillId] ?? []) {
      if (seenDecorationIds.has(decoration.id)) {
        continue;
      }
      seenDecorationIds.add(decoration.id);
      let totalRequestedGain = 0;
      for (const requestedSkillId of requestedSkillIds) {
        const gain = decoration.skills[requestedSkillId] ?? 0;
        if (gain > 0) {
          totalRequestedGain += gain;
        }
      }
      if (totalRequestedGain <= 0) {
        continue;
      }
      for (let slotSize = decoration.slotReq; slotSize <= 4; slotSize += 1) {
        const slot = slotSize as SlotSize;
        if (totalRequestedGain > maxTotalGainBySlot[slot]) {
          maxTotalGainBySlot[slot] = totalRequestedGain;
        }
      }
    }
  }

  return maxTotalGainBySlot;
}

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

function hasRequestedIntersection(
  skills: SkillPoints,
  requestedSkillIds: number[],
): boolean {
  for (const skillId of requestedSkillIds) {
    if ((skills[skillId] ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function armorAllowed(
  piece: ArmorPiece,
  allowAlpha: boolean,
  allowGamma: boolean,
): boolean {
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
  if (
    a.defenseBase < b.defenseBase ||
    Object.keys(a.resist).some(
      (k) =>
        a.resist[k as keyof typeof a.resist] <
        b.resist[k as keyof typeof b.resist],
    )
  )
    return false;

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
    // Extra requested points are penalized; unequal totals are not dominance.
    if (aSkill !== bSkill) {
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
      if (
        dominatesArmor(pieces[j], candidate, requestedSkillIds, relevantSetIds)
      ) {
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

function dominatesCharm(
  a: CharmRank,
  b: CharmRank,
  requestedSkillIds: number[],
): boolean {
  if (!slotsAtLeast(a.weaponSlots ?? [], b.weaponSlots ?? [])) return false;
  let strictlyBetter = false;
  for (const skillId of requestedSkillIds) {
    const aSkill = a.skills[skillId] ?? 0;
    const bSkill = b.skills[skillId] ?? 0;
    if (aSkill !== bSkill) {
      return false;
    }
    if (aSkill > bSkill) {
      strictlyBetter = true;
    }
  }

  if (!slotsAtLeast(a.slots, b.slots)) {
    return false;
  }
  if (slotsStrictlyBetter(a.slots, b.slots)) {
    strictlyBetter = true;
  }

  return strictlyBetter;
}

function pruneDominatedCharms(
  charms: CharmRank[],
  requestedSkillIds: number[],
): CharmRank[] {
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

function mapRequestedSkillLevels(
  skillIds: number[],
  points: SkillPoints,
): number[] {
  return skillIds.map((skillId) => points[skillId] ?? 0);
}

function slotCountsFromSlots(slots: number[]): SlotCountVector {
  const slotCounts: SlotCountVector = [0, 0, 0, 0, 0];
  for (const slot of slots) {
    if (slot >= 1 && slot <= 4) {
      slotCounts[slot] += 1;
    }
  }
  return slotCounts;
}

function serializeDeficitState(state: DeficitState): string {
  return `${state.deficits.join(",")}|${state.slotCounts.slice(1).join(",")}`;
}

function sumDeficits(deficits: number[]): number {
  let total = 0;
  for (const value of deficits) {
    if (value > 0) {
      total += value;
    }
  }
  return total;
}

function mostUrgentSkillIndex(
  deficits: number[],
  skillIds: number[],
  decorationData: DecorationData,
): number {
  let bestIndex = -1;
  let bestCandidateCount = Number.POSITIVE_INFINITY;
  let bestDeficit = 0;
  for (let i = 0; i < deficits.length; i += 1) {
    const deficit = deficits[i];
    if (deficit <= 0) {
      continue;
    }
    const candidates = decorationData.bySkill[skillIds[i]] ?? [];
    const candidateCount = candidates.length;
    if (
      candidateCount < bestCandidateCount ||
      (candidateCount === bestCandidateCount && deficit > bestDeficit)
    ) {
      bestCandidateCount = candidateCount;
      bestDeficit = deficit;
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
  const coverageByDecorationId: Record<number, number> = {};

  for (const skillId of requestedSkillIds) {
    bySkill[skillId] = [];
  }

  for (const decoration of allDecorations) {
    if (!["armor", "weapon"].includes(decoration.kind.toLowerCase())) continue;
    if (!useAllDecorations && !allowedSet.has(decoration.id)) {
      continue;
    }
    if (!hasRequestedIntersection(decoration.skills, requestedSkillIds)) {
      continue;
    }
    byId[decoration.id] = decoration;
    let coverage = 0;
    for (const skillId of requestedSkillSet) {
      if ((decoration.skills[skillId] ?? 0) > 0) {
        bySkill[skillId].push(decoration);
        coverage += 1;
      }
    }
    coverageByDecorationId[decoration.id] = coverage;
  }

  for (const skillId of requestedSkillIds) {
    bySkill[skillId].sort((a, b) => {
      const gainA = a.skills[skillId] ?? 0;
      const gainB = b.skills[skillId] ?? 0;
      if (gainA !== gainB) {
        return gainB - gainA;
      }
      const coverageA = coverageByDecorationId[a.id] ?? 0;
      const coverageB = coverageByDecorationId[b.id] ?? 0;
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

function findSmallestFittingSlot(
  slotCounts: number[],
  slotReq: SlotSize,
): SlotSize | null {
  for (let slot = slotReq; slot <= 4; slot += 1) {
    const slotSize = slot as SlotSize;
    if (slotCounts[slotSize] > 0) {
      return slotSize;
    }
  }
  return null;
}

function assignDecorations(
  skillIds: number[],
  skillIndexById: SkillIndexById,
  deficits: number[],
  slotCounts: number[],
  maxRemainingMissing: number,
  decorationData: DecorationData,
  decorationUpperBounds: DecorationUpperBound,
  decorationTotalUpperBound: DecorationTotalUpperBound,
  memo: Map<string, DecorationPlacement[] | null>,
  memoMaxEntries: number,
  inventory?: Record<number, number>,
  preferred = skillIds.map(() => -1),
): DecorationPlacement[] | null {
  const totalDeficit = sumDeficits(deficits);
  if (totalDeficit === 0 && !preferred.some((n) => n > 0)) return [];
  const stockKey = inventory
    ? Object.entries(inventory)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([id, n]) => id + ":" + n)
        .join(",")
    : "unlimited";
  const key =
    skillIds.join(",") +
    "|" +
    maxRemainingMissing +
    "|" +
    serializeDeficitState({ deficits, slotCounts }) +
    "|" +
    stockKey +
    "|" +
    preferred.join(",");
  if (memo.has(key)) return memo.get(key) ?? null;
  const allSlots = slotCounts
    .slice(1, 5)
    .map((n, i) => n + (slotCounts[i + 5] ?? 0));
  const optimistic = allSlots.reduce(
    (sum, n, i) => sum + n * decorationTotalUpperBound[(i + 1) as SlotSize],
    0,
  );
  if (optimistic + maxRemainingMissing < totalDeficit) {
    memoSetWithCap(memo, key, null, memoMaxEntries);
    return null;
  }
  const requiredUrgent = mostUrgentSkillIndex(
    deficits,
    skillIds,
    decorationData,
  );
  const urgent =
    requiredUrgent >= 0
      ? requiredUrgent
      : mostUrgentSkillIndex(
          preferred.map((n) => Math.max(0, n)),
          skillIds,
          decorationData,
        );
  if (urgent < 0) return [];
  let best: DecorationPlacement[] | null =
    totalDeficit <= maxRemainingMissing ? [] : null;
  // Missing points can be allocated to any target, including an unfillable skill.
  if (requiredUrgent < 0 || deficits[urgent] <= maxRemainingMissing) {
    const next = deficits.slice(),
      nextPreferred = preferred.slice();
    if (requiredUrgent < 0) nextPreferred[urgent] = 0;
    else next[urgent] = 0;
    best = assignDecorations(
      skillIds,
      skillIndexById,
      next,
      slotCounts,
      maxRemainingMissing - (requiredUrgent < 0 ? 0 : deficits[urgent]),
      decorationData,
      decorationUpperBounds,
      decorationTotalUpperBound,
      memo,
      memoMaxEntries,
      inventory,
      nextPreferred,
    );
  }
  function cost(
    items: DecorationPlacement[],
  ): [number, number, number, number, string] {
    const gained = skillIds.map(() => 0);
    let used = 0;
    for (const item of items) {
      used += item.slotSizeUsed;
      const deco = decorationData.byId[item.decorationId];
      skillIds.forEach((id, i) => (gained[i] += deco.skills[id] ?? 0));
    }
    return [
      deficits.reduce((sum, n, i) => sum + Math.max(0, n - gained[i]), 0),
      -preferred.reduce(
        (sum, n, i) => sum + (n < 0 ? 0 : Math.min(n, gained[i])),
        0,
      ),
      used,
      deficits.reduce(
        (sum, n, i) =>
          sum + (preferred[i] < 0 ? Math.max(0, gained[i] - n) : 0),
        0,
      ),
      items
        .map((p) => p.decorationId + ":" + p.slotSizeUsed + ":" + p.slotKind)
        .sort()
        .join(","),
    ];
  }
  function better(a: DecorationPlacement[], b: DecorationPlacement[]): boolean {
    const x = cost(a),
      y = cost(b);
    for (let i = 0; i < 4; i++) {
      if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number);
    }
    return x[4] < y[4];
  }
  for (const deco of decorationData.bySkill[skillIds[urgent]] ?? []) {
    if (inventory && (inventory[deco.id] ?? 0) <= 0) continue;
    const offset = deco.kind.toLowerCase() === "weapon" ? 4 : 0;
    const slot = findSmallestFittingSlot(
      offset ? [0, ...slotCounts.slice(5, 9)] : slotCounts,
      deco.slotReq,
    );
    if (slot === null) continue;
    const next = deficits.map((n, i) =>
      Math.max(0, n - (deco.skills[skillIds[i]] ?? 0)),
    );
    const nextSlots = slotCounts.slice();
    nextSlots[slot + offset] -= 1;
    const stock = inventory
      ? { ...inventory, [deco.id]: inventory[deco.id] - 1 }
      : undefined;
    const sub = assignDecorations(
      skillIds,
      skillIndexById,
      next,
      nextSlots,
      maxRemainingMissing,
      decorationData,
      decorationUpperBounds,
      decorationTotalUpperBound,
      memo,
      memoMaxEntries,
      stock,
      preferred.map((n, i) =>
        n < 0 ? -1 : Math.max(0, n - (deco.skills[skillIds[i]] ?? 0)),
      ),
    );
    if (sub !== null) {
      const candidate = [
        {
          decorationId: deco.id,
          slotSizeUsed: slot,
          slotKind: offset ? ("weapon" as const) : ("armor" as const),
        },
        ...sub,
      ];
      if (best === null || better(candidate, best)) best = candidate;
    }
  }
  memoSetWithCap(memo, key, best, memoMaxEntries);
  return best;
}

function buildArmorSetPieceCounts(armorPieces: ArmorPiece[]): SetPieceCounts {
  const counts: SetPieceCounts = {};
  for (const piece of armorPieces) {
    if (piece.armorSetId === null) {
      continue;
    }
    const setId = String(piece.armorSetId);
    counts[setId] = (counts[setId] ?? 0) + 1;
  }
  return counts;
}

function mergeArmorAndWeaponSetPieceCounts(
  armorSetCounts: SetPieceCounts,
  weaponSetBonusPieces: WeaponSetBonusPieces,
): SetPieceCounts {
  const merged: SetPieceCounts = { ...armorSetCounts };
  for (const [setId, rawCount] of Object.entries(weaponSetBonusPieces)) {
    const count = Math.floor(Number(rawCount));
    if (!setId || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    merged[setId] = (merged[setId] ?? 0) + count;
  }
  return merged;
}

function toSingleWeaponSetBonusPieces(setId: string): WeaponSetBonusPieces {
  if (!setId) {
    return {};
  }
  return { [setId]: 1 };
}

function accumulateBonusRanks(
  target: SkillPoints,
  ranks: ArmorSetBonusRank[],
  pieceCount: number,
): void {
  const bestBySkill: SkillPoints = {};
  for (const rank of ranks) {
    if (pieceCount < rank.pieces) {
      continue;
    }
    for (const key in rank.skills) {
      const skillId = Number(key);
      const level = rank.skills[skillId] ?? 0;
      if (level <= 0) {
        continue;
      }
      if ((bestBySkill[skillId] ?? 0) < level) {
        bestBySkill[skillId] = level;
      }
    }
  }
  addSkillPoints(target, bestBySkill);
}

function computeSetAndGroupBonusSkills(
  armorPieces: ArmorPiece[],
  armorSetsById: OptimizeWorkerRequest["data"]["armorSetsById"],
  weaponSetBonusPieces: WeaponSetBonusPieces,
  weaponGroups?: Record<string, number>,
): SkillPoints {
  const setCounts = mergeArmorAndWeaponSetPieceCounts(
    buildArmorSetPieceCounts(armorPieces),
    weaponSetBonusPieces,
  );
  const groupCounts: Record<number, number> = {};
  const groupRanksById: Record<number, ArmorSetBonusRank[]> = {};

  const groupSourceCounts =
    weaponGroups === undefined
      ? setCounts
      : buildArmorSetPieceCounts(armorPieces);
  for (const key in groupSourceCounts) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    if (!armorSet || armorSet.groupBonusId === null) {
      continue;
    }
    const groupId = armorSet.groupBonusId;
    groupCounts[groupId] =
      (groupCounts[groupId] ?? 0) + (groupSourceCounts[key] ?? 0);
    const existingRanks = groupRanksById[groupId];
    if (
      !existingRanks ||
      existingRanks.length < armorSet.groupBonusRanks.length
    ) {
      groupRanksById[groupId] = armorSet.groupBonusRanks;
    }
  }

  for (const [id, n] of Object.entries(weaponGroups ?? {})) {
    const groupId = Number(id);
    const provider = Object.values(armorSetsById).find(
      (s) => s.groupBonusId === groupId,
    );
    if (provider && n > 0) {
      groupCounts[groupId] = (groupCounts[groupId] ?? 0) + Math.min(1, n);
      groupRanksById[groupId] = provider.groupBonusRanks;
    }
  }
  const bonusSkills: SkillPoints = {};

  for (const key in setCounts) {
    const setId = Number(key);
    const armorSet = armorSetsById[setId];
    if (!armorSet) {
      continue;
    }
    accumulateBonusRanks(bonusSkills, armorSet.bonusRanks, setCounts[key]);
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
  const aMissing = a.missingRequestedPoints ?? 0;
  const bMissing = b.missingRequestedPoints ?? 0;
  if (aMissing !== bMissing) {
    return aMissing - bMissing;
  }
  if ((a.optionalSkillPoints ?? 0) !== (b.optionalSkillPoints ?? 0))
    return (b.optionalSkillPoints ?? 0) - (a.optionalSkillPoints ?? 0);
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

export function compareForMode(
  a: BuildResult,
  b: BuildResult,
  mode: OptimizeWorkerRequest["sortMode"] = "defense",
): number {
  const missing =
    (a.missingRequestedPoints ?? 0) - (b.missingRequestedPoints ?? 0);
  if (missing) return missing;
  const preferred = (b.optionalSkillPoints ?? 0) - (a.optionalSkillPoints ?? 0);
  if (preferred) return preferred;
  if (mode === "slots" && a.leftoverSlotCapacity !== b.leftoverSlotCapacity)
    return b.leftoverSlotCapacity - a.leftoverSlotCapacity;
  if (
    mode !== "defense" &&
    mode !== "slots" &&
    mode &&
    a.resist[mode] !== b.resist[mode]
  )
    return b.resist[mode] - a.resist[mode];
  return compareBuildResults(a, b);
}

function filterArmor(
  request: OptimizeWorkerRequest,
  kind: ArmorKind,
): ArmorPiece[] {
  const ids = request.armorConstraints?.[kind];
  return request.data.armorByKind[kind]
    .filter(
      (p) =>
        armorAllowed(p, request.allowAlpha, request.allowGamma) &&
        (!ids || ids.includes(p.id)) &&
        (!request.maxRarity || p.rarity <= request.maxRarity) &&
        (!request.armorRank ||
          request.armorRank === "all" ||
          p.rank === request.armorRank),
    )
    .map((p) =>
      request.armorUpgradeMode === "base"
        ? { ...p, defenseMax: p.defenseBase, upgradeState: "base" as const }
        : p,
    );
}

/** Prepare globally before sharding, so worker count cannot change the candidate pool. */
export function prepareSearchData(
  request: OptimizeWorkerRequest,
): NormalizedSearchData {
  const requestedIds = request.desiredSkills.map((s) => s.skillId);
  const relevant = collectRelevantSetIdsForRequestedSkills(
    request.data.armorSetsById,
    requestedIds,
  );
  const armorByKind = { ...request.data.armorByKind };
  const armorById = { ...request.data.armorById };
  for (const kind of ARMOR_ORDER) {
    armorByKind[kind] = pruneDominatedArmor(
      filterArmor(request, kind),
      requestedIds,
      relevant,
    ).sort(
      (a, b) =>
        b.defenseMax - a.defenseMax ||
        b.slots.reduce((n, s) => n + s, 0) -
          a.slots.reduce((n, s) => n + s, 0) ||
        a.id - b.id,
    );
    for (const piece of armorByKind[kind]) armorById[piece.id] = piece;
  }
  return { ...request.data, armorByKind, armorById };
}
type NormalizedSearchData = OptimizeWorkerRequest["data"];

function locatePlacements(result: BuildResult, pieces: ArmorPiece[]): void {
  const slots: Array<{
    piece: ArmorKind | "charm" | "weapon";
    slotIndex: number;
    size: SlotSize;
    kind: "armor" | "weapon";
    used: boolean;
  }> = pieces.flatMap((p) =>
    p.slots.map((size, slotIndex) => ({
      piece: p.kind,
      slotIndex,
      size,
      kind: "armor" as const,
      used: false,
    })),
  );
  result.charmSlots.forEach((size, slotIndex) =>
    slots.push({ piece: "charm", slotIndex, size, kind: "armor", used: false }),
  );
  result.equippedCharm?.weaponSlots?.forEach((size, slotIndex) =>
    slots.push({
      piece: "charm",
      slotIndex,
      size,
      kind: "weapon",
      used: false,
    }),
  );
  result.weaponSlots?.forEach((size, slotIndex) =>
    slots.push({
      piece: "weapon",
      slotIndex,
      size,
      kind: "weapon",
      used: false,
    }),
  );
  for (const placement of result.placements) {
    const slot = slots.find(
      (s) =>
        !s.used &&
        s.size === placement.slotSizeUsed &&
        s.kind === (placement.slotKind ?? "armor"),
    );
    if (!slot) throw new Error("Invalid decoration assignment.");
    slot.used = true;
    placement.piece = slot.piece;
    placement.slotIndex = slot.slotIndex;
  }
}

function tryInsertResult(
  results: BuildResult[],
  candidate: BuildResult,
  maxResults: number,
  compare = compareBuildResults,
): void {
  if (maxResults <= 0) return;
  let low = 0,
    high = results.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(candidate, results[mid]) < 0) high = mid;
    else low = mid + 1;
  }
  if (low >= maxResults) return;
  results.splice(low, 0, candidate);
  if (results.length > maxResults) results.pop();
}
function wouldInsertResult(
  results: BuildResult[],
  candidate: BuildResult,
  maxResults: number,
  compare = compareBuildResults,
): boolean {
  return (
    maxResults > 0 &&
    (results.length < maxResults ||
      compare(candidate, results[results.length - 1]) < 0)
  );
}

function toRequestedTargets(
  desiredSkills: OptimizeWorkerRequest["desiredSkills"],
  skillIds: number[],
): number[] {
  const byId: Record<number, number> = {};
  for (const desired of desiredSkills) {
    if (desired.level > 0 && !desired.optional) {
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

function buildMaxCharmContribution(
  charms: CharmRank[],
  skillIds: number[],
): number[] {
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

    const thresholdsBySkill: Record<
      number,
      Array<{ pieces: number; level: number }>
    > = {};
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
      const thresholds = thresholdsBySkill[skillId].sort(
        (a, b) => a.pieces - b.pieces,
      );
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
  const includeNearMissResults = request.includeNearMissResults === true;
  const maxMissingPoints = includeNearMissResults
    ? Math.max(1, Math.min(12, Math.floor(request.maxMissingPoints ?? 2)))
    : 0;
  for (const desired of request.desiredSkills) {
    if (desired.level > 0 && !desired.optional) {
      desiredById.set(desired.skillId, desired.level);
    }
  }
  const requestedSkillIds = [
    ...new Set([
      ...desiredById.keys(),
      ...request.desiredSkills.filter((s) => s.optional).map((s) => s.skillId),
    ]),
  ].sort((a, b) => a - b);
  const compare = (a: BuildResult, b: BuildResult) =>
    compareForMode(a, b, request.sortMode);
  if (requestedSkillIds.length === 0) {
    stats.durationMs = nowMs() - startedAt;
    return {
      workerIndex,
      results: [],
      stats,
      error: "At least one target skill is required.",
    };
  }
  const requestedWeaponSetBonusPieces = normalizeWeaponSetBonusPieces(
    request.weaponSetBonusPieces,
  );
  const weaponSetBonusSetIds = Object.keys(
    requestedWeaponSetBonusPieces,
  ).filter((setId) => !!setId);
  const weaponSetBonusCandidateSetIdSet = new Set<string>(weaponSetBonusSetIds);
  const hasWeaponSetBonusPieces = weaponSetBonusSetIds.length > 0;
  const weaponSetBonusOptions: Array<{
    setId: string;
    pieces: WeaponSetBonusPieces;
  }> = [
    { setId: "", pieces: {} },
    ...weaponSetBonusSetIds.map((setId) => ({
      setId,
      pieces: toSingleWeaponSetBonusPieces(setId),
    })),
  ];
  if (
    request.weaponGroupBonusPieces !== undefined &&
    weaponSetBonusSetIds.length === 1
  )
    weaponSetBonusOptions.shift();

  const allowedHeadSet = new Set<number>(request.allowedHeadIds);
  const setAndGroupBonusSkillIds = collectSetAndGroupBonusSkillIds(
    request.data.armorSetsById,
  );
  const requestedHasSetOrGroupBonusSkill = requestedSkillIds.some((skillId) =>
    setAndGroupBonusSkillIds.has(skillId),
  );
  const relevantSetIds = requestedHasSetOrGroupBonusSkill
    ? collectRelevantSetIdsForRequestedSkills(
        request.data.armorSetsById,
        requestedSkillIds,
      )
    : new Set<number>();

  const filteredByKind: Record<ArmorKind, ArmorPiece[]> = {
    head: [],
    chest: [],
    arms: [],
    waist: [],
    legs: [],
  };

  for (const kind of ARMOR_ORDER) {
    const allowed = filterArmor(request, kind);
    if (kind === "head") {
      // Prune against the full allowed head pool first, then shard.
      // This keeps dominance pruning quality stable regardless of worker chunking.
      const globallyPrunedHeads = request.prepared
        ? allowed
        : pruneDominatedArmor(allowed, requestedSkillIds, relevantSetIds);
      filteredByKind.head = globallyPrunedHeads.filter((piece) =>
        allowedHeadSet.has(piece.id),
      );
    } else {
      filteredByKind[kind] = request.prepared
        ? allowed
        : pruneDominatedArmor(allowed, requestedSkillIds, relevantSetIds);
    }
    if (filteredByKind[kind].length === 0) {
      stats.durationMs = nowMs() - startedAt;
      return {
        workerIndex,
        results: [],
        stats,
      };
    }
    filteredByKind[kind].sort(
      (a, b) =>
        b.defenseMax - a.defenseMax ||
        b.slots.reduce((n, s) => n + s, 0) -
          a.slots.reduce((n, s) => n + s, 0) ||
        a.id - b.id,
    );
  }

  const prunedCharms = pruneDominatedCharms(
    request.charmPool ?? request.data.charmRanks,
    requestedSkillIds,
  );
  if (prunedCharms.length === 0) {
    stats.durationMs = nowMs() - startedAt;
    return {
      workerIndex,
      results: [],
      stats,
    };
  }
  const charmEvalData: CharmEvalData[] = prunedCharms.map((charm) => ({
    charm,
    requestedLevels: requestedSkillIds.map(
      (skillId) => charm.skills[skillId] ?? 0,
    ),
    slotCounts: slotCountsFromSlots(charm.slots),
    slotCapacity: [...charm.slots, ...(charm.weaponSlots ?? [])].reduce(
      (sum, value) => sum + value,
      0,
    ),
  }));

  const totalArmorCombos =
    filteredByKind.head.length *
    filteredByKind.chest.length *
    filteredByKind.arms.length *
    filteredByKind.waist.length *
    filteredByKind.legs.length;
  const totalCandidates = totalArmorCombos * charmEvalData.length;
  let lastProgressSentAt = startedAt;

  function emitProgress(force = false): void {
    if (!onProgress) {
      return;
    }
    const currentTime = nowMs();
    if (!force) {
      const dueToTime = currentTime - lastProgressSentAt >= 120;
      const dueToCombos =
        stats.completedArmorCombos > 0 &&
        stats.completedArmorCombos % 100 === 0;
      if (!dueToTime && !dueToCombos) {
        return;
      }
    }
    lastProgressSentAt = currentTime;
    onProgress({
      completedArmorCombos: stats.completedArmorCombos,
      totalArmorCombos,
      evaluatedCandidates: stats.completedArmorCombos * charmEvalData.length,
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
  const maxSetBonus = computeRequestedSetBonusUpperBound(
    requestedSkillIds,
    request.data.armorSetsById,
  );
  const setBonusProvidersBySkill = buildSetBonusProvidersBySkill(
    request.data.armorSetsById,
    requestedSkillIds,
  );
  const remainingUpperBounds = buildRemainingSkillUpperBounds(
    maxByKind,
    requestedSkillIds,
  );

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
    if (
      !hasCoverage &&
      !canMeetWithoutDeco &&
      maxCharm[skillIndexById[skillId]] +
        maxSetBonus[skillIndexById[skillId]] +
        remainingUpperBounds[0][skillIndexById[skillId]] +
        maxMissingPoints <
        targets[skillIndexById[skillId]]
    ) {
      stats.durationMs = nowMs() - startedAt;
      return {
        workerIndex,
        results: [],
        stats,
      };
    }
  }

  const decorationMemo = new Map<string, DecorationPlacement[] | null>();
  const decorationMemoLimit = resolveDecorationMemoLimit(
    requestedSkillIds.length,
    includeNearMissResults,
  );
  const decorationUpperBounds = buildDecorationUpperBounds(
    decorationData,
    requestedSkillIds,
  );
  const decorationTotalUpperBound = buildDecorationTotalUpperBound(
    decorationData,
    requestedSkillIds,
  );
  const maxSlotsByKind = ARMOR_ORDER.map((kind) =>
    Math.max(
      ...filteredByKind[kind].map((p) =>
        p.slots.reduce((sum, n) => sum + n, 0),
      ),
      0,
    ),
  );
  const maxCharmSlots =
    (request.weaponSlots ?? []).reduce((n, s) => n + s, 0) +
    Math.max(
      ...prunedCharms.map((c) =>
        [...c.slots, ...(c.weaponSlots ?? [])].reduce((sum, n) => sum + n, 0),
      ),
      0,
    );
  const selectedSlots = () =>
    Object.values(selected).reduce(
      (sum, p) => sum + (p?.slots.reduce((n, s) => n + s, 0) ?? 0),
      0,
    );
  const topResults: BuildResult[] = [];
  const selected: Partial<Record<ArmorKind, ArmorPiece>> = {};
  const currentRequested = requestedSkillIds.map(() => 0);
  const baseSelectedSetCounts: Record<string, number> = {};
  const selectedSetCounts: Record<string, number> = {};
  const setBonusUpperMemo = new Map<string, number>();
  const setBonusMemoLimit = resolveSetBonusMemoLimit(
    requestedSkillIds.length,
    includeNearMissResults,
  );
  emitProgress(true);

  function maxSetBonusFromCurrentCounts(
    skillId: number,
    remainingPieces: number,
  ): number {
    const providers = setBonusProvidersBySkill[skillId];
    if (!providers || providers.length === 0) {
      return 0;
    }

    const countsKey = providers
      .map((provider) => selectedSetCounts[String(provider.setId)] ?? 0)
      .join(",");
    const memoKey = `${skillId}|${remainingPieces}|${countsKey}`;
    const cached = setBonusUpperMemo.get(memoKey);
    if (cached !== undefined) {
      return cached;
    }

    let dp = new Array(remainingPieces + 1).fill(Number.NEGATIVE_INFINITY);
    dp[0] = 0;

    for (const provider of providers) {
      const next = new Array(remainingPieces + 1).fill(
        Number.NEGATIVE_INFINITY,
      );
      for (let used = 0; used <= remainingPieces; used += 1) {
        if (!Number.isFinite(dp[used])) {
          continue;
        }
        for (let add = 0; used + add <= remainingPieces; add += 1) {
          const providerSetId = String(provider.setId);
          const weaponBonus = weaponSetBonusCandidateSetIdSet.has(providerSetId)
            ? 1
            : 0;
          const pieceCount =
            (selectedSetCounts[providerSetId] ?? 0) + add + weaponBonus;
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
    memoSetWithCap(setBonusUpperMemo, memoKey, best, setBonusMemoLimit);
    return best;
  }

  function canStillHitTargets(kindIndex: number): boolean {
    const remainingPieces = ARMOR_ORDER.length - kindIndex;
    let allowedMissingForBound = includeNearMissResults ? maxMissingPoints : 0;
    if (topResults.length >= request.maxResults && topResults.length > 0) {
      const worstMissing =
        topResults[topResults.length - 1].missingRequestedPoints ?? 0;
      if (worstMissing < allowedMissingForBound) {
        allowedMissingForBound = worstMissing;
      }
    }
    for (let i = 0; i < requestedSkillIds.length; i += 1) {
      const skillId = requestedSkillIds[i];
      const setBonusUpper =
        (setBonusProvidersBySkill[skillId]?.length ?? 0) > 0
          ? maxSetBonusFromCurrentCounts(skillId, remainingPieces)
          : maxSetBonus[i];
      const slotCapacity =
        selectedSlots() +
        maxSlotsByKind.slice(kindIndex).reduce((sum, n) => sum + n, 0) +
        maxCharmSlots;
      const gains = decorationUpperBounds[skillId] ?? [0, 0, 0, 0, 0];
      // One gain per capacity unit deliberately overestimates, preserving correctness.
      const decoUpper = slotCapacity * Math.max(...gains);
      const upperBound =
        (request.weaponSkills?.[skillId] ?? 0) +
        currentRequested[i] +
        remainingUpperBounds[kindIndex][i] +
        maxCharm[i] +
        setBonusUpper +
        decoUpper;
      if (upperBound + allowedMissingForBound < targets[i]) {
        return false;
      }
    }
    // A safe ranking bound for the default objective. Optional targets need their own bound.
    if (
      (request.sortMode ?? "defense") === "defense" &&
      !request.desiredSkills.some((s) => s.optional) &&
      topResults.length >= request.maxResults &&
      topResults.length > 0 &&
      (topResults[topResults.length - 1].missingRequestedPoints ?? 0) === 0
    ) {
      const maxDefense = ARMOR_ORDER.reduce(
        (sum, kind, index) =>
          sum +
          (index < kindIndex
            ? selected[kind]!.defenseMax
            : Math.max(...filteredByKind[kind].map((p) => p.defenseMax))),
        0,
      );
      const worst = topResults[topResults.length - 1];
      if (maxDefense < worst.defenseMax) return false;
      const maxSlots =
        ARMOR_ORDER.reduce(
          (sum, kind, index) =>
            sum +
            (index < kindIndex
              ? selected[kind]!.slots.reduce((n, s) => n + s, 0)
              : maxSlotsByKind[index]),
          0,
        ) + maxCharmSlots;
      if (
        maxDefense === worst.defenseMax &&
        maxSlots < worst.leftoverSlotCapacity
      )
        return false;
    }
    return true;
  }

  function evaluateCompleteArmorSet(): void {
    stats.completedArmorCombos += 1;
    const head = selected.head;
    const chest = selected.chest;
    const arms = selected.arms;
    const waist = selected.waist;
    const legs = selected.legs;
    if (!head || !chest || !arms || !waist || !legs) {
      return;
    }
    const armorPieces: ArmorPiece[] = [head, chest, arms, waist, legs];

    const armorOnlySkills: SkillPoints = {};
    const baseSlotCounts: SlotCountVector = [0, 0, 0, 0, 0];
    let baseSlotCapacity = 0;
    const armorIds: Record<ArmorKind, number> = {
      head: head.id,
      chest: chest.id,
      arms: arms.id,
      waist: waist.id,
      legs: legs.id,
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
      addSkillPoints(armorOnlySkills, piece.skills);
      for (const slot of piece.slots) {
        if (slot >= 1 && slot <= 4) {
          baseSlotCounts[slot] += 1;
          baseSlotCapacity += slot;
        }
      }
      defenseBase += piece.defenseBase;
      defenseMax += piece.defenseMax;
      resist.fire += piece.resist.fire;
      resist.water += piece.resist.water;
      resist.ice += piece.resist.ice;
      resist.thunder += piece.resist.thunder;
      resist.dragon += piece.resist.dragon;
    }

    const allowedMissing = includeNearMissResults ? maxMissingPoints : 0;
    const baseSkillOptions = weaponSetBonusOptions.map((option) => {
      const setBonusSkills = computeSetAndGroupBonusSkills(
        armorPieces,
        request.data.armorSetsById,
        option.pieces,
        request.weaponGroupBonusPieces,
      );
      const baseSkills = cloneSkillPoints(armorOnlySkills);
      addSkillPoints(baseSkills, request.weaponSkills ?? {});
      addSkillPoints(baseSkills, setBonusSkills);
      return {
        setId: option.setId,
        baseSkills,
        requestedBase: mapRequestedSkillLevels(requestedSkillIds, baseSkills),
      };
    });
    const noWeaponBaseOption =
      baseSkillOptions.find((option) => option.setId === "") ?? null;

    const evaluateCharmAgainstBase = (
      baseSkillsForEval: SkillPoints,
      requestedBaseForEval: number[],
      charmData: CharmEvalData,
      missingLimit: number,
    ): {
      placement: DecorationPlacement[];
      totalsAfterDecos: SkillPoints;
      missingRequestedPoints: number;
      wastedRequestedPoints: number;
      leftoverSlotCapacity: number;
    } | null => {
      const deficits = new Array<number>(requestedSkillIds.length);
      let totalDeficit = 0;
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        const deficit =
          targets[i] - (requestedBaseForEval[i] + charmData.requestedLevels[i]);
        const normalizedDeficit = deficit > 0 ? deficit : 0;
        deficits[i] = normalizedDeficit;
        totalDeficit += normalizedDeficit;
      }

      const preferred = requestedSkillIds.map((id, i) => {
        const desired = request.desiredSkills.find(
          (s) => s.skillId === id && s.optional,
        );
        return desired
          ? Math.max(
              0,
              desired.level -
                (requestedBaseForEval[i] + charmData.requestedLevels[i]),
            )
          : -1;
      });
      let placement: DecorationPlacement[] | null;
      if (totalDeficit === 0 && !preferred.some((n) => n > 0)) {
        placement = [];
      } else {
        const combinedSlotCounts: number[] = [
          0,
          baseSlotCounts[1] + charmData.slotCounts[1],
          baseSlotCounts[2] + charmData.slotCounts[2],
          baseSlotCounts[3] + charmData.slotCounts[3],
          baseSlotCounts[4] + charmData.slotCounts[4],
          ...slotCountsFromSlots([
            ...(charmData.charm.weaponSlots ?? []),
            ...(request.weaponSlots ?? []),
          ]).slice(1),
        ];
        placement = assignDecorations(
          requestedSkillIds,
          skillIndexById,
          deficits,
          combinedSlotCounts,
          missingLimit,
          decorationData,
          decorationUpperBounds,
          decorationTotalUpperBound,
          decorationMemo,
          decorationMemoLimit,
          request.decorationCounts,
          preferred,
        );
        if (placement === null) {
          return null;
        }
      }

      const totalsAfterDecos = cloneSkillPoints(baseSkillsForEval);
      addSkillPoints(totalsAfterDecos, charmData.charm.skills);
      let usedSlotCapacity = 0;
      for (const item of placement) {
        usedSlotCapacity += item.slotSizeUsed;
        const decoration = decorationData.byId[item.decorationId];
        if (!decoration) {
          continue;
        }
        addSkillPoints(totalsAfterDecos, decoration.skills);
      }

      let allTargetsMet = true;
      let missingRequestedPoints = 0;
      let wastedRequestedPoints = 0;
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        const skillId = requestedSkillIds[i];
        const total = totalsAfterDecos[skillId] ?? 0;
        const target = targets[i];
        if (target === 0) continue; // Preferred skills are not excess required points.
        if (total < target) {
          allTargetsMet = false;
          missingRequestedPoints += target - total;
          continue;
        }
        if (total > target) {
          wastedRequestedPoints += total - target;
        }
      }
      const nearMissAccepted =
        includeNearMissResults &&
        missingRequestedPoints > 0 &&
        missingRequestedPoints <= missingLimit;
      if (!allTargetsMet && !nearMissAccepted) {
        return null;
      }

      const totalSlotCapacity =
        baseSlotCapacity +
        charmData.slotCapacity +
        (request.weaponSlots ?? []).reduce((n, s) => n + s, 0);
      const leftoverSlotCapacity = totalSlotCapacity - usedSlotCapacity;

      return {
        placement,
        totalsAfterDecos,
        missingRequestedPoints,
        wastedRequestedPoints,
        leftoverSlotCapacity,
      };
    };

    for (const charmData of charmEvalData) {
      let effectiveMissingLimit = allowedMissing;
      if (topResults.length >= request.maxResults && topResults.length > 0) {
        const worstMissing =
          topResults[topResults.length - 1].missingRequestedPoints ?? 0;
        if (worstMissing < effectiveMissingLimit) {
          effectiveMissingLimit = worstMissing;
        }
      }

      let bestCandidate: {
        result: BuildResult;
        optionSetId: string;
      } | null = null;

      for (const option of baseSkillOptions) {
        const evaluation = evaluateCharmAgainstBase(
          option.baseSkills,
          option.requestedBase,
          charmData,
          effectiveMissingLimit,
        );
        if (!evaluation) {
          continue;
        }

        const tieKey = buildTieKey(
          armorIds,
          charmData.charm.id,
          evaluation.placement,
        );
        const candidate: BuildResult = {
          armor: armorIds,
          armorPieces: { head, chest, arms, waist, legs },
          charmRankId: charmData.charm.id,
          charmName: charmData.charm.name,
          charmSlots: [...charmData.charm.slots],
          equippedCharm: charmData.charm,
          optionalSkillPoints: request.desiredSkills
            .filter((s) => s.optional)
            .reduce(
              (sum, s) =>
                sum +
                Math.min(s.level, evaluation.totalsAfterDecos[s.skillId] ?? 0),
              0,
            ),
          weaponGroupBonusId:
            Number(Object.keys(request.weaponGroupBonusPieces ?? {})[0]) ||
            undefined,
          placements: evaluation.placement.map((p) => ({ ...p })),
          weaponSlots: request.weaponSlots,
          weaponSkills: request.weaponSkills,
          skillTotals: evaluation.totalsAfterDecos,
          defenseBase,
          defenseMax,
          resist,
          leftoverSlotCapacity: evaluation.leftoverSlotCapacity,
          wastedRequestedPoints: evaluation.wastedRequestedPoints,
          missingRequestedPoints: evaluation.missingRequestedPoints,
          tieKey,
        };

        if (!bestCandidate) {
          bestCandidate = { result: candidate, optionSetId: option.setId };
          continue;
        }

        const delta = compare(candidate, bestCandidate.result);
        if (
          delta < 0 ||
          (delta === 0 &&
            option.setId === "" &&
            bestCandidate.optionSetId !== "")
        ) {
          bestCandidate = { result: candidate, optionSetId: option.setId };
        }
      }

      if (!bestCandidate) {
        continue;
      }
      const result = bestCandidate.result;

      stats.feasibleBuilds += 1;
      if (!wouldInsertResult(topResults, result, request.maxResults, compare)) {
        continue;
      }
      if (
        hasWeaponSetBonusPieces &&
        bestCandidate.optionSetId &&
        noWeaponBaseOption
      ) {
        // Dependency badge should reflect strict target viability without weapon assist,
        // independent of near-miss tolerance used for search expansion.
        const noWeaponResult = evaluateCharmAgainstBase(
          noWeaponBaseOption.baseSkills,
          noWeaponBaseOption.requestedBase,
          charmData,
          0,
        );
        if (noWeaponResult === null) {
          result.requiresWeaponSetBonusRoll = true;
          result.requiredWeaponSetBonusSetId = bestCandidate.optionSetId;
        }
      }
      locatePlacements(result, armorPieces);
      tryInsertResult(topResults, result, request.maxResults, compare);
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
        const setId = String(piece.armorSetId);
        selectedSetCounts[setId] = (selectedSetCounts[setId] ?? 0) + 1;
      }
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        currentRequested[i] += piece.skills[requestedSkillIds[i]] ?? 0;
      }
      dfs(kindIndex + 1);
      for (let i = 0; i < requestedSkillIds.length; i += 1) {
        currentRequested[i] -= piece.skills[requestedSkillIds[i]] ?? 0;
      }
      if (piece.armorSetId !== null) {
        const setId = String(piece.armorSetId);
        const baseCount = baseSelectedSetCounts[setId] ?? 0;
        const nextCount = (selectedSetCounts[setId] ?? 0) - 1;
        if (nextCount <= baseCount) {
          if (baseCount > 0) {
            selectedSetCounts[setId] = baseCount;
          } else {
            delete selectedSetCounts[setId];
          }
        } else {
          selectedSetCounts[setId] = nextCount;
        }
      }
    }
  }

  dfs(0);

  topResults.sort(compare);
  stats.durationMs = nowMs() - startedAt;
  emitProgress(true);
  return {
    workerIndex,
    results: topResults,
    stats,
  };
}
