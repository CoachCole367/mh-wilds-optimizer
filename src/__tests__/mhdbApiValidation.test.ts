import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOptimizerData } from "../mhdbApi";
import { sampleNormalizedData } from "./fixtures/samplePayload";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function mockInvalidPayloadFetch(version = "new-version"): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/version")) {
      return jsonResponse({ version });
    }
    if (url.includes("/skills")) {
      return jsonResponse([{ id: "invalid-skill-id", name: "bad", kind: "armor" }]);
    }
    if (url.includes("/armor/sets")) {
      return jsonResponse([]);
    }
    if (url.includes("/armor")) {
      return jsonResponse([]);
    }
    if (url.includes("/decorations")) {
      return jsonResponse([]);
    }
    if (url.includes("/charms")) {
      return jsonResponse([]);
    }
    return jsonResponse([], 404);
  });
}

function createLocalStorageMock(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mhdbApi payload validation handling", () => {
  it("throws a clear format-changed error when payload validation fails without cache", async () => {
    vi.stubGlobal("fetch", mockInvalidPayloadFetch());
    await expect(loadOptimizerData("en", true)).rejects.toThrow("Data format changed upstream");
  });

  it("falls back to cache when payload validation fails and cache exists", async () => {
    const cacheKey = "mh-wilds-optimizer:v2:locale:en";
    const cachedEnvelope = {
      locale: "en",
      version: "old-version",
      fetchedAt: Date.now(),
      data: sampleNormalizedData,
    };
    vi.stubGlobal(
      "localStorage",
      createLocalStorageMock({
        [cacheKey]: JSON.stringify(cachedEnvelope),
      }),
    );
    vi.stubGlobal("fetch", mockInvalidPayloadFetch("remote-version"));

    const result = await loadOptimizerData("en", false);
    expect(result.source).toBe("cache-fallback");
    expect(result.data.locale).toBe("en");
  });
});
