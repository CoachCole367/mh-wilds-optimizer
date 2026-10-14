import { describe, expect, it } from "vitest";
import {
  optimizeBuilds,
  prepareSearchData,
  compareForMode,
} from "../optimizer";
import { normalizeWildsPayload } from "../normalize";
import {
  sampleNormalizedData,
  sampleRawPayload,
} from "./fixtures/samplePayload";
import type { OptimizeWorkerRequest, CharmRank, ArmorKind } from "../types";

function fixture(): OptimizeWorkerRequest {
  const data = structuredClone(sampleNormalizedData);
  data.armorSetsById = {};
  for (const [kind, pieces] of Object.entries(data.armorByKind)) {
    const piece = {
      ...pieces[0],
      skills: {},
      slots: kind === "head" ? [1 as const] : [],
      armorSetId: null,
    };
    data.armorByKind[kind as keyof typeof data.armorByKind] = [piece];
    data.armorById[piece.id] = piece;
  }
  data.decorations = [
    {
      id: 900,
      name: "Fixture jewel",
      kind: "armor",
      slotReq: 1,
      skills: { 1: 1 },
    },
  ];
  data.decorationsById = { 900: data.decorations[0] };
  data.charmRanks = [
    {
      id: 0,
      charmId: 0,
      name: "Empty",
      level: 0,
      rarity: 0,
      skills: {},
      slots: [],
    },
  ];
  return {
    data,
    desiredSkills: [{ skillId: 1, level: 1 }],
    allowAlpha: true,
    allowGamma: true,
    useAllDecorations: true,
    allowedDecorationIds: [],
    maxResults: 10,
    allowedHeadIds: data.armorByKind.head.map((p) => p.id),
  };
}
describe("build correctness regressions", () => {
  it("separates memo states with different weapon slot counts",()=>{
    const req=fixture();req.data.armorByKind.head[0].slots=[];req.data.decorations[0].kind="weapon";
    req.charmPool=[{...req.data.charmRanks[0],id:1},{...req.data.charmRanks[0],id:2,weaponSlots:[1]}];
    const builds=optimizeBuilds(req).results;expect(builds).toHaveLength(1);expect(builds[0].charmRankId).toBe(2);
  });
  it("fills preferred skills without sacrificing required targets",()=>{
    const req=fixture();req.desiredSkills.push({skillId:2,level:1,optional:true});req.data.armorByKind.head[0].slots=[1,1];
    req.data.decorations.push({id:902,name:"Preferred",kind:"armor",slotReq:1,skills:{2:1}});
    const build=optimizeBuilds(req).results[0];expect(build.skillTotals).toMatchObject({1:1,2:1});expect(build.missingRequestedPoints).toBe(0);expect(build.optionalSkillPoints).toBe(1);expect(build.wastedRequestedPoints).toBe(0);
  });
  it("prefers a compound decoration when it adds a preferred skill",()=>{
    const req=fixture();req.desiredSkills.push({skillId:2,level:1,optional:true});
    req.data.decorations.push({id:903,name:"Compound",kind:"armor",slotReq:1,skills:{1:1,2:1}});
    expect(optimizeBuilds(req).results[0].placements[0].decorationId).toBe(903);
  });
  it("uses innate weapon skills and places jewels in that weapon", () => {
    const req=fixture();req.data.armorByKind.head[0].slots=[];req.data.decorations[0].kind="weapon";
    req.desiredSkills[0].level=2;req.weaponSkills={1:1};req.weaponSlots=[1];
    const result=optimizeBuilds(req).results[0];expect(result.skillTotals[1]).toBe(2);expect(result.placements[0]).toMatchObject({piece:"weapon",slotKind:"weapon",slotIndex:0});
  });
  it("keeps a weapon's set and group contribution independent",()=>{
    const req=fixture();req.data.decorations=[];req.desiredSkills=[{skillId:3,level:1},{skillId:4,level:1}];
    req.data.armorByKind.head[0].armorSetId=100;
    req.data.armorSetsById={100:{id:100,name:"First",bonusId:1,groupBonusId:500,bonusRanks:[{pieces:2,skills:{3:1}}],groupBonusRanks:[{pieces:2,skills:{4:1}}]}};
    req.weaponSetBonusPieces={100:1};req.weaponGroupBonusPieces={};expect(optimizeBuilds(req).results).toHaveLength(0);
    req.weaponGroupBonusPieces={500:1};expect(optimizeBuilds(req).results[0].skillTotals).toMatchObject({3:1,4:1});
  });
  it("does not mutate decoration locations on previously retained results",()=>{
    const req=fixture();req.data.armorByKind.chest[0].slots=[1];
    const builds=optimizeBuilds(req).results;for(const b of builds)for(const p of b.placements)expect(b.armorPieces?.[p.piece as ArmorKind]?.slots[p.slotIndex!]).toBe(p.slotSizeUsed);
  });
  it("finds a decoration-only completion", () => {
    const results = optimizeBuilds(fixture()).results;
    expect(results).toHaveLength(1);
    expect(results[0].skillTotals[1]).toBe(1);
    expect(results[0].placements[0]).toMatchObject({
      piece: "head",
      slotIndex: 0,
      slotKind: "armor",
    });
  });
  it("enforces quantities across placements", () => {
    const req = fixture();
    req.desiredSkills[0].level = 2;
    req.data.armorByKind.head[0].slots = [1, 1];
    req.decorationCounts = { 900: 1 };
    expect(optimizeBuilds(req).results).toHaveLength(0);
    req.decorationCounts = { 900: 2 };
    expect(optimizeBuilds(req).results[0].placements).toHaveLength(2);
  });
  it("does not put a weapon jewel in armor", () => {
    const req = fixture();
    req.data.decorations[0].kind = "weapon";
    expect(optimizeBuilds(req).results).toHaveLength(0);
    req.charmPool = [{ ...req.data.charmRanks[0], weaponSlots: [1] }];
    expect(optimizeBuilds(req).results[0].placements[0].slotKind).toBe(
      "weapon",
    );
  });
  it("searches exactly one owned charm, including its slots", () => {
    const req = fixture();
    req.data.armorByKind.head[0].slots = [];
    const owned: CharmRank = {
      id: -1,
      charmId: -1,
      name: "Owned",
      level: 0,
      rarity: 8,
      skills: {},
      slots: [1],
    };
    req.charmPool = [owned];
    const build = optimizeBuilds(req).results[0];
    expect(build.charmRankId).toBe(-1);
    expect(build.equippedCharm).toEqual(owned);
    expect(build.skillTotals[1]).toBe(1);
    req.charmPool = [];
    expect(optimizeBuilds(req).results).toHaveLength(0);
  });
  it("allows one missing unfillable target and fills the other", () => {
    const req = fixture();
    req.desiredSkills = [
      { skillId: 1, level: 1 },
      { skillId: 2, level: 1 },
    ];
    req.includeNearMissResults = true;
    req.maxMissingPoints = 1;
    const build = optimizeBuilds(req).results[0];
    expect(build).toBeDefined();
    expect(build.missingRequestedPoints).toBe(1);
    expect(build.skillTotals[1]).toBe(1);
  });
  it("still fills available deficits in near-miss mode", () => {
    const req = fixture();
    req.includeNearMissResults = true;
    req.maxMissingPoints = 2;
    expect(optimizeBuilds(req).results[0].missingRequestedPoints).toBe(0);
  });
  it("chooses the least slot capacity among feasible assignments", () => {
    const req = fixture();
    req.desiredSkills[0].level = 2;
    req.data.armorByKind.head[0].slots = [1, 1, 3];
    req.data.decorations.unshift({
      id: 901,
      name: "Big",
      kind: "armor",
      slotReq: 3,
      skills: { 1: 2 },
    });
    const result = optimizeBuilds(req).results[0];
    expect(result.leftoverSlotCapacity).toBe(3);
    expect(result.placements).toHaveLength(2);
  });
  it("does not prune a lower-waste charm", () => {
    const req = fixture();
    req.charmPool = [
      { ...req.data.charmRanks[0], id: 1, skills: { 1: 2 } },
      { ...req.data.charmRanks[0], id: 2, skills: { 1: 1 } },
    ];
    expect(optimizeBuilds(req).results[0].charmRankId).toBe(2);
  });
  it("keeps results independent of head sharding", () => {
    const req = fixture();
    req.data.armorByKind.head.push({
      ...req.data.armorByKind.head[0],
      id: 99,
      defenseMax: 99,
    });
    req.data = prepareSearchData(req);
    req.prepared = true;
    req.allowedHeadIds = req.data.armorByKind.head.map((p) => p.id);
    const all = optimizeBuilds(req).results;
    const split = req.allowedHeadIds
      .flatMap((id) => optimizeBuilds({ ...req, allowedHeadIds: [id] }).results)
      .sort(compareForMode)
      .slice(0, req.maxResults);
    expect(split.map((r) => r.tieKey)).toEqual(all.map((r) => r.tieKey));
  });
  it("honors locked pieces, rank and base defense", () => {
    const req = fixture();
    req.armorConstraints = { head: [-5] };
    expect(optimizeBuilds(req).results).toHaveLength(0);
    req.armorConstraints = {};
    req.armorUpgradeMode = "base";
    const result = optimizeBuilds(req).results[0];
    expect(result.defenseMax).toBe(result.defenseBase);
  });
  it("does not apply conditional skills as innate armor skills", () => {
    const raw = structuredClone(sampleRawPayload);
    raw.armor[0].skills = [
      { skill: { id: 4, kind: "group" }, level: 1, setPiecesRequired: 3 },
    ];
    const data = normalizeWildsPayload(raw, {
      locale: "en",
      version: "fixture",
      fetchedAt: 0,
    });
    expect(data.armorById[raw.armor[0].id].skills[4]).toBeUndefined();
  });
});
