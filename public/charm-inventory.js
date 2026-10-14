export const STORAGE_KEY = "mh-wilds-optimizer:owned-charms:v1";
export const BACKUP_KEY = `${STORAGE_KEY}:backup`;
export function normalizeSkillName(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
export function normalizeInventory(raw, skills = []) {
  if (!Array.isArray(raw))
    throw new Error("Expected a JSON array of talismans.");
  if (raw.length > 500)
    throw new Error("Import at most 500 talismans at a time.");
  const byName = new Map(skills.map((s) => [normalizeSkillName(s.name), s.id]));
  return raw.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !Array.isArray(entry.slots) ||
      entry.slots.length !== 3
    ) {
      throw new Error(
        `Talisman ${index + 1}: provide three armor slots (use 0 for empty).`,
      );
    }
    const slot = (n) => {
      if (!Number.isInteger(n) || n < 0 || n > 3)
        throw new Error(`Talisman ${index + 1}: slot sizes must be 0–3.`);
      return n;
    };
    const points = {};
    for (const [key, level] of Object.entries(entry.skills || {})) {
      const id = /^\d+$/.test(key)
        ? Number(key)
        : byName.get(normalizeSkillName(key));
      if (!id || !Number.isInteger(level) || level < 1 || level > 99) {
        throw new Error(
          `Talisman ${index + 1}: unknown skill or invalid level (${key}).`,
        );
      }
      // Preserve IDs that are not yet represented by the current upstream dataset.
      points[String(id)] = level;
    }
    return {
      ...entry,
      id: typeof entry.id === "string" ? entry.id : `owned-${index + 1}`,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : `Owned Talisman ${index + 1}`,
      skills: points,
      slots: entry.slots.map(slot),
      weaponSlot: slot(entry.weaponSlot ?? 0),
    };
  });
}
export function readInventory(storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? normalizeInventory(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}
export function saveInventory(charms, storage) {
  try {
    storage ??= globalThis.localStorage;
    const normalized = normalizeInventory(charms);
    const previous = storage?.getItem(STORAGE_KEY);
    if (previous) storage.setItem(BACKUP_KEY, previous);
    if (!storage) throw new Error("Storage unavailable");
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}
export function restoreInventory(storage) {
  try {
    storage ??= globalThis.localStorage;
    const backup = storage?.getItem(BACKUP_KEY);
    if (!backup) throw new Error("No backup available.");
    const charms = normalizeInventory(JSON.parse(backup));
    if (!saveInventory(charms, storage))
      throw new Error("Could not save restored inventory.");
    return charms;
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Could not restore backup.",
    );
  }
}
