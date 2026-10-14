import type { BuildResult, NormalizedData } from "./types";
export type SavedBuild = {
  id: string;
  name: string;
  version: string;
  locale: string;
  build: BuildResult;
};
const KEY = "mh-wilds-optimizer:saved-builds:v1";
export function isSavedBuild(value: unknown): value is SavedBuild {
  if (!value || typeof value !== "object") return false;
  const saved = value as SavedBuild,
    b = saved.build;
  const record = (v: unknown) =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const points = (v: unknown) =>
    record(v) &&
    Object.values(v as object).every(
      (n) => Number.isInteger(n) && Number(n) >= 0,
    );
  const slots = (v: unknown) =>
    Array.isArray(v) &&
    v.length <= 3 &&
    v.every((n) => Number.isInteger(n) && n >= 1 && n <= 4);
  if (
    typeof saved.name !== "string" ||
    typeof saved.version !== "string" ||
    !record(b) ||
    typeof b.charmName !== "string" ||
    typeof b.tieKey !== "string" ||
    !record(b.armor) ||
    !["head", "chest", "arms", "waist", "legs"].every((k) =>
      Number.isInteger(b.armor[k as keyof typeof b.armor]),
    ) ||
    !points(b.skillTotals) ||
    !record(b.resist) ||
    !["fire", "water", "ice", "thunder", "dragon"].every((k) =>
      Number.isFinite(b.resist[k as keyof typeof b.resist]),
    ) ||
    ![
      b.defenseBase,
      b.defenseMax,
      b.leftoverSlotCapacity,
      b.wastedRequestedPoints,
    ].every(Number.isFinite) ||
    !slots(b.charmSlots) ||
    (b.weaponSlots !== undefined && !slots(b.weaponSlots)) ||
    !Array.isArray(b.placements) ||
    !b.placements.every(
      (p) =>
        p &&
        Number.isInteger(p.decorationId) &&
        Number.isInteger(p.slotSizeUsed),
    )
  )
    return false;
  if (
    b.equippedCharm &&
    (!slots(b.equippedCharm.slots) ||
      !points(b.equippedCharm.skills) ||
      (b.equippedCharm.weaponSlots !== undefined &&
        !slots(b.equippedCharm.weaponSlots)))
  )
    return false;
  if (
    b.armorPieces &&
    (!record(b.armorPieces) ||
      !Object.values(b.armorPieces).every(
        (p) => p && typeof p.name === "string" && slots(p.slots),
      ))
  )
    return false;
  return true;
}
export function readSavedBuilds(): SavedBuild[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isSavedBuild).slice(0, 50) : [];
  } catch {
    return [];
  }
}
export function writeSavedBuilds(builds: SavedBuild[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(builds.slice(0, 50)));
    return true;
  } catch {
    return false;
  }
}
export function buildChecklist(
  build: BuildResult,
  data: NormalizedData,
): string {
  const lines = [
    "MH Wilds build",
    `Database: ${data.version}`,
    `Locale: ${data.locale}`,
    `Equipment defense: ${build.defenseBase} base / ${build.defenseMax} database maximum`,
  ];
  for (const [kind, id] of Object.entries(build.armor))
    lines.push(
      `${kind}: ${build.armorPieces?.[kind as keyof typeof build.armor]?.name ?? data.armorById[id]?.name ?? `Unknown #${id}`}`,
    );
  lines.push(`Talisman: ${build.charmName}`);
  for (const p of build.placements)
    lines.push(
      `${p.piece ?? "equipment"} ${p.slotKind ?? "armor"} slot ${(p.slotIndex ?? 0) + 1} [${p.slotSizeUsed}]: ${data.decorationsById[p.decorationId]?.name ?? p.decorationId}`,
    );
  lines.push(
    "Skills:",
    ...Object.entries(build.skillTotals).map(
      ([id, n]) => `${data.skillsById[Number(id)]?.name ?? id}: ${n}`,
    ),
  );
  lines.push(
    "Stats exclude food, defensive-skill effects and conditional effects.",
  );
  return lines.join("\n");
}
export function downloadText(
  name: string,
  text: string,
  mime = "application/json",
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
