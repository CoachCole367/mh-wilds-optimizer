import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const fixtureData = {
  locale: "en",
  version: "bench",
  fetchedAt: Date.now(),
  skills: [
    { id: 1, name: "Constitution", kind: "armor", maxLevel: 2, description: "Reduce stamina use.", rankDescriptions: { 1: "Stamina use down.", 2: "Stamina use further down." } },
    { id: 2, name: "Adrenaline Rush", kind: "armor", maxLevel: 1, description: "Attack up after perfect evade.", rankDescriptions: { 1: "Attack up." } },
    { id: 3, name: "Set Synergy", kind: "set", maxLevel: 1, description: "", rankDescriptions: { 1: "Set bonus active." } },
  ],
  skillsById: {
    1: { id: 1, name: "Constitution", kind: "armor", maxLevel: 2, description: "Reduce stamina use.", rankDescriptions: { 1: "Stamina use down.", 2: "Stamina use further down." } },
    2: { id: 2, name: "Adrenaline Rush", kind: "armor", maxLevel: 1, description: "Attack up after perfect evade.", rankDescriptions: { 1: "Attack up." } },
    3: { id: 3, name: "Set Synergy", kind: "set", maxLevel: 1, description: "", rankDescriptions: { 1: "Set bonus active." } },
  },
  armorByKind: {
    head: [
      {
        id: 11,
        name: "Scout Helm",
        kind: "head",
        rarity: 5,
        defenseBase: 20,
        defenseMax: 52,
        resist: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 0 },
        slots: [2],
        skills: { 1: 1 },
        armorSetId: 100,
        armorSetName: "Pioneer α",
        isAlpha: true,
        isGamma: false,
      },
      {
        id: 12,
        name: "Runner Helm",
        kind: "head",
        rarity: 5,
        defenseBase: 19,
        defenseMax: 50,
        resist: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
        slots: [1],
        skills: { 2: 1 },
        armorSetId: 101,
        armorSetName: "Ranger γ",
        isAlpha: false,
        isGamma: true,
      },
    ],
    chest: [
      {
        id: 21,
        name: "Scout Mail",
        kind: "chest",
        rarity: 5,
        defenseBase: 20,
        defenseMax: 51,
        resist: { fire: 0, water: 0, ice: 0, thunder: 1, dragon: 0 },
        slots: [1],
        skills: { 1: 1 },
        armorSetId: 100,
        armorSetName: "Pioneer α",
        isAlpha: true,
        isGamma: false,
      },
    ],
    arms: [
      {
        id: 31,
        name: "Scout Vambraces",
        kind: "arms",
        rarity: 5,
        defenseBase: 19,
        defenseMax: 50,
        resist: { fire: 0, water: 0, ice: 1, thunder: 0, dragon: 0 },
        slots: [2],
        skills: {},
        armorSetId: 100,
        armorSetName: "Pioneer α",
        isAlpha: true,
        isGamma: false,
      },
    ],
    waist: [
      {
        id: 41,
        name: "Scout Coil",
        kind: "waist",
        rarity: 5,
        defenseBase: 18,
        defenseMax: 49,
        resist: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 1 },
        slots: [1],
        skills: { 2: 1 },
        armorSetId: 100,
        armorSetName: "Pioneer α",
        isAlpha: true,
        isGamma: false,
      },
    ],
    legs: [
      {
        id: 51,
        name: "Scout Greaves",
        kind: "legs",
        rarity: 5,
        defenseBase: 18,
        defenseMax: 49,
        resist: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
        slots: [1],
        skills: {},
        armorSetId: 100,
        armorSetName: "Pioneer α",
        isAlpha: true,
        isGamma: false,
      },
    ],
  },
  armorById: {
    11: {
      id: 11,
      name: "Scout Helm",
      kind: "head",
      rarity: 5,
      defenseBase: 20,
      defenseMax: 52,
      resist: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 0 },
      slots: [2],
      skills: { 1: 1 },
      armorSetId: 100,
      armorSetName: "Pioneer α",
      isAlpha: true,
      isGamma: false,
    },
    12: {
      id: 12,
      name: "Runner Helm",
      kind: "head",
      rarity: 5,
      defenseBase: 19,
      defenseMax: 50,
      resist: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
      slots: [1],
      skills: { 2: 1 },
      armorSetId: 101,
      armorSetName: "Ranger γ",
      isAlpha: false,
      isGamma: true,
    },
    21: {
      id: 21,
      name: "Scout Mail",
      kind: "chest",
      rarity: 5,
      defenseBase: 20,
      defenseMax: 51,
      resist: { fire: 0, water: 0, ice: 0, thunder: 1, dragon: 0 },
      slots: [1],
      skills: { 1: 1 },
      armorSetId: 100,
      armorSetName: "Pioneer α",
      isAlpha: true,
      isGamma: false,
    },
    31: {
      id: 31,
      name: "Scout Vambraces",
      kind: "arms",
      rarity: 5,
      defenseBase: 19,
      defenseMax: 50,
      resist: { fire: 0, water: 0, ice: 1, thunder: 0, dragon: 0 },
      slots: [2],
      skills: {},
      armorSetId: 100,
      armorSetName: "Pioneer α",
      isAlpha: true,
      isGamma: false,
    },
    41: {
      id: 41,
      name: "Scout Coil",
      kind: "waist",
      rarity: 5,
      defenseBase: 18,
      defenseMax: 49,
      resist: { fire: 1, water: 0, ice: 0, thunder: 0, dragon: 1 },
      slots: [1],
      skills: { 2: 1 },
      armorSetId: 100,
      armorSetName: "Pioneer α",
      isAlpha: true,
      isGamma: false,
    },
    51: {
      id: 51,
      name: "Scout Greaves",
      kind: "legs",
      rarity: 5,
      defenseBase: 18,
      defenseMax: 49,
      resist: { fire: 0, water: 1, ice: 0, thunder: 0, dragon: 0 },
      slots: [1],
      skills: {},
      armorSetId: 100,
      armorSetName: "Pioneer α",
      isAlpha: true,
      isGamma: false,
    },
  },
  armorSetsById: {
    100: {
      id: 100,
      name: "Pioneer α",
      bonusId: 900,
      groupBonusId: null,
      bonusRanks: [{ pieces: 2, skills: { 3: 1 } }],
      groupBonusRanks: [],
    },
    101: {
      id: 101,
      name: "Ranger γ",
      bonusId: null,
      groupBonusId: null,
      bonusRanks: [],
      groupBonusRanks: [],
    },
  },
  decorations: [
    { id: 201, name: "Constitution Jewel [1]", slotReq: 1, kind: "armor", skills: { 1: 1 } },
    { id: 202, name: "Rush Jewel [2]", slotReq: 2, kind: "armor", skills: { 2: 1 } },
  ],
  decorationsById: {
    201: { id: 201, name: "Constitution Jewel [1]", slotReq: 1, kind: "armor", skills: { 1: 1 } },
    202: { id: 202, name: "Rush Jewel [2]", slotReq: 2, kind: "armor", skills: { 2: 1 } },
  },
  charmRanks: [
    { id: 301, charmId: 300, name: "Fitness Charm I", level: 1, rarity: 5, skills: { 1: 1 }, slots: [1] },
    { id: 302, charmId: 301, name: "Rush Charm I", level: 1, rarity: 5, skills: { 2: 1 }, slots: [2] },
  ],
  charmRankById: {
    301: { id: 301, charmId: 300, name: "Fitness Charm I", level: 1, rarity: 5, skills: { 1: 1 }, slots: [1] },
    302: { id: 302, charmId: 301, name: "Rush Charm I", level: 1, rarity: 5, skills: { 2: 1 }, slots: [2] },
  },
};

