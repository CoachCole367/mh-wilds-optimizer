import { describe, expect, it } from "vitest";

import { compareBuildResults, optimizeBuilds } from "../optimizer";
import { makeBuildResult, sampleNormalizedData } from "./fixtures/samplePayload";

describe("compareBuildResults", () => {
  it("prioritizes fewer missing points, then defense, then slot headroom", () => {
    const strong = makeBuildResult({
      tieKey: "a",
      missingRequestedPoints: 0,
      defenseMax: 300,
      leftoverSlotCapacity: 12,
    });
    const weak = makeBuildResult({
      tieKey: "b",
      missingRequestedPoints: 1,
      defenseMax: 320,
      leftoverSlotCapacity: 14,
    });
    expect(compareBuildResults(strong, weak)).toBeLessThan(0);
    expect(compareBuildResults(weak, strong)).toBeGreaterThan(0);
  });

  it("returns deterministic ordering for repeated optimizeBuilds runs", () => {
    const request = {
      data: sampleNormalizedData,
      desiredSkills: [
        { skillId: 1, level: 2 },
        { skillId: 2, level: 1 },
      ],
      allowAlpha: true,
      allowGamma: true,
      useAllDecorations: true,
      allowedDecorationIds: [],
      maxResults: 10,
      includeNearMissResults: false,
      maxMissingPoints: 0,
      allowedHeadIds: [11, 12],
    };

    const first = optimizeBuilds(request, 0);
    const second = optimizeBuilds(request, 0);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.results.map((result) => result.tieKey)).toEqual(second.results.map((result) => result.tieKey));
  });
});
