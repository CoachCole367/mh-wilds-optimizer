const STORAGE_KEY = "mh-wilds-optimizer:owned-charms:v1";
const API_BASE_URL = "https://wilds.mhdb.io";

const el = {
  charmName: document.querySelector("#charm-name"),
  charmRarity: document.querySelector("#charm-rarity"),
  locale: document.querySelector("#locale"),
  slot1: document.querySelector("#slot-1"),
  slot2: document.querySelector("#slot-2"),
  slot3: document.querySelector("#slot-3"),
  skillRows: document.querySelector("#skill-rows"),
  addSkillRow: document.querySelector("#add-skill-row"),
  addCharm: document.querySelector("#add-charm"),
  builderStatus: document.querySelector("#builder-status"),
  exportJson: document.querySelector("#export-json"),
  copyJson: document.querySelector("#copy-json"),
  importJson: document.querySelector("#import-json"),
  clearAll: document.querySelector("#clear-all"),
  jsonIo: document.querySelector("#json-io"),
  librarySummary: document.querySelector("#library-summary"),
  ownedList: document.querySelector("#owned-list"),
};

const state = {
  locale: "en",
  skillOptions: [],
  skillById: {},
  ownedCharms: [],
  nextRowId: 1,
};

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeSlots(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  return [
    clampInt(raw[0], 0, 0, 3),
    clampInt(raw[1], 0, 0, 3),
    clampInt(raw[2], 0, 0, 3),
  ];
}

function buildSkillLookup() {
  const byName = {};
  for (const option of state.skillOptions) {
    byName[normalizeName(option.name)] = option.id;
  }
  return byName;
}

function resolveSkillId(rawKey, skillNameLookup) {
  const numeric = Number.parseInt(String(rawKey), 10);
  if (Number.isFinite(numeric) && numeric > 0 && state.skillById[numeric]) {
    return numeric;
  }
  const normalized = normalizeName(rawKey);
  if (!normalized) {
    return null;
  }
  return skillNameLookup[normalized] || null;
}

function normalizeOwnedCharmList(rawArray) {
  const skillNameLookup = buildSkillLookup();
  const output = [];
  for (let i = 0; i < rawArray.length; i += 1) {
    const entry = rawArray[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const slots = normalizeSlots(entry.slots);
    if (!slots) {
      continue;
    }
    const normalizedSkills = {};
    if (entry.skills && typeof entry.skills === "object") {
      for (const [rawSkillKey, rawLevel] of Object.entries(entry.skills)) {
        const skillId = resolveSkillId(rawSkillKey, skillNameLookup);
        const level = clampInt(rawLevel, 0, 0, 99);
        if (!skillId || level <= 0) {
          continue;
        }
        normalizedSkills[String(skillId)] = level;
      }
    }
    output.push({
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : `Owned Charm #${i + 1}`,
      rarity: Number.isFinite(entry.rarity) ? entry.rarity : undefined,
      skills: normalizedSkills,
      slots,
    });
  }
  return output;
}

function persistOwnedCharms() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ownedCharms));
}

function readOwnedCharms() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeOwnedCharmList(parsed);
  } catch {
    return [];
  }
}

function setStatus(text) {
  el.builderStatus.textContent = text;
}

function skillSelectMarkup(selectedSkillId) {
  const options = state.skillOptions
    .map((skill) => {
      const selected = selectedSkillId === skill.id ? " selected" : "";
      return `<option value="${skill.id}"${selected}>${skill.name} (max ${skill.maxLevel})</option>`;
    })
    .join("");
  return `<select class="skill-select">${options}</select>`;
}

function createSkillRow(selectedSkillId = null, level = 1) {
  const rowId = `row-${state.nextRowId++}`;
  const wrapper = document.createElement("div");
  wrapper.className = "skill-row";
  wrapper.dataset.rowId = rowId;
  wrapper.innerHTML = `
    <label>
      <span>Skill</span>
      ${skillSelectMarkup(selectedSkillId)}
    </label>
    <label>
      <span>Level</span>
      <input class="skill-level" type="number" min="1" max="99" value="${clampInt(level, 1, 1, 99)}" />
    </label>
    <button type="button" class="remove-skill-row">Remove</button>
  `;
  wrapper.querySelector(".remove-skill-row").addEventListener("click", () => {
    wrapper.remove();
  });
  return wrapper;
}

