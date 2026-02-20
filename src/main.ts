import "./style.css";
import { clearCachedLocale, loadOptimizerData } from "./mhdbApi";
import { compareBuildResults } from "./optimizer";
import {
  DEFAULT_CHARM_SLOT_PATTERNS,
  DEFAULT_CHARM_SUGGESTION_OPTIONS,
  buildDefaultSkillWeights,
  suggestCharmsForBuild,
} from "./charmSuggestions";
import {
  HUNT_ELEMENT_OPTIONS,
  HUNT_STATUS_OPTIONS,
  suggestFlexDecorations,
  type FlexPresetMode,
  type HuntElement,
  type HuntFocus,
  type HuntStatus,
  type LeftoverSlot,
} from "./flexSuggestions";
import type {
  ArmorPiece,
  BuildResult,
  Charm,
  DesiredSkill,
  LoadDataSource,
  NormalizedData,
  OptimizeWorkerDone,
  OptimizeWorkerMessage,
  OptimizeWorkerProgress,
  OptimizeWorkerRequest,
  CharmMode,
  CharmSuggestion,
  SkillPoints,
  SlotSize,
  WorkerStats,
} from "./types";

const LOCALES = ["en", "ja", "ko", "fr", "de", "es", "it", "pl", "pt-BR", "ru", "zh-Hans", "zh-Hant", "ar"];
const AVAILABLE_THREADS = Math.max(1, navigator.hardwareConcurrency || 4);
const MAX_THREADS = AVAILABLE_THREADS;
const MAX_RESULTS = 100;
const MAX_POST_PROCESS_RESULTS = 120;
const DEFAULT_THREADS = Math.max(1, Math.min(MAX_THREADS, Math.round(AVAILABLE_THREADS * 0.8)));
const DEFAULT_RESULTS = 25;
const DEFAULT_NEAR_MISS_MAX_MISSING_POINTS = 2;
const OWNED_CHARMS_STORAGE_KEY = "mh-wilds-optimizer:owned-charms:v1";

type SkillKindFilter = "all" | "armor" | "set" | "group";

type State = {
  locale: string;
  data: NormalizedData | null;
  dataSource: LoadDataSource | null;
  loading: boolean;
  dataError: string;
  desired: DesiredSkill[];
  allowAlpha: boolean;
  allowGamma: boolean;
  useAllDecos: boolean;
  selectedDecos: Set<number>;
  threads: number;
  resultsPerThread: number;
  optimizing: boolean;
  runStatus: string;
  rawResults: BuildResult[];
  results: BuildResult[];
  workerStats: WorkerStats[];
  workerProgressByIndex: Record<number, OptimizeWorkerProgress>;
  expectedWorkers: number;
  activeWorkerCancels: Array<() => void>;
  cancelRequested: boolean;
  skillSearch: string;
  skillKindFilter: SkillKindFilter;
  decoSearch: string;
  charmMode: CharmMode;
  charmSuggestCount: number;
  charmMaxSuggestedSkills: number;
  charmMaxSkillLevelPerSkill: number;
  charmSlotPatternsText: string;
  charmSlotPatterns: Array<[number, number, number]>;
  nearMissEnabled: boolean;
  nearMissMaxMissingPoints: number;
  minCharmScoreToShow: number;
  hideSuggestionsIfNoDeficits: boolean;
  showComfortCharmWhenNoDeficits: boolean;
  filterShowMeetsBase: boolean;
  filterShowMeetsWithBestCharm: boolean;
  filterHideHighCharmDependence: boolean;
  previewCharmByResultKey: Record<string, string | null>;
  expandedCharmSuggestionsByResultKey: Record<string, boolean>;
  ownedCharms: Charm[];
  flexPresetMode: FlexPresetMode;
  huntElement: HuntElement | "";
  huntStatuses: Set<HuntStatus>;
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app.");

root.innerHTML = `
<div class="shell">
  <header class="hero">
    <p class="kicker">Monster Hunter Wilds</p>
    <h1>Skill-First Gear Optimizer</h1>
    <nav class="info-links" aria-label="Site pages">
      <a class="info-link active" href="/">Optimizer</a>
      <a class="info-link" href="/about/index.html">About</a>
      <a class="info-link" href="/faq/index.html">FAQ</a>
      <a class="info-link" href="/charm-builder/index.html">Owned Charm Builder</a>
    </nav>
  </header>

  <section class="panel">
    <div class="panel-title-row"><h2>Data</h2><button id="refresh-data" type="button">Refresh Data</button></div>
    <div class="inline-grid">
      <label class="field"><span>Locale</span><select id="locale"></select></label>
      <p id="data-status" class="status-line"></p>
    </div>
  </section>

  <section class="panel split">
    <div class="pane">
      <h2>Desired Skills</h2>
      <div class="inline-grid">
        <label class="field"><span>Search</span><input id="skill-search" type="search" placeholder="Skill name"/></label>
        <label class="field"><span>Type</span>
          <select id="skill-kind-filter">
            <option value="all">All (except weapon)</option>
            <option value="armor">Armor</option>
            <option value="set">Set Bonus</option>
            <option value="group">Group Bonus</option>
          </select>
        </label>
      </div>
      <select id="skill-list" size="9"></select>
      <p class="muted">Set and Group skills (including Gogmapocalypse) are selectable here.</p>
      <div class="button-row"><button id="add-skill" type="button">Add Skill</button></div>
      <div id="desired-list"></div>
    </div>
    <div class="pane">
      <h2>Decoration Pool</h2>
      <label class="field"><span>Search</span><input id="deco-search" type="search" placeholder="Decoration name"/></label>
      <div class="button-row"><button id="deco-all" type="button">Select All</button><button id="deco-none" type="button">Clear All</button></div>
      <select id="deco-list" multiple size="10"></select>
      <p id="deco-summary" class="muted"></p>
    </div>
  </section>

  <section class="panel">
    <h2 title="Core optimizer settings. Use optional sections below for advanced tuning.">Controls</h2>
    <div class="controls-main">
      <label class="checkbox-line" title="Include alpha armor pieces in the search pool."><input id="allow-alpha" type="checkbox"/><span>Allow &alpha; armor</span></label>
      <label class="checkbox-line" title="Include gamma armor pieces in the search pool."><input id="allow-gamma" type="checkbox"/><span>Allow &gamma; armor</span></label>
      <label class="field"><span title="How many worker threads to use. Higher is faster, but uses more CPU.">Max Threads</span><input id="threads" type="number" min="1" max="${MAX_THREADS}" title="How many worker threads to use. Higher is faster, but uses more CPU."/></label>
      <label class="field"><span title="How many candidate builds each worker may keep before merge and re-rank.">Max Results Per Thread</span><input id="results-per-thread" type="number" min="1" max="100" title="How many candidate builds each worker may keep before merge and re-rank."/></label>
      <label class="field"><span title="Off: no charm post-processing. Suggest After: theoretical RNG templates. Owned: uses your saved charm list.">Charm Mode</span>
        <select id="charm-mode">
          <option value="off">Off</option>
          <option value="suggest">Suggest After</option>
          <option value="owned">Owned (v2 stub)</option>
        </select>
      </label>
    </div>
    <div class="controls-optional">
      <details class="optional-block">
        <summary title="Tune how theoretical RNG charm suggestions are generated and displayed.">Charm Suggestion Tuning (Optional)</summary>
        <div class="inline-grid optional-grid">
          <label class="field"><span title="Number of templates shown in each result card.">Charm Suggest Count</span><input id="charm-suggest-count" type="number" min="1" max="20"/></label>
          <label class="field"><span title="Only the top missing skills are used to generate templates.">Max Suggested Skills</span><input id="charm-max-skills" type="number" min="1" max="12"/></label>
          <label class="field"><span title="Cap per skill in a single suggested charm template.">Max Skill Lvl / Charm Skill</span><input id="charm-skill-cap" type="number" min="1" max="7"/></label>
          <label class="field"><span title="Allowed slot patterns for theoretical RNG charm templates.">Charm Slot Patterns</span><input id="charm-slot-patterns" type="text" placeholder="3-0-0,2-1-0,2-0-0,1-1-0,1-0-0,0-0-0"/></label>
          <label class="field"><span title="Hide charm rows that provide very low value.">Min Charm Score To Show</span><input id="charm-min-score" type="number" min="0" step="0.1"/></label>
          <label class="checkbox-line" title="If a build already meets all targets, hide the charm requirement section."><input id="charm-hide-no-deficit" type="checkbox"/><span>Hide when no target deficits</span></label>
          <label class="checkbox-line" title="When a build already meets targets, still suggest slot-focused charms."><input id="charm-show-comfort" type="checkbox"/><span>Show comfort charms when no deficits</span></label>
        </div>
      </details>

      <details class="optional-block">
        <summary title="Filter which results are shown based on charm completion and dependence.">Charm Filters (Optional)</summary>
        <div class="inline-grid optional-grid">
          <label class="checkbox-line" title="Include solver outputs that are slightly short on requested levels so Suggest mode can complete them."><input id="near-miss-enabled" type="checkbox"/><span>Allow Near-Miss Solver Results</span></label>
          <label class="field"><span title="Total requested skill points a build may be short by and still be kept for charm completion.">Near-Miss Max Missing Points</span><input id="near-miss-max-missing" type="number" min="1" max="12"/></label>
          <label class="checkbox-line" title="Show builds that already satisfy targets before theoretical RNG charms."><input id="filter-meets-base" type="checkbox"/><span>Show meets targets without charm</span></label>
          <label class="checkbox-line" title="Show builds that satisfy targets after applying the best suggested charm template."><input id="filter-meets-with-charm" type="checkbox"/><span>Show meets targets with best charm</span></label>
          <label class="checkbox-line" title="Hide builds whose completion heavily depends on theoretical RNG charms."><input id="filter-hide-high-dependence" type="checkbox"/><span>Hide HIGH charm dependence</span></label>
        </div>
      </details>

      <details class="optional-block">
        <summary title="Import, export, and manage your owned charm list for Owned charm mode.">Owned Charms (Optional)</summary>
        <div class="owned-charms-wrap">
          <p class="muted">Use <a href="/charm-builder/index.html" target="_blank" rel="noreferrer">Owned Charm Builder</a> for a form UI, or paste JSON: [{"name":"WEX2 EE1","skills":{"57":2,"102":1},"slots":[2,1,0]}]</p>
          <textarea id="owned-charms-json" class="owned-json" rows="5" placeholder='[{"name":"WEX2 EE1","skills":{"57":2,"102":1},"slots":[2,1,0]}]'></textarea>
          <div class="button-row compact">
            <button id="owned-charms-import" type="button">Import JSON</button>
            <button id="owned-charms-export" type="button">Export JSON</button>
            <button id="owned-charms-clear" type="button">Clear Owned</button>
          </div>
          <p id="owned-charms-summary" class="muted"></p>
        </div>
      </details>

      <details class="optional-block">
        <summary title="Bias flex-slot decoration suggestions toward comfort, balance, or damage goals.">Hunt Focus + Flex Preset (Optional)</summary>
        <div class="controls-hunt">
          <label class="field"><span title="Controls how leftover decoration slots are prioritized in flex suggestions.">Flex Preset</span>
            <select id="flex-preset">
              <option value="auto">Auto</option>
              <option value="comfort">Comfort</option>
              <option value="balanced">Balanced</option>
              <option value="damage">Damage</option>
            </select>
          </label>
          <label class="field"><span title="Optional hunt context to improve element-specific flex deco suggestions.">Hunt Element (Optional)</span>
            <select id="hunt-element">
              <option value="">None</option>
              ${HUNT_ELEMENT_OPTIONS.map((element) => `<option value="${element}">${element[0].toUpperCase()}${element.slice(1)}</option>`).join("")}
            </select>
          </label>
          <fieldset class="hunt-status-box" title="Optional hunt status context for flex slot suggestions.">
            <legend>Hunt Status (Optional)</legend>
            <div class="hunt-status-list">
              ${HUNT_STATUS_OPTIONS.map(
                (status) => {
                  const statusLabel = `${status[0].toUpperCase()}${status.slice(1)}`;
                  return `<label class="hunt-status-pill" title="Include ${statusLabel} hunt context when generating flex slot suggestions."><input type="checkbox" data-hunt-status="${status}" title="Toggle ${statusLabel} hunt context."/><span>${statusLabel}</span></label>`;
                },
              ).join("")}
            </div>
          </fieldset>
        </div>
      </details>
    </div>
    <div class="button-row">
      <button id="optimize" type="button" title="Start a new optimization run with current filters and settings.">Optimize</button>
      <button id="stop" type="button" title="Stop all currently running worker searches.">Stop</button>
      <button id="copy-link" type="button" title="Copy a URL containing your current settings and selected skills.">Copy Share Link</button>
    </div>
    <div class="progress-wrap">
      <progress id="run-progress" max="1" value="0"></progress>
      <p id="progress-text" class="muted">No active run.</p>
    </div>
    <p id="run-status" class="status-line"></p>
  </section>

  <section class="panel"><h2>Results</h2><div id="results"></div></section>
  <footer class="footer-note">Not affiliated with Capcom. <a href="/about/index.html">About</a> | <a href="/faq/index.html">FAQ</a> | <a href="/charm-builder/index.html">Owned Charm Builder</a></footer>
</div>`;

const el = {
  locale: document.querySelector<HTMLSelectElement>("#locale")!,
  refreshData: document.querySelector<HTMLButtonElement>("#refresh-data")!,
  dataStatus: document.querySelector<HTMLParagraphElement>("#data-status")!,
  skillSearch: document.querySelector<HTMLInputElement>("#skill-search")!,
  skillKindFilter: document.querySelector<HTMLSelectElement>("#skill-kind-filter")!,
  skillList: document.querySelector<HTMLSelectElement>("#skill-list")!,
  addSkill: document.querySelector<HTMLButtonElement>("#add-skill")!,
  desiredList: document.querySelector<HTMLDivElement>("#desired-list")!,
  decoSearch: document.querySelector<HTMLInputElement>("#deco-search")!,
  decoAll: document.querySelector<HTMLButtonElement>("#deco-all")!,
  decoNone: document.querySelector<HTMLButtonElement>("#deco-none")!,
  decoList: document.querySelector<HTMLSelectElement>("#deco-list")!,
  decoSummary: document.querySelector<HTMLParagraphElement>("#deco-summary")!,
  allowAlpha: document.querySelector<HTMLInputElement>("#allow-alpha")!,
  allowGamma: document.querySelector<HTMLInputElement>("#allow-gamma")!,
  threads: document.querySelector<HTMLInputElement>("#threads")!,
  resultsPerThread: document.querySelector<HTMLInputElement>("#results-per-thread")!,
  charmMode: document.querySelector<HTMLSelectElement>("#charm-mode")!,
  charmSuggestCount: document.querySelector<HTMLInputElement>("#charm-suggest-count")!,
  charmMaxSkills: document.querySelector<HTMLInputElement>("#charm-max-skills")!,
  charmSkillCap: document.querySelector<HTMLInputElement>("#charm-skill-cap")!,
  charmSlotPatterns: document.querySelector<HTMLInputElement>("#charm-slot-patterns")!,
  nearMissEnabled: document.querySelector<HTMLInputElement>("#near-miss-enabled")!,
  nearMissMaxMissing: document.querySelector<HTMLInputElement>("#near-miss-max-missing")!,
  charmMinScore: document.querySelector<HTMLInputElement>("#charm-min-score")!,
  charmHideNoDeficit: document.querySelector<HTMLInputElement>("#charm-hide-no-deficit")!,
  charmShowComfort: document.querySelector<HTMLInputElement>("#charm-show-comfort")!,
  filterMeetsBase: document.querySelector<HTMLInputElement>("#filter-meets-base")!,
  filterMeetsWithCharm: document.querySelector<HTMLInputElement>("#filter-meets-with-charm")!,
  filterHideHighDependence: document.querySelector<HTMLInputElement>("#filter-hide-high-dependence")!,
  ownedCharmsJson: document.querySelector<HTMLTextAreaElement>("#owned-charms-json")!,
  ownedCharmsImport: document.querySelector<HTMLButtonElement>("#owned-charms-import")!,
  ownedCharmsExport: document.querySelector<HTMLButtonElement>("#owned-charms-export")!,
  ownedCharmsClear: document.querySelector<HTMLButtonElement>("#owned-charms-clear")!,
  ownedCharmsSummary: document.querySelector<HTMLParagraphElement>("#owned-charms-summary")!,
  flexPreset: document.querySelector<HTMLSelectElement>("#flex-preset")!,
  huntElement: document.querySelector<HTMLSelectElement>("#hunt-element")!,
  optimize: document.querySelector<HTMLButtonElement>("#optimize")!,
  stop: document.querySelector<HTMLButtonElement>("#stop")!,
  copyLink: document.querySelector<HTMLButtonElement>("#copy-link")!,
  runProgress: document.querySelector<HTMLProgressElement>("#run-progress")!,
  progressText: document.querySelector<HTMLParagraphElement>("#progress-text")!,
  runStatus: document.querySelector<HTMLParagraphElement>("#run-status")!,
  results: document.querySelector<HTMLDivElement>("#results")!,
};
const huntStatusInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[data-hunt-status]'),
);

