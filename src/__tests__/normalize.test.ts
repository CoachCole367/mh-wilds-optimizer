import { describe, expect, it } from "vitest";

import { sampleNormalizedData } from "./fixtures/samplePayload";

describe("normalizeWildsPayload", () => {
  it("maps skill descriptions and rank descriptions", () => {
    expect(sampleNormalizedData.skillsById[1]?.description).toContain("stamina");
    expect(sampleNormalizedData.skillsById[1]?.rankDescriptions[1]).toContain("Slightly");
    expect(sampleNormalizedData.skillsById[3]?.rankDescriptions[1]).toContain("set synergy");
  });

  it("detects alpha/gamma armor variants from source names", () => {
    expect(sampleNormalizedData.armorById[11]?.isAlpha).toBe(true);
    expect(sampleNormalizedData.armorById[12]?.isGamma).toBe(true);
  });

  it("normalizes set and group bonus ranks", () => {
    const set = sampleNormalizedData.armorSetsById[100];
    expect(set.bonusRanks.length).toBe(1);
    expect(set.bonusRanks[0].pieces).toBe(2);
    expect(set.groupBonusRanks.length).toBe(1);
    expect(set.groupBonusRanks[0].pieces).toBe(3);
  });
});
