type ShareStateMap = Record<string, string>;

type ShareStateV2 = {
  v: 2;
  c: "plain";
  p: ShareStateMap;
};

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBase64Url(text: string): string {
  return toBase64(ENCODER.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  return DECODER.decode(fromBase64(padded));
}

function isShareStateMap(value: unknown): value is ShareStateMap {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, mapValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || typeof mapValue !== "string") {
      return false;
    }
  }
  return true;
}

export function encodeShareStateV2(params: ShareStateMap): string {
  const payload: ShareStateV2 = {
    v: 2,
    c: "plain",
    p: params,
  };
  return toBase64Url(JSON.stringify(payload));
}

export function decodeShareStateV2(hash: string): ShareStateMap | null {
  if (!hash) {
    return null;
  }
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash) {
    return null;
  }
  const params = new URLSearchParams(rawHash);
  const encoded = params.get("s2");
  if (!encoded) {
    return null;
  }

  try {
    const decoded = fromBase64Url(encoded);
    const parsed = JSON.parse(decoded) as Partial<ShareStateV2>;
    if (parsed.v !== 2 || parsed.c !== "plain" || !isShareStateMap(parsed.p)) {
      return null;
    }
    return parsed.p;
  } catch {
    return null;
  }
}