for (const locale of LOCALES) {
  const option = document.createElement("option");
  option.value = locale;
  option.textContent = locale;
  el.locale.append(option);
}

const params = new URLSearchParams(window.location.search);
const decoParam = params.get("decos");
const flexPresetParam = params.get("fp");
const charmModeParam = params.get("cm");
const charmSuggestCountParam = params.get("sc");
const charmMaxSkillsParam = params.get("mss");
const charmSkillCapParam = params.get("msl");
const charmSlotPatternsParam = params.get("sp");
const nearMissEnabledParam = params.get("nm");
const nearMissMaxMissingParam = params.get("nmm");
const minCharmScoreParam = params.get("mcs");
const hideNoDeficitParam = params.get("hnd");
const showComfortParam = params.get("scn");
const filterMeetsBaseParam = params.get("fb");
const filterMeetsWithCharmParam = params.get("fw");
const filterHideHighDependenceParam = params.get("fh");
const skillKindFilterParam = params.get("sk");
const huntElementParam = params.get("he");
const huntStatusParam = params.get("hs");
const validFlexPresetModes: FlexPresetMode[] = ["auto", "comfort", "balanced", "damage"];
const validCharmModes: CharmMode[] = ["off", "suggest", "owned"];
const validSkillKindFilters: SkillKindFilter[] = ["all", "armor", "set", "group"];
const parsedFlexPresetMode: FlexPresetMode = validFlexPresetModes.includes((flexPresetParam as FlexPresetMode) || "auto")
  ? ((flexPresetParam as FlexPresetMode) || "auto")
  : "auto";
const parsedCharmMode: CharmMode = validCharmModes.includes((charmModeParam as CharmMode) || "off")
  ? ((charmModeParam as CharmMode) || "off")
  : "off";
const parsedSkillKindFilter: SkillKindFilter = validSkillKindFilters.includes((skillKindFilterParam as SkillKindFilter) || "all")
  ? ((skillKindFilterParam as SkillKindFilter) || "all")
  : "all";
const parsedHuntElement: HuntElement | "" = HUNT_ELEMENT_OPTIONS.includes((huntElementParam as HuntElement) || ("" as HuntElement))
  ? ((huntElementParam as HuntElement) || "")
  : "";
const parsedHuntStatuses = new Set<HuntStatus>();
for (const part of (huntStatusParam || "").split(",")) {
  const trimmed = part.trim();
  if (!trimmed) continue;
  if (HUNT_STATUS_OPTIONS.includes(trimmed as HuntStatus)) {
    parsedHuntStatuses.add(trimmed as HuntStatus);
  }
}
const defaultCharmSlotPatternText = DEFAULT_CHARM_SLOT_PATTERNS.map((pattern) => pattern.join("-")).join(",");
const parsedCharmSuggestCount = clampInt(
  charmSuggestCountParam,
  DEFAULT_CHARM_SUGGESTION_OPTIONS.suggestCount,
  1,
  20,
);
const parsedCharmMaxSkills = clampInt(
  charmMaxSkillsParam,
  DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSuggestedSkills,
  1,
  12,
);
const parsedCharmSkillCap = clampInt(
  charmSkillCapParam,
  DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSkillLevelPerCharmSkill,
  1,
  7,
);
const parsedNearMissEnabled = parseBool(nearMissEnabledParam, true);
const parsedNearMissMaxMissingPoints = clampInt(
  nearMissMaxMissingParam,
  DEFAULT_NEAR_MISS_MAX_MISSING_POINTS,
  1,
  12,
);
const parsedMinCharmScoreToShow = clampFloat(minCharmScoreParam, 1, 0, 100);
const parsedHideSuggestionsIfNoDeficits = parseBool(hideNoDeficitParam, true);
const parsedShowComfortCharmWhenNoDeficits = parseBool(showComfortParam, false);
const parsedCharmSlotPatternText = (charmSlotPatternsParam || defaultCharmSlotPatternText).trim() || defaultCharmSlotPatternText;
const parsedCharmSlotPatterns = parseSlotPatterns(
  parsedCharmSlotPatternText,
  DEFAULT_CHARM_SLOT_PATTERNS,
);
const defaultCharmFilters = defaultFiltersForCharmMode(parsedCharmMode);
const parsedFilterShowMeetsBase = parseBool(filterMeetsBaseParam, defaultCharmFilters.showMeetsBase);
const parsedFilterShowMeetsWithBestCharm = parseBool(
  filterMeetsWithCharmParam,
  defaultCharmFilters.showMeetsWithBestCharm,
);
const parsedFilterHideHighDependence = parseBool(filterHideHighDependenceParam, false);
const state: State = {
  locale: LOCALES.includes(params.get("loc") || "") ? (params.get("loc") as string) : "en",
  data: null,
  dataSource: null,
  loading: false,
  dataError: "",
  desired: parseDesired(params.get("ds")),
  allowAlpha: parseBool(params.get("aa"), true),
  allowGamma: parseBool(params.get("ag"), true),
  useAllDecos: !decoParam || decoParam === "all",
  selectedDecos: decoParam && decoParam !== "all" ? parseIdSet(decoParam) : new Set<number>(),
  threads: clampInt(params.get("t"), DEFAULT_THREADS, 1, MAX_THREADS),
  resultsPerThread: clampInt(params.get("r"), DEFAULT_RESULTS, 1, MAX_RESULTS),
  optimizing: false,
  runStatus: "",
  rawResults: [],
  results: [],
  workerStats: [],
  workerProgressByIndex: {},
  expectedWorkers: 0,
  activeWorkerCancels: [],
  cancelRequested: false,
  skillSearch: "",
  skillKindFilter: parsedSkillKindFilter,
  decoSearch: "",
  charmMode: parsedCharmMode,
  charmSuggestCount: parsedCharmSuggestCount,
  charmMaxSuggestedSkills: parsedCharmMaxSkills,
  charmMaxSkillLevelPerSkill: parsedCharmSkillCap,
  charmSlotPatternsText: parsedCharmSlotPatternText,
  charmSlotPatterns: parsedCharmSlotPatterns,
  nearMissEnabled: parsedNearMissEnabled,
  nearMissMaxMissingPoints: parsedNearMissMaxMissingPoints,
  minCharmScoreToShow: parsedMinCharmScoreToShow,
  hideSuggestionsIfNoDeficits: parsedHideSuggestionsIfNoDeficits,
  showComfortCharmWhenNoDeficits: parsedShowComfortCharmWhenNoDeficits,
  filterShowMeetsBase: parsedFilterShowMeetsBase,
  filterShowMeetsWithBestCharm: parsedFilterShowMeetsWithBestCharm,
  filterHideHighCharmDependence: parsedFilterHideHighDependence,
  previewCharmByResultKey: {},
  expandedCharmSuggestionsByResultKey: {},
  ownedCharms: readOwnedCharmsFromStorage(),
  flexPresetMode: parsedFlexPresetMode,
  huntElement: parsedHuntElement,
  huntStatuses: parsedHuntStatuses,
};

const decoLabel: Record<number, string> = {};
const decoSearch: Record<number, string> = {};

