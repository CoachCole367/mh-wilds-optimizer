import {
  readInventory,
  saveInventory,
  normalizeInventory,
  restoreInventory,
  STORAGE_KEY,
} from "../charm-inventory.js";
const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let inventory = readInventory(),
  skills = [],
  editing = null;
function status(text) {
  $("builder-status").textContent = text;
}
function options(id) {
  const known = skills.some((s) => s.id === id);
  return (
    (!known && id
      ? `<option value="${id}">Unknown skill #${id} (preserved)</option>`
      : "") +
    skills
      .map(
        (s) =>
          `<option value="${s.id}" ${s.id === id ? "selected" : ""}>${esc(s.name)} (${esc(s.kind)}, max ${s.max})</option>`,
      )
      .join("")
  );
}
function row(id, level = 1) {
  const div = document.createElement("div");
  div.className = "skill-row";
  div.innerHTML = `<label>Skill<select class="skill-select">${options(id)}</select></label><label>Level<input class="skill-level" type="number" min="1" max="99" value="${level}"/></label><button type="button" class="remove-skill-row">Remove</button>`;
  div.querySelector("button").onclick = () => div.remove();
  $("skill-rows").append(div);
}
function reset() {
  editing = null;
  $("charm-name").value = "";
  $("charm-rarity").value = "";
  [1, 2, 3].forEach((i) => ($("slot-" + i).value = "0"));
  $("weapon-slot").value = "0";
  $("skill-rows").innerHTML = "";
  row();
  $("add-charm").textContent = "Add Talisman";
  $("cancel-edit").hidden = true;
}
function render() {
  $("owned-list").innerHTML =
    inventory
      .map(
        (c, i) =>
          `<article class="owned-card"><strong>${esc(c.name)}</strong><p>Armor slots: ${c.slots.join("-")} · weapon slot: ${c.weaponSlot ?? 0}</p><p>${
            Object.entries(c.skills)
              .map(
                ([id, n]) =>
                  `${esc(skills.find((s) => s.id === Number(id))?.name ?? `Skill #${id}`)} +${n}`,
              )
              .join(", ") || "Slot-only talisman"
          }</p><button data-edit="${i}">Edit</button><button data-delete="${i}">Delete (backup retained)</button></article>`,
      )
      .join("") || "<p>No talismans saved yet.</p>";
  $("library-summary").textContent =
    `${inventory.length} talismans saved on this device. Weapon skills and slots are preserved.`;
}
function commit(next, message) {
  if (!saveInventory(next)) {
    status(
      "Could not save: browser storage is unavailable or full. The previous library is preserved.",
    );
    return false;
  }
  inventory = next;
  render();
  status(message);
  return true;
}
$("add-skill-row").onclick = () => row();
$("cancel-edit").onclick = () => {
  reset();
  status("Edit cancelled. Original talisman was preserved.");
};
$("add-charm").onclick = () => {
  try {
    const points = {};
    for (const r of $("skill-rows").querySelectorAll(".skill-row")) {
      const id = Number(r.querySelector("select").value),
        n = Number(r.querySelector("input").value);
      if (
        !id ||
        !Number.isInteger(n) ||
        n < 1 ||
        n > (skills.find((s) => s.id === id)?.max ?? 99)
      )
        throw Error("Choose a valid skill level.");
      points[id] = Math.max(points[id] ?? 0, n);
    }
    const original = editing === null ? {} : inventory[editing];
    const charm = normalizeInventory(
      [
        {
          ...original,
          name:
            $("charm-name").value || `Owned Talisman ${inventory.length + 1}`,
          rarity: Number($("charm-rarity").value) || undefined,
          skills: points,
          slots: [1, 2, 3].map((i) => Number($("slot-" + i).value)),
          weaponSlot: Number($("weapon-slot").value),
        },
      ],
      skills,
    )[0];
    const next = inventory.slice();
    if (editing === null) next.push(charm);
    else next[editing] = charm;
    if (commit(next, `Saved ${charm.name}.`)) reset();
  } catch (e) {
    status(e.message);
  }
};
$("owned-list").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.delete !== undefined) {
    const i = Number(b.dataset.delete);
    if (
      commit(
        inventory.filter((_, n) => n !== i),
        "Talisman deleted. Restore previous inventory to undo.",
      )
    )
      reset();
    return;
  }
  if (b.dataset.edit === undefined) return;
  editing = Number(b.dataset.edit);
  const c = inventory[editing];
  $("charm-name").value = c.name;
  $("charm-rarity").value = c.rarity ?? "";
  [1, 2, 3].forEach((i) => ($("slot-" + i).value = c.slots[i - 1]));
  $("weapon-slot").value = c.weaponSlot ?? 0;
  $("skill-rows").innerHTML = "";
  Object.entries(c.skills).forEach(([id, n]) => row(Number(id), n));
  $("add-charm").textContent = "Save Changes";
  $("cancel-edit").hidden = false;
  status(`Editing ${c.name}. Original remains saved until Save Changes.`);
  $("charm-name").focus();
};
$("import-json").onclick = () => {
  try {
    const imported = normalizeInventory(JSON.parse($("json-io").value), skills);
    const next =
      $("import-mode").value === "merge"
        ? [...inventory, ...imported]
        : imported;
    if (
      commit(
        next,
        `Imported ${imported.length} talismans. Previous inventory backed up.`,
      )
    )
      reset();
  } catch (e) {
    status(e.message);
  }
};
$("export-json").onclick = () => {
  const text = JSON.stringify(inventory, null, 2);
  $("json-io").value = text;
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "mh-wilds-talismans.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("copy-json").onclick = async () => {
  const text = JSON.stringify(inventory, null, 2);
  $("json-io").value = text;
  try {
    await navigator.clipboard.writeText(text);
    status("Inventory JSON copied.");
  } catch {
    status("Clipboard unavailable; copy the JSON below.");
  }
};
$("clear-all").onclick = () => {
  if (commit([], "Library cleared. Restore previous inventory to undo."))
    reset();
};
$("restore-backup").onclick = () => {
  try {
    inventory = restoreInventory();
    render();
    reset();
    status("Previous library restored.");
  } catch (e) {
    status(e.message);
  }
};
async function loadSkills() {
  try {
    status("Loading skills…");
    const response = await fetch(
      `https://wilds.mhdb.io/${$("locale").value}/skills`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw Error(`Skill load failed (${response.status})`);
    skills = (await response.json())
      .filter((s) => ["armor", "weapon"].includes(s.kind))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        max: Math.max(1, ...s.ranks.map((r) => r.level)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    render();
    if (editing === null) reset();
    status(
      "Ready. Enter the talisman exactly as it appears in game. Legal roll combinations are not automatically verified.",
    );
  } catch (e) {
    render();
    status(
      e.message +
        ". Your inventory remains saved; retry by changing the language.",
    );
  }
}
$("locale").onchange = () => void loadSkills();
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    inventory = readInventory();
    render();
    reset();
    status("Library updated in another tab.");
  }
});
render();
void loadSkills();
