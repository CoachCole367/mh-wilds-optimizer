import { describe, expect, it } from "vitest";

import { decodeShareStateV2, encodeShareStateV2 } from "../shareState";

describe("shareState v2", () => {
  it("encodes and decodes a share payload from hash format", () => {
    const params = {
      loc: "en",
      ds: "1-2,2-1",
      decos: "all",
      cm: "suggest",
      t: "4",
    };
    const encoded = encodeShareStateV2(params);
    const decoded = decodeShareStateV2(`#s2=${encoded}`);
    expect(decoded).toEqual(params);
  });

  it("returns null for invalid or mismatched hash payloads", () => {
    expect(decodeShareStateV2("")).toBeNull();
    expect(decodeShareStateV2("#not-a-share-payload")).toBeNull();
    expect(decodeShareStateV2("#s2=this-is-not-base64url")).toBeNull();
  });
});