function ensureAtLeastOneSkillRow() {
  if (!el.skillRows.querySelector(".skill-row")) {
    el.skillRows.append(createSkillRow());
  }
}

function refreshSkillRowOptionsPreserveSelection() {
  const rows = Array.from(el.skillRows.querySelectorAll(".skill-row"));
  for (const row of rows) {
    const select = row.querySelector(".skill-select");
    const previous = Number.parseInt(select.value, 10);
    select.innerHTML = state.skillOptions
      .map((skill) => {
        const selected = skill.id === previous ? " selected" : "";
        return `<option value="${skill.id}"${selected}>${skill.name} (max ${skill.maxLevel})</option>`;
      })
      .join("");
    if (!select.value && state.skillOptions.length > 0) {
      select.value = String(state.skillOptions[0].id);
    }
  }
  ensureAtLeastOneSkillRow();
}

function skillNameById(skillId) {
  return state.skillById[skillId]?.name || `Skill #${skillId}`;
}

function renderOwnedList() {
  if (state.ownedCharms.length === 0) {
    el.ownedList.innerHTML = `<p class="muted">No owned charms saved yet.</p>`;
  } else {
    el.ownedList.innerHTML = state.ownedCharms
      .map((charm, index) => {
        const skillParts = Object.entries(charm.skills)
          .map(([rawSkillId, level]) => {
            const skillId = Number(rawSkillId);
            return `${skillNameById(skillId)} +${level}`;
          })
          .join(", ");
        const rarityText = Number.isFinite(charm.rarity) ? `R${charm.rarity}` : "Rarity ?";
        return `<article class="owned-card">
          <div class="owned-head">
            <span class="owned-title">${charm.name}</span>
            <span class="owned-meta">${rarityText} | Slots ${charm.slots.join("-")}</span>
          </div>
          <p class="owned-skills">${skillParts || "No skills (slot-only charm)."}</p>
          <div class="owned-actions">
            <button type="button" data-owned-action="edit" data-owned-index="${index}">Edit</button>
            <button type="button" class="danger" data-owned-action="delete" data-owned-index="${index}">Delete</button>
          </div>
        </article>`;
      })
      .join("");
  }

  const jsonText = JSON.stringify(state.ownedCharms, null, 2);
  if (document.activeElement !== el.jsonIo) {
    el.jsonIo.value = jsonText;
  }
  el.librarySummary.textContent = `${state.ownedCharms.length} owned charms saved to optimizer storage.`;
}

function resetBuilderForm() {
  el.charmName.value = "";
  el.charmRarity.value = "";
  el.slot1.value = "2";
  el.slot2.value = "1";
  el.slot3.value = "0";
  el.skillRows.innerHTML = "";
  el.skillRows.append(createSkillRow());
}

function addCharmFromForm() {
  const slots = [
    clampInt(el.slot1.value, 0, 0, 3),
    clampInt(el.slot2.value, 0, 0, 3),
    clampInt(el.slot3.value, 0, 0, 3),
  ];
  const name = el.charmName.value.trim() || `Owned Charm #${state.ownedCharms.length + 1}`;
  const rarityRaw = el.charmRarity.value.trim();
  const rarity = rarityRaw ? clampInt(rarityRaw, 1, 1, 10) : undefined;

  const skills = {};
  const rows = Array.from(el.skillRows.querySelectorAll(".skill-row"));
  for (const row of rows) {
    const select = row.querySelector(".skill-select");
    const levelInput = row.querySelector(".skill-level");
    const skillId = clampInt(select.value, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxLevel = state.skillById[skillId]?.maxLevel || 99;
    const level = clampInt(levelInput.value, 1, 1, maxLevel);
    if (!skillId || level <= 0) {
      continue;
    }
    const key = String(skillId);
    skills[key] = Math.max(level, skills[key] || 0);
  }

  state.ownedCharms.push({
    name,
    rarity,
    skills,
    slots,
  });
  persistOwnedCharms();
  renderOwnedList();
  resetBuilderForm();
  setStatus(`Added ${name}.`);
}

async function fetchArmorSkills(locale) {
  const projection = encodeURIComponent(
    JSON.stringify({
      id: true,
      name: true,
      kind: true,
      "ranks.level": true,
    }),
  );
  const url = `${API_BASE_URL}/${locale}/skills?p=${projection}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load skills (${response.status})`);
  }
  const allSkills = await response.json();
  const armorSkills = allSkills
    .filter((skill) => String(skill.kind || "").toLowerCase() === "armor")
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      maxLevel: Array.isArray(skill.ranks) ? skill.ranks.reduce((max, rank) => Math.max(max, rank.level || 0), 0) : 7,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  state.skillOptions = armorSkills;
  state.skillById = {};
  for (const skill of armorSkills) {
    state.skillById[skill.id] = skill;
  }
}