function parseBool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clampFloat(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(value || "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function defaultFiltersForCharmMode(mode: CharmMode): {
  showMeetsBase: boolean;
  showMeetsWithBestCharm: boolean;
} {
  if (mode === "suggest") {
    return {
      showMeetsBase: true,
      showMeetsWithBestCharm: true,
    };
  }
  if (mode === "owned") {
    return {
      showMeetsBase: true,
      showMeetsWithBestCharm: true,
    };
  }
  return {
    showMeetsBase: true,
    showMeetsWithBestCharm: false,
  };
}

function parseSlotPatterns(
  raw: string,
  fallback: Array<[number, number, number]>,
): Array<[number, number, number]> {
  const deduped = new Map<string, [number, number, number]>();
  for (const segment of raw.split(",")) {
    const text = segment.trim();
    if (!text) continue;
    const parts = text.split("-").map((value) => Number.parseInt(value, 10));
    if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
      continue;
    }
    const normalized: [number, number, number] = [
      Math.max(0, Math.min(3, parts[0])),
      Math.max(0, Math.min(3, parts[1])),
      Math.max(0, Math.min(3, parts[2])),
    ];
    deduped.set(normalized.join("-"), normalized);
  }

  if (deduped.size === 0) {
    return [...fallback];
  }
  return [...deduped.values()];
}

function normalizeCharmSlots(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  const values = raw.map((value) => Number.parseInt(String(value), 10));
  if (values.some((value) => Number.isNaN(value))) {
    return null;
  }
  return [
    Math.max(0, Math.min(3, values[0])),
    Math.max(0, Math.min(3, values[1])),
    Math.max(0, Math.min(3, values[2])),
  ];
}

function normalizeCharmSkillsNumericOnly(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const skillId = Number.parseInt(key, 10);
    const level = Number.parseInt(String(value), 10);
    if (!Number.isFinite(skillId) || Number.isNaN(level) || skillId <= 0 || level <= 0) {
      continue;
    }
    out[String(skillId)] = level;
  }
  return out;
}

function readOwnedCharmsFromStorage(): Charm[] {
  const raw = localStorage.getItem(OWNED_CHARMS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const charms: Charm[] = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const entry = parsed[i] as Record<string, unknown>;
      const slots = normalizeCharmSlots(entry?.slots);
      if (!slots) {
        continue;
      }
      const skills = normalizeCharmSkillsNumericOnly(entry?.skills);
      charms.push({
        id: `owned-${i + 1}`,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : `Owned Charm #${i + 1}`,
        rarity: typeof entry?.rarity === "number" ? entry.rarity : undefined,
        skills,
        slots,
        weaponSlot: 0,
      });
    }
    return charms;
  } catch {
    return [];
  }
}

function writeOwnedCharmsToStorage(charms: Charm[]): void {
  const serializable = charms.map((charm) => ({
    name: charm.name,
    rarity: charm.rarity,
    skills: charm.skills,
    slots: charm.slots,
  }));
  localStorage.setItem(OWNED_CHARMS_STORAGE_KEY, JSON.stringify(serializable));
}

function serializeOwnedCharmsJson(charms: Charm[], pretty = true): string {
  const serializable = charms.map((charm) => ({
    name: charm.name,
    rarity: charm.rarity,
    skills: charm.skills,
    slots: charm.slots,
  }));
  return JSON.stringify(serializable, null, pretty ? 2 : 0);
}

function serializeSlotPatterns(patterns: Array<[number, number, number]>): string {
  return patterns.map((pattern) => pattern.join("-")).join(",");
}

function parseDesired(raw: string | null): DesiredSkill[] {
  if (!raw) return [];
  const seen = new Set<number>();
  const desired: DesiredSkill[] = [];
  for (const part of raw.split(",")) {
    const [idPart, levelPart] = part.split("-");
    const id = Number.parseInt(idPart || "", 10);
    const level = Number.parseInt(levelPart || "", 10);
    if (Number.isNaN(id) || Number.isNaN(level) || id <= 0 || level <= 0 || seen.has(id)) continue;
    seen.add(id);
    desired.push({ skillId: id, level });
  }
  return desired;
}

function parseIdSet(raw: string): Set<number> {
  const output = new Set<number>();
  for (const part of raw.split(",")) {
    const id = Number.parseInt(part, 10);
    if (!Number.isNaN(id) && id > 0) output.add(id);
  }
  return output;
}

function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function armorAllowed(piece: ArmorPiece): boolean {
  if (piece.isAlpha && !state.allowAlpha) return false;
  if (piece.isGamma && !state.allowGamma) return false;
  return true;
}

function isWeaponSkillKind(kind: string | undefined): boolean {
  return (kind ?? "").toLowerCase() === "weapon";
}

function normalizeSkillKind(kind: string | undefined): SkillKindFilter | "weapon" | "unknown" {
  const normalized = (kind ?? "").toLowerCase();
  if (normalized === "weapon") return "weapon";
  if (normalized === "armor") return "armor";
  if (normalized === "set") return "set";
  if (normalized === "group") return "group";
  return "unknown";
}

function matchesSkillKindFilter(kind: string | undefined, filter: SkillKindFilter): boolean {
  const normalized = normalizeSkillKind(kind);
  if (normalized === "weapon") {
    return false;
  }
  if (filter === "all") {
    return true;
  }
  return normalized === filter;
}

function skillKindLabel(kind: string | undefined): string {
  const normalized = normalizeSkillKind(kind);
  if (normalized === "set") return "Set";
  if (normalized === "group") return "Group";
  if (normalized === "armor") return "Armor";
  return "Other";
}

function isCharmRollableSkillId(skillId: number): boolean {
  if (!state.data) {
    return true;
  }
  return normalizeSkillKind(state.data.skillsById[skillId]?.kind) === "armor";
}

function normalizeSkillLookupName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveSkillIdFromImportKey(rawKey: string): number | null {
  if (!state.data) {
    const numeric = Number.parseInt(rawKey, 10);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  const numeric = Number.parseInt(rawKey, 10);
  if (Number.isFinite(numeric) && numeric > 0 && state.data.skillsById[numeric]) {
    return numeric;
  }
  const target = normalizeSkillLookupName(rawKey);
  if (!target) {
    return null;
  }
  for (const skill of state.data.skills) {
    if (normalizeSkillLookupName(skill.name) === target) {
      return skill.id;
    }
  }
  return null;
}

function parseOwnedCharmsJsonInput(rawText: string): Charm[] {
  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) {
    throw new Error("JSON must be an array of charms.");
  }

  const output: Charm[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i] as Record<string, unknown>;
    const slots = normalizeCharmSlots(entry?.slots);
    if (!slots) {
      continue;
    }
    const rawSkills = entry?.skills;
    const normalizedSkills: Record<string, number> = {};
    if (rawSkills && typeof rawSkills === "object") {
      for (const [rawKey, rawValue] of Object.entries(rawSkills as Record<string, unknown>)) {
        const skillId = resolveSkillIdFromImportKey(rawKey);
        const level = Number.parseInt(String(rawValue), 10);
        if (!skillId || Number.isNaN(level) || level <= 0) {
          continue;
        }
        if (!isCharmRollableSkillId(skillId)) {
          continue;
        }
        normalizedSkills[String(skillId)] = level;
      }
    }
    output.push({
      id: `owned-${i + 1}`,
      name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : `Owned Charm #${i + 1}`,
      rarity: typeof entry?.rarity === "number" ? entry.rarity : undefined,
      skills: normalizedSkills,
      slots,
      weaponSlot: 0,
    });
  }
  return output;
}

function isSelectableRequestedSkillId(skillId: number): boolean {
  if (!state.data) {
    return false;
  }
  return !isWeaponSkillKind(state.data.skillsById[skillId]?.kind);
}

function simplifyDecorationDisplayName(name: string): string {
  return name.replace(/\s*\[\d+\]\s*$/, "");
}

function decorationKindLabel(kind: string): string {
  if (kind.toLowerCase() === "armor") return "Armor";
  if (kind.toLowerCase() === "weapon") return "Weapon";
  return kind;
}

function formatDecorationLabel(decoration: NormalizedData["decorations"][number], data: NormalizedData): string {
  const skillText = Object.entries(decoration.skills)
    .map(([id, level]) => `${data.skillsById[Number(id)]?.name || `Skill #${id}`} +${level}`)
    .join(", ");
  const decorationName = simplifyDecorationDisplayName(decoration.name);
  const metaText = `S${decoration.slotReq}, ${decorationKindLabel(decoration.kind)}`;
  return skillText.length > 0 ? `${decorationName} (${metaText}) - ${skillText}` : `${decorationName} (${metaText})`;
}

const numberFormatter = new Intl.NumberFormat("en-US");
function formatCount(value: number): string {
  return numberFormatter.format(Math.max(0, Math.floor(value)));
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%";
  }
  const raw = (numerator / denominator) * 100;
  if (raw > 0 && raw < 0.1) {
    return "<0.1%";
  }
  return `${Math.min(100, raw).toFixed(1)}%`;
}

type AggregatedProgress = {
  completedArmorCombos: number;
  totalArmorCombos: number;
  evaluatedCandidates: number;
  totalCandidates: number;
  feasibleBuilds: number;
};

function aggregateProgress(): AggregatedProgress {
  const progressEntries = Object.values(state.workerProgressByIndex);
  let completedArmorCombos = 0;
  let totalArmorCombos = 0;
  let evaluatedCandidates = 0;
  let totalCandidates = 0;
  let feasibleBuilds = 0;

  for (const progress of progressEntries) {
    completedArmorCombos += progress.completedArmorCombos;
    totalArmorCombos += progress.totalArmorCombos;
    evaluatedCandidates += progress.evaluatedCandidates;
    totalCandidates += progress.totalCandidates;
    feasibleBuilds += progress.feasibleBuilds;
  }

  return {
    completedArmorCombos,
    totalArmorCombos,
    evaluatedCandidates,
    totalCandidates,
    feasibleBuilds,
  };
}

function renderProgress(): void {
  const aggregated = aggregateProgress();
  const max = aggregated.totalCandidates > 0 ? aggregated.totalCandidates : 1;
  const value = Math.min(max, aggregated.evaluatedCandidates);
  el.runProgress.max = max;
  el.runProgress.value = value;

  if (state.optimizing) {
    if (aggregated.totalCandidates > 0) {
      const percent = formatPercent(aggregated.evaluatedCandidates, aggregated.totalCandidates);
      el.progressText.textContent = `${percent}% | ${formatCount(aggregated.evaluatedCandidates)}/${formatCount(aggregated.totalCandidates)} outcomes | armor combos ${formatCount(aggregated.completedArmorCombos)}/${formatCount(aggregated.totalArmorCombos)} | feasible ${formatCount(aggregated.feasibleBuilds)}`;
    } else {
      el.progressText.textContent = "Preparing search space...";
    }
    return;
  }

  if (aggregated.totalCandidates > 0) {
    el.progressText.textContent = `Last run: ${formatCount(aggregated.evaluatedCandidates)}/${formatCount(aggregated.totalCandidates)} estimated outcomes checked.`;
  } else {
    el.progressText.textContent = "No active run.";
  }
}

function rerender(): void {
  el.locale.value = state.locale;
  el.skillKindFilter.value = state.skillKindFilter;
  el.allowAlpha.checked = state.allowAlpha;
  el.allowGamma.checked = state.allowGamma;
  el.threads.value = String(state.threads);
  el.resultsPerThread.value = String(state.resultsPerThread);
  el.charmMode.value = state.charmMode;
  el.charmSuggestCount.value = String(state.charmSuggestCount);
  el.charmMaxSkills.value = String(state.charmMaxSuggestedSkills);
  el.charmSkillCap.value = String(state.charmMaxSkillLevelPerSkill);
  el.charmSlotPatterns.value = state.charmSlotPatternsText;
  el.nearMissEnabled.checked = state.nearMissEnabled;
  el.nearMissMaxMissing.value = String(state.nearMissMaxMissingPoints);
  el.charmMinScore.value = state.minCharmScoreToShow.toFixed(1);
  el.charmHideNoDeficit.checked = state.hideSuggestionsIfNoDeficits;
  el.charmShowComfort.checked = state.showComfortCharmWhenNoDeficits;
  el.filterMeetsBase.checked = state.filterShowMeetsBase;
  el.filterMeetsWithCharm.checked = state.filterShowMeetsWithBestCharm;
  el.filterHideHighDependence.checked = state.filterHideHighCharmDependence;
  if (document.activeElement !== el.ownedCharmsJson) {
    el.ownedCharmsJson.value = serializeOwnedCharmsJson(state.ownedCharms, true);
  }
  el.ownedCharmsSummary.textContent = `${state.ownedCharms.length} owned charms loaded.`;
  const charmModeOff = state.charmMode === "off";
  const suggestOnlyDisabled = state.charmMode !== "suggest";
  const supportsNearMiss = state.charmMode !== "off";
  el.charmSuggestCount.disabled = charmModeOff;
  el.charmMaxSkills.disabled = suggestOnlyDisabled;
  el.charmSkillCap.disabled = suggestOnlyDisabled;
  el.charmSlotPatterns.disabled = suggestOnlyDisabled;
  el.charmMinScore.disabled = suggestOnlyDisabled;
  el.charmHideNoDeficit.disabled = suggestOnlyDisabled;
  el.charmShowComfort.disabled = suggestOnlyDisabled;
  el.nearMissEnabled.disabled = !supportsNearMiss;
  el.nearMissMaxMissing.disabled = !supportsNearMiss || !state.nearMissEnabled;
  el.filterMeetsBase.disabled = false;
  el.filterMeetsWithCharm.disabled = state.charmMode === "off";
  el.filterHideHighDependence.disabled = state.charmMode === "off";
  el.ownedCharmsJson.disabled = state.optimizing;
  el.ownedCharmsImport.disabled = state.optimizing;
  el.ownedCharmsExport.disabled = state.optimizing;
  el.ownedCharmsClear.disabled = state.optimizing;
  el.flexPreset.value = state.flexPresetMode;
  el.huntElement.value = state.huntElement;
  for (const input of huntStatusInputs) {
    input.checked = state.huntStatuses.has(input.dataset.huntStatus as HuntStatus);
  }
  renderDataStatus();
  renderSkillList();
  renderDesired();
  renderDecoList();
  renderProgress();
  renderResults();
  const disable = state.loading || state.optimizing || !state.data;
  el.optimize.disabled = disable;
  el.stop.disabled = !state.optimizing;
  el.locale.disabled = state.loading || state.optimizing;
}

