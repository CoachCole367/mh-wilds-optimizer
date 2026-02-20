import { normalizeWildsPayload, type RawWildsPayload } from "./normalize";
import type { LoadDataResult, NormalizedData } from "./types";

const API_BASE_URL = "https://wilds.mhdb.io";
const CACHE_VERSION = "v1";
const CACHE_KEY_PREFIX = `mh-wilds-optimizer:${CACHE_VERSION}:locale`;

type Projection = Record<string, true>;

type VersionResponse = {
  version: string;
};

type CacheEnvelope = {
  locale: string;
  version: string;
  fetchedAt: number;
  data: NormalizedData;
};

const SKILLS_PROJECTION: Projection = {
  id: true,
  name: true,
  kind: true,
  "ranks.level": true,
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

function readCache(locale: string): CacheEnvelope | null {
  const raw = localStorage.getItem(cacheKey(locale));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (!parsed?.data || parsed.locale !== locale || typeof parsed.version !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(envelope: CacheEnvelope): void {
  localStorage.setItem(cacheKey(envelope.locale), JSON.stringify(envelope));
}

async function fetchAndNormalize(locale: string, version: string): Promise<NormalizedData> {
  const [skills, armor, armorSets, decorations, charms] = await Promise.all([
    fetchLocaleArray<RawWildsPayload["skills"][number]>(locale, "/skills", SKILLS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["armor"][number]>(locale, "/armor", ARMOR_PROJECTION),
    fetchLocaleArray<RawWildsPayload["armorSets"][number]>(locale, "/armor/sets", ARMOR_SETS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["decorations"][number]>(locale, "/decorations", DECORATIONS_PROJECTION),
    fetchLocaleArray<RawWildsPayload["charms"][number]>(locale, "/charms", CHARMS_PROJECTION),
  ]);

  return normalizeWildsPayload(
    { skills, armor, armorSets, decorations, charms },
    { locale, version, fetchedAt: Date.now() },
  );
}

export function clearCachedLocale(locale: string): void {
  localStorage.removeItem(cacheKey(locale));
}

export async function loadOptimizerData(locale: string, forceRefresh = false): Promise<LoadDataResult> {
  const cached = readCache(locale);
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
    writeCache({
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
    throw error;
  }
}
