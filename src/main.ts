import "./style.css";
import { clearCachedLocale, loadOptimizerData } from "./mhdbApi";
import { compareBuildResults } from "./optimizer";
import type {
  ArmorPiece,
  BuildResult,
  DesiredSkill,
  LoadDataSource,
  NormalizedData,
  OptimizeWorkerDone,
  OptimizeWorkerMessage,
  OptimizeWorkerProgress,
  OptimizeWorkerRequest,
  SkillPoints,
  WorkerStats,
} from "./types";

const LOCALES = ["en", "ja", "ko", "fr", "de", "es", "it", "pl", "pt-BR", "ru", "zh-Hans", "zh-Hant", "ar"];
const MAX_THREADS = 16;
const MAX_RESULTS = 200;
const DEFAULT_THREADS = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));
const DEFAULT_RESULTS = 50;

type State = {
  locale: string;
  data: NormalizedData | null;
  dataSource: LoadDataSource | null;
  loading: boolean;
  dataError: string;
  desired: DesiredSkill[];
  allowAlpha: boolean;
  allowGamma: boolean;
  armorDecoOnly: boolean;
  useAllDecos: boolean;
  selectedDecos: Set<number>;
  threads: number;
  resultsPerThread: number;
  optimizing: boolean;
  runStatus: string;
  results: BuildResult[];
  workerStats: WorkerStats[];
  workerProgressByIndex: Record<number, OptimizeWorkerProgress>;
  expectedWorkers: number;
  activeWorkerCancels: Array<() => void>;
  cancelRequested: boolean;
  skillSearch: string;
  decoSearch: string;
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app.");

root.innerHTML = `
<div class="shell">
  <header class="hero">
    <p class="kicker">Monster Hunter Wilds</p>
    <h1>Skill-First Gear Optimizer</h1>
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
      <label class="field"><span>Search</span><input id="skill-search" type="search" placeholder="Skill name"/></label>
      <select id="skill-list" size="9"></select>
      <div class="button-row"><button id="add-skill" type="button">Add Skill</button></div>
      <div id="desired-list"></div>
    </div>
    <div class="pane">
      <h2>Decoration Pool</h2>
      <label class="checkbox-line"><input id="armor-deco-only" type="checkbox"/><span>Armor decorations only</span></label>
      <label class="field"><span>Search</span><input id="deco-search" type="search" placeholder="Decoration name"/></label>
      <div class="button-row"><button id="deco-all" type="button">Select All</button><button id="deco-none" type="button">Clear All</button></div>
      <select id="deco-list" multiple size="10"></select>
      <p id="deco-summary" class="muted"></p>
    </div>
  </section>

  <section class="panel">
    <h2>Controls</h2>
    <div class="inline-grid">
      <label class="checkbox-line"><input id="allow-alpha" type="checkbox"/><span>Allow α armor</span></label>
      <label class="checkbox-line"><input id="allow-gamma" type="checkbox"/><span>Allow γ armor</span></label>
      <label class="field"><span>Max Threads</span><input id="threads" type="number" min="1" max="16"/></label>
      <label class="field"><span>Max Results Per Thread</span><input id="results-per-thread" type="number" min="1" max="200"/></label>
    </div>
    <div class="button-row">
      <button id="optimize" type="button">Optimize</button>
      <button id="stop" type="button">Stop</button>
      <button id="copy-link" type="button">Copy Share Link</button>
    </div>
    <div class="progress-wrap">
      <progress id="run-progress" max="1" value="0"></progress>
      <p id="progress-text" class="muted">No active run.</p>
    </div>
    <p id="run-status" class="status-line"></p>
  </section>

  <section class="panel"><h2>Results</h2><div id="results"></div></section>
  <footer class="footer-note">Not affiliated with Capcom.</footer>
</div>`;

const el = {
  locale: document.querySelector<HTMLSelectElement>("#locale")!,
  refreshData: document.querySelector<HTMLButtonElement>("#refresh-data")!,
  dataStatus: document.querySelector<HTMLParagraphElement>("#data-status")!,
  skillSearch: document.querySelector<HTMLInputElement>("#skill-search")!,
  skillList: document.querySelector<HTMLSelectElement>("#skill-list")!,
  addSkill: document.querySelector<HTMLButtonElement>("#add-skill")!,
  desiredList: document.querySelector<HTMLDivElement>("#desired-list")!,
  armorDecoOnly: document.querySelector<HTMLInputElement>("#armor-deco-only")!,
  decoSearch: document.querySelector<HTMLInputElement>("#deco-search")!,
  decoAll: document.querySelector<HTMLButtonElement>("#deco-all")!,
  decoNone: document.querySelector<HTMLButtonElement>("#deco-none")!,
  decoList: document.querySelector<HTMLSelectElement>("#deco-list")!,
  decoSummary: document.querySelector<HTMLParagraphElement>("#deco-summary")!,
  allowAlpha: document.querySelector<HTMLInputElement>("#allow-alpha")!,
  allowGamma: document.querySelector<HTMLInputElement>("#allow-gamma")!,
  threads: document.querySelector<HTMLInputElement>("#threads")!,
  resultsPerThread: document.querySelector<HTMLInputElement>("#results-per-thread")!,
  optimize: document.querySelector<HTMLButtonElement>("#optimize")!,
  stop: document.querySelector<HTMLButtonElement>("#stop")!,
  copyLink: document.querySelector<HTMLButtonElement>("#copy-link")!,
  runProgress: document.querySelector<HTMLProgressElement>("#run-progress")!,
  progressText: document.querySelector<HTMLParagraphElement>("#progress-text")!,
  runStatus: document.querySelector<HTMLParagraphElement>("#run-status")!,
  results: document.querySelector<HTMLDivElement>("#results")!,
};

for (const locale of LOCALES) {
  const option = document.createElement("option");
  option.value = locale;
  option.textContent = locale;
  el.locale.append(option);
}

const params = new URLSearchParams(window.location.search);
const decoParam = params.get("decos");
const state: State = {
  locale: LOCALES.includes(params.get("loc") || "") ? (params.get("loc") as string) : "en",
  data: null,
  dataSource: null,
  loading: false,
  dataError: "",
  desired: parseDesired(params.get("ds")),
  allowAlpha: parseBool(params.get("aa"), true),
  allowGamma: parseBool(params.get("ag"), true),
  armorDecoOnly: parseBool(params.get("ad"), false),
  useAllDecos: !decoParam || decoParam === "all",
  selectedDecos: decoParam && decoParam !== "all" ? parseIdSet(decoParam) : new Set<number>(),
  threads: clampInt(params.get("t"), DEFAULT_THREADS, 1, MAX_THREADS),
  resultsPerThread: clampInt(params.get("r"), DEFAULT_RESULTS, 1, MAX_RESULTS),
  optimizing: false,
  runStatus: "",
  results: [],
  workerStats: [],
  workerProgressByIndex: {},
  expectedWorkers: 0,
  activeWorkerCancels: [],
  cancelRequested: false,
  skillSearch: "",
  decoSearch: "",
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
  el.armorDecoOnly.checked = state.armorDecoOnly;
  el.allowAlpha.checked = state.allowAlpha;
  el.allowGamma.checked = state.allowGamma;
  el.threads.value = String(state.threads);
  el.resultsPerThread.value = String(state.resultsPerThread);
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
  const list = state.data.skills.filter((skill) => skill.name.toLowerCase().includes(q)).slice(0, 120);
  el.skillList.innerHTML = list
    .map((skill) => `<option value="${skill.id}">${esc(skill.name)} (max ${skill.maxLevel})</option>`)
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
  el.desiredList.innerHTML = `<table class="simple-table"><thead><tr><th>Skill</th><th>Target</th><th></th></tr></thead><tbody>${
    state.desired
      .map((d) => {
        const skill = state.data!.skillsById[d.skillId];
        if (!skill) return "";
        return `<tr><td>${esc(skill.name)}</td><td><input class="target" data-skill-id="${d.skillId}" type="number" min="1" max="${skill.maxLevel}" value="${d.level}"/></td><td><button class="remove" data-skill-id="${d.skillId}" type="button">Remove</button></td></tr>`;
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
  el.decoSummary.textContent = `Selected ${state.selectedDecos.size}/${state.data.decorations.length}`;
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

function groupedDecorations(placements: BuildResult["placements"]): string {
  if (!state.data || placements.length === 0) {
    return `<p class="muted">No decorations required.</p>`;
  }

  const grouped = new Map<string, { slotSize: number; name: string; count: number }>();
  for (const placement of placements) {
    const name = state.data!.decorationsById[placement.decorationId]?.name || `Decoration #${placement.decorationId}`;
    const key = `${placement.slotSizeUsed}-${placement.decorationId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        slotSize: placement.slotSizeUsed,
        name,
        count: 1,
      });
    }
  }

  const rows = [...grouped.values()]
    .sort((a, b) => a.slotSize - b.slotSize || a.name.localeCompare(b.name))
    .map((item) => `<tr><td>S${item.slotSize}</td><td>${esc(item.name)}</td><td>x${item.count}</td></tr>`)
    .join("");

  return `<table class="deco-table"><thead><tr><th>Slot</th><th>Decoration</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    el.results.innerHTML = `<p class="muted">No results yet.</p>`;
    return;
  }
  const stats = state.workerStats.length
    ? `<p class="muted">Workers: ${state.workerStats.map((s, i) => `#${i + 1} ${Math.round(s.durationMs)}ms`).join(" | ")}</p>`
    : "";
  el.results.innerHTML =
    stats +
    state.results
      .map((r, i) => {
        const head = state.data!.armorById[r.armor.head]?.name || "?";
        const chest = state.data!.armorById[r.armor.chest]?.name || "?";
        const arms = state.data!.armorById[r.armor.arms]?.name || "?";
        const waist = state.data!.armorById[r.armor.waist]?.name || "?";
        const legs = state.data!.armorById[r.armor.legs]?.name || "?";
        const charm = state.data!.charmRankById[r.charmRankId]?.name || "?";
        return `
<article class="result-card">
  <div class="result-header">
    <h3>#${i + 1}</h3>
    <span class="def-pill">DEF ${r.defenseMax}</span>
  </div>

  <div class="result-columns">
    <section class="result-block">
      <h4>Gear</h4>
      <div class="gear-grid">
        <div class="gear-row"><span>Head</span><strong>${esc(head)}</strong></div>
        <div class="gear-row"><span>Chest</span><strong>${esc(chest)}</strong></div>
        <div class="gear-row"><span>Arms</span><strong>${esc(arms)}</strong></div>
        <div class="gear-row"><span>Waist</span><strong>${esc(waist)}</strong></div>
        <div class="gear-row"><span>Legs</span><strong>${esc(legs)}</strong></div>
        <div class="gear-row"><span>Charm</span><strong>${esc(charm)}</strong></div>
      </div>
      <div class="stat-grid">
        <div class="stat-item"><span>Defense</span><strong>${r.defenseBase}/${r.defenseMax}</strong></div>
        <div class="stat-item"><span>Resists</span><strong>${r.resist.fire}/${r.resist.water}/${r.resist.ice}/${r.resist.thunder}/${r.resist.dragon}</strong></div>
        <div class="stat-item"><span>Leftover Slot Capacity</span><strong>${r.leftoverSlotCapacity}</strong></div>
      </div>
    </section>

    <section class="result-block">
      <h4>Requested Skills</h4>
      ${requestedSkillChecklist(r.skillTotals)}
      <h4>Decorations Used</h4>
      ${groupedDecorations(r.placements)}
    </section>
  </div>

  <details>
    <summary>All Skills</summary>
    <div class="skill-chip-wrap">${skillChips(r.skillTotals)}</div>
  </details>
</article>`;
      })
      .join("");
}

