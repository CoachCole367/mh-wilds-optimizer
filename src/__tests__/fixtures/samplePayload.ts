import { normalizeWildsPayload, type RawWildsPayload } from "../../normalize";
import type { BuildResult, NormalizedData } from "../../types";

export const sampleRawPayload: RawWildsPayload = {
  skills: [
    {
      id: 1,
      name: "Constitution",
      description: "Reduces fixed stamina depletion.",
      kind: "armor",
      ranks: [
        { level: 1, description: "Slightly reduces stamina use." },
        { level: 2, description: "Further reduces stamina use." },
      ],
    },
    {
      id: 2,
      name: "Adrenaline Rush",
      description: "Boosts attack after perfect evade.",
      kind: "armor",
      ranks: [{ level: 1, description: "Attack increases briefly." }],
    },
    {
      id: 3,
      name: "Set Synergy",
      description: null,
      kind: "set",
      ranks: [{ level: 1, description: "Enables set synergy bonus." }],
    },
    {
      id: 4,
      name: "Group Unity",
      description: null,
      kind: "group",
      ranks: [{ level: 1, description: "Enables group bonus effect." }],
    },
    {
      id: 5,
      name: "Fire Resistance",
      description: "Raises fire resistance.",
      kind: "armor",
      ranks: [{ level: 1, description: "Fire resistance +3." }],
    },
  ],
  armor: [
    {
      id: 11,
      name: "Scout Helm",
      kind: "head",
      rarity: 5,
      defense: { base: 20, max: 52 },
      resistances: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 0 },
      slots: [2],
      skills: [{ skill: { id: 1 }, level: 1 }],
      armorSet: { id: 100, name: "Pioneer α" },
    },
    {
      id: 12,
      name: "Runner Helm",
      kind: "head",
      rarity: 5,
      defense: { base: 19, max: 50 },
      resistances: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
      slots: [1],
      skills: [{ skill: { id: 2 }, level: 1 }],
      armorSet: { id: 101, name: "Ranger γ" },
    },
    {
      id: 21,
      name: "Scout Mail",
      kind: "chest",
      rarity: 5,
      defense: { base: 20, max: 51 },
      resistances: { fire: 0, water: 0, ice: 0, thunder: 1, dragon: 0 },
      slots: [1],
      skills: [{ skill: { id: 1 }, level: 1 }],
      armorSet: { id: 100, name: "Pioneer α" },
    },
    {
      id: 31,
      name: "Scout Vambraces",
      kind: "arms",
      rarity: 5,
      defense: { base: 19, max: 50 },
      resistances: { fire: 0, water: 0, ice: 1, thunder: 0, dragon: 0 },
      slots: [2],
      skills: [{ skill: { id: 5 }, level: 1 }],
      armorSet: { id: 100, name: "Pioneer α" },
    },
    {
      id: 41,
      name: "Scout Coil",
      kind: "waist",
      rarity: 5,
      defense: { base: 18, max: 49 },
      resistances: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 1 },
      slots: [1],
      skills: [{ skill: { id: 2 }, level: 1 }],
      armorSet: { id: 100, name: "Pioneer α" },
    },
    {
      id: 51,
      name: "Scout Greaves",
      kind: "legs",
      rarity: 5,
      defense: { base: 18, max: 49 },
      resistances: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
      slots: [1],
      skills: [],
      armorSet: { id: 100, name: "Pioneer α" },
    },
  ],
  armorSets: [
    {
      id: 100,
      name: "Pioneer α",
      bonus: {
        id: 900,
        ranks: [
          {
            pieces: 2,
            skill: {
              level: 1,
              skill: { id: 3 },
            },
          },
        ],
      },
      groupBonus: {
        id: 901,
        ranks: [
          {
            pieces: 3,
            skill: {
              level: 1,
              skill: { id: 4 },
            },
          },
        ],
      },
    },
    {
      id: 101,
      name: "Ranger γ",
      bonus: null,
      groupBonus: null,
    },
  ],
  decorations: [
    {
      id: 201,
      name: "Constitution Jewel [1]",
      slot: 1,
      kind: "armor",
      skills: [{ skill: { id: 1 }, level: 1 }],
    },
    {
      id: 202,
      name: "Rush Jewel [2]",
      slot: 2,
      kind: "armor",
      skills: [{ skill: { id: 2 }, level: 1 }],
    },
    {
      id: 203,
      name: "Flame Jewel [1]",
      slot: 1,
      kind: "armor",
      skills: [{ skill: { id: 5 }, level: 1 }],
    },
  ],
  charms: [
    {
      id: 300,
      ranks: [
        {
          id: 301,
          name: "Fitness Charm I",
          level: 1,
          rarity: 5,
          slots: [1],
          skills: [{ skill: { id: 1 }, level: 1 }],
        },
      ],
    },
    {
      id: 301,
      ranks: [
        {
          id: 302,
          name: "Rush Charm I",
          level: 1,
          rarity: 5,
          slots: [2],
          skills: [{ skill: { id: 2 }, level: 1 }],
        },
      ],
    },
  ],
};

export const sampleNormalizedData: NormalizedData = normalizeWildsPayload(sampleRawPayload, {
  locale: "en",
  version: "test-version",
  fetchedAt: 1_700_000_000_000,
});

export function makeBuildResult(partial: Partial<BuildResult>): BuildResult {
  return {
    armor: { head: 11, chest: 21, arms: 31, waist: 41, legs: 51 },
    charmRankId: 301,
    charmName: "Fitness Charm I",
    charmSlots: [1],
    placements: [],
    skillTotals: {},
    defenseBase: 95,
    defenseMax: 251,
    resist: { fire: 0, water: 0, ice: 0, thunder: 0, dragon: 0 },
    leftoverSlotCapacity: 0,
    wastedRequestedPoints: 0,
    missingRequestedPoints: 0,
    tieKey: "11|21|31|41|51|301|",
    ...partial,
  };
}