async function loadOptimizerModule() {
  const tempDir = await mkdtemp(join(tmpdir(), "mhw-optimizer-bench-"));
  const outfile = join(tempDir, "optimizer.bundle.mjs");
  await build({
    entryPoints: [join(projectRoot, "src", "optimizer.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  const moduleUrl = `${pathToFileURL(outfile).href}?v=${Date.now()}`;
  const mod = await import(moduleUrl);
  return {
    optimizeBuilds: mod.optimizeBuilds,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

async function run() {
  const { optimizeBuilds, cleanup } = await loadOptimizerModule();
  try {
    const request = {
      data: fixtureData,
      desiredSkills: [
        { skillId: 1, level: 2 },
        { skillId: 2, level: 1 },
      ],
      allowAlpha: true,
      allowGamma: true,
      useAllDecorations: true,
      allowedDecorationIds: [],
      maxResults: 20,
      includeNearMissResults: false,
      maxMissingPoints: 0,
      allowedHeadIds: [11, 12],
    };

    for (let i = 0; i < 5; i += 1) {
      optimizeBuilds(request, 0);
    }

    const runs = 20;
    const timings = [];
    let latestResult = null;
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      latestResult = optimizeBuilds(request, 0);
      timings.push(performance.now() - startedAt);
    }

    console.log("Optimizer benchmark");
    console.log(`Runs: ${runs}`);
    console.log(`Average: ${average(timings).toFixed(2)}ms`);
    console.log(`Median: ${median(timings).toFixed(2)}ms`);
    console.log(`Min: ${Math.min(...timings).toFixed(2)}ms`);
    console.log(`Max: ${Math.max(...timings).toFixed(2)}ms`);
    console.log(`Latest result count: ${latestResult?.results.length ?? 0}`);
  } finally {
    await cleanup();
  }
}

run().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