function refreshDerived(): void {
  if (!state.data) return;
  for (const d of state.data.decorations) {
    const skillText = Object.entries(d.skills)
      .map(([id, level]) => `${state.data!.skillsById[Number(id)]?.name || `Skill #${id}`} +${level}`)
      .join(", ");
    decoLabel[d.id] = `${d.name} [S${d.slotReq}] - ${skillText}`;
    decoSearch[d.id] = `${d.name} ${skillText}`.toLowerCase();
  }
  const normalized: DesiredSkill[] = [];
  const seen = new Set<number>();
  for (const d of state.desired) {
    const skill = state.data.skillsById[d.skillId];
    if (!skill || seen.has(d.skillId)) continue;
    seen.add(d.skillId);
    normalized.push({ skillId: d.skillId, level: Math.max(1, Math.min(skill.maxLevel, d.level)) });
  }
  state.desired = normalized;
  if (state.useAllDecos && state.selectedDecos.size === 0) state.selectedDecos = new Set(state.data.decorations.map((d) => d.id));
  else state.selectedDecos = new Set([...state.selectedDecos].filter((id) => state.data!.decorationsById[id]));
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
  if (state.desired.length) p.set("ds", [...state.desired].sort((a, b) => a.skillId - b.skillId).map((d) => `${d.skillId}-${d.level}`).join(","));
  p.set("aa", state.allowAlpha ? "1" : "0");
  p.set("ag", state.allowGamma ? "1" : "0");
  p.set("ad", state.armorDecoOnly ? "1" : "0");
  p.set("t", String(state.threads));
  p.set("r", String(state.resultsPerThread));
  const selected = [...state.selectedDecos].sort((a, b) => a - b);
  p.set("decos", state.useAllDecos ? "all" : selected.length > 0 ? selected.join(",") : "none");
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
    rerender();
    return;
  }
  const heads = state.data.armorByKind.head.filter(armorAllowed).map((p) => p.id);
  if (!heads.length) {
    state.runStatus = "No head armor remains after alpha/gamma filters.";
    state.results = [];
    rerender();
    return;
  }
  const threads = Math.max(1, Math.min(state.threads, navigator.hardwareConcurrency || state.threads, heads.length));
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
  state.results = [];
  state.workerStats = [];
  rerender();
  try {
    const base: WorkerBase = {
      data: state.data,
      desiredSkills: state.desired,
      allowAlpha: state.allowAlpha,
      allowGamma: state.allowGamma,
      armorDecorationsOnly: state.armorDecoOnly,
      useAllDecorations: state.useAllDecos,
      allowedDecorationIds: state.useAllDecos ? [] : [...state.selectedDecos].sort((a, b) => a - b),
      maxResults: state.resultsPerThread,
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
    state.results = merged.slice(0, state.resultsPerThread * responses.length);
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

el.locale.addEventListener("change", () => {
  state.locale = el.locale.value;
  state.results = [];
  load(false).catch(() => undefined);
});
el.refreshData.addEventListener("click", () => {
  clearCachedLocale(state.locale);
  load(true).catch(() => undefined);
});
el.skillSearch.addEventListener("input", () => {
  state.skillSearch = el.skillSearch.value;
  renderSkillList();
});
el.addSkill.addEventListener("click", () => {
  if (!state.data) return;
  const option = el.skillList.selectedOptions[0];
  const id = Number.parseInt(option?.value || "", 10);
  if (Number.isNaN(id) || state.desired.some((d) => d.skillId === id)) return;
  const max = state.data.skillsById[id]?.maxLevel || 1;
  state.desired.push({ skillId: id, level: Math.min(1, max) });
  renderDesired();
});
el.skillList.addEventListener("dblclick", () => el.addSkill.click());
el.desiredList.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (!(t instanceof HTMLButtonElement) || !t.classList.contains("remove")) return;
  const id = Number.parseInt(t.dataset.skillId || "", 10);
  state.desired = state.desired.filter((d) => d.skillId !== id);
  renderDesired();
});
el.desiredList.addEventListener("change", (ev) => {
  if (!(ev.target instanceof HTMLInputElement) || !ev.target.classList.contains("target") || !state.data) return;
  const id = Number.parseInt(ev.target.dataset.skillId || "", 10);
  const skill = state.data.skillsById[id];
  if (!skill) return;
  const next = clampInt(ev.target.value, 1, 1, skill.maxLevel);
  state.desired = state.desired.map((d) => (d.skillId === id ? { skillId: id, level: next } : d));
});
el.armorDecoOnly.addEventListener("change", () => (state.armorDecoOnly = el.armorDecoOnly.checked));
el.decoSearch.addEventListener("input", () => {
  state.decoSearch = el.decoSearch.value;
  renderDecoList();
});
el.decoAll.addEventListener("click", () => {
  if (!state.data) return;
  state.useAllDecos = true;
  state.selectedDecos = new Set(state.data.decorations.map((d) => d.id));
  renderDecoList();
});
el.decoNone.addEventListener("click", () => {
  state.useAllDecos = false;
  state.selectedDecos = new Set<number>();
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
  renderDecoList();
});
el.allowAlpha.addEventListener("change", () => (state.allowAlpha = el.allowAlpha.checked));
el.allowGamma.addEventListener("change", () => (state.allowGamma = el.allowGamma.checked));
el.threads.addEventListener("change", () => (state.threads = clampInt(el.threads.value, DEFAULT_THREADS, 1, MAX_THREADS)));
el.resultsPerThread.addEventListener("change", () => (state.resultsPerThread = clampInt(el.resultsPerThread.value, DEFAULT_RESULTS, 1, MAX_RESULTS)));
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