function renderDataStatus(): void {
  if (state.loading) {
    el.dataStatus.textContent = "Loading data...";
    return;
  }
  if (state.dataError) {
    el.dataStatus.textContent = state.dataError;
    el.dataStatus.className = "status-line error";
    return;
  }
  if (!state.data) {
    el.dataStatus.textContent = "No data loaded.";
    return;
  }
  const source = state.dataSource === "network" ? "network" : state.dataSource === "cache-fallback" ? "cache fallback" : "cache";
  el.dataStatus.className = "status-line";
  el.dataStatus.textContent = `Locale ${state.data.locale} | Version ${state.data.version} | ${source}`;
}

function renderSkillList(): void {
  if (!state.data) return;
  const q = state.skillSearch.toLowerCase();
  const list = state.data.skills
    .filter((skill) => matchesSkillKindFilter(skill.kind, state.skillKindFilter))
    .filter((skill) => skill.name.toLowerCase().includes(q))
    .slice(0, 120);
  el.skillList.innerHTML = list
    .map((skill) => `<option value="${skill.id}">[${esc(skillKindLabel(skill.kind))}] ${esc(skill.name)} (max ${skill.maxLevel})</option>`)
    .join("");
}

function renderDesired(): void {
  if (!state.data) {
    el.desiredList.innerHTML = `<p class="muted">Load data first.</p>`;
    return;
  }
  if (state.desired.length === 0) {
    el.desiredList.innerHTML = `<p class="muted">No target skills selected.</p>`;
    return;
  }
  el.desiredList.innerHTML = `<table class="simple-table"><thead><tr><th>Skill</th><th>Target Level</th><th></th></tr></thead><tbody>${
    state.desired
      .map((d) => {
        const skill = state.data!.skillsById[d.skillId];
        if (!skill) return "";
        const levelButtonCount = Math.max(5, skill.maxLevel);
        const levelButtons = Array.from({ length: levelButtonCount }, (_, index) => {
          const level = index + 1;
          const selectable = level <= skill.maxLevel;
          const active = selectable && d.level === level;
          const classNames = ["level-btn"];
          if (active) classNames.push("active");
          return `<button type="button" class="${classNames.join(" ")}" data-skill-id="${d.skillId}" data-level="${level}" ${selectable ? "" : "disabled"}>${level}</button>`;
        }).join("");
        return `<tr><td><div class="desired-skill-cell"><span>${esc(skill.name)}</span><span class="skill-kind-chip">${esc(skillKindLabel(skill.kind))}</span></div></td><td><div class="level-picker">${levelButtons}</div></td><td><button class="remove" data-skill-id="${d.skillId}" type="button">Remove</button></td></tr>`;
      })
      .join("")
  }</tbody></table>`;
}

function renderDecoList(): void {
  if (!state.data) return;
  const q = state.decoSearch.toLowerCase();
  const list = state.data.decorations.filter((d) => !q || (decoSearch[d.id] || "").includes(q));
  el.decoList.innerHTML = list
    .map((d) => `<option value="${d.id}"${state.selectedDecos.has(d.id) ? " selected" : ""}>${esc(decoLabel[d.id] || d.name)}</option>`)
    .join("");
  const selectedDecorationCount = state.data.decorations.reduce(
    (count, decoration) => count + (state.selectedDecos.has(decoration.id) ? 1 : 0),
    0,
  );
  el.decoSummary.textContent = `Selected ${selectedDecorationCount}/${state.data.decorations.length} decorations`;
}

function skillChips(points: SkillPoints): string {
  if (!state.data) return "";
  const requested = new Set(state.desired.map((d) => d.skillId));
  return Object.entries(points)
    .map(([idStr, level]) => ({ id: Number(idStr), level }))
    .filter((x) => x.level > 0)
    .sort((a, b) => b.level - a.level || a.id - b.id)
    .map((x) => {
      const name = state.data!.skillsById[x.id]?.name || `Skill #${x.id}`;
      const cls = requested.has(x.id) ? "skill-chip requested" : "skill-chip";
      return `<span class="${cls}">${esc(name)} +${x.level}</span>`;
    })
    .join("");
}

function requestedSkillChecklist(points: SkillPoints): string {
  if (!state.data || state.desired.length === 0) {
    return `<p class="muted">No requested skills.</p>`;
  }

  const rows = state.desired
    .map((desired) => {
      const name = state.data!.skillsById[desired.skillId]?.name || `Skill #${desired.skillId}`;
      const total = points[desired.skillId] ?? 0;
      const met = total >= desired.level;
      return `<div class="target-row ${met ? "met" : "missing"}"><span class="target-name">${esc(name)}</span><span class="target-value">${total}/${desired.level}</span><span class="target-flag">${met ? "Met" : "Missing"}</span></div>`;
    })
    .join("");

  return `<div class="target-list">${rows}</div>`;
}

type PieceKey = "head" | "chest" | "arms" | "waist" | "legs" | "charm";
type PlannedSlot = { slotSize: number; decoName: string | null };
type PieceSlotPlan = { key: PieceKey; label: string; name: string; slots: PlannedSlot[] };

const pieceSlotPlanCache = new Map<string, PieceSlotPlan[]>();
const gearRenderCache = new Map<string, string>();
const flexRenderCache = new Map<string, string>();

function clearResultRenderCaches(): void {
  pieceSlotPlanCache.clear();
  gearRenderCache.clear();
  flexRenderCache.clear();
}

function clearFlexRenderCache(): void {
  flexRenderCache.clear();
}

