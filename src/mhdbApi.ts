import {
  clearCacheEnvelope,
  readCacheEnvelope,
  type CacheEnvelope,
  writeCacheEnvelope,
} from "./cacheStore";
import { normalizeWildsPayload, type RawWildsPayload } from "./normalize";
import type { LoadDataResult, NormalizedData } from "./types";
import { isPayloadValidationError, validateRawWildsPayload } from "./validatePayload";

const API_BASE_URL = "https://wilds.mhdb.io";
const CACHE_VERSION = "v2";
const CACHE_KEY_PREFIX = `mh-wilds-optimizer:${CACHE_VERSION}:locale`;

type Projection = Record<string, true>;

type VersionResponse = {
  version: string;
};

const SKILLS_PROJECTION: Projection = {
  id: true,
  name: true,
  description: true,
  kind: true,
  "ranks.level": true,
  "ranks.description": true,
};

const ARMOR_PROJECTION: Projection = {
  id: true,
  name: true,
  kind: true,
  rarity: true,
  "defense.base": true,
  "defense.max": true,
  "resistances.fire": true,
  "resistances.water": true,
  "resistances.ice": true,
  "resistances.thunder": true,
  "resistances.dragon": true,
  slots: true,
  "skills.skill.id": true,
  "skills.level": true,
  "armorSet.id": true,
  "armorSet.name": true,
};

const ARMOR_SETS_PROJECTION: Projection = {
  id: true,
  name: true,
  "bonus.id": true,
  "bonus.ranks.pieces": true,
  "bonus.ranks.skill.skill.id": true,
  "bonus.ranks.skill.level": true,
  "groupBonus.id": true,
  "groupBonus.ranks.pieces": true,
  "groupBonus.ranks.skill.skill.id": true,
  "groupBonus.ranks.skill.level": true,
};

const DECORATIONS_PROJECTION: Projection = {
  id: true,
  name: true,
  kind: true,
  slot: true,
  "skills.skill.id": true,
  "skills.level": true,
};

const CHARMS_PROJECTION: Projection = {
  id: true,
  "ranks.id": true,
  "ranks.name": true,
  "ranks.level": true,
  "ranks.rarity": true,
  "ranks.slots": true,
  "ranks.skills.skill.id": true,
  "ranks.skills.level": true,
};

function cacheKey(locale: string): string {
  return `${CACHE_KEY_PREFIX}:${locale}`;
}

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function serializeProjection(projection: Projection): string {
  return encodeURIComponent(JSON.stringify(projection));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchVersion(): Promise<string> {
  const data = await fetchJson<VersionResponse>(`${API_BASE_URL}/version`);
  return data.version;
}

async function fetchLocaleArray<T>(locale: string, path: string, projection: Projection): Promise<T[]> {
  const projectionParam = serializeProjection(projection);
  const url = `${API_BASE_URL}/${locale}${path}?p=${projectionParam}`;
  return fetchJson<T[]>(url);
}

function isCacheEnvelope(value: unknown, locale: string): value is CacheEnvelope<NormalizedData> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const parsed = value as Partial<CacheEnvelope<NormalizedData>>;
  return (
    parsed.locale === locale &&
    typeof parsed.version === "string" &&
    typeof parsed.fetchedAt === "number" &&
    typeof parsed.data === "object" &&
    parsed.data !== null
  );
}

function readLocalStorageCache(locale: string): CacheEnvelope<NormalizedData> | null {
  if (!canUseLocalStorage()) {
    return null;
  }
  try {
    const raw = localStorage.getItem(cacheKey(locale));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isCacheEnvelope(parsed, locale)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalStorageCache(envelope: CacheEnvelope<NormalizedData>): void {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(cacheKey(envelope.locale), JSON.stringify(envelope));
  } catch {
    // Ignore local storage write failures and rely on indexedDB when available.
  }
}

async function readCache(locale: string): Promise<CacheEnvelope<NormalizedData> | null> {
  const indexedEnvelope = await readCacheEnvelope<NormalizedData>(locale);
  if (isCacheEnvelope(indexedEnvelope, locale)) {
    return indexedEnvelope;
  }
  const localEnvelope = readLocalStorageCache(locale);
  if (!localEnvelope) {
    return null;
  }
  void writeCacheEnvelope(locale, localEnvelope);
  return localEnvelope;
}

async function writeCache(envelope: CacheEnvelope<NormalizedData>): Promise<void> {
  writeLocalStorageCache(envelope);
  await writeCacheEnvelope(envelope.locale, envelope);
}

async function fetchAndNormalize(locale: string, version: string): Promise<NormalizedData> {
  const [skills, armor, armorSets, decorations, charms] = await Promise.all([
    fetchLocaleArray<RawWildsPayload["skills"][number]>(locale, "/skills", SKILLS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["armor"][number]>(locale, "/armor", ARMOR_PROJECTION),
    fetchLocaleArray<RawWildsPayload["armorSets"][number]>(locale, "/armor/sets", ARMOR_SETS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["decorations"][number]>(locale, "/decorations", DECORATIONS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["charms"][number]>(locale, "/charms", CHARMS_PROJECTION),
  ]);

  const payload: RawWildsPayload = { skills, armor, armorSets, decorations, charms };
  validateRawWildsPayload(payload);
  return normalizeWildsPayload(payload, { locale, version, fetchedAt: Date.now() });
}

export function clearCachedLocale(locale: string): void {
  if (canUseLocalStorage()) {
    try {
      localStorage.removeItem(cacheKey(locale));
    } catch {
      // Ignore clear failures.
    }
  }
  void clearCacheEnvelope(locale);
}

export async function loadOptimizerData(locale: string, forceRefresh = false): Promise<LoadDataResult> {
  const cached = await readCache(locale);
  let remoteVersion: string | null = null;

  try {
    remoteVersion = await fetchVersion();
  } catch {
    remoteVersion = null;
  }

  if (!forceRefresh && cached && remoteVersion && cached.version === remoteVersion) {
    return {
      data: cached.data,
      source: "cache",
    };
  }

  if (!forceRefresh && cached && !remoteVersion) {
    return {
      data: cached.data,
      source: "cache",
    };
  }

  const nextVersion = remoteVersion ?? cached?.version ?? "unknown";

  try {
    const data = await fetchAndNormalize(locale, nextVersion);
    await writeCache({
      locale,
      version: data.version,
      fetchedAt: data.fetchedAt,
      data,
    });
    return {
      data,
      source: "network",
    };
  } catch (error) {
    if (cached) {
      return {
        data: cached.data,
        source: "cache-fallback",
      };
    }
    if (isPayloadValidationError(error)) {
      throw new Error("Data format changed upstream. Please try again later.");
    }
    throw error;
  }
}
