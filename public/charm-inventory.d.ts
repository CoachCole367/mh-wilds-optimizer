import type { Charm, SkillInfo } from "../src/types";
export const STORAGE_KEY: string;
export const BACKUP_KEY: string;
export function normalizeSkillName(text: string): string;
export function normalizeInventory(
  raw: unknown,
  skills?: Pick<SkillInfo, "name" | "id">[],
): Charm[];
export function readInventory(storage?: Storage): Charm[];
export function saveInventory(charms: Charm[], storage?: Storage): boolean;
export function restoreInventory(storage?: Storage): Charm[];
