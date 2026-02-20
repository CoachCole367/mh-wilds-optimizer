import type { RawWildsPayload } from "./normalize";

type UnknownRecord = Record<string, unknown>;

export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadValidationError";
  }
}

export function isPayloadValidationError(error: unknown): error is PayloadValidationError {
  return error instanceof PayloadValidationError;
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new PayloadValidationError(message);
  }
}

function assertNumber(value: unknown, path: string): asserts value is number {
  assert(typeof value === "number" && Number.isFinite(value), `${path} must be a finite number.`);
}

function assertString(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string", `${path} must be a string.`);
}

function assertOptionalString(value: unknown, path: string): void {
  if (value === undefined || value === null) {
    return;
  }
  assertString(value, path);
}

function assertOptionalArray(value: unknown, path: string): asserts value is unknown[] {
  if (value === undefined || value === null) {
    return;
  }
  assert(Array.isArray(value), `${path} must be an array when provided.`);
}

export function validateRawWildsPayload(raw: unknown): asserts raw is RawWildsPayload {
  assert(isObject(raw), "Payload must be an object.");

  const payload = raw as UnknownRecord;
  assert(Array.isArray(payload.skills), "Payload.skills must be an array.");
  assert(Array.isArray(payload.armor), "Payload.armor must be an array.");
  assert(Array.isArray(payload.armorSets), "Payload.armorSets must be an array.");
  assert(Array.isArray(payload.decorations), "Payload.decorations must be an array.");
  assert(Array.isArray(payload.charms), "Payload.charms must be an array.");

  for (let i = 0; i < payload.skills.length; i += 1) {
    const skill = payload.skills[i];
    assert(isObject(skill), `skills[${i}] must be an object.`);
    assertNumber(skill.id, `skills[${i}].id`);
    assertString(skill.name, `skills[${i}].name`);
    assertOptionalString(skill.description, `skills[${i}].description`);
    assertOptionalString(skill.kind, `skills[${i}].kind`);
    assertOptionalArray(skill.ranks, `skills[${i}].ranks`);
    for (let rankIndex = 0; rankIndex < (skill.ranks ?? []).length; rankIndex += 1) {
      const rank = skill.ranks?.[rankIndex];
      assert(isObject(rank), `skills[${i}].ranks[${rankIndex}] must be an object.`);
      if (rank.level !== undefined && rank.level !== null) {
        assertNumber(rank.level, `skills[${i}].ranks[${rankIndex}].level`);
      }
      assertOptionalString(rank.description, `skills[${i}].ranks[${rankIndex}].description`);
    }
  }

  for (let i = 0; i < payload.armor.length; i += 1) {
    const armor = payload.armor[i];
    assert(isObject(armor), `armor[${i}] must be an object.`);
    assertNumber(armor.id, `armor[${i}].id`);
    assertString(armor.name, `armor[${i}].name`);
    assertString(armor.kind, `armor[${i}].kind`);
    if (armor.slots !== undefined && armor.slots !== null) {
      assert(Array.isArray(armor.slots), `armor[${i}].slots must be an array when provided.`);
    }
    if (armor.skills !== undefined && armor.skills !== null) {
      assert(Array.isArray(armor.skills), `armor[${i}].skills must be an array when provided.`);
    }
  }

  for (let i = 0; i < payload.armorSets.length; i += 1) {
    const armorSet = payload.armorSets[i];
    assert(isObject(armorSet), `armorSets[${i}] must be an object.`);
    assertNumber(armorSet.id, `armorSets[${i}].id`);
    assertString(armorSet.name, `armorSets[${i}].name`);
  }

  for (let i = 0; i < payload.decorations.length; i += 1) {
    const decoration = payload.decorations[i];
    assert(isObject(decoration), `decorations[${i}] must be an object.`);
    assertNumber(decoration.id, `decorations[${i}].id`);
    assertString(decoration.name, `decorations[${i}].name`);
    if (decoration.slot !== undefined && decoration.slot !== null) {
      assertNumber(decoration.slot, `decorations[${i}].slot`);
    }
    if (decoration.skills !== undefined && decoration.skills !== null) {
      assert(Array.isArray(decoration.skills), `decorations[${i}].skills must be an array when provided.`);
    }
  }

  for (let i = 0; i < payload.charms.length; i += 1) {
    const charm = payload.charms[i];
    assert(isObject(charm), `charms[${i}] must be an object.`);
    assertNumber(charm.id, `charms[${i}].id`);
    assertOptionalArray(charm.ranks, `charms[${i}].ranks`);
    for (let rankIndex = 0; rankIndex < (charm.ranks ?? []).length; rankIndex += 1) {
      const rank = charm.ranks?.[rankIndex];
      assert(isObject(rank), `charms[${i}].ranks[${rankIndex}] must be an object.`);
      assertNumber(rank.id, `charms[${i}].ranks[${rankIndex}].id`);
      assertString(rank.name, `charms[${i}].ranks[${rankIndex}].name`);
      if (rank.level !== undefined && rank.level !== null) {
        assertNumber(rank.level, `charms[${i}].ranks[${rankIndex}].level`);
      }
      if (rank.rarity !== undefined && rank.rarity !== null) {
        assertNumber(rank.rarity, `charms[${i}].ranks[${rankIndex}].rarity`);
      }
      if (rank.slots !== undefined && rank.slots !== null) {
        assert(Array.isArray(rank.slots), `charms[${i}].ranks[${rankIndex}].slots must be an array when provided.`);
      }
      if (rank.skills !== undefined && rank.skills !== null) {
        assert(Array.isArray(rank.skills), `charms[${i}].ranks[${rankIndex}].skills must be an array when provided.`);
      }
    }
  }
}
