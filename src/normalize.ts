import type {
  ArmorKind,
  ArmorPiece,
  ArmorSetBonusRank,
  ArmorSetInfo,
  CharmRank,
  Decoration,
  NormalizedData,
  SkillInfo,
  SkillPoints,
  SlotSize,
  Slots,
} from "./types";

const ARMOR_KINDS: ArmorKind[] = ["head", "chest", "arms", "waist", "legs"];
const ALPHA_PATTERN = /α/i;
const GAMMA_PATTERN = /γ/i;

type RawSkillRank = {
  level?: number;
};

type RawSkill = {
  id: number;
  name: string;
  kind?: string;
  ranks?: RawSkillRank[];
};

type RawSkillLevelEntry = {
  level?: number;
  skill?: {
    id?: number;
  };
};

type RawArmor = {
  id: number;
  name: string;
  kind: string;
  rarity?: number;
  defense?: {
    base?: number;
    max?: number;
  };
  resistances?: {
    fire?: number;
    water?: number;
    ice?: number;
    thunder?: number;
    dragon?: number;
  };
  slots?: number[];
  skills?: RawSkillLevelEntry[];
  armorSet?: {
    id?: number;
    name?: string;
  } | null;
};

type RawDecoration = {
  id: number;
  name: string;
  slot?: number;
  kind?: string;
  skills?: RawSkillLevelEntry[];
};

type RawCharmRank = {
  id: number;
  name: string;
  level?: number;
  rarity?: number;
  slots?: number[];
  skills?: RawSkillLevelEntry[];
};

type RawCharm = {
  id: number;
  ranks?: RawCharmRank[];
};

type RawBonusRank = {
  pieces?: number;
  skill?: {
    level?: number;
    skill?: {
      id?: number;
    };
  };
};

type RawBonus = {
  id?: number;
  ranks?: RawBonusRank[];
};

type RawArmorSet = {
  id: number;
  name: string;
  bonus?: RawBonus | null;
  groupBonus?: RawBonus | null;
};

export type RawWildsPayload = {
  skills: RawSkill[];
  armor: RawArmor[];
  armorSets: RawArmorSet[];
  decorations: RawDecoration[];
  charms: RawCharm[];
};

export type NormalizeOptions = {
  locale: string;
  version: string;
  fetchedAt: number;
};

function toSlotSize(value: number): SlotSize | null {
  if (value === 1 || value === 2 || value === 3 || value === 4) {
    return value;
  }
  return null;
}

function toSlots(values: number[] | undefined): Slots {
  if (!values || values.length === 0) {
    return [];
  }
  const slots: Slots = [];
  for (const value of values) {
    const slot = toSlotSize(value);
    if (slot !== null) {
      slots.push(slot);
    }
  }
  return slots;
}

function toSkillPoints(entries: RawSkillLevelEntry[] | undefined): SkillPoints {
  const out: SkillPoints = {};
  if (!entries) {
    return out;
  }
  for (const entry of entries) {
    const skillId = entry.skill?.id;
    const level = entry.level ?? 0;
    if (!skillId || level === 0) {
      continue;
    }
    out[skillId] = (out[skillId] ?? 0) + level;
  }
  return out;
}

function toBonusRanks(raw: RawBonus | null | undefined): ArmorSetBonusRank[] {
  if (!raw?.ranks) {
    return [];
  }
  const output: ArmorSetBonusRank[] = [];
  for (const rank of raw.ranks) {
    const pieces = rank.pieces ?? 0;
    const skillId = rank.skill?.skill?.id;
    const level = rank.skill?.level ?? 0;
    if (pieces <= 0 || !skillId || level <= 0) {
      continue;
    }
    output.push({
      pieces,
      skills: {
        [skillId]: level,
      },
    });
  }
  output.sort((a, b) => a.pieces - b.pieces);
  return output;
}

