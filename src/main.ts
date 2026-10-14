import { interfaceMarkup } from "./interfaceMarkup";
import "./style.css";
import { loadOptimizerData } from "./mhdbApi";
import { escapeAttr as attr, escapeText as esc } from "./html";
import { decodeShareStateV2, encodeShareStateV2 } from "./shareState";
import { startSearch } from "./searchCoordinator";
import {
  readInventory,
  saveInventory,
  normalizeInventory,
  restoreInventory,
  STORAGE_KEY,
} from "../public/charm-inventory.js";
import {
  readSavedBuilds,
  isSavedBuild,
  writeSavedBuilds,
  downloadText,
  buildChecklist,
  type SavedBuild,
} from "./buildStorage";
import {
  suggestFlexDecorations,
  type LeftoverSlot,
  type FlexPresetMode,
} from "./flexSuggestions";
import { suggestCharmsForBuild } from "./charmSuggestions";
import type {
  ArmorKind,
  BuildResult,
  Charm,
  CharmRank,
  DesiredSkill,
  NormalizedData,
  OptimizeWorkerRequest,
  SlotSize,
  SkillPoints,
} from "./types";

const KINDS: ArmorKind[] = ["head", "chest", "arms", "waist", "legs"];
const LOCALES = [
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "it",
  "pl",
  "pt-BR",
  "ru",
  "zh-Hans",
  "zh-Hant",
  "ar",
];
const SETTINGS_KEY = "mh-wilds-optimizer:settings:v3";
const ALIASES: Record<number, string> = {
  57: "wex weakness exploit",
  102: "ee evade extender",
  22: "cb critical boost",
  3: "ce critical eye",
  144: "agi agitator",
  14: "con constitution",
  105: "sr stun resistance",
  122: "db divine blessing",
};
const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = interfaceMarkup(LOCALES);

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const value = (id: string) => $<HTMLInputElement>(id).value;
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const integer = (id: string, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(Number(value(id)) || min)));
type Override = { defense: number; slots: SlotSize[]; state: string };
let data: NormalizedData | null = null,
  resultData: NormalizedData | null = null;
let desired: DesiredSkill[] = [],
  owned: Charm[] = readInventory(),
  selected = new Set<number>(),
  counts: Record<number, number> = {},
  favorites = new Set<number>();
let locks: Partial<Record<ArmorKind, number>> = {},
  exclusions = new Set<number>(),
  overrides: Record<number, Override> = {},
  weaponSkills: SkillPoints = {};
let results: BuildResult[] = [],
  saved = readSavedBuilds(),
  pins: BuildResult[] = [],
  visibleSkills = 20,
  visibleResults = 10,
  runId = 0;
let active: ReturnType<typeof startSearch> | null = null,
  loading = false,
  stale = false,
  linkedBuild: SavedBuild | null = null;
function status(text: string): void {
  $("run-status").textContent = text;
}
function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}
function slots(text: string): SlotSize[] {
  if (!text.trim()) return [];
  const values = text
    .split(/[,\s-]+/)
    .filter(Boolean)
    .map(Number);
  if (
    values.length > 3 ||
    values.some((n) => !Number.isInteger(n) || n < 0 || n > 3)
  )
    throw new Error("Enter up to three slot sizes 0–3, such as 3,2,1.");
  return values.filter((n) => n > 0) as SlotSize[];
}
function inventoryRanks(charms: Charm[]): CharmRank[] {
  return charms.map((c, i) => ({
    id: -(i + 1),
    charmId: -(i + 1),
    name: c.name,
    level: 0,
    rarity: c.rarity ?? 0,
    skills: Object.fromEntries(
      Object.entries(c.skills).map(([id, n]) => [Number(id), n]),
    ),
    slots: c.slots.filter((n) => n > 0) as SlotSize[],
    weaponSlots: c.weaponSlot ? [c.weaponSlot as SlotSize] : [],
  }));
}
function settings(): Record<string, string> {
  return {
    loc: value("locale"),
    cm: value("mode"),
    ds: desired
      .map((s) => `${s.skillId}:${s.level}${s.optional ? ":optional" : ""}`)
      .join(","),
    decos: [...selected].join(","),
    dc: JSON.stringify(counts),
    od: checked("owned-decos") ? "1" : "0",
    aa: checked("alpha") ? "1" : "0",
    ag: checked("gamma") ? "1" : "0",
    r: value("result-limit"),
    t: value("workers"),
    nmm: value("missing"),
    sort: value("sort"),
    rank: value("armor-rank"),
    rarity: value("rarity"),
    hr: value("hr"),
    up: value("upgrade"),
    locks: JSON.stringify(locks),
    excluded: JSON.stringify([...exclusions]),
    overrides: JSON.stringify(overrides),
    ws: value("weapon-set"),
    wg: value("weapon-group"),
    wslots: value("weapon-slots"),
    wskills: JSON.stringify(weaponSkills),
    fp: value("flex-preset"),
    favorites: JSON.stringify([...favorites]),
    version: data?.version ?? "unknown",
  };
}
function storeSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings()));
  } catch {
    /* Session remains usable. */
  }
}
function numericRecord(
  text: string | undefined,
  min: number,
  max: number,
): Record<string, number> {
  const raw = parseJson<unknown>(text, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([, n]) =>
        typeof n === "number" && Number.isInteger(n) && n >= min && n <= max,
    ),
  );
}
function idList(text: string | undefined): number[] {
  const raw = parseJson<unknown>(text, []);
  return Array.isArray(raw)
    ? raw.filter((n) => Number.isInteger(n) && n > 0)
    : [];
}
function validOverrides(text: string | undefined): Record<number, Override> {
  const raw = parseJson<unknown>(text, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, o]) =>
        Number.isInteger(Number(id)) &&
        o &&
        typeof o.defense === "number" &&
        Number.isInteger(o.defense) &&
        o.defense >= 0 &&
        o.defense <= 999 &&
        Array.isArray(o.slots) &&
        o.slots.length <= 3 &&
        o.slots.every((s: number) => Number.isInteger(s) && s > 0 && s <= 3) &&
        typeof o.state === "string",
    ),
  );
}

