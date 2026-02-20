import { describe, expect, it } from "vitest";

import { optimizeBuilds } from "../optimizer";
import { sampleNormalizedData } from "./fixtures/samplePayload";

describe("optimizer set bonus level handling", () => {
  it("does not stack repeated set-bonus ranks as additive levels", () => {
    const data = structuredClone(sampleNormalizedData);

    // Simulate a set skill whose 2pc gives level 1 and 4pc gives level 2.
    // Effective level at 4pc should be 2, not 1+2=3.
    data.armorSetsById[100].bonusRanks = [
      { pieces: 2, skills: { 3: 1 } },
      { pieces: 4, skills: { 3: 2 } },
    ];

    const response = optimizeBuilds({
      data,
      desiredSkills: [{ skillId: 3, level: 3 }],
      allowAlpha: true,
      allowGamma: true,
      useAllDecorations: true,
      allowedDecorationIds: [],
      maxResults: 10,
      includeNearMissResults: false,
      maxMissingPoints: 0,
      allowedHeadIds: data.armorByKind.head.map((piece) => piece.id),
      weaponSetBonusPieces: {},
    });

    expect(response.results.length).toBe(0);
  });
});
