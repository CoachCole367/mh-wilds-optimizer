import { describe, expect, it } from "vitest";

import { escapeAttr, escapeText, safeJoin } from "../html";

describe("html escaping helpers", () => {
  it("escapes text content safely", () => {
    const raw = `<script>alert("xss")</script>`;
    expect(escapeText(raw)).toBe("&lt;script&gt;alert(\"xss\")&lt;/script&gt;");
  });

  it("escapes attribute content safely", () => {
    const raw = `" onmouseover='alert(1)' \``;
    expect(escapeAttr(raw)).toContain("&quot;");
    expect(escapeAttr(raw)).toContain("&#39;");
    expect(escapeAttr(raw)).toContain("&#96;");
  });

  it("joins only defined string fragments", () => {
    expect(safeJoin(["a", "", null, undefined, "b"], "|")).toBe("a|b");
  });
});