function restoreSettings(): void {
  let local: Record<string, string> = {};
  try {
    local = parseJson(localStorage.getItem(SETTINGS_KEY), {});
  } catch {
    /* Storage optional. */
  }
  const shared = decodeShareStateV2(location.hash),
    query = Object.fromEntries(new URLSearchParams(location.search));
  const input = shared ?? (location.search ? query : local);
  const fields: Record<string, string> = {
    loc: "locale",
    cm: "mode",
    r: "result-limit",
    t: "workers",
    nmm: "missing",
    sort: "sort",
    rank: "armor-rank",
    rarity: "rarity",
    hr: "hr",
    up: "upgrade",
    fp: "flex-preset",
    wslots: "weapon-slots",
  };
  for (const [key, id] of Object.entries(fields))
    if (input[key] !== undefined) $<HTMLInputElement>(id).value = input[key];
  if (!LOCALES.includes(value("locale")))
    $<HTMLSelectElement>("locale").value = "en";
  if (!["off", "owned", "suggest"].includes(value("mode")))
    $<HTMLSelectElement>("mode").value = "off";
  for (const [key, id] of [
    ["aa", "alpha"],
    ["ag", "gamma"],
    ["od", "owned-decos"],
  ])
    if (input[key] !== undefined)
      $<HTMLInputElement>(id).checked = input[key] === "1";
  desired = (input.ds ?? "")
    .split(",")
    .map((s) => {
      const [id, n, opt] = s.split(":");
      return {
        skillId: Number(id),
        level: Number(n),
        optional: opt === "optional",
      };
    })
    .filter(
      (s) =>
        Number.isInteger(s.skillId) &&
        s.skillId > 0 &&
        Number.isInteger(s.level) &&
        s.level > 0,
    );
  selected = new Set(
    (input.decos ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  );
  counts = numericRecord(input.dc, 0, 99);
  locks = Object.fromEntries(
    Object.entries(numericRecord(input.locks, 1, 1000000)).filter(([k]) =>
      KINDS.includes(k as ArmorKind),
    ),
  );
  exclusions = new Set(idList(input.excluded));
  overrides = validOverrides(input.overrides);
  weaponSkills = numericRecord(input.wskills, 1, 99);
  favorites = new Set(idList(input.favorites));
  $<HTMLSelectElement>("weapon-set").dataset.initial = input.ws ?? "";
  $<HTMLSelectElement>("weapon-group").dataset.initial = input.wg ?? "";
  if (input.charm) {
    try {
      owned = normalizeInventory([JSON.parse(input.charm)]);
      $<HTMLSelectElement>("mode").value = "owned";
    } catch {
      status(
        "Shared talisman could not be read; your saved library was preserved.",
      );
    }
  }
  if (input.build)
    linkedBuild = parseJson<SavedBuild | null>(input.build, null);
  if (input.version) $("data-status").dataset.linkVersion = input.version;
  $("deco-list").dataset.initial =
    (input.decos ?? "all") === "all" ? "all" : "selected";
}
function changed(): void {
  if (active) return;
  stale = results.length > 0;
  pins = [];
  visibleResults = 10;
  status(
    stale
      ? "Settings changed. Find builds again to apply them."
      : "Ready when you are.",
  );
  renderResults();
  storeSettings();
  updateButtons();
}
function updateButtons(): void {
  $<HTMLSelectElement>("locale").disabled = loading || !!active;
  $<HTMLButtonElement>("optimize").disabled =
    loading || !!active || !data || !desired.some((s) => !s.optional);
  $<HTMLButtonElement>("stop").disabled = !active;
  $<HTMLButtonElement>("refresh-data").disabled = loading || !!active;
}
function setBusy(busy: boolean): void {
  root
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input,select,button")
    .forEach((e) => {
      if (e.id !== "stop") e.disabled = busy;
    });
  $("inventory").toggleAttribute("inert", busy);
  updateButtons();
}
function renderMode(): void {
  $("mode-help").textContent =
    value("mode") === "owned"
      ? "Equips exactly one talisman from your library, including its weapon slot."
      : value("mode") === "suggest"
        ? "Explores an unverified sample of hypothetical talismans. These are requirement ideas, not guaranteed legal rolls or farming probabilities."
        : "Uses one craftable talisman or no talisman. Decorations are fitted during search.";
  if (value("mode") === "owned") $<HTMLDetailsElement>("inventory").open = true;
  $("inventory-summary").textContent =
    `${owned.length} talismans available. Your inventory stays on this device.`;
}
function renderSkills(): void {
  if (!data) return;
  const q = value("skill-search").normalize("NFKC").toLocaleLowerCase(),
    kind = value("skill-type");
  const matching = data.skills.filter(
    (s) =>
      (kind === "all" ||
        kind === s.kind ||
        (kind === "favorites" && favorites.has(s.id))) &&
      `${s.name.toLocaleLowerCase()} ${ALIASES[s.id] ?? ""}`.includes(q),
  );
  $("skill-options").innerHTML =
    matching
      .slice(0, visibleSkills)
      .map(
        (s) =>
          `<div class="skill-choice"><button data-add-skill="${s.id}" ${desired.some((d) => d.skillId === s.id) ? "disabled" : ""}>${esc(s.name)} <small>${esc(s.kind)} · max ${s.maxLevel}</small></button><button data-favorite="${s.id}" aria-label="${favorites.has(s.id) ? "Unfavorite" : "Favorite"} ${attr(s.name)}" aria-pressed="${favorites.has(s.id)}">${favorites.has(s.id) ? "★" : "☆"}</button></div>`,
      )
      .join("") || "<p>No matching skills.</p>";
  $("more-skills").hidden = matching.length <= visibleSkills;
}
function renderSetTargets(): void {
  if (!data) return;
  const select = $<HTMLSelectElement>("set-target");
  const previous = select.value;
  select.innerHTML = data.skills
    .filter((s) => s.kind === "set" || s.kind === "group")
    .map(
      (s) =>
        `<option value="${s.id}">${esc(s.name)} (${s.kind} bonus)</option>`,
    )
    .join("");
  if (data.skillsById[Number(previous)]) select.value = previous;
  renderSetLevels();
}
function renderSetLevels(): void {
  if (!data) return;
  const id = Number(value("set-target")),
    skill = data.skillsById[id];
  const level = $<HTMLSelectElement>("set-level");
  const previous = level.value;
  level.innerHTML = skill
    ? Array.from(
        { length: skill.maxLevel },
        (_, i) => `<option value="${i + 1}">Level ${i + 1}</option>`,
      ).join("")
    : "";
  if ([...level.options].some((o) => o.value === previous))
    level.value = previous;
  const ranks = Object.values(data.armorSetsById).flatMap((set) =>
    (skill?.kind === "group" ? set.groupBonusRanks : set.bonusRanks)
      .filter((rank) => rank.skills[id])
      .map((rank) => `${rank.pieces} pieces → level ${rank.skills[id]}`),
  );
  $("set-thresholds").textContent =
    [...new Set(ranks)].join(" · ") ||
    "No bonus thresholds available in this dataset.";
  $<HTMLButtonElement>("set-add").disabled = !skill || !!active;
}
function addRequiredTarget(id: number, level = 1): void {
  if (active || !data?.skillsById[id]) return;
  const existing = desired.find((d) => d.skillId === id);
  if (existing) {
    existing.level = level;
    existing.optional = false;
  } else desired.push({ skillId: id, level });
  renderDesired();
  renderSkills();
  renderDecos();
  changed();
}
function renderDesired(): void {
  if (!data) return;
  $("desired-list").innerHTML =
    desired
      .map((d) => {
        const s = data!.skillsById[d.skillId];
        if (!s) return "";
        return `<article class="target-row"><strong>${esc(s.name)}</strong><div class="level-picker">${Array.from({ length: s.maxLevel }, (_, i) => `<button data-skill-level="${d.skillId}" data-level="${i + 1}" aria-label="${attr(s.name)} level ${i + 1}" aria-pressed="${d.level === i + 1}" class="level-btn ${d.level === i + 1 ? "active" : ""}">${i + 1}</button>`).join("")}</div><label><input type="checkbox" data-optional="${d.skillId}" ${d.optional ? "checked" : ""}/>Preferred</label><button data-remove-skill="${d.skillId}" aria-label="Remove ${attr(s.name)}">Remove</button><details><summary>Effects and activation</summary><p>${esc(s.description)}</p>${Object.entries(
          s.rankDescriptions,
        )
          .map(([lv, text]) => `<p>Level ${lv}: ${esc(text)}</p>`)
          .join("")}</details></article>`;
      })
      .join("") ||
    "<p>No targets yet. Add a skill or try the comfort example.</p>";
  updateButtons();
}
function usableDecorations() {
  if (!data) return [];
  let weapon = false;
  try {
    weapon =
      slots(value("weapon-slots")).length > 0 ||
      owned.some((c) => !!c.weaponSlot) ||
      desired.some((d) => data!.skillsById[d.skillId]?.kind === "weapon");
  } catch {
    /* Search validates inputs. */
  }
  return data.decorations
    .filter((d) => d.kind === "armor" || (weapon && d.kind === "weapon"))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}
function renderDecos(): void {
  if (!data) return;
  const all = usableDecorations(),
    q = value("deco-search").toLocaleLowerCase(),
    visible = all.filter((d) =>
      `${d.name} ${d.slotReq} ${Object.keys(d.skills)
        .map((id) => data!.skillsById[Number(id)]?.name)
        .join(" ")}`
        .toLocaleLowerCase()
        .includes(q),
    );
  $("deco-list").innerHTML = visible
    .map(
      (d) =>
        `<div class="deco-row"><label><input type="checkbox" data-deco="${d.id}" ${selected.has(d.id) ? "checked" : ""}/><span>${esc(d.name)} <small>[${d.slotReq}] ${esc(d.kind)} · ${Object.entries(
          d.skills,
        )
          .map(
            ([id, n]) =>
              `${esc(data!.skillsById[Number(id)]?.name ?? id)} +${n}`,
          )
          .join(
            ", ",
          )}</small></span></label>${checked("owned-decos") ? `<label class="deco-count">Owned<input type="number" min="0" max="99" data-count="${d.id}" value="${counts[d.id] ?? 0}" aria-label="Owned copies of ${attr(d.name)}"/></label>` : ""}</div>`,
    )
    .join("");
  $("deco-summary").textContent =
    `${all.filter((d) => selected.has(d.id)).length}/${all.length} usable types selected; ${visible.length} match your search.`;
}
function renderEquipment(): void {
  if (!data) return;
  $("armor-locks").innerHTML = KINDS.map(
    (k) =>
      `<label class="field">Lock ${k}<select data-lock="${k}"><option value="">Any ${k} piece</option>${data!.armorByKind[k].map((p) => `<option value="${p.id}" ${locks[k] === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>`,
  ).join("");
  $("excluded").innerHTML = [...exclusions]
    .map(
      (id) =>
        `<button data-include="${id}">Include ${esc(data!.armorById[id]?.name ?? String(id))} again</button>`,
    )
    .join("");
  $<HTMLSelectElement>("override-piece").innerHTML = Object.values(
    data.armorById,
  )
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join("");
  const sets = Object.values(data.armorSetsById),
    ss = $<HTMLSelectElement>("weapon-set"),
    gs = $<HTMLSelectElement>("weapon-group"),
    oldSet = ss.value || ss.dataset.initial || "",
    oldGroup = gs.value || gs.dataset.initial || "";
  ss.innerHTML =
    '<option value="">No weapon set roll</option>' +
    sets
      .filter((s) => s.bonusId !== null)
      .map(
        (s) =>
          `<option value="${s.id}">${esc(s.name)} — ${esc(
            Object.keys(s.bonusRanks[0]?.skills ?? {})
              .map((id) => data!.skillsById[Number(id)]?.name)
              .join(", "),
          )}</option>`,
      )
      .join("");
  const groups = [
    ...new Map(
      sets
        .filter((s) => s.groupBonusId !== null)
        .map((s) => [s.groupBonusId, s]),
    ).values(),
  ];
  gs.innerHTML =
    '<option value="">No weapon group roll</option>' +
    groups
      .map(
        (s) =>
          `<option value="${s.groupBonusId}">${esc(
            Object.keys(s.groupBonusRanks[0]?.skills ?? {})
              .map((id) => data!.skillsById[Number(id)]?.name)
              .join(", "),
          )}</option>`,
      )
      .join("");
  ss.value = oldSet;
  gs.value = oldGroup;
  $<HTMLSelectElement>("weapon-skill").innerHTML = data.skills
    .filter((s) => s.kind === "weapon")
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
    .join("");
  $("weapon-skills").innerHTML = Object.entries(weaponSkills)
    .map(
      ([id, n]) =>
        `<button data-remove-weapon="${id}">${esc(data!.skillsById[Number(id)]?.name ?? id)} ${n} · Remove</button>`,
    )
    .join("");
  $("overrides-summary").textContent = Object.entries(overrides)
    .map(
      ([id, o]) =>
        `${data!.armorById[Number(id)]?.name ?? id}: ${o.state}, DEF ${o.defense}, slots ${o.slots.join("-") || "none"}`,
    )
    .join("; ");
}
function effectiveData(): NormalizedData {
  const next = structuredClone(data!);
  for (const kind of KINDS)
    next.armorByKind[kind] = next.armorByKind[kind]
      .filter((p) => !exclusions.has(p.id))
      .map((p) => {
        const o = value("upgrade") === "base" ? undefined : overrides[p.id],
          piece = o
            ? {
                ...p,
                slots: o.slots,
                defenseMax: o.defense,
                upgradeState: "custom" as const,
              }
            : p;
        next.armorById[p.id] = piece;
        return piece;
      });
  return next;
}
function makeRequest(): OptimizeWorkerRequest {
  const next = effectiveData(),
    pool = value("mode") === "owned" ? inventoryRanks(owned) : undefined;
  if (value("mode") === "owned" && !pool?.length)
    throw new Error("Add or import a talisman first.");
  for (const c of pool ?? [])
    for (const [id, n] of Object.entries(c.skills))
      if (
        !next.skillsById[Number(id)] ||
        n > next.skillsById[Number(id)].maxLevel ||
        !["armor", "weapon"].includes(next.skillsById[Number(id)].kind)
      )
        throw new Error(
          `${c.name}: verify unknown skills or levels above the game maximum. Your original inventory was preserved.`,
        );
  const request: OptimizeWorkerRequest = {
    data: next,
    desiredSkills: desired,
    allowAlpha: checked("alpha"),
    allowGamma: checked("gamma"),
    useAllDecorations: false,
    allowedDecorationIds: [...selected],
    decorationCounts: checked("owned-decos") ? counts : undefined,
    maxResults: integer("result-limit", 1, 100),
    allowedHeadIds: next.armorByKind.head.map((p) => p.id),
    charmPool: pool,
    includeNearMissResults: integer("missing", 0, 12) > 0,
    maxMissingPoints: integer("missing", 0, 12),
    armorRank: value("armor-rank"),
    maxRarity: integer("rarity", 1, 12),
    armorUpgradeMode: value("upgrade") === "base" ? "base" : "database",
    armorConstraints: Object.fromEntries(
      Object.entries(locks).map(([k, id]) => [k, [id]]),
    ),
    weaponSlots: slots(value("weapon-slots")),
    weaponSkills,
    weaponSetBonusPieces: value("weapon-set")
      ? { [value("weapon-set")]: 1 }
      : {},
    weaponGroupBonusPieces: value("weapon-group")
      ? { [value("weapon-group")]: 1 }
      : {},
    sortMode: value("sort") as OptimizeWorkerRequest["sortMode"],
  };
  if (value("mode") === "suggest") {
    const empty: BuildResult = {
      armor: { head: 0, chest: 0, arms: 0, waist: 0, legs: 0 },
      charmRankId: 0,
      charmName: "",
      charmSlots: [],
      placements: [],
      skillTotals: {},
      defenseBase: 0,
      defenseMax: 0,
      resist: { fire: 0, water: 0, ice: 0, thunder: 0, dragon: 0 },
      leftoverSlotCapacity: 0,
      wastedRequestedPoints: 0,
      tieKey: "template",
    };
    const templates = suggestCharmsForBuild({
      build: empty,
      data: next,
      targetConfig: { requiredSkills: desired.filter((s) => !s.optional) },
      options: { suggestCount: 20 },
    });
    request.charmPool = [
      ...next.charmRanks,
      ...inventoryRanks(
        templates.map((t) => ({
          ...t.charm,
          name: `Unverified template: ${Object.entries(t.charm.skills)
            .map(([id, n]) => `${next.skillsById[Number(id)]?.name ?? id} ${n}`)
            .join(" / ")} [${t.charm.slots.join("-")}]`,
        })),
      ),
    ];
  }
  if (!request.charmPool)
    request.charmPool = [
      {
        id: 0,
        charmId: 0,
        name: "No talisman",
        level: 0,
        rarity: 0,
        skills: {},
        slots: [],
      },
      ...next.charmRanks,
    ];
  return request;
}
type DisplaySlot = {
  piece: string;
  name: string;
  kind: "armor" | "weapon";
  index: number;
  size: SlotSize;
};
function pieceSlots(build: BuildResult): DisplaySlot[] {
  const source = resultData ?? data!,
    output: DisplaySlot[] = KINDS.flatMap((k) =>
      (
        build.armorPieces?.[k]?.slots ??
        source.armorById[build.armor[k]]?.slots ??
        []
      ).map((size, index) => ({
        piece: k,
        name:
          build.armorPieces?.[k]?.name ?? source.armorById[build.armor[k]].name,
        kind: "armor" as const,
        index,
        size,
      })),
    );
  build.charmSlots.forEach((size, index) =>
    output.push({
      piece: "charm",
      name: build.charmName,
      kind: "armor",
      index,
      size,
    }),
  );
  build.equippedCharm?.weaponSlots?.forEach((size, index) =>
    output.push({
      piece: "charm",
      name: build.charmName,
      kind: "weapon",
      index,
      size,
    }),
  );
  build.weaponSlots?.forEach((size, index) =>
    output.push({
      piece: "weapon",
      name: "Equipped weapon",
      kind: "weapon",
      index,
      size,
    }),
  );
  return output;
}
function buildCard(b: BuildResult, index: number): string {
  const source = resultData ?? data!,
    missing = b.missingRequestedPoints ?? 0;
  const gear = KINDS.map((k) => {
    const p = b.armorPieces?.[k] ?? source.armorById[b.armor[k]];
    return `<tr><th>${k}</th><td>${esc(p?.name ?? "Unavailable piece")}${p?.upgradeState === "custom" ? " · entered upgrade" : ""}</td><td><button data-lock-result="${index}" data-kind="${k}">Lock</button><button data-exclude="${b.armor[k]}">Exclude</button></td></tr>`;
  }).join("");
  const slotRows = pieceSlots(b)
    .map((s) => {
      const p = b.placements.find(
        (p) =>
          p.piece === s.piece &&
          p.slotKind === s.kind &&
          p.slotIndex === s.index,
      );
      return `<li>${esc(s.piece)} · ${s.kind} [${s.size}] ${p ? esc(source.decorationsById[p.decorationId]?.name ?? "Unknown jewel") : "Empty"}</li>`;
    })
    .join("");
  const bonuses = Object.entries(b.skillTotals)
    .filter(
      ([id, n]) =>
        n > 0 && ["set", "group"].includes(source.skillsById[Number(id)]?.kind),
    )
    .map(([id, n]) => `${source.skillsById[Number(id)].name} ${n}`)
    .join(" · ");
  return `<article class="result-card"><h3>Build ${index + 1} · ${missing ? `Missing ${missing} required levels` : "Required skills met"}</h3>${b.charmName.startsWith("Unverified template:") ? '<p class="warning">Hypothetical talisman: legal roll not verified.</p>' : ""}<p>Equipment DEF ${b.defenseMax} · empty slot capacity ${b.leftoverSlotCapacity} · preferred levels ${b.optionalSkillPoints ?? 0}</p><table class="simple-table">${gear}<tr><th>Talisman</th><td colspan="2">${esc(b.charmName)}</td></tr></table><p>${bonuses ? `Active bonuses: ${esc(bonuses)}` : "No active set/group bonus."}</p><div class="target-checklist">${desired
    .map((d) => {
      const n = b.skillTotals[d.skillId] ?? 0;
      return `<span class="skill-chip">${esc(source.skillsById[d.skillId]?.name ?? String(d.skillId))}: ${n}/${d.level} ${d.optional ? "preferred" : n >= d.level ? "met" : "missing"}</span>`;
    })
    .join(
      "",
    )}</div><details><summary>Decorations and empty slots</summary><ul>${slotRows || "<li>No slots</li>"}</ul></details><details><summary>All skills and equipment stats</summary><p>${Object.entries(
    b.skillTotals,
  )
    .map(([id, n]) => `${esc(source.skillsById[Number(id)]?.name ?? id)} ${n}`)
    .join(
      " · ",
    )}</p><p>Base DEF ${b.defenseBase}; database/entered max DEF ${b.defenseMax}. Resistances: ${Object.entries(
    b.resist,
  )
    .map(([el, n]) => `${el} ${n}`)
    .join(
      " · ",
    )}. Food and skill effects excluded.</p></details><details data-flex="${index}"><summary>Suggestions for leftover armor slots</summary><div class="flex-body">Open to calculate.</div></details><div class="button-row"><button data-pin="${index}">${pins.some((p) => p.tieKey === b.tieKey) ? "Unpin" : "Compare"}</button><button data-save="${index}">Save build</button><button data-export="${index}">Download checklist</button><button data-share="${index}">Share this build</button></div></article>`;
}
function renderResults(): void {
  $("results").innerHTML = stale
    ? "<p class='warning'>Results use previous settings. Run the search again before using them.</p>"
    : results.length
      ? results.slice(0, visibleResults).map(buildCard).join("")
      : "<p>Add at least one required skill, then Find builds. If no match is found, lower a target, increase jewel counts, or allow more armor.</p>";
  $("more-results").hidden = stale || visibleResults >= results.length;
  $("comparison").innerHTML = pins.length
    ? `<h3>Pinned comparison</h3><div class="comparison-scroll"><table class="simple-table"><tr><th>Metric</th>${pins.map((_, i) => `<th>Build ${i + 1}</th>`).join("")}</tr>${["charmName", "defenseMax", "leftoverSlotCapacity", "missingRequestedPoints"].map((key) => `<tr><th>${esc(({ charmName: "Talisman", defenseMax: "Equipment defense", leftoverSlotCapacity: "Empty slot capacity", missingRequestedPoints: "Missing required levels" } as Record<string, string>)[key])}</th>${pins.map((p) => `<td>${esc(String(p[key as keyof BuildResult] ?? 0))}</td>`).join("")}</tr>`).join("")}${KINDS.map((k) => `<tr><th>${k}</th>${pins.map((p) => `<td>${esc((resultData ?? data!).armorById[p.armor[k]]?.name ?? "Unknown")}</td>`).join("")}</tr>`).join("")}${desired.map((d) => `<tr><th>${esc(data!.skillsById[d.skillId]?.name ?? String(d.skillId))}</th>${pins.map((p) => `<td>${p.skillTotals[d.skillId] ?? 0}/${d.level}</td>`).join("")}</tr>`).join("")}</table></div>`
    : "";
}
function renderSaved(): void {
  $("saved-builds").innerHTML =
    saved
      .map(
        (b, i) =>
          `<article><strong>${esc(b.name)}</strong> · data ${esc(b.version)} <button data-open-saved="${i}">View</button><button data-delete-saved="${i}">Delete</button><button data-export-saved="${i}">Export JSON</button></article>`,
      )
      .join("") || "<p>No saved builds yet.</p>";
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    status("Link copied.");
  } catch {
    status(text);
  }
}
function share(build?: BuildResult): string {
  const p = settings();
  if (build) {
    p.build = JSON.stringify({
      id: "shared",
      name: "Shared build",
      locale: data!.locale,
      version: data!.version,
      build,
    });
    if (build.equippedCharm)
      p.charm = JSON.stringify({
        name: build.charmName,
        skills: build.equippedCharm.skills,
        slots: [...build.charmSlots, 0, 0, 0].slice(0, 3),
        weaponSlot: build.equippedCharm.weaponSlots?.[0] ?? 0,
      });
  }
  const encoded = encodeShareStateV2(p);
  if (encoded.length > 32000)
    throw new Error("Link too large. Export JSON instead.");
  return `${location.origin}${location.pathname}#s2=${encoded}`;
}
function showSaved(build: SavedBuild): void {
  if (
    !data ||
    !isSavedBuild(build) ||
    !Array.isArray(build.build.placements) ||
    !Array.isArray(build.build.charmSlots) ||
    !build.build.resist ||
    !build.build.skillTotals ||
    !KINDS.every((k) => data!.armorById[build.build.armor[k]])
  ) {
    status(
      "This saved build references equipment unavailable in the current database.",
    );
    return;
  }
  resultData = effectiveData();
  results = [build.build];
  stale = false;
  pins = [];
  renderResults();
  status(
    build.version === data.version
      ? `Viewing ${build.name}.`
      : `Viewing ${build.name} from a different database. Re-run before relying on it.`,
  );
}
async function load(force = false): Promise<void> {
  if (active) return;
  loading = true;
  updateButtons();
  $("data-status").textContent = "Loading equipment…";
  try {
    const loaded = await loadOptimizerData(value("locale") || "en", force);
    data = loaded.data;
    desired = desired
      .filter((d) => data!.skillsById[d.skillId])
      .map((d) => ({
        ...d,
        level: Math.min(d.level, data!.skillsById[d.skillId].maxLevel),
      }));
    if ($("deco-list").dataset.initial === "all")
      selected = new Set(data.decorations.map((d) => d.id));
    $("deco-list").dataset.initial = "selected";
    const source =
      loaded.source === "network"
        ? "Fresh network data"
        : loaded.source === "cache-fallback"
          ? "Cached fallback: refresh failed"
          : "Cached data";
    $("data-status").textContent =
      `${source} · database ${data.version} · fetched ${new Date(data.fetchedAt).toLocaleString()}${$("data-status").dataset.linkVersion && $("data-status").dataset.linkVersion !== data.version ? " · shared link uses different data" : ""}`;
    $("coverage").textContent =
      `${data.skills.length} skills, ${Object.keys(data.armorById).length} pieces, ${data.decorations.length} decorations. Equipment counts do not certify complete patch coverage.`;
    renderMode();
    renderEquipment();
    renderSetTargets();
    renderSkills();
    renderDesired();
    renderDecos();
    renderSaved();
    if (linkedBuild) {
      showSaved(linkedBuild);
      linkedBuild = null;
    } else renderResults();
  } catch (e) {
    $("data-status").textContent =
      `Load failed: ${e instanceof Error ? e.message : e}. Retry Refresh data.`;
    status("Equipment data unavailable. Your inventory was preserved.");
  } finally {
    loading = false;
    updateButtons();
  }
}
async function search(): Promise<void> {
  if (active || !data) return;
  let request: OptimizeWorkerRequest;
  try {
    request = makeRequest();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
    return;
  }
  if (!desired.some((s) => !s.optional)) {
    status("Add at least one required skill.");
    return;
  }
  const id = ++runId;
  resultData = request.data;
  stale = false;
  pins = [];
  results = [];
  renderResults();
  storeSettings();
  $("progress").removeAttribute("value");
  const started = performance.now();
  let last = 0;
  active = startSearch(request, integer("workers", 1, 4), (visited, found) => {
    if (id !== runId) return;
    const now = performance.now();
    if (now - last < 150) return;
    last = now;
    status(
      `Searching · ${Math.round((now - started) / 1000)}s · ${visited.toLocaleString()} branches visited · ${found.toLocaleString()} feasible candidates. Pruned branches are skipped.`,
    );
  });
  setBusy(true);
  status("Searching for builds…");
  try {
    const output = await active.promise;
    if (id !== runId) return;
    results = output.results;
    visibleResults = 10;
    status(
      results.length
        ? `${results.length} builds found in ${(output.durationMs / 1000).toFixed(2)}s.${value("mode") === "suggest" ? " Hypothetical rolls remain unverified." : ""}`
        : "No builds satisfy these constraints. Check levels, quantities, locks and exclusions; allow a missing level to inspect alternatives.",
    );
  } catch (e) {
    if (id === runId) status(e instanceof Error ? e.message : String(e));
  } finally {
    if (id === runId) {
      active = null;
      $("progress").setAttribute("value", "1");
      setBusy(false);
      renderResults();
    }
  }
}

restoreSettings();
renderMode();
renderSaved();
$("skill-search").addEventListener("input", () => {
  visibleSkills = 20;
  renderSkills();
});
$("set-target").addEventListener("change", renderSetLevels);
$("set-add").addEventListener("click", () =>
  addRequiredTarget(Number(value("set-target")), Number(value("set-level"))),
);
$("skill-type").addEventListener("change", () => {
  visibleSkills = 20;
  renderSkills();
});
$("more-skills").addEventListener("click", () => {
  visibleSkills += 20;
  renderSkills();
});
$("skill-options").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b || active) return;
  if (b.dataset.favorite) {
    const id = Number(b.dataset.favorite);
    favorites.has(id) ? favorites.delete(id) : favorites.add(id);
    renderSkills();
    storeSettings();
    return;
  }
  const id = Number(b.dataset.addSkill);
  if (!data?.skillsById[id] || desired.some((d) => d.skillId === id)) return;
  addRequiredTarget(id);
});
$("desired-list").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b || active) return;
  if (b.dataset.removeSkill) {
    desired = desired.filter(
      (s) => s.skillId !== Number(b.dataset.removeSkill),
    );
    renderDesired();
    renderSkills();
    $("skill-search").focus();
  } else if (b.dataset.skillLevel) {
    const d = desired.find((s) => s.skillId === Number(b.dataset.skillLevel));
    if (d) d.level = Number(b.dataset.level);
    renderDesired();
  } else return;
  changed();
});
$("desired-list").addEventListener("change", (event) => {
  const i = event.target as HTMLInputElement;
  if (i.dataset.optional) {
    const d = desired.find((s) => s.skillId === Number(i.dataset.optional));
    if (d) d.optional = i.checked;
    changed();
  }
});
$("example").addEventListener("click", () => {
  if (!data) return;
  desired = [
    { skillId: 105, level: 3 },
    { skillId: 102, level: 1 },
  ].filter((s) => data!.skillsById[s.skillId]);
  renderDesired();
  renderSkills();
  changed();
});
$("deco-search").addEventListener("input", renderDecos);
$("owned-decos").addEventListener("change", () => {
  renderDecos();
  changed();
});
$("deco-list").addEventListener("change", (event) => {
  const i = event.target as HTMLInputElement;
  if (i.dataset.deco) {
    const id = Number(i.dataset.deco);
    i.checked ? selected.add(id) : selected.delete(id);
  }
  if (i.dataset.count) {
    const id = Number(i.dataset.count);
    counts[id] = Math.max(0, Math.min(99, Math.floor(Number(i.value) || 0)));
    if (counts[id] > 0) selected.add(id);
  }
  renderDecos();
  changed();
});
$("deco-list").addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (!input.dataset.count) return;
  const id = Number(input.dataset.count);
  counts[id] = Math.max(0, Math.min(99, Math.floor(Number(input.value) || 0)));
  if (counts[id] > 0) selected.add(id);
  changed();
});
$("deco-all").addEventListener("click", () => {
  usableDecorations().forEach((d) => selected.add(d.id));
  renderDecos();
  changed();
});
$("deco-none").addEventListener("click", () => {
  selected.clear();
  renderDecos();
  changed();
});
$("armor-locks").addEventListener("change", (event) => {
  const e = event.target as HTMLSelectElement,
    k = e.dataset.lock as ArmorKind;
  if (e.value) locks[k] = Number(e.value);
  else delete locks[k];
  changed();
});
$("excluded").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-include]",
  );
  if (b) {
    exclusions.delete(Number(b.dataset.include));
    renderEquipment();
    changed();
  }
});
$("override-save").addEventListener("click", () => {
  try {
    if (!data) return;
    if (
      value("override-state") === "Transcended" &&
      integer("hr", 1, 999) < 100
    )
      throw new Error("Transcendence requires HR100.");
    overrides[Number(value("override-piece"))] = {
      defense: integer("override-defense", 0, 999),
      slots: slots(value("override-slots")),
      state: value("override-state"),
    };
    renderEquipment();
    changed();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
  }
});
$("override-clear").addEventListener("click", () => {
  overrides = {};
  renderEquipment();
  changed();
});
$("weapon-add").addEventListener("click", () => {
  const id = Number(value("weapon-skill"));
  if (!data?.skillsById[id]) return;
  weaponSkills[id] = integer("weapon-level", 1, data.skillsById[id].maxLevel);
  renderEquipment();
  changed();
});
$("weapon-skills").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (b) {
    delete weaponSkills[Number(b.dataset.removeWeapon)];
    renderEquipment();
    changed();
  }
});
$("mode").addEventListener("change", () => {
  renderMode();
  renderDecos();
  changed();
});
for (const id of [
  "alpha",
  "gamma",
  "workers",
  "result-limit",
  "missing",
  "sort",
  "armor-rank",
  "rarity",
  "upgrade",
  "hr",
  "weapon-set",
  "weapon-group",
  "weapon-slots",
  "flex-preset",
])
  $(id).addEventListener("change", () => {
    if (id === "weapon-slots") renderDecos();
    changed();
  });