function buildPieceSlotPlans(result: BuildResult): PieceSlotPlan[] {
  if (!state.data) return [];
  const cached = pieceSlotPlanCache.get(result.tieKey);
  if (cached) {
    return cached;
  }

  const pieceOrder: PieceKey[] = ["head", "chest", "arms", "waist", "legs", "charm"];
  const pieceLabel: Record<PieceKey, string> = {
    head: "Head",
    chest: "Chest",
    arms: "Arms",
    waist: "Waist",
    legs: "Legs",
    charm: "Charm",
  };

  const pieceNames: Record<PieceKey, string> = {
    head: state.data.armorById[result.armor.head]?.name || "?",
    chest: state.data.armorById[result.armor.chest]?.name || "?",
    arms: state.data.armorById[result.armor.arms]?.name || "?",
    waist: state.data.armorById[result.armor.waist]?.name || "?",
    legs: state.data.armorById[result.armor.legs]?.name || "?",
    charm: result.charmName || state.data.charmRankById[result.charmRankId]?.name || "?",
  };

  const slotsByPiece: Record<PieceKey, PlannedSlot[]> = {
    head: (state.data.armorById[result.armor.head]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
    chest: (state.data.armorById[result.armor.chest]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
    arms: (state.data.armorById[result.armor.arms]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
    waist: (state.data.armorById[result.armor.waist]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
    legs: (state.data.armorById[result.armor.legs]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
    charm: (result.charmSlots ?? state.data.charmRankById[result.charmRankId]?.slots ?? []).map((slotSize) => ({ slotSize, decoName: null })),
  };

  for (const piece of pieceOrder) {
    slotsByPiece[piece].sort((a, b) => b.slotSize - a.slotSize);
  }

  const placements = result.placements
    .map((placement, index) => {
      const decoration = state.data!.decorationsById[placement.decorationId];
      return {
        index,
        slotSizeUsed: placement.slotSizeUsed,
        slotReq: decoration?.slotReq ?? placement.slotSizeUsed,
        decoName: decoration?.name || `Decoration #${placement.decorationId}`,
      };
    })
    .sort(
      (a, b) =>
        b.slotSizeUsed - a.slotSizeUsed || b.slotReq - a.slotReq || a.decoName.localeCompare(b.decoName) || a.index - b.index,
    );

  for (const placement of placements) {
    let assigned = false;

    for (const piece of pieceOrder) {
      const slot = slotsByPiece[piece].find((candidate) => candidate.decoName === null && candidate.slotSize === placement.slotSizeUsed);
      if (!slot) {
        continue;
      }
      slot.decoName = placement.decoName;
      assigned = true;
      break;
    }

    if (assigned) {
      continue;
    }

    for (const piece of pieceOrder) {
      const slot = slotsByPiece[piece].find((candidate) => candidate.decoName === null && candidate.slotSize >= placement.slotReq);
      if (!slot) {
        continue;
      }
      slot.decoName = placement.decoName;
      break;
    }
  }

  const plans = pieceOrder.map((piece) => ({
    key: piece,
    label: pieceLabel[piece],
    name: pieceNames[piece],
    slots: slotsByPiece[piece],
  }));
  pieceSlotPlanCache.set(result.tieKey, plans);
  return plans;
}

function renderGearWithDecorations(result: BuildResult): string {
  const cached = gearRenderCache.get(result.tieKey);
  if (cached) {
    return cached;
  }
  const plans = buildPieceSlotPlans(result);
  if (plans.length === 0) {
    return `<p class="muted">No gear data.</p>`;
  }

  const html = plans
    .map((plan) => {
      const slotRows =
        plan.slots.length > 0
          ? plan.slots
              .map((slot) => {
                if (slot.decoName === null) {
                  return `<li><span class="slot-pill empty">S${slot.slotSize} Empty</span></li>`;
                }
                return `<li><span class="slot-pill filled">S${slot.slotSize} ${esc(slot.decoName)}</span></li>`;
              })
              .join("")
          : `<li><span class="slot-pill empty">No slots</span></li>`;

      return `
<details class="gear-accordion" open>
  <summary class="gear-row gear-row-summary">
    <span class="gear-row-left"><span class="gear-arrow" aria-hidden="true"></span>${plan.label}</span>
    <strong>${esc(plan.name)}</strong>
  </summary>
  <div class="gear-slots">
    <ul class="gear-slot-list">${slotRows}</ul>
  </div>
</details>`;
    })
    .join("");
  gearRenderCache.set(result.tieKey, html);
  return html;
}

function buildHuntFocusFromState(): HuntFocus {
  const statuses = [...state.huntStatuses];
  if (!state.huntElement && statuses.length === 0) {
    return null;
  }
  return {
    element: state.huntElement || undefined,
    status: statuses.length > 0 ? statuses : undefined,
  };
}

function extractLeftoverSlots(result: BuildResult): LeftoverSlot[] {
  const plans = buildPieceSlotPlans(result);
  const leftover: LeftoverSlot[] = [];
  let slotIndex = 1;
  for (const plan of plans) {
    for (const slot of plan.slots) {
      if (slot.decoName === null) {
        leftover.push({
          slotIndex,
          slotLevel: slot.slotSize as SlotSize,
          pieceLabel: plan.label,
          pieceName: plan.name,
        });
      }
      slotIndex += 1;
    }
  }
  return leftover;
}

function renderFlexSuggestions(result: BuildResult): string {
  const cached = flexRenderCache.get(result.tieKey);
  if (cached) {
    return cached;
  }
  if (!state.data) {
    return `<p class="muted">No flex suggestion data.</p>`;
  }

  const leftoverSlots = extractLeftoverSlots(result);
  if (leftoverSlots.length === 0) {
    const html = `<p class="muted">No leftover slots available for flex suggestions.</p>`;
    flexRenderCache.set(result.tieKey, html);
    return html;
  }

  const suggestions = suggestFlexDecorations({
    build: result,
    leftoverSlots,
    data: state.data,
    desiredSkills: state.desired,
    presetMode: state.flexPresetMode,
    huntFocus: buildHuntFocusFromState(),
    allowedDecorationIds: state.useAllDecos ? null : state.selectedDecos,
  });

  if (suggestions.length === 0) {
    const html = `<p class="muted">No valid flex suggestions for the current decoration pool.</p>`;
    flexRenderCache.set(result.tieKey, html);
    return html;
  }

  const html = `<div class="flex-suggestion-list">${suggestions
    .map((suggestion, index) => {
      const loadoutRows = suggestion.decorationLoadout
        .map(
          (entry) =>
            `<li>Slot ${entry.slotIndex} (${entry.pieceLabel} S${entry.slotLevel}) -> ${esc(entry.decorationName)}</li>`,
        )
        .join("");
      return `<article class="flex-suggestion-card">
        <div class="flex-suggestion-header"><strong>Option ${index + 1}</strong><span>Score ${suggestion.score.toFixed(1)}</span></div>
        <ul class="flex-loadout-list">${loadoutRows}</ul>
        <p class="muted">${esc(suggestion.explanation)}</p>
      </article>`;
    })
    .join("")}</div>`;
  flexRenderCache.set(result.tieKey, html);
  return html;
}

function computeBaseScore(result: BuildResult): number {
  const defenseScore = result.defenseMax * 0.9 + result.defenseBase * 0.15;
  const slotScore = result.leftoverSlotCapacity * 1.1;
  const efficiencyPenalty = result.wastedRequestedPoints * 1.4;
  return defenseScore + slotScore - efficiencyPenalty;
}

function computeTargetDeficitPoints(skillTotals: SkillPoints): {
  totalMissing: number;
  missingBySkillId: Record<number, number>;
} {
  const missingBySkillId: Record<number, number> = {};
  let totalMissing = 0;
  for (const desired of state.desired) {
    const current = skillTotals[desired.skillId] ?? 0;
    const missing = Math.max(0, desired.level - current);
    if (missing > 0) {
      missingBySkillId[desired.skillId] = missing;
      totalMissing += missing;
    }
  }
  return { totalMissing, missingBySkillId };
}

function meetsTargets(skillTotals: SkillPoints): boolean {
  return state.desired.every((desired) => (skillTotals[desired.skillId] ?? 0) >= desired.level);
}

function applyCharmToSkillTotals(baseTotals: SkillPoints, charm: CharmSuggestion["charm"] | null): SkillPoints {
  if (!charm) {
    return { ...baseTotals };
  }
  const merged: SkillPoints = { ...baseTotals };
  for (const rawSkillId in charm.skills) {
    const skillId = Number(rawSkillId);
    const level = charm.skills[rawSkillId] ?? 0;
    if (!Number.isFinite(skillId) || level <= 0) {
      continue;
    }
    merged[skillId] = (merged[skillId] ?? 0) + level;
  }
  return merged;
}

function buildCharmSummaryFromCharm(charm: CharmSuggestion["charm"] | null): string {
  if (!charm || !state.data) {
    return "";
  }
  const skillSummary = Object.entries(charm.skills)
    .map(([skillIdText, level]) => ({ skillId: Number(skillIdText), level }))
    .filter((entry) => entry.level > 0)
    .sort((a, b) => b.level - a.level || a.skillId - b.skillId)
    .map((entry) => {
      const skillName = state.data!.skillsById[entry.skillId]?.name || `Skill #${entry.skillId}`;
      return `${skillName}+${entry.level}`;
    })
    .join(" ");
  const slotSummary = charm.slots.join("-");
  if (!skillSummary) {
    return slotSummary;
  }
  return `${skillSummary} | ${slotSummary}`;
}

function buildCharmRequirementSummary(suggestion: CharmSuggestion | null): string {
  return buildCharmSummaryFromCharm(suggestion?.charm ?? null);
}

function computeCharmCoveragePoints(
  missingBySkillId: Record<number, number>,
  charm: CharmSuggestion["charm"] | null,
): number {
  if (!charm) {
    return 0;
  }
  let covered = 0;
  for (const rawSkillId in charm.skills) {
    const skillId = Number(rawSkillId);
    const level = charm.skills[rawSkillId] ?? 0;
    if (!Number.isFinite(skillId) || level <= 0) {
      continue;
    }
    const missing = missingBySkillId[skillId] ?? 0;
    covered += Math.min(level, Math.max(0, missing));
  }
  return covered;
}

function classifyCharmDependence(
  baseScore: number,
  charmBonusScore: number,
  requiredDeficitPoints: number,
  coveredByCharmPoints: number,
): "NONE" | "LOW" | "MED" | "HIGH" {
  if (requiredDeficitPoints <= 0) {
    return "NONE";
  }

  const coverageRatio = coveredByCharmPoints / Math.max(1, requiredDeficitPoints);
  if (coverageRatio >= 0.6) {
    return "HIGH";
  }
  if (coverageRatio >= 0.25) {
    return "MED";
  }

  const scoreRatio = charmBonusScore / Math.max(1, baseScore);
  if (scoreRatio > 0.15) {
    return "HIGH";
  }
  if (scoreRatio >= 0.05) {
    return "MED";
  }
  return "LOW";
}

function scoreCharmSlotList(slots: [number, number, number]): number {
  return slots.reduce((sum, slotSize) => {
    if (slotSize >= 3) return sum + 1.8;
    if (slotSize === 2) return sum + 1.25;
    if (slotSize === 1) return sum + 0.8;
    return sum;
  }, 0);
}

function buildOwnedCharmSuggestions(
  deficits: { missingBySkillId: Record<number, number> },
  weights: Record<number, number> | null,
): CharmSuggestion[] {
  if (state.ownedCharms.length === 0) {
    return [];
  }
  const suggestions = state.ownedCharms.map((charm) => {
    let skillScore = 0;
    const explains: string[] = [];
    for (const [rawSkillId, rawLevel] of Object.entries(charm.skills)) {
      const skillId = Number(rawSkillId);
      const level = Number(rawLevel) || 0;
      if (!Number.isFinite(skillId) || level <= 0) {
        continue;
      }
      const missing = deficits.missingBySkillId[skillId] ?? 0;
      const covered = Math.min(Math.max(0, missing), level);
      if (covered > 0) {
        const weight = weights?.[skillId] ?? 1;
        skillScore += covered * weight;
        const skillName = state.data?.skillsById[skillId]?.name || `Skill #${skillId}`;
        explains.push(`Covers ${skillName} +${covered}.`);
      }
    }
    const slotScore = scoreCharmSlotList(charm.slots) * 0.6;
    if (explains.length === 0) {
      explains.push(`Adds slot pattern ${charm.slots.join("-")}.`);
    }
    const score = Math.round((skillScore + slotScore) * 10) / 10;
    return {
      charm,
      score,
      explains: explains.slice(0, 3),
    } as CharmSuggestion;
  });

  suggestions.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const aSummary = buildCharmSummaryFromCharm(a.charm);
    const bSummary = buildCharmSummaryFromCharm(b.charm);
    return aSummary.localeCompare(bSummary);
  });

  return suggestions.slice(0, Math.max(1, state.charmSuggestCount));
}

function attachCharmMetaToResult(
  result: BuildResult,
  targetConfig: { requiredSkills: DesiredSkill[] } | null,
  weights: Record<number, number> | null,
): BuildResult {
  const baseScore = computeBaseScore(result);
  const deficits = computeTargetDeficitPoints(result.skillTotals);
  const meetsTargetsBase = deficits.totalMissing === 0;

  if (!state.data || state.charmMode === "off") {
    return {
      ...result,
      baseScore,
      charmSuggestions: [],
      suggestedCharms: [],
      bestSuggestedCharm: null,
      charmBonusScore: 0,
      totalScoreWithCharm: baseScore,
      charmRequirementSummary: "",
      meetsTargetsBase,
      meetsTargetsWithBestCharm: meetsTargetsBase,
      charmDependence: deficits.totalMissing <= 0 ? "NONE" : "LOW",
      charmDeficitPoints: deficits.totalMissing,
      charmCoveredPoints: 0,
    };
  }

  if (state.charmMode === "owned") {
    const charmSuggestions = buildOwnedCharmSuggestions(deficits, weights);
    const bestSuggestedCharm = charmSuggestions[0] ?? null;
    const charmBonusScore = bestSuggestedCharm?.score ?? 0;
    const previewTotals = applyCharmToSkillTotals(result.skillTotals, bestSuggestedCharm?.charm ?? null);
    const meetsTargetsWithBestCharm = meetsTargets(previewTotals);
    const totalScoreWithCharm = baseScore + charmBonusScore;
    const coveredByCharmPoints = computeCharmCoveragePoints(
      deficits.missingBySkillId,
      bestSuggestedCharm?.charm ?? null,
    );
    const charmDependence = classifyCharmDependence(
      baseScore,
      charmBonusScore,
      deficits.totalMissing,
      coveredByCharmPoints,
    );
    const charmRequirementSummary = bestSuggestedCharm ? buildCharmRequirementSummary(bestSuggestedCharm) : "";
    return {
      ...result,
      baseScore,
      charmSuggestions,
      suggestedCharms: charmSuggestions,
      bestSuggestedCharm,
      charmBonusScore,
      totalScoreWithCharm,
      charmRequirementSummary,
      meetsTargetsBase,
      meetsTargetsWithBestCharm,
      charmDependence,
      charmDeficitPoints: deficits.totalMissing,
      charmCoveredPoints: coveredByCharmPoints,
    };
  }

  const shouldSkipDueToNoDeficits =
    deficits.totalMissing === 0 &&
    state.hideSuggestionsIfNoDeficits &&
    !state.showComfortCharmWhenNoDeficits;

  const charmSuggestions = shouldSkipDueToNoDeficits
    ? []
    : suggestCharmsForBuild({
        build: result,
        data: state.data,
        targetConfig: targetConfig ?? { requiredSkills: state.desired },
        weights: weights ?? undefined,
        options: {
          suggestCount: state.charmSuggestCount,
          maxSuggestedSkills: state.charmMaxSuggestedSkills,
          allowSlotPatterns: state.charmSlotPatterns,
          maxSkillLevelPerCharmSkill: state.charmMaxSkillLevelPerSkill,
          suggestSlotForwardWhenComplete: state.showComfortCharmWhenNoDeficits,
        },
      });

  const bestSuggestedCharm = charmSuggestions[0] ?? null;
  const charmBonusScore = bestSuggestedCharm?.score ?? 0;
  const previewTotals = applyCharmToSkillTotals(result.skillTotals, bestSuggestedCharm?.charm ?? null);
  const meetsTargetsWithBestCharm = meetsTargets(previewTotals);
  const totalScoreWithCharm = baseScore + charmBonusScore;
  const coveredByCharmPoints = computeCharmCoveragePoints(
    deficits.missingBySkillId,
    bestSuggestedCharm?.charm ?? null,
  );
  const charmDependence = classifyCharmDependence(
    baseScore,
    charmBonusScore,
    deficits.totalMissing,
    coveredByCharmPoints,
  );
  const charmRequirementSummary =
    bestSuggestedCharm && bestSuggestedCharm.score >= state.minCharmScoreToShow
      ? buildCharmRequirementSummary(bestSuggestedCharm)
      : "";

  return {
    ...result,
    baseScore,
    charmSuggestions,
    suggestedCharms: charmSuggestions,
    bestSuggestedCharm,
    charmBonusScore,
    totalScoreWithCharm,
    charmRequirementSummary,
    meetsTargetsBase,
    meetsTargetsWithBestCharm,
    charmDependence,
    charmDeficitPoints: deficits.totalMissing,
    charmCoveredPoints: coveredByCharmPoints,
  };
}

function applyCharmSuggestionsToResults(results: BuildResult[]): BuildResult[] {
  if (!state.data || state.charmMode === "off") {
    return results.map((result) => attachCharmMetaToResult(result, null, null));
  }
  const targetConfig = { requiredSkills: state.desired };
  const weights = buildDefaultSkillWeights(state.data, targetConfig);
  return results.map((result) => attachCharmMetaToResult(result, targetConfig, weights));
}

function scoreForSorting(result: BuildResult): number {
  const baseScore = result.baseScore ?? computeBaseScore(result);
  if (state.charmMode === "suggest" || state.charmMode === "owned") {
    return result.totalScoreWithCharm ?? baseScore;
  }
  return baseScore;
}

function sortResultsForDisplay(results: BuildResult[]): BuildResult[] {
  return [...results].sort((a, b) => {
    const scoreDelta = scoreForSorting(b) - scoreForSorting(a);
    if (Math.abs(scoreDelta) > 0.000001) {
      return scoreDelta;
    }
    const fallback = compareBuildResults(a, b);
    if (fallback !== 0) {
      return fallback;
    }
    return a.tieKey.localeCompare(b.tieKey);
  });
}

function filterResultsForDisplay(results: BuildResult[]): BuildResult[] {
  return results.filter((result) => {
    const meetsBase = result.meetsTargetsBase ?? meetsTargets(result.skillTotals);
    const meetsWithCharm = result.meetsTargetsWithBestCharm ?? meetsBase;
    const showBase = state.filterShowMeetsBase;
    const showWithCharm = state.filterShowMeetsWithBestCharm;
    const targetPass =
      (!showBase && !showWithCharm) ||
      (showBase && meetsBase) ||
      (showWithCharm && meetsWithCharm);
    if (!targetPass) {
      return false;
    }
    if (state.filterHideHighCharmDependence && result.charmDependence === "HIGH") {
      return false;
    }
    return true;
  });
}

function logTopResultCharmDiagnostics(results: BuildResult[], label: string): void {
  if ((state.charmMode !== "suggest" && state.charmMode !== "owned") || results.length === 0) {
    return;
  }
  const top = results[0];
  const baseScore = top.baseScore ?? computeBaseScore(top);
  const requiredDeficitPoints = top.charmDeficitPoints ?? computeTargetDeficitPoints(top.skillTotals).totalMissing;
  const coveredByCharmPoints = top.charmCoveredPoints ?? 0;
  const bestSuggestedCharmScore = top.bestSuggestedCharm?.score ?? 0;
  const charmBonusScore = top.charmBonusScore ?? bestSuggestedCharmScore;
  const deficitsCount = requiredDeficitPoints;
  const hideWhenNoDeficits = state.hideSuggestionsIfNoDeficits;
  const showComfortWhenNoDeficits = state.showComfortCharmWhenNoDeficits;
  const suggestionsLength = top.charmSuggestions?.length ?? 0;
  console.info("[top-result-charm-metrics]", {
    label,
    baseScore: Math.round(baseScore * 100) / 100,
    "bestSuggestedCharm.score": Math.round(bestSuggestedCharmScore * 100) / 100,
    charmBonusScore: Math.round(charmBonusScore * 100) / 100,
    requiredDeficitPoints,
    coveredByCharmPoints,
    deficitsCount,
    hideWhenNoDeficits,
    showComfortWhenNoDeficits,
    "suggestions.length": suggestionsLength,
    nearMissEnabled: state.nearMissEnabled,
    nearMissMaxMissingPoints: state.nearMissMaxMissingPoints,
    charmDependence: top.charmDependence ?? "NONE",
    tieKey: top.tieKey,
  });
}

function refreshResultsView(): void {
  if (state.rawResults.length === 0) {
    state.results = [];
    return;
  }
  const withMeta = applyCharmSuggestionsToResults(state.rawResults);
  const sorted = sortResultsForDisplay(withMeta);
  logTopResultCharmDiagnostics(sorted, "pre-filter");
  const filtered = filterResultsForDisplay(sorted);
  const effectiveWorkers = Math.max(1, state.expectedWorkers || 1);
  const limit = Math.max(1, Math.min(MAX_POST_PROCESS_RESULTS, state.resultsPerThread * effectiveWorkers));
  state.results = filtered.slice(0, limit);
  logTopResultCharmDiagnostics(state.results, "post-filter");
}

function refreshCharmSuggestionsForCurrentResults(): void {
  refreshResultsView();
}

function getPreviewCharmForResult(result: BuildResult): CharmSuggestion["charm"] | null {
  const previewCharmId = state.previewCharmByResultKey[result.tieKey];
  if (!previewCharmId) {
    return null;
  }
  const selected = (result.charmSuggestions ?? []).find((suggestion) => suggestion.charm.id === previewCharmId);
  return selected?.charm ?? null;
}

function getDisplayBuildStats(result: BuildResult, previewCharm: CharmSuggestion["charm"] | null): {
  skillTotals: SkillPoints;
  leftoverSlotCapacity: number;
  meetsTargets: boolean;
} {
  const skillTotals = applyCharmToSkillTotals(result.skillTotals, previewCharm);
  const slotBonus = previewCharm ? previewCharm.slots.reduce((sum, value) => sum + value, 0) : 0;
  const leftoverSlotCapacity = result.leftoverSlotCapacity + slotBonus;
  return {
    skillTotals,
    leftoverSlotCapacity,
    meetsTargets: meetsTargets(skillTotals),
  };
}

function renderCharmSuggestionSkillList(suggestion: CharmSuggestion): string {
  if (!state.data) {
    return "";
  }
  const entries = Object.entries(suggestion.charm.skills)
    .map(([skillIdText, level]) => ({ skillId: Number(skillIdText), level }))
    .filter((entry) => entry.level > 0)
    .sort((a, b) => b.level - a.level || a.skillId - b.skillId);

  if (entries.length === 0) {
    return `<span class="muted">No direct skill coverage</span>`;
  }

  return entries
    .map((entry) => {
      const name = state.data!.skillsById[entry.skillId]?.name ?? `Skill #${entry.skillId}`;
      return `<span class="skill-chip">${esc(name)} +${entry.level}</span>`;
    })
    .join("");
}

function renderCharmDependenceBadge(result: BuildResult): string {
  if (state.charmMode === "off") {
    return "";
  }
  const level = result.charmDependence ?? "NONE";
  return `<span class="dependence-badge ${level.toLowerCase()}">Charm dependence: ${level}</span>`;
}

function renderCharmRequirement(
  result: BuildResult,
  previewCharm: CharmSuggestion["charm"] | null,
  displayStats: { meetsTargets: boolean },
): string {
  if (state.charmMode === "off") {
    return "";
  }
  const isSuggestMode = state.charmMode === "suggest";
  const isOwnedMode = state.charmMode === "owned";

  const suggestions = result.charmSuggestions ?? [];
  const best = result.bestSuggestedCharm ?? null;
  const noDeficits = (result.charmDeficitPoints ?? 0) === 0;

  if (isOwnedMode && state.ownedCharms.length === 0) {
    return `<p class="muted">No owned charms loaded. Import JSON in the Owned Charms panel.</p>`;
  }

  if (isSuggestMode && noDeficits && state.hideSuggestionsIfNoDeficits && !state.showComfortCharmWhenNoDeficits) {
    return "";
  }
  if (!best) {
    return isOwnedMode
      ? `<p class="muted">No owned charm improves this build.</p>`
      : `<p class="muted">No charm suggestions for this build.</p>`;
  }
  if (isSuggestMode && best.score < state.minCharmScoreToShow) {
    return `<p class="muted">No meaningful charm improvements for this build.</p>`;
  }

  const visibleSuggestions = isSuggestMode
    ? suggestions.filter((suggestion) => suggestion.score >= state.minCharmScoreToShow)
    : suggestions;
  if (visibleSuggestions.length === 0) {
    return `<p class="muted">No meaningful charm improvements for this build.</p>`;
  }

  const bestSummary = result.charmRequirementSummary || buildCharmRequirementSummary(best);
  const expanded = state.expandedCharmSuggestionsByResultKey[result.tieKey] ?? false;
  const meetsLabel = displayStats.meetsTargets ? "Meets targets" : "Missing targets";
  const bestPreviewing = previewCharm?.id === best.charm.id;
  const previewNotice = previewCharm
    ? `<p class="muted preview-line">Previewing charm: ${esc(buildCharmSummaryFromCharm(previewCharm))} <button type="button" class="tiny-btn" data-charm-action="clear-preview" data-result-key="${esc(result.tieKey)}">Clear preview</button></p>`
    : "";

  const summaryTitle = isOwnedMode ? "Best owned charm:" : "Charm requirement (theoretical):";
  const summaryLine = `<p class="charm-summary-line"><strong>${summaryTitle}</strong> ${esc(bestSummary)} <span class="muted">(${best.score.toFixed(1)} score)</span></p>`;
  const toggleRow = `<div class="charm-actions"><button type="button" class="tiny-btn" data-charm-action="preview" data-result-key="${esc(result.tieKey)}" data-charm-id="${esc(best.charm.id)}">${bestPreviewing ? "Previewing" : "Apply (preview)"}</button><button type="button" class="tiny-btn" data-charm-action="toggle-list" data-result-key="${esc(result.tieKey)}">${expanded ? "Hide suggestions" : `Show more (${visibleSuggestions.length})`}</button><span class="target-inline ${displayStats.meetsTargets ? "met" : "missing"}">${meetsLabel}</span></div>`;

  if (!expanded) {
    return `${summaryLine}${toggleRow}${previewNotice}`;
  }

  const list = visibleSuggestions
    .map((suggestion, index) => {
      const slotText = suggestion.charm.slots.join("-");
      const explainLines = (suggestion.explains ?? []).map((line) => `<li>${esc(line)}</li>`).join("");
      const isPreviewing = previewCharm?.id === suggestion.charm.id;
      return `<article class="flex-suggestion-card charm-suggestion-card">
        <div class="flex-suggestion-header"><strong>Template ${index + 1}</strong><span>Score ${suggestion.score.toFixed(1)}</span></div>
        <p class="muted">Skills: ${renderCharmSuggestionSkillList(suggestion)}</p>
        <p class="muted">Slots: <strong>${slotText}</strong> | ${isOwnedMode ? "Owned charm" : "Theoretical only"}</p>
        <div class="button-row compact"><button type="button" class="tiny-btn" data-charm-action="preview" data-result-key="${esc(result.tieKey)}" data-charm-id="${esc(suggestion.charm.id)}">${isPreviewing ? "Previewing" : "Apply (preview)"}</button></div>
        <ul class="flex-loadout-list">${explainLines}</ul>
      </article>`;
    })
    .join("");

  return `${summaryLine}${toggleRow}${previewNotice}<div class="charm-suggestion-list">${list}</div>`;
}

function renderResultCard(result: BuildResult, index: number): string {
  const previewCharm = getPreviewCharmForResult(result);
  const displayStats = getDisplayBuildStats(result, previewCharm);
  const scoreLabel = state.charmMode === "suggest" ? "Score (With Charm)" : "Score (Base)";
  const scoreValue = scoreForSorting(result).toFixed(1);
  return `
<article class="result-card" data-result-key="${esc(result.tieKey)}">
  <div class="result-header">
    <h3>#${index + 1}</h3>
    <div class="result-header-right">
      <span class="score-pill">${esc(scoreLabel)} ${scoreValue}</span>
      <span class="def-pill">DEF ${result.defenseMax}</span>
      ${state.charmMode === "suggest" && (result.missingRequestedPoints ?? 0) > 0 ? `<span class="missing-pill">Base missing ${result.missingRequestedPoints}</span>` : ""}
      ${renderCharmDependenceBadge(result)}
    </div>
  </div>

  <div class="result-columns">
    <section class="result-block">
      <h4>Gear</h4>
      <div class="gear-grid">
        ${renderGearWithDecorations(result)}
      </div>
      <div class="stat-grid">
        <div class="stat-item"><span>Defense</span><strong>${result.defenseBase}/${result.defenseMax}</strong></div>
        <div class="stat-item"><span>Resists</span><strong>${result.resist.fire}/${result.resist.water}/${result.resist.ice}/${result.resist.thunder}/${result.resist.dragon}</strong></div>
        <div class="stat-item"><span>Leftover Slot Capacity</span><strong>${displayStats.leftoverSlotCapacity}${previewCharm ? " (preview)" : ""}</strong></div>
      </div>
    </section>

    <section class="result-block">
      <h4>Requested Skills</h4>
      ${requestedSkillChecklist(displayStats.skillTotals)}
      <h4>${state.charmMode === "owned" ? "Owned Charms" : "Suggested RNG Charms (Theoretical)"}</h4>
      ${renderCharmRequirement(result, previewCharm, displayStats)}
      <h4>Flex Slot Suggestions</h4>
      ${renderFlexSuggestions(result)}
    </section>
  </div>

  <details>
    <summary>All Skills</summary>
    <div class="skill-chip-wrap">${skillChips(displayStats.skillTotals)}</div>
  </details>
</article>`;
}

function rerenderResultCardByKey(resultKey: string): void {
  const index = state.results.findIndex((result) => result.tieKey === resultKey);
  if (index < 0) {
    renderResults();
    return;
  }
  const card = Array.from(el.results.querySelectorAll<HTMLElement>("article.result-card")).find(
    (node) => node.dataset.resultKey === resultKey,
  );
  if (!card) {
    renderResults();
    return;
  }
  card.outerHTML = renderResultCard(state.results[index], index);
}

function renderResults(): void {
  el.runStatus.textContent = state.runStatus;
  if (!state.data) {
    el.results.innerHTML = `<p class="muted">Load data and optimize.</p>`;
    return;
  }
  if (state.optimizing) {
    el.results.innerHTML = `<p class="muted">Optimizing...</p>`;
    return;
  }
  if (state.results.length === 0) {
    el.results.innerHTML =
      state.rawResults.length > 0
        ? `<p class="muted">No builds match the current charm filters.</p>`
        : `<p class="muted">No results yet.</p>`;
    return;
  }
  const stats = state.workerStats.length
    ? `<p class="muted">Workers: ${state.workerStats.map((s, i) => `#${i + 1} ${Math.round(s.durationMs)}ms`).join(" | ")}</p>`
    : "";
  el.results.innerHTML = stats + state.results.map((result, index) => renderResultCard(result, index)).join("");
}

function refreshDerived(): void {
  if (!state.data) return;
  clearResultRenderCaches();
  for (const decoration of state.data.decorations) {
    const skillText = Object.entries(decoration.skills)
      .map(([id, level]) => `${state.data!.skillsById[Number(id)]?.name || `Skill #${id}`} +${level}`)
      .join(", ");
    decoLabel[decoration.id] = formatDecorationLabel(decoration, state.data);
    decoSearch[decoration.id] =
      `${decoration.name} ${simplifyDecorationDisplayName(decoration.name)} s${decoration.slotReq} ${decoration.kind} ${skillText}`.toLowerCase();
  }
  const normalized: DesiredSkill[] = [];
  const seen = new Set<number>();
  for (const d of state.desired) {
    const skill = state.data.skillsById[d.skillId];
    if (!skill || isWeaponSkillKind(skill.kind) || seen.has(d.skillId)) continue;
    seen.add(d.skillId);
    normalized.push({ skillId: d.skillId, level: Math.max(1, Math.min(skill.maxLevel, d.level)) });
  }
  state.desired = normalized;
  state.ownedCharms = reindexOwnedCharms(sanitizeOwnedCharmsForCurrentData(state.ownedCharms));
  writeOwnedCharmsToStorage(state.ownedCharms);
  const decorationIdSet = new Set(state.data.decorations.map((decoration) => decoration.id));
  if (state.useAllDecos && state.selectedDecos.size === 0) {
    state.selectedDecos = new Set(decorationIdSet);
  } else {
    state.selectedDecos = new Set([...state.selectedDecos].filter((id) => decorationIdSet.has(id)));
  }

  state.useAllDecos = state.data.decorations.length > 0 && state.selectedDecos.size === state.data.decorations.length;
}

type WorkerBase = Omit<OptimizeWorkerRequest, "allowedHeadIds">;
type WorkerTask = {
  promise: Promise<OptimizeWorkerDone>;
  cancel: () => void;
};

function runWorker(
  base: WorkerBase,
  allowedHeadIds: number[],
  workerIndex: number,
  onProgress: (progress: OptimizeWorkerProgress) => void,
): WorkerTask {
  const worker = new Worker(new URL("./optimizerWorker.ts", import.meta.url), { type: "module" });
  let settled = false;
  let rejectPromise: ((error: Error) => void) | null = null;

  const promise = new Promise<OptimizeWorkerDone>((resolve, reject) => {
    rejectPromise = reject;

    worker.onmessage = (ev: MessageEvent<OptimizeWorkerMessage>) => {
      const message = ev.data;
      if (message.type === "progress") {
        onProgress(message);
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      resolve(message);
    };

    worker.onerror = (ev) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      reject(new Error(ev.message || "worker failed"));
    };

    worker.postMessage({ ...base, allowedHeadIds, workerIndex });
  });

  const cancel = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    worker.terminate();
    rejectPromise?.(new Error("cancelled"));
  };

  return { promise, cancel };
}

function shareUrl(): string {
  const p = new URLSearchParams();
  p.set("loc", state.locale);
  if (state.skillKindFilter !== "all") {
    p.set("sk", state.skillKindFilter);
  }
  if (state.desired.length) p.set("ds", [...state.desired].sort((a, b) => a.skillId - b.skillId).map((d) => `${d.skillId}-${d.level}`).join(","));
  p.set("aa", state.allowAlpha ? "1" : "0");
  p.set("ag", state.allowGamma ? "1" : "0");
  p.set("t", String(state.threads));
  p.set("r", String(state.resultsPerThread));
  if (state.charmMode !== "off") {
    p.set("cm", state.charmMode);
  }
  if (state.charmSuggestCount !== DEFAULT_CHARM_SUGGESTION_OPTIONS.suggestCount) {
    p.set("sc", String(state.charmSuggestCount));
  }
  if (state.charmMaxSuggestedSkills !== DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSuggestedSkills) {
    p.set("mss", String(state.charmMaxSuggestedSkills));
  }
  if (state.charmMaxSkillLevelPerSkill !== DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSkillLevelPerCharmSkill) {
    p.set("msl", String(state.charmMaxSkillLevelPerSkill));
  }
  if (!state.nearMissEnabled) {
    p.set("nm", "0");
  }
  if (state.nearMissMaxMissingPoints !== DEFAULT_NEAR_MISS_MAX_MISSING_POINTS) {
    p.set("nmm", String(state.nearMissMaxMissingPoints));
  }
  if (Math.abs(state.minCharmScoreToShow - 1) > 0.0001) {
    p.set("mcs", state.minCharmScoreToShow.toFixed(1));
  }
  if (!state.hideSuggestionsIfNoDeficits) {
    p.set("hnd", "0");
  }
  if (state.showComfortCharmWhenNoDeficits) {
    p.set("scn", "1");
  }
  const slotPatternText = serializeSlotPatterns(state.charmSlotPatterns);
  const defaultSlotPatternText = serializeSlotPatterns(DEFAULT_CHARM_SLOT_PATTERNS);
  if (slotPatternText !== defaultSlotPatternText) {
    p.set("sp", slotPatternText);
  }
  const defaultFilterSettings = defaultFiltersForCharmMode(state.charmMode);
  if (state.filterShowMeetsBase !== defaultFilterSettings.showMeetsBase) {
    p.set("fb", state.filterShowMeetsBase ? "1" : "0");
  }
  if (state.filterShowMeetsWithBestCharm !== defaultFilterSettings.showMeetsWithBestCharm) {
    p.set("fw", state.filterShowMeetsWithBestCharm ? "1" : "0");
  }
  if (state.filterHideHighCharmDependence) {
    p.set("fh", "1");
  }
  const selected = [...state.selectedDecos].sort((a, b) => a - b);
  p.set("decos", state.useAllDecos ? "all" : selected.length > 0 ? selected.join(",") : "none");
  if (state.flexPresetMode !== "auto") {
    p.set("fp", state.flexPresetMode);
  }
  if (state.huntElement) {
    p.set("he", state.huntElement);
  }
  if (state.huntStatuses.size > 0) {
    p.set("hs", [...state.huntStatuses].sort().join(","));
  }
  return `${window.location.origin}${window.location.pathname}?${p.toString()}`;
}

async function load(force: boolean): Promise<void> {
  state.loading = true;
  state.dataError = "";
  rerender();
  try {
    const loaded = await loadOptimizerData(state.locale, force);
    state.data = loaded.data;
    state.dataSource = loaded.source;
    refreshDerived();
  } catch (error) {
    state.data = null;
    state.dataError = `Load failed: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    state.loading = false;
    rerender();
  }
}

function cancelOptimization(): void {
  if (!state.optimizing) {
    return;
  }
  state.cancelRequested = true;
  for (const cancel of state.activeWorkerCancels) {
    cancel();
  }
  state.activeWorkerCancels = [];
  state.optimizing = false;
  state.runStatus = "Optimization cancelled.";
  rerender();
}

async function optimize(): Promise<void> {
  if (!state.data) return;
  if (!state.desired.length) {
    state.runStatus = "Add at least one desired skill.";
    state.rawResults = [];
    state.results = [];
    rerender();
    return;
  }
  const heads = state.data.armorByKind.head.filter(armorAllowed).map((p) => p.id);
  if (!heads.length) {
    state.runStatus = "No head armor remains after alpha/gamma filters.";
    state.rawResults = [];
    state.results = [];
    rerender();
    return;
  }
  const threads = Math.max(1, Math.min(state.threads, MAX_THREADS, heads.length));
  const chunks: number[][] = Array.from({ length: threads }, () => []);
  heads.forEach((id, i) => chunks[i % threads].push(id));
  const workerChunks = chunks.filter((chunk) => chunk.length > 0);
  const started = performance.now();
  state.cancelRequested = false;
  state.optimizing = true;
  state.expectedWorkers = workerChunks.length;
  state.workerProgressByIndex = {};
  state.activeWorkerCancels = [];
  state.runStatus = `Running ${workerChunks.length} workers...`;
  state.rawResults = [];
  state.results = [];
  state.workerStats = [];
  state.previewCharmByResultKey = {};
  state.expandedCharmSuggestionsByResultKey = {};
  clearResultRenderCaches();
  rerender();
  try {
    const base: WorkerBase = {
      data: state.data,
      desiredSkills: state.desired,
      allowAlpha: state.allowAlpha,
      allowGamma: state.allowGamma,
      useAllDecorations: state.useAllDecos,
      allowedDecorationIds: state.useAllDecos ? [] : [...state.selectedDecos].sort((a, b) => a - b),
      maxResults: state.resultsPerThread,
      includeNearMissResults: (state.charmMode === "suggest" || state.charmMode === "owned") && state.nearMissEnabled,
      maxMissingPoints:
        (state.charmMode === "suggest" || state.charmMode === "owned") && state.nearMissEnabled
          ? state.nearMissMaxMissingPoints
          : 0,
    };
    const tasks = workerChunks.map((chunk, workerIndex) => {
      const task = runWorker(base, chunk, workerIndex, (progress) => {
        state.workerProgressByIndex[workerIndex] = progress;
        if (!state.optimizing) {
          return;
        }
        const aggregated = aggregateProgress();
        if (aggregated.totalCandidates > 0) {
          const percent = formatPercent(aggregated.evaluatedCandidates, aggregated.totalCandidates);
          state.runStatus = `Running ${state.expectedWorkers} workers... ${percent}`;
        } else {
          state.runStatus = `Running ${state.expectedWorkers} workers...`;
        }
        renderProgress();
        el.runStatus.textContent = state.runStatus;
      });
      state.activeWorkerCancels.push(task.cancel);
      return task.promise;
    });

    const responses = await Promise.all(tasks);
    if (state.cancelRequested) {
      return;
    }
    state.workerStats = responses.map((r) => r.stats);
    const merged = responses.flatMap((r) => r.results).sort(compareBuildResults);
    const limit = Math.min(MAX_POST_PROCESS_RESULTS, state.resultsPerThread * responses.length);
    state.rawResults = merged.slice(0, limit);
    refreshResultsView();
    state.runStatus = state.results.length
      ? `Found ${state.results.length} builds in ${Math.round(performance.now() - started)} ms.`
      : `No valid builds found in ${Math.round(performance.now() - started)} ms.`;
  } catch (error) {
    if (!state.cancelRequested) {
      state.runStatus = `Optimization failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  } finally {
    state.activeWorkerCancels = [];
    if (!state.cancelRequested) {
      state.optimizing = false;
    }
    rerender();
  }
}

function refreshAndRenderResults(): void {
  refreshCharmSuggestionsForCurrentResults();
  renderResults();
}

function reindexOwnedCharms(charms: Charm[]): Charm[] {
  return charms.map((charm, index) => ({
    ...charm,
    id: `owned-${index + 1}`,
    weaponSlot: 0,
  }));
}

function updateOwnedCharms(next: Charm[], statusMessage?: string): void {
  state.ownedCharms = reindexOwnedCharms(next);
  writeOwnedCharmsToStorage(state.ownedCharms);
  state.previewCharmByResultKey = {};
  state.expandedCharmSuggestionsByResultKey = {};
  if (statusMessage) {
    state.runStatus = statusMessage;
  }
  refreshAndRenderResults();
}

function sanitizeOwnedCharmsForCurrentData(charms: Charm[]): Charm[] {
  return charms.map((charm) => {
    const filteredSkills: Record<string, number> = {};
    for (const [rawSkillId, rawLevel] of Object.entries(charm.skills)) {
      const skillId = Number(rawSkillId);
      const level = Number(rawLevel) || 0;
      if (!Number.isFinite(skillId) || level <= 0) {
        continue;
      }
      if (!isCharmRollableSkillId(skillId)) {
        continue;
      }
      filteredSkills[String(skillId)] = level;
    }
    return {
      ...charm,
      skills: filteredSkills,
    };
  });
}

el.locale.addEventListener("change", () => {
  state.locale = el.locale.value;
  state.rawResults = [];
  state.results = [];
  state.previewCharmByResultKey = {};
  state.expandedCharmSuggestionsByResultKey = {};
  clearResultRenderCaches();
  load(false).catch(() => undefined);
});
el.refreshData.addEventListener("click", () => {
  clearResultRenderCaches();
  clearCachedLocale(state.locale);
  load(true).catch(() => undefined);
});
el.skillSearch.addEventListener("input", () => {
  state.skillSearch = el.skillSearch.value;
  renderSkillList();
});
el.skillKindFilter.addEventListener("change", () => {
  const value = el.skillKindFilter.value as SkillKindFilter;
  state.skillKindFilter = validSkillKindFilters.includes(value) ? value : "all";
  renderSkillList();
});
el.addSkill.addEventListener("click", () => {
  if (!state.data) return;
  const option = el.skillList.selectedOptions[0];
  const id = Number.parseInt(option?.value || "", 10);
  if (Number.isNaN(id) || state.desired.some((d) => d.skillId === id)) return;
  if (!isSelectableRequestedSkillId(id)) return;
  const max = state.data.skillsById[id]?.maxLevel || 1;
  state.desired.push({ skillId: id, level: Math.min(1, max) });
  clearFlexRenderCache();
  renderDesired();
});
el.skillList.addEventListener("dblclick", () => el.addSkill.click());
el.desiredList.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (!(t instanceof HTMLButtonElement)) return;

  if (t.classList.contains("remove")) {
    const id = Number.parseInt(t.dataset.skillId || "", 10);
    state.desired = state.desired.filter((d) => d.skillId !== id);
    clearFlexRenderCache();
    renderDesired();
    return;
  }

  if (!t.classList.contains("level-btn") || !state.data) {
    return;
  }
  const skillId = Number.parseInt(t.dataset.skillId || "", 10);
  const nextLevel = Number.parseInt(t.dataset.level || "", 10);
  if (Number.isNaN(skillId) || Number.isNaN(nextLevel)) {
    return;
  }
  const skill = state.data.skillsById[skillId];
  if (!skill) {
    return;
  }
  const clampedLevel = Math.max(1, Math.min(skill.maxLevel, nextLevel));
  state.desired = state.desired.map((desired) =>
    desired.skillId === skillId ? { skillId, level: clampedLevel } : desired,
  );
  clearFlexRenderCache();
  renderDesired();
});
el.decoSearch.addEventListener("input", () => {
  state.decoSearch = el.decoSearch.value;
  renderDecoList();
});
el.decoAll.addEventListener("click", () => {
  if (!state.data) return;
  state.useAllDecos = true;
  state.selectedDecos = new Set(state.data.decorations.map((d) => d.id));
  clearFlexRenderCache();
  renderDecoList();
});
el.decoNone.addEventListener("click", () => {
  state.useAllDecos = false;
  state.selectedDecos = new Set<number>();
  clearFlexRenderCache();
  renderDecoList();
});
el.decoList.addEventListener("change", () => {
  if (!state.data) return;
  state.useAllDecos = false;
  for (const option of el.decoList.options) {
    const id = Number.parseInt(option.value, 10);
    if (Number.isNaN(id)) continue;
    if (option.selected) state.selectedDecos.add(id);
    else state.selectedDecos.delete(id);
  }
  state.useAllDecos = state.selectedDecos.size === state.data.decorations.length;
  clearFlexRenderCache();
  renderDecoList();
});
el.allowAlpha.addEventListener("change", () => (state.allowAlpha = el.allowAlpha.checked));
el.allowGamma.addEventListener("change", () => (state.allowGamma = el.allowGamma.checked));
el.threads.addEventListener("change", () => (state.threads = clampInt(el.threads.value, DEFAULT_THREADS, 1, MAX_THREADS)));
el.resultsPerThread.addEventListener("change", () => {
  state.resultsPerThread = clampInt(el.resultsPerThread.value, DEFAULT_RESULTS, 1, MAX_RESULTS);
  refreshAndRenderResults();
});
el.charmMode.addEventListener("change", () => {
  const value = el.charmMode.value as CharmMode;
  state.charmMode = validCharmModes.includes(value) ? value : "off";
  const defaults = defaultFiltersForCharmMode(state.charmMode);
  state.filterShowMeetsBase = defaults.showMeetsBase;
  state.filterShowMeetsWithBestCharm = defaults.showMeetsWithBestCharm;
  if (state.charmMode !== "suggest") {
    state.filterHideHighCharmDependence = false;
  }
  state.previewCharmByResultKey = {};
  state.expandedCharmSuggestionsByResultKey = {};
  refreshCharmSuggestionsForCurrentResults();
  rerender();
});
el.charmSuggestCount.addEventListener("change", () => {
  state.charmSuggestCount = clampInt(
    el.charmSuggestCount.value,
    DEFAULT_CHARM_SUGGESTION_OPTIONS.suggestCount,
    1,
    20,
  );
  refreshAndRenderResults();
});
el.charmMaxSkills.addEventListener("change", () => {
  state.charmMaxSuggestedSkills = clampInt(
    el.charmMaxSkills.value,
    DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSuggestedSkills,
    1,
    12,
  );
  refreshAndRenderResults();
});
el.charmSkillCap.addEventListener("change", () => {
  state.charmMaxSkillLevelPerSkill = clampInt(
    el.charmSkillCap.value,
    DEFAULT_CHARM_SUGGESTION_OPTIONS.maxSkillLevelPerCharmSkill,
    1,
    7,
  );
  refreshAndRenderResults();
});
el.charmSlotPatterns.addEventListener("change", () => {
  const fallback = DEFAULT_CHARM_SLOT_PATTERNS;
  state.charmSlotPatternsText = el.charmSlotPatterns.value.trim() || serializeSlotPatterns(fallback);
  state.charmSlotPatterns = parseSlotPatterns(state.charmSlotPatternsText, fallback);
  state.charmSlotPatternsText = serializeSlotPatterns(state.charmSlotPatterns);
  refreshAndRenderResults();
});
el.nearMissEnabled.addEventListener("change", () => {
  state.nearMissEnabled = el.nearMissEnabled.checked;
  state.runStatus = "Near-miss solver setting changed. Re-run Optimize to apply.";
  rerender();
});
el.nearMissMaxMissing.addEventListener("change", () => {
  state.nearMissMaxMissingPoints = clampInt(
    el.nearMissMaxMissing.value,
    DEFAULT_NEAR_MISS_MAX_MISSING_POINTS,
    1,
    12,
  );
  state.runStatus = "Near-miss solver setting changed. Re-run Optimize to apply.";
  rerender();
});
el.charmMinScore.addEventListener("change", () => {
  state.minCharmScoreToShow = clampFloat(el.charmMinScore.value, 1, 0, 100);
  refreshAndRenderResults();
});
el.charmHideNoDeficit.addEventListener("change", () => {
  state.hideSuggestionsIfNoDeficits = el.charmHideNoDeficit.checked;
  refreshAndRenderResults();
});
el.charmShowComfort.addEventListener("change", () => {
  state.showComfortCharmWhenNoDeficits = el.charmShowComfort.checked;
  refreshAndRenderResults();
});
el.filterMeetsBase.addEventListener("change", () => {
  state.filterShowMeetsBase = el.filterMeetsBase.checked;
  refreshAndRenderResults();
});
el.filterMeetsWithCharm.addEventListener("change", () => {
  state.filterShowMeetsWithBestCharm = el.filterMeetsWithCharm.checked;
  refreshAndRenderResults();
});
el.filterHideHighDependence.addEventListener("change", () => {
  state.filterHideHighCharmDependence = el.filterHideHighDependence.checked;
  refreshAndRenderResults();
});
el.ownedCharmsImport.addEventListener("click", () => {
  try {
    const parsed = parseOwnedCharmsJsonInput(el.ownedCharmsJson.value.trim());
    updateOwnedCharms(parsed, `Imported ${parsed.length} owned charms.`);
  } catch (error) {
    state.runStatus = `Owned charm import failed: ${error instanceof Error ? error.message : "invalid JSON"}`;
    rerender();
  }
});
el.ownedCharmsExport.addEventListener("click", async () => {
  const text = serializeOwnedCharmsJson(state.ownedCharms, true);
  el.ownedCharmsJson.value = text;
  try {
    await navigator.clipboard.writeText(text);
    state.runStatus = `Exported ${state.ownedCharms.length} owned charms (copied to clipboard).`;
  } catch {
    state.runStatus = `Exported ${state.ownedCharms.length} owned charms to text box.`;
  }
  rerender();
});
el.ownedCharmsClear.addEventListener("click", () => {
  updateOwnedCharms([], "Owned charms cleared.");
});
el.results.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>("button[data-charm-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.charmAction;
  const resultKey = button.dataset.resultKey;
  if (!action || !resultKey) {
    return;
  }
  if (action === "toggle-list") {
    const current = state.expandedCharmSuggestionsByResultKey[resultKey] ?? false;
    state.expandedCharmSuggestionsByResultKey[resultKey] = !current;
    rerenderResultCardByKey(resultKey);
    return;
  }
  if (action === "clear-preview") {
    delete state.previewCharmByResultKey[resultKey];
    rerenderResultCardByKey(resultKey);
    return;
  }
  if (action !== "preview") {
    return;
  }
  const charmId = button.dataset.charmId;
  if (!charmId) {
    return;
  }
  const result = state.results.find((entry) => entry.tieKey === resultKey);
  if (!result) {
    return;
  }
  const hasCharm = (result.charmSuggestions ?? []).some((suggestion) => suggestion.charm.id === charmId);
  if (!hasCharm) {
    return;
  }
  const current = state.previewCharmByResultKey[resultKey] ?? null;
  if (current === charmId) {
    delete state.previewCharmByResultKey[resultKey];
  } else {
    state.previewCharmByResultKey[resultKey] = charmId;
  }
  rerenderResultCardByKey(resultKey);
});
el.flexPreset.addEventListener("change", () => {
  const value = el.flexPreset.value as FlexPresetMode;
  state.flexPresetMode = ["auto", "comfort", "balanced", "damage"].includes(value) ? value : "auto";
  clearFlexRenderCache();
  renderResults();
});
el.huntElement.addEventListener("change", () => {
  const value = el.huntElement.value as HuntElement | "";
  state.huntElement = HUNT_ELEMENT_OPTIONS.includes(value as HuntElement) ? (value as HuntElement) : "";
  clearFlexRenderCache();
  renderResults();
});
for (const input of huntStatusInputs) {
  input.addEventListener("change", () => {
    const next = new Set<HuntStatus>();
    for (const statusInput of huntStatusInputs) {
      if (!statusInput.checked) continue;
      const status = statusInput.dataset.huntStatus as HuntStatus | undefined;
      if (status && HUNT_STATUS_OPTIONS.includes(status)) {
        next.add(status);
      }
    }
    state.huntStatuses = next;
    clearFlexRenderCache();
    renderResults();
  });
}
el.optimize.addEventListener("click", () => optimize().catch(() => undefined));
el.stop.addEventListener("click", () => cancelOptimization());
el.copyLink.addEventListener("click", async () => {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    state.runStatus = "Share link copied.";
  } catch {
    state.runStatus = url;
  }
  renderResults();
});

load(false).catch(() => undefined);
