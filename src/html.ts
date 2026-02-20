const TEXT_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const ATTR_ESCAPE_MAP: Record<string, string> = {
  ...TEXT_ESCAPE_MAP,
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

const TEXT_ESCAPE_PATTERN = /[&<>]/g;
const ATTR_ESCAPE_PATTERN = /[&<>"'`]/g;

export function escapeText(value: string): string {
  return value.replace(TEXT_ESCAPE_PATTERN, (char) => TEXT_ESCAPE_MAP[char]);
}

export function escapeAttr(value: string): string {
  return value.replace(ATTR_ESCAPE_PATTERN, (char) => ATTR_ESCAPE_MAP[char]);
}

export function safeJoin(parts: Array<string | null | undefined>, separator = ""): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(separator);
}
