import type {
  ArmorSetBonusRank,
  DesiredSkill,
  NormalizedData,
  SkillPoints,
  WeaponSetBonusPieces,
} from "./types";

export const AUTO_WEAPON_SET_BONUS_SET_ID = "__auto__";
const NONE_WEAPON_SET_BONUS_SET_ID = "";

export type WeaponSetBonusVariant = {
  setId: string;
  label: string;
  pieces: WeaponSetBonusPieces;
};

function hasPositiveSkill(points: SkillPoints): boolean {
  for (const key in points) {
    const value = points[Number(key)] ?? 0;
    if (value > 0) {
      return true;
    }
  }
  return false;
}

function firstBonusSkillName(
  ranks: ArmorSetBonusRank[],
  skillsById: NormalizedData["skillsById"],
): string | null {
  const sortedRanks = [...ranks].sort((a, b) => a.pieces - b.pieces);
  for (const rank of sortedRanks) {
    for (const key in rank.skills) {
      const skillId = Number(key);
      const level = rank.skills[skillId] ?? 0;
      if (level <= 0) {
        continue;
      }
      return skillsById[skillId]?.name ?? `Skill #${skillId}`;
    }
  }
  return null;
}

export function normalizeWeaponSetBonusPieces(
  raw: WeaponSetBonusPieces | null | undefined,
): WeaponSetBonusPieces {
  const normalized: WeaponSetBonusPieces = {};
  if (!raw) {
    return normalized;
  }
  for (const [rawSetId, rawCount] of Object.entries(raw)) {
    const setId = String(rawSetId).trim();
    const count = Math.floor(Number(rawCount));
    if (!setId || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    normalized[setId] = count;
  }
  return normalized;
}

export function selectedWeaponSetBonusPieces(
  allowRoll: boolean,
  selectedSetId: string | null | undefined,
): WeaponSetBonusPieces {
  if (!allowRoll) {
    return {};
  }
  const setId = String(selectedSetId ?? "").trim();
  if (!setId || setId === AUTO_WEAPON_SET_BONUS_SET_ID) {
    return {};
  }
  return { [setId]: 1 };
}

function collectRequestedSetAndGroupSkillIds(
  data: NormalizedData,
  desiredSkills: DesiredSkill[],
): Set<number> {
  const requested = new Set<number>();
  for (const desired of desiredSkills) {
    if (desired.level <= 0) {
      continue;
    }
    const kind = (data.skillsById[desired.skillId]?.kind ?? "").toLowerCase();
    if (kind === "set" || kind === "group") {
      requested.add(desired.skillId);
    }
  }
  return requested;
}

function rankContributesRequestedSkill(
  rank: ArmorSetBonusRank,
  requestedSetOrGroupSkillIds: Set<number>,
): boolean {
  for (const key in rank.skills) {
    const skillId = Number(key);
    if (!requestedSetOrGroupSkillIds.has(skillId)) {
      continue;
    }
    const level = rank.skills[skillId] ?? 0;
    if (level > 0) {
      return true;
    }
  }
  return false;
}

export function inferWeaponSetBonusSetIdsFromDesired(
  data: NormalizedData,
  desiredSkills: DesiredSkill[],
): string[] {
  const requestedSetOrGroupSkillIds = collectRequestedSetAndGroupSkillIds(data, desiredSkills);
  if (requestedSetOrGroupSkillIds.size === 0) {
    return [];
  }

  const matching = new Set<string>();
  for (const armorSet of Object.values(data.armorSetsById)) {
    const matchesBonus = armorSet.bonusRanks.some((rank) =>
      rankContributesRequestedSkill(rank, requestedSetOrGroupSkillIds),
    );
    const matchesGroup = armorSet.groupBonusRanks.some((rank) =>
      rankContributesRequestedSkill(rank, requestedSetOrGroupSkillIds),
    );
    if (matchesBonus || matchesGroup) {
      matching.add(String(armorSet.id));
    }
  }

  return [...matching].sort((a, b) => Number(a) - Number(b));
}

export function resolveWeaponSetBonusPiecesForRequest(
  data: NormalizedData,
  desiredSkills: DesiredSkill[],
  allowRoll: boolean,
  selectedSetId: string | null | undefined,
): WeaponSetBonusPieces {
  if (!allowRoll) {
    return {};
  }
  const setId = String(selectedSetId ?? "").trim();
  if (!setId || setId === NONE_WEAPON_SET_BONUS_SET_ID) {
    return {};
  }
  if (setId === AUTO_WEAPON_SET_BONUS_SET_ID) {
    const inferred = inferWeaponSetBonusSetIdsFromDesired(data, desiredSkills);
    const pieces: WeaponSetBonusPieces = {};
    for (const inferredSetId of inferred) {
      pieces[inferredSetId] = 1;
    }
    return pieces;
  }
  return { [setId]: 1 };
}

export function buildWeaponSetBonusVariants(data: NormalizedData): WeaponSetBonusVariant[] {
  const variants: WeaponSetBonusVariant[] = [
    { setId: NONE_WEAPON_SET_BONUS_SET_ID, label: "None", pieces: {} },
    {
      setId: AUTO_WEAPON_SET_BONUS_SET_ID,
      label: "Auto (from requested Set/Group skills)",
      pieces: {},
    },
  ];
  const sets = Object.values(data.armorSetsById).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  for (const armorSet of sets) {
    const hasAnyBonusSkill =
      armorSet.bonusRanks.some((rank) => hasPositiveSkill(rank.skills)) ||
      armorSet.groupBonusRanks.some((rank) => hasPositiveSkill(rank.skills));
    if (!hasAnyBonusSkill) {
      continue;
    }
    const setId = String(armorSet.id);
    const firstSkill =
      firstBonusSkillName(armorSet.bonusRanks, data.skillsById) ??
      firstBonusSkillName(armorSet.groupBonusRanks, data.skillsById);
    const label = firstSkill ? `${armorSet.name} (${firstSkill})` : armorSet.name;
    variants.push({
      setId,
      label,
      pieces: { [setId]: 1 },
    });
  }

  return variants;
}