function importFromTextarea() {
  try {
    const parsed = JSON.parse(el.jsonIo.value);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON must be an array.");
    }
    state.ownedCharms = normalizeOwnedCharmList(parsed);
    persistOwnedCharms();
    renderOwnedList();
    setStatus(`Imported ${state.ownedCharms.length} charms.`);
  } catch (error) {
    setStatus(`Import failed: ${error instanceof Error ? error.message : "Invalid JSON"}`);
  }
}

function editOwnedCharm(index) {
  const charm = state.ownedCharms[index];
  if (!charm) {
    return;
  }
  state.ownedCharms.splice(index, 1);
  persistOwnedCharms();
  renderOwnedList();

  el.charmName.value = charm.name;
  el.charmRarity.value = Number.isFinite(charm.rarity) ? String(charm.rarity) : "";
  el.slot1.value = String(charm.slots[0] || 0);
  el.slot2.value = String(charm.slots[1] || 0);
  el.slot3.value = String(charm.slots[2] || 0);

  el.skillRows.innerHTML = "";
  const skillEntries = Object.entries(charm.skills);
  if (skillEntries.length === 0) {
    el.skillRows.append(createSkillRow());
  } else {
    for (const [rawSkillId, level] of skillEntries) {
      const skillId = Number.parseInt(rawSkillId, 10);
      el.skillRows.append(createSkillRow(skillId, level));
    }
  }
  setStatus(`Editing ${charm.name}. Save by clicking "Add Charm".`);
}

function wireEvents() {
  el.addSkillRow.addEventListener("click", () => {
    el.skillRows.append(createSkillRow());
  });

  el.addCharm.addEventListener("click", () => {
    addCharmFromForm();
  });

  el.exportJson.addEventListener("click", () => {
    el.jsonIo.value = JSON.stringify(state.ownedCharms, null, 2);
    setStatus("Exported current owned charms to JSON.");
  });

  el.copyJson.addEventListener("click", async () => {
    const text = JSON.stringify(state.ownedCharms, null, 2);
    el.jsonIo.value = text;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied owned charm JSON to clipboard.");
    } catch {
      setStatus("Could not access clipboard. JSON is shown in the text area.");
    }
  });

  el.importJson.addEventListener("click", () => {
    importFromTextarea();
  });

  el.clearAll.addEventListener("click", () => {
    state.ownedCharms = [];
    persistOwnedCharms();
    renderOwnedList();
    setStatus("Cleared all owned charms.");
  });

  el.ownedList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-owned-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.ownedAction;
    const index = clampInt(button.dataset.ownedIndex, -1, -1, 99999);
    if (index < 0) {
      return;
    }
    if (action === "delete") {
      const name = state.ownedCharms[index]?.name || `Charm #${index + 1}`;
      state.ownedCharms.splice(index, 1);
      persistOwnedCharms();
      renderOwnedList();
      setStatus(`Deleted ${name}.`);
      return;
    }
    if (action === "edit") {
      editOwnedCharm(index);
    }
  });

  el.locale.addEventListener("change", async () => {
    state.locale = el.locale.value;
    setStatus("Loading armor skills for selected locale...");
    try {
      await fetchArmorSkills(state.locale);
      refreshSkillRowOptionsPreserveSelection();
      renderOwnedList();
      setStatus(`Loaded ${state.skillOptions.length} armor skills for ${state.locale}.`);
    } catch (error) {
      setStatus(`Skill load failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    state.ownedCharms = readOwnedCharms();
    renderOwnedList();
    setStatus("Detected updates from another tab and reloaded owned charms.");
  });
}

async function init() {
  state.locale = "en";
  el.locale.value = state.locale;
  setStatus("Loading armor skills...");
  try {
    await fetchArmorSkills(state.locale);
    el.skillRows.append(createSkillRow());
    state.ownedCharms = readOwnedCharms();
    renderOwnedList();
    setStatus(`Ready. Loaded ${state.skillOptions.length} armor skills and ${state.ownedCharms.length} owned charms.`);
  } catch (error) {
    setStatus(`Initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

wireEvents();
init().catch(() => undefined);
