import { describe, expect, it } from "vitest";

import { sampleNormalizedData } from "./fixtures/samplePayload";
import {
  AUTO_WEAPON_SET_BONUS_SET_ID,
  inferWeaponSetBonusSetIdsFromDesired,
  resolveWeaponSetBonusPiecesForRequest,
} from "../weaponSetBonus";

describe("weaponSetBonus auto inference", () => {
  it("infers matching armor sets from requested set/group bonus skills", () => {
    const fromSetSkill = inferWeaponSetBonusSetIdsFromDesired(sampleNormalizedData, [{ skillId: 3, level: 1 }]);
    const fromGroupSkill = inferWeaponSetBonusSetIdsFromDesired(sampleNormalizedData, [{ skillId: 4, level: 1 }]);
    expect(fromSetSkill).toEqual(["100"]);
    expect(fromGroupSkill).toEqual(["100"]);
  });

  it("resolves auto and manual request payloads to weapon set piece maps", () => {
    const autoResolved = resolveWeaponSetBonusPiecesForRequest(
      sampleNormalizedData,
      [{ skillId: 3, level: 1 }],
      true,
      AUTO_WEAPON_SET_BONUS_SET_ID,
    );
    const autoWithoutSetTargets = resolveWeaponSetBonusPiecesForRequest(
      sampleNormalizedData,
      [{ skillId: 1, level: 2 }],
      true,
      AUTO_WEAPON_SET_BONUS_SET_ID,
    );
    const manualResolved = resolveWeaponSetBonusPiecesForRequest(
      sampleNormalizedData,
      [{ skillId: 1, level: 2 }],
      true,
      "100",
    );

    expect(autoResolved).toEqual({ "100": 1 });
    expect(autoWithoutSetTargets).toEqual({});
    expect(manualResolved).toEqual({ "100": 1 });
  });
});