function toSkillInfo(rawSkills: RawSkill[]): { skills: SkillInfo[]; byId: Record<number, SkillInfo> } {
  const skills = rawSkills
    .map((skill) => {
      const maxLevel = (skill.ranks ?? []).reduce((max, rank) => {
        const level = rank.level ?? 0;
        return level > max ? level : max;
      }, 0);
      return {
        id: skill.id,
        name: skill.name,
        kind: skill.kind ?? "unknown",
        maxLevel: maxLevel > 0 ? maxLevel : 1,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  const byId: Record<number, SkillInfo> = {};
  for (const skill of skills) {
    byId[skill.id] = skill;
  }
  return { skills, byId };
}

function toArmorSets(rawArmorSets: RawArmorSet[]): Record<number, ArmorSetInfo> {
  const byId: Record<number, ArmorSetInfo> = {};
  for (const armorSet of rawArmorSets) {
    byId[armorSet.id] = {
      id: armorSet.id,
      name: armorSet.name,
      bonusId: armorSet.bonus?.id ?? null,
      groupBonusId: armorSet.groupBonus?.id ?? null,
      bonusRanks: toBonusRanks(armorSet.bonus),
      groupBonusRanks: toBonusRanks(armorSet.groupBonus),
    };
  }
  return byId;
}

function isArmorKind(value: string): value is ArmorKind {
  return ARMOR_KINDS.includes(value as ArmorKind);
}

function toArmor(
  rawArmor: RawArmor[],
): { byKind: Record<ArmorKind, ArmorPiece[]>; byId: Record<number, ArmorPiece> } {
  const byKind: Record<ArmorKind, ArmorPiece[]> = {
    head: [],
    chest: [],
    arms: [],
    waist: [],
    legs: [],
  };
  const byId: Record<number, ArmorPiece> = {};

  for (const armor of rawArmor) {
    if (!isArmorKind(armor.kind)) {
      continue;
    }

    const sourceName = `${armor.name} ${armor.armorSet?.name ?? ""}`;
    const normalized: ArmorPiece = {
      id: armor.id,
      name: armor.name,
      kind: armor.kind,
      rarity: armor.rarity ?? 0,
      defenseBase: armor.defense?.base ?? 0,
      defenseMax: armor.defense?.max ?? 0,
      resist: {
        fire: armor.resistances?.fire ?? 0,
        water: armor.resistances?.water ?? 0,
        ice: armor.resistances?.ice ?? 0,
        thunder: armor.resistances?.thunder ?? 0,
        dragon: armor.resistances?.dragon ?? 0,
      },
      slots: toSlots(armor.slots),
      skills: toSkillPoints(armor.skills),
      armorSetId: armor.armorSet?.id ?? null,
      armorSetName: armor.armorSet?.name ?? null,
      isAlpha: ALPHA_PATTERN.test(sourceName),
      isGamma: GAMMA_PATTERN.test(sourceName),
    };

    byKind[normalized.kind].push(normalized);
    byId[normalized.id] = normalized;
  }

  for (const kind of ARMOR_KINDS) {
    byKind[kind].sort((a, b) => a.id - b.id);
  }

  return { byKind, byId };
}

function toDecorations(rawDecorations: RawDecoration[]): {
  decorations: Decoration[];
  byId: Record<number, Decoration>;
} {
  const decorations: Decoration[] = [];
  const byId: Record<number, Decoration> = {};
  for (const deco of rawDecorations) {
    const slotReq = toSlotSize(deco.slot ?? 0);
    if (slotReq === null) {
      continue;
    }
    const normalized: Decoration = {
      id: deco.id,
      name: deco.name,
      slotReq,
      kind: deco.kind ?? "unknown",
      skills: toSkillPoints(deco.skills),
    };
    decorations.push(normalized);
    byId[normalized.id] = normalized;
  }
  decorations.sort((a, b) => a.id - b.id);
  return { decorations, byId };
}

function toCharmRanks(rawCharms: RawCharm[]): {
  charmRanks: CharmRank[];
  byId: Record<number, CharmRank>;
} {
  const charmRanks: CharmRank[] = [];
  const byId: Record<number, CharmRank> = {};

  for (const charm of rawCharms) {
    for (const rank of charm.ranks ?? []) {
      const normalized: CharmRank = {
        id: rank.id,
        charmId: charm.id,
        name: rank.name,
        level: rank.level ?? 0,
        rarity: rank.rarity ?? 0,
        skills: toSkillPoints(rank.skills),
        slots: toSlots(rank.slots),
      };
      charmRanks.push(normalized);
      byId[normalized.id] = normalized;
    }
  }

  charmRanks.sort((a, b) => a.id - b.id);
  return { charmRanks, byId };
}

export function normalizeWildsPayload(raw: RawWildsPayload, options: NormalizeOptions): NormalizedData {
  const { skills, byId: skillsById } = toSkillInfo(raw.skills);
  const armorSetsById = toArmorSets(raw.armorSets);
  const { byKind: armorByKind, byId: armorById } = toArmor(raw.armor);
  const { decorations, byId: decorationsById } = toDecorations(raw.decorations);
  const { charmRanks, byId: charmRankById } = toCharmRanks(raw.charms);

  return {
    locale: options.locale,
    version: options.version,
    fetchedAt: options.fetchedAt,
    skills,
    skillsById,
    armorByKind,
    armorById,
    armorSetsById,
    decorations,
    decorationsById,
    charmRanks,
    charmRankById,
  };
}