$("locale").addEventListener("change", () => {
  changed();
  void load();
});
$("refresh-data").addEventListener("click", () => {
  changed();
  void load(true);
});
$("optimize").addEventListener("click", () => void search());
$("stop").addEventListener("click", () => active?.cancel());
$("copy-link").addEventListener("click", () => {
  try {
    void copy(share());
  } catch (e) {
    status(String(e));
  }
});
$("more-results").addEventListener("click", () => {
  visibleResults += 10;
  renderResults();
});
$("results").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b || active || stale) return;
  if (b.dataset.exclude) {
    exclusions.add(Number(b.dataset.exclude));
    renderEquipment();
    changed();
    return;
  }
  if (b.dataset.lockResult !== undefined) {
    const r = results[Number(b.dataset.lockResult)],
      k = b.dataset.kind as ArmorKind;
    locks[k] = r.armor[k];
    renderEquipment();
    changed();
    return;
  }
  const index = Number(
      b.dataset.pin ?? b.dataset.save ?? b.dataset.export ?? b.dataset.share,
    ),
    r = results[index];
  if (!r) return;
  if (b.dataset.pin !== undefined) {
    pins = pins.some((p) => p.tieKey === r.tieKey)
      ? pins.filter((p) => p.tieKey !== r.tieKey)
      : [...pins.slice(-2), r];
    renderResults();
  }
  if (b.dataset.save !== undefined) {
    const name = prompt("Name this build", `Build ${saved.length + 1}`);
    if (!name) return;
    const entry: SavedBuild = {
        id: crypto.randomUUID(),
        name,
        version: data!.version,
        locale: data!.locale,
        build: r,
      },
      next = [entry, ...saved].slice(0, 50);
    if (writeSavedBuilds(next)) {
      saved = next;
      renderSaved();
      status("Build saved on this device.");
    } else status("Could not save. Download its checklist instead.");
  }
  if (b.dataset.export !== undefined)
    downloadText(
      "mh-wilds-build.txt",
      buildChecklist(r, resultData!),
      "text/plain",
    );
  if (b.dataset.share !== undefined) {
    try {
      void copy(share(r));
    } catch (e) {
      status(String(e));
    }
  }
});
$("results").addEventListener(
  "toggle",
  (event) => {
    const details = event.target as HTMLDetailsElement;
    if (!details.open || details.dataset.flex === undefined || !data || stale)
      return;
    const body = details.querySelector(".flex-body")!,
      r = results[Number(details.dataset.flex)];
    if (!r) return;
    const available = pieceSlots(r).filter(
      (s) =>
        s.kind === "armor" &&
        !r.placements.some(
          (p) =>
            p.piece === s.piece &&
            p.slotKind === s.kind &&
            p.slotIndex === s.index,
        ),
    );
    const leftover: LeftoverSlot[] = available.map((s, i) => ({
        slotIndex: i,
        slotLevel: s.size,
        pieceLabel: s.piece,
        pieceName: s.name,
      })),
      stock = checked("owned-decos") ? { ...counts } : undefined;
    if (stock)
      for (const p of r.placements)
        stock[p.decorationId] = (stock[p.decorationId] ?? 0) - 1;
    const suggestions = suggestFlexDecorations({
      build: r,
      leftoverSlots: leftover,
      data: resultData!,
      desiredSkills: desired,
      presetMode: value("flex-preset") as FlexPresetMode,
      huntFocus: null,
      allowedDecorationIds: selected,
      decorationCounts: stock,
    });
    body.innerHTML =
      suggestions
        .map(
          (s) =>
            `<p>${esc(s.explanation)}</p><ul>${s.decorationLoadout.map((p) => `<li>${esc(p.pieceLabel)} [${p.slotLevel}]: ${esc(p.decorationName)}</li>`).join("")}</ul>`,
        )
        .join("") || "<p>No useful placements from this inventory.</p>";
  },
  true,
);
$("saved-builds").addEventListener("click", (event) => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  if (b.dataset.openSaved !== undefined)
    showSaved(saved[Number(b.dataset.openSaved)]);
  if (b.dataset.exportSaved !== undefined)
    downloadText(
      "mh-wilds-saved-build.json",
      JSON.stringify(saved[Number(b.dataset.exportSaved)], null, 2),
    );
  if (b.dataset.deleteSaved !== undefined) {
    const next = saved.filter((_, i) => i !== Number(b.dataset.deleteSaved));
    if (writeSavedBuilds(next)) {
      saved = next;
      renderSaved();
    } else status("Could not save the library change.");
  }
});
$("inventory-file").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error("Use a file smaller than 1 MB.");
    const imported = normalizeInventory(
        JSON.parse(await file.text()),
        data?.skills,
      ),
      next =
        value("import-mode") === "replace" ? imported : [...owned, ...imported];
    if (!saveInventory(next))
      throw new Error(
        "Storage unavailable or full. Existing inventory remains saved.",
      );
    owned = next;
    renderMode();
    renderDecos();
    changed();
    status(
      `Imported ${imported.length} talismans; ${owned.length} total. Previous library backed up.`,
    );
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
  } finally {
    input.value = "";
  }
});
$("inventory-export").addEventListener("click", () =>
  downloadText("mh-wilds-talismans.json", JSON.stringify(owned, null, 2)),
);
$("inventory-backup").addEventListener("click", () => {
  try {
    owned = restoreInventory();
    renderMode();
    changed();
    status("Previous inventory restored.");
  } catch (e) {
    status(e instanceof Error ? e.message : String(e));
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    owned = readInventory();
    if (active) active.cancel();
    renderMode();
    renderDecos();
    changed();
  }
});
void load();
