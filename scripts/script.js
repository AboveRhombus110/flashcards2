// ---------- Constants ----------

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const SCHEDULE_KEY = "flashcards-schedule-v2";
const CUSTOM_CARDS_KEY = "flashcards-custom-cards-v1";
const CUSTOM_SETS_KEY = "flashcards-custom-sets-v1";
const SET_EDITS_KEY = "flashcards-set-edits-v1";
const DELETED_SETS_KEY = "flashcards-deleted-sets-v1";
const EDITS_KEY = "flashcards-edits-v1";
const DELETED_KEY = "flashcards-deleted-v1";
const RETENTION_KEY = "flashcards-retention-v1";
const SYNC_CONFIG_KEY = "flashcards-sync-config-v1";
const SYNC_META_KEY = "flashcards-sync-meta-v1";
const SYNC_DEBOUNCE_MS = 2500;

// ---------- Data loading ----------

async function loadData() {
  const response = await fetch("./flashcards.json");

  if (!response.ok) {
    throw new Error("Could not load data.");
  }

  return response.json();
}

let flashcardData = null;

// ---------- Custom (user-added) sets ----------
//
// Same approach as custom cards: the app can't write new sets back to
// flashcards.json, so sets created in the app live in localStorage and
// get appended to the base data at load time.

function loadCustomSets() {
  try {
    const raw = localStorage.getItem(CUSTOM_SETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not read custom sets, resetting.", err);
    return [];
  }
}

function saveCustomSets(sets) {
  localStorage.setItem(CUSTOM_SETS_KEY, JSON.stringify(sets));
}

function generateSetId() {
  return "customset-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Appends any locally-stored custom sets onto the freshly loaded data.
function mergeCustomSets(data) {
  const customSets = loadCustomSets();
  return data.concat(customSets);
}

// Creates a new (empty) set: persists it to localStorage and updates
// the in-memory flashcardData immediately.
function addSet(title) {
  const set = { id: generateSetId(), title, description: "", cards: [] };

  const customSets = loadCustomSets();
  customSets.push(set);
  saveCustomSets(customSets);

  flashcardData.push(set);
  markChanged();

  return set;
}

// ---------- Editing sets ----------
//
// Same override pattern as editing cards: a rename is stored keyed by
// set id, separately from the base JSON content, and works the same
// way regardless of whether the set came from flashcards.json or was
// created in the app.

function loadSetEdits() {
  try {
    const raw = localStorage.getItem(SET_EDITS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("Could not read set edits, resetting.", err);
    return {};
  }
}

function saveSetEdits(edits) {
  localStorage.setItem(SET_EDITS_KEY, JSON.stringify(edits));
}

function applySetEdits(data) {
  const edits = loadSetEdits();
  if (!Object.keys(edits).length) return data;

  data.forEach((set) => {
    const edit = edits[set.id];
    if (edit) set.title = edit.title;
  });

  return data;
}

function editSet(setId, title) {
  const edits = loadSetEdits();
  edits[setId] = { title };
  saveSetEdits(edits);

  const set = flashcardData.find((s) => s.id === setId);
  if (set) set.title = title;
  markChanged();
}

// ---------- Deleting sets ----------
//
// Same origin-aware approach as deleting cards: custom sets are removed
// from storage outright, base JSON sets are hidden via an id blocklist.
// Deleting a set also cleans up any custom cards, edits, and schedule
// state that belonged to cards inside it.

function loadDeletedSetIds() {
  try {
    const raw = localStorage.getItem(DELETED_SETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not read deleted set ids, resetting.", err);
    return [];
  }
}

function saveDeletedSetIds(ids) {
  localStorage.setItem(DELETED_SETS_KEY, JSON.stringify(ids));
}

function filterDeletedSets(data) {
  const deleted = new Set(loadDeletedSetIds());
  if (!deleted.size) return data;
  return data.filter((set) => !deleted.has(set.id));
}

function deleteSet(setId) {
  const set = flashcardData.find((s) => s.id === setId);

  const customSets = loadCustomSets();
  const before = customSets.length;
  const remainingCustomSets = customSets.filter((s) => s.id !== setId);
  const wasCustom = remainingCustomSets.length !== before;
  saveCustomSets(remainingCustomSets);

  if (!wasCustom) {
    const deletedIds = loadDeletedSetIds();
    if (!deletedIds.includes(setId)) {
      deletedIds.push(setId);
      saveDeletedSetIds(deletedIds);
    }
  }

  const customCards = loadCustomCards();
  if (customCards[setId]) {
    delete customCards[setId];
    saveCustomCards(customCards);
  }

  const setEdits = loadSetEdits();
  if (setEdits[setId]) {
    delete setEdits[setId];
    saveSetEdits(setEdits);
  }

  if (set) {
    const schedule = loadSchedule();
    const edits = loadEdits();
    let scheduleChanged = false;
    let editsChanged = false;

    set.cards.forEach((card) => {
      if (schedule[card.id]) {
        delete schedule[card.id];
        scheduleChanged = true;
      }
      if (edits[card.id]) {
        delete edits[card.id];
        editsChanged = true;
      }
    });

    if (scheduleChanged) saveSchedule(schedule);
    if (editsChanged) saveEdits(edits);
  }

  flashcardData = flashcardData.filter((s) => s.id !== setId);
  markChanged();
}

// ---------- Custom (user-added) cards ----------
//
// The app is a static site with no server, so it can't write back to
// flashcards.json. New cards you add on-device are stored in localStorage
// and merged into flashcardData in memory each time the app loads.
// Keyed by set id: { [setId]: [ { id, front, back }, ... ] }

function loadCustomCards() {
  try {
    const raw = localStorage.getItem(CUSTOM_CARDS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("Could not read custom cards, resetting.", err);
    return {};
  }
}

function saveCustomCards(customCards) {
  localStorage.setItem(CUSTOM_CARDS_KEY, JSON.stringify(customCards));
}

function generateCardId() {
  return "custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Merges any locally-stored custom cards into the freshly loaded data,
// mutating each set's `cards` array in place.
function mergeCustomCards(data) {
  const customCards = loadCustomCards();

  data.forEach((set) => {
    const extra = customCards[set.id];
    if (extra && extra.length) {
      set.cards = set.cards.concat(extra);
    }
  });

  return data;
}

// Adds a new card to a set: persists it to localStorage and updates the
// in-memory flashcardData so it shows up immediately without a reload.
function addCard(setId, front, back) {
  const card = { id: generateCardId(), front, back };

  const customCards = loadCustomCards();
  if (!customCards[setId]) customCards[setId] = [];
  customCards[setId].push(card);
  saveCustomCards(customCards);

  const set = flashcardData.find((s) => s.id === setId);
  if (set) set.cards.push(card);
  markChanged();

  return card;
}

// ---------- Editing existing cards ----------
//
// Edits are stored as overrides keyed by card id, separately from both
// the base flashcards.json content and any custom cards. This works the
// same way regardless of whether the card originally came from the JSON
// file or was added later through the app.
// { [cardId]: { front, back } }

function loadEdits() {
  try {
    const raw = localStorage.getItem(EDITS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("Could not read edits, resetting.", err);
    return {};
  }
}

function saveEdits(edits) {
  localStorage.setItem(EDITS_KEY, JSON.stringify(edits));
}

// Overlays any stored edits onto the freshly loaded (and custom-merged)
// data, mutating each matching card's front/back in place.
function applyEdits(data) {
  const edits = loadEdits();
  if (!Object.keys(edits).length) return data;

  data.forEach((set) => {
    set.cards.forEach((card) => {
      const edit = edits[card.id];
      if (edit) {
        card.front = edit.front;
        card.back = edit.back;
      }
    });
  });

  return data;
}

// Persists an edit and updates the in-memory flashcardData immediately.
function editCard(cardId, front, back) {
  const edits = loadEdits();
  edits[cardId] = { front, back };
  saveEdits(edits);

  flashcardData.forEach((set) => {
    const card = set.cards.find((c) => c.id === cardId);
    if (card) {
      card.front = front;
      card.back = back;
    }
  });
  markChanged();
}

// ---------- Deleting cards ----------
//
// Cards added through the app (id starts with "custom-") only ever
// lived in localStorage, so deleting them just removes them from that
// store. Cards from the base flashcards.json can't actually be removed
// from that file (same static-site limitation as editing/adding), so
// deletion instead records the id as "hidden" and every card list is
// filtered against that set when data loads.

function loadDeletedIds() {
  try {
    const raw = localStorage.getItem(DELETED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not read deleted ids, resetting.", err);
    return [];
  }
}

function saveDeletedIds(ids) {
  localStorage.setItem(DELETED_KEY, JSON.stringify(ids));
}

function filterDeleted(data) {
  const deleted = new Set(loadDeletedIds());
  if (!deleted.size) return data;

  data.forEach((set) => {
    set.cards = set.cards.filter((card) => !deleted.has(card.id));
  });

  return data;
}

function deleteCard(setId, cardId) {
  const customCards = loadCustomCards();
  let wasCustom = false;

  if (customCards[setId]) {
    const before = customCards[setId].length;
    customCards[setId] = customCards[setId].filter((c) => c.id !== cardId);
    wasCustom = customCards[setId].length !== before;
    saveCustomCards(customCards);
  }

  if (!wasCustom) {
    const deletedIds = loadDeletedIds();
    if (!deletedIds.includes(cardId)) {
      deletedIds.push(cardId);
      saveDeletedIds(deletedIds);
    }
  }

  // Clean up any leftover schedule/edit state so it doesn't linger unused.
  const schedule = loadSchedule();
  if (schedule[cardId]) {
    delete schedule[cardId];
    saveSchedule(schedule);
  }
  const edits = loadEdits();
  if (edits[cardId]) {
    delete edits[cardId];
    saveEdits(edits);
  }

  const set = flashcardData.find((s) => s.id === setId);
  if (set) set.cards = set.cards.filter((c) => c.id !== cardId);
  markChanged();
}

// ---------- Scheduling (spaced repetition) ----------
//
// This is a simplified, FSRS-inspired scheduler — not Anki's exact
// trained algorithm (that's a ~17-parameter model fit to 700M real
// reviews), but the same underlying idea:
//
//   - Difficulty (D, 1-10): how intrinsically hard this card is for you.
//   - Stability (S, days): how many days it takes for your recall
//     probability to decay to a "forgotten" threshold.
//   - Retrievability (R, 0-1): your estimated recall probability for
//     this card *right now*, computed from S and time elapsed using the
//     actual FSRS power-law forgetting curve.
//
// Unlike the old fixed-multiplier version, the interval isn't just
// "previous interval x constant" — it's solved from the forgetting
// curve so that R will have decayed to your desired retention target
// by the next due date. Reviewing a card later than expected but still
// getting it right also grows stability more (you retained it despite
// more forgetting than usual), which mirrors Anki's real behavior.
//
// Each card's state is stored in localStorage, keyed by the card's
// stable "id" from flashcards.json, so editing flashcards.json content
// doesn't wipe your review progress.
//
// state shape: { difficulty, stability, due, reps, lastReview }
// A card with no stored state is brand new and due immediately.

// FSRS's published forgetting curve: R(t, S) = (1 + FACTOR*t/S) ^ DECAY
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;

function loadRetention() {
  const raw = localStorage.getItem(RETENTION_KEY);
  const value = raw ? parseFloat(raw) : 0.9;
  return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.9;
}

function saveRetention(value) {
  localStorage.setItem(RETENTION_KEY, String(value));
}

function loadSchedule() {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("Could not read schedule, resetting.", err);
    return {};
  }
}

function saveSchedule(schedule) {
  localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
}

function getCardState(cardId) {
  const schedule = loadSchedule();
  return schedule[cardId] || null; // null = brand new, never reviewed
}

function isDue(cardId) {
  const state = getCardState(cardId);
  return !state || state.due <= Date.now();
}

function countDue(set) {
  return set.cards.filter((card) => isDue(card.id)).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Retrievability: estimated recall probability right now, given how
// many days have elapsed since the last review and the card's stability.
function retrievability(elapsedDays, stability) {
  return Math.pow(1 + (FSRS_FACTOR * elapsedDays) / stability, FSRS_DECAY);
}

// Inverts the forgetting curve to find the interval (days) at which R
// will have decayed to the target retention.
function intervalForRetention(stability, retention) {
  return (stability / FSRS_FACTOR) * (Math.pow(retention, 1 / FSRS_DECAY) - 1);
}

// Initial stability/difficulty the first time a (new) card is rated.
const INITIAL_STABILITY = { again: 0.4, hard: 1.0, good: 3.0, easy: 6.0 };
const INITIAL_DIFFICULTY = { again: 8, hard: 6, good: 5, easy: 3 };

function nextDifficulty(difficulty, rating) {
  const delta = { again: 1, hard: 0.5, good: 0, easy: -1 }[rating];
  let next = difficulty + delta;
  next += 0.1 * (5 - next); // gentle mean reversion toward the middle
  return clamp(next, 1, 10);
}

// Stability growth after a successful recall (Hard/Good/Easy).
// Easier cards (low difficulty) grow faster; cards recalled after
// more forgetting than expected (low R) get a bigger stability boost.
function nextStabilitySuccess(stability, difficulty, rating, R) {
  const base = { hard: 1.2, good: 2.0, easy: 3.0 }[rating];
  const difficultyFactor = 1 + (5 - difficulty) * 0.1;
  const overdueBonus = 1 + (1 - R) * 0.5;
  return Math.max(stability * base * difficultyFactor * overdueBonus, 0.1);
}

// Stability after a lapse (Again): drops sharply, more so for
// already-difficult cards.
function nextStabilityLapse(stability, difficulty) {
  const retained = 1 - (difficulty - 1) / 18; // harder cards retain less
  return Math.max(stability * 0.2 * retained, 0.2);
}

function computeNextState(prev, rating, retention, now) {
  let difficulty;
  let stability;

  if (!prev) {
    difficulty = INITIAL_DIFFICULTY[rating];
    stability = INITIAL_STABILITY[rating];
  } else {
    const elapsedDays = Math.max((now - prev.lastReview) / DAY, 0);
    const R = clamp(retrievability(elapsedDays, prev.stability), 0.01, 1);

    difficulty = nextDifficulty(prev.difficulty, rating);
    stability =
      rating === "again"
        ? nextStabilityLapse(prev.stability, prev.difficulty)
        : nextStabilitySuccess(prev.stability, prev.difficulty, rating, R);
  }

  const due =
    rating === "again"
      ? now + 10 * MINUTE
      : now + intervalForRetention(stability, retention) * DAY;

  return {
    difficulty,
    stability,
    due,
    reps: prev ? prev.reps + 1 : 1,
    lastReview: now,
  };
}

function rateCard(cardId, rating) {
  const schedule = loadSchedule();
  const prev = schedule[cardId] || null;
  const now = Date.now();
  const retention = loadRetention();

  schedule[cardId] = computeNextState(prev, rating, retention, now);
  saveSchedule(schedule);
  markChanged();
}

// Computes what each rating button would schedule, without saving —
// used to show a preview label like Anki does ("Good" -> "3d").
function previewIntervals(cardId) {
  const prev = getCardState(cardId);
  const now = Date.now();
  const retention = loadRetention();
  const preview = {};

  ["again", "hard", "good", "easy"].forEach((rating) => {
    const next = computeNextState(prev, rating, retention, now);
    preview[rating] = formatInterval((next.due - now) / DAY);
  });

  return preview;
}

function formatInterval(days) {
  if (days < 1) return Math.round(days * 24 * 60) + "m";
  if (days < 30) return Math.round(days) + "d";
  if (days < 365) return Math.round(days / 30) + "mo";
  return (days / 365).toFixed(1) + "y";
}

// ---------- Math rendering (KaTeX) ----------
//
// Card front/back text can include LaTeX: $...$ or \(...\) for inline
// math, $$...$$ or \[...\] for display math. This walks a DOM element
// and typesets any math it finds. Loaded via CDN in site.html; if the
// CDN hasn't loaded yet (or is unavailable), this quietly no-ops and
// the raw LaTeX text is still shown.
function renderMath(container) {
  if (window.renderMathInElement) {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }
}

// ---------- Rendering: list of sets ----------

function createSetRow(set) {
  const li = document.createElement("li");
  li.className = "set-item";

  const info = document.createElement("div");
  info.className = "set-item-info";

  const title = document.createElement("h3");
  title.textContent = set.title;

  const due = countDue(set);
  const badge = document.createElement("span");
  badge.className = "due-badge" + (due === 0 ? " due-none" : "");
  badge.textContent = due === 0 ? "Nothing due" : due + " due";

  info.appendChild(title);
  info.appendChild(badge);
  li.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "set-item-actions";

  const studyAllBtn = document.createElement("button");
  studyAllBtn.className = "manage-btn";
  studyAllBtn.textContent = "Study all";
  studyAllBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startReviewSession(set, "all");
  });
  actions.appendChild(studyAllBtn);

  const manageBtn = document.createElement("button");
  manageBtn.className = "manage-btn";
  manageBtn.textContent = "Manage cards";
  manageBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    renderManageCards(set);
  });
  actions.appendChild(manageBtn);

  li.appendChild(actions);

  li.addEventListener("click", () => {
    startReviewSession(set, "due");
  });

  return li;
}

function renderAllSets() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const header = document.createElement("div");
  header.className = "sets-header";

  const newSetBtn = document.createElement("button");
  newSetBtn.className = "settings-btn";
  newSetBtn.textContent = "+ New Set";
  newSetBtn.addEventListener("click", renderAddSetForm);
  header.appendChild(newSetBtn);

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "settings-btn";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.textContent = "⚙ Settings";
  settingsBtn.addEventListener("click", renderSettings);
  header.appendChild(settingsBtn);

  app.appendChild(header);

  const list = document.createElement("ul");
  list.className = "sets-list";

  flashcardData.forEach((set) => {
    list.appendChild(createSetRow(set));
  });

  app.appendChild(list);

  const fab = document.createElement("button");
  fab.className = "fab-add-btn";
  fab.setAttribute("aria-label", "Add card");
  fab.textContent = "+";
  fab.addEventListener("click", renderAddCardForm);
  app.appendChild(fab);
}

// ---------- Rendering: settings ----------

function renderSettings() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "add-card-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Settings";
  headerRow.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back to sets";
  backBtn.addEventListener("click", renderAllSets);
  headerRow.appendChild(backBtn);

  section.appendChild(headerRow);

  const form = document.createElement("form");
  form.className = "add-card-form";

  const label = document.createElement("label");
  label.textContent = "Desired retention";

  const currentRetention = loadRetention();

  const row = document.createElement("div");
  row.className = "retention-row";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0.70";
  slider.max = "0.98";
  slider.step = "0.01";
  slider.value = String(currentRetention);

  const valueLabel = document.createElement("span");
  valueLabel.className = "retention-value";
  valueLabel.textContent = Math.round(currentRetention * 100) + "%";

  slider.addEventListener("input", () => {
    valueLabel.textContent = Math.round(slider.value * 100) + "%";
  });

  row.appendChild(slider);
  row.appendChild(valueLabel);
  label.appendChild(row);
  form.appendChild(label);

  const hint = document.createElement("p");
  hint.className = "latex-hint";
  hint.textContent =
    "How often you want to successfully recall a card when it comes up. Higher = more frequent reviews but better retention. Lower = fewer reviews but you'll forget more. Anki's default is 90%.";
  form.appendChild(hint);

  const statusMsg = document.createElement("p");
  statusMsg.className = "form-status";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "save-card-btn";
  saveBtn.textContent = "Save";
  form.appendChild(saveBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveRetention(parseFloat(slider.value));
    markChanged();
    statusMsg.textContent = "Saved. This affects intervals from your next review onward.";
  });

  section.appendChild(form);
  section.appendChild(statusMsg);

  // ---- Cloud sync sub-section ----

  const syncHeading = document.createElement("h2");
  syncHeading.className = "section-title";
  syncHeading.style.marginTop = "2rem";
  syncHeading.textContent = "Cloud Sync (GitHub)";
  section.appendChild(syncHeading);

  const syncHint = document.createElement("p");
  syncHint.className = "latex-hint";
  syncHint.textContent =
    "Syncs your cards, edits, and review progress to a JSON file in a GitHub repo, so your other device(s) can pick up the same data. Use a fine-grained personal access token scoped to just this repo's Contents permission (read & write).";
  section.appendChild(syncHint);

  const syncConfig = loadSyncConfig();
  const syncForm = document.createElement("form");
  syncForm.className = "add-card-form";

  function field(labelText, value, placeholder, inputType) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = inputType || "text";
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    label.appendChild(input);
    syncForm.appendChild(label);
    return input;
  }

  const ownerInput = field("GitHub username / org", syncConfig.owner, "e.g. alex");
  const repoInput = field("Repository name", syncConfig.repo, "e.g. flashcards-app");
  const branchInput = field("Branch", syncConfig.branch || "main", "main");
  const pathInput = field(
    "Data file path",
    syncConfig.path || "data/flashcards-state.json",
    "data/flashcards-state.json"
  );
  const tokenInput = field(
    "Personal access token",
    syncConfig.token,
    "fine-grained token, Contents: read & write",
    "password"
  );

  const syncStatusMsg = document.createElement("p");
  syncStatusMsg.className = "form-status";

  const syncBtnRow = document.createElement("div");
  syncBtnRow.className = "review-header-actions";
  syncBtnRow.style.justifyContent = "flex-start";

  const saveSyncBtn = document.createElement("button");
  saveSyncBtn.type = "submit";
  saveSyncBtn.className = "save-card-btn";
  saveSyncBtn.textContent = "Save Sync Settings";
  syncBtnRow.appendChild(saveSyncBtn);

  const syncNowBtn = document.createElement("button");
  syncNowBtn.type = "button";
  syncNowBtn.className = "manage-btn";
  syncNowBtn.textContent = "Sync Now";
  syncNowBtn.addEventListener("click", () => {
    if (!hasSyncConfig()) {
      syncStatusMsg.textContent = "Save sync settings first.";
      return;
    }
    syncNow();
  });
  syncBtnRow.appendChild(syncNowBtn);

  syncForm.appendChild(syncBtnRow);
  syncForm.appendChild(syncStatusMsg);

  onSyncStatus((message) => {
    syncStatusMsg.textContent = message;
  });

  syncForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const owner = ownerInput.value.trim();
    const repo = repoInput.value.trim();
    const branch = branchInput.value.trim() || "main";
    const path = pathInput.value.trim() || "data/flashcards-state.json";
    const token = tokenInput.value.trim();

    if (!owner || !repo || !token) {
      syncStatusMsg.textContent = "Username, repository, and token are all required.";
      return;
    }

    saveSyncConfig({ owner, repo, branch, path, token });
    syncStatusMsg.textContent = "Saved. Syncing…";
    syncNow();
  });

  section.appendChild(syncForm);

  app.appendChild(section);
}

// ---------- Rendering: add set form ----------

function renderAddSetForm() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "add-card-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "New Set";
  headerRow.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back to sets";
  backBtn.addEventListener("click", renderAllSets);
  headerRow.appendChild(backBtn);

  section.appendChild(headerRow);

  const form = document.createElement("form");
  form.className = "add-card-form";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Set name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.required = true;
  nameInput.placeholder = "e.g. Vector Calculus";
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const statusMsg = document.createElement("p");
  statusMsg.className = "form-status";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "save-card-btn";
  saveBtn.textContent = "Create Set";
  form.appendChild(saveBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const name = nameInput.value.trim();
    if (!name) {
      statusMsg.textContent = "Please enter a name for the set.";
      return;
    }

    addSet(name);
    nameInput.value = "";
    statusMsg.textContent = "Set created! Use the + button to add cards to it.";
    nameInput.focus();
  });

  section.appendChild(form);
  section.appendChild(statusMsg);

  app.appendChild(section);
}

// ---------- Rendering: edit set form ----------

function renderEditSetForm(set) {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "add-card-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Rename Set";
  headerRow.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    renderManageCards(set);
  });
  headerRow.appendChild(backBtn);

  section.appendChild(headerRow);

  const form = document.createElement("form");
  form.className = "add-card-form";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Set name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.required = true;
  nameInput.value = set.title;
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const statusMsg = document.createElement("p");
  statusMsg.className = "form-status";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "save-card-btn";
  saveBtn.textContent = "Save";
  form.appendChild(saveBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const name = nameInput.value.trim();
    if (!name) {
      statusMsg.textContent = "Please enter a name for the set.";
      return;
    }

    editSet(set.id, name);
    renderManageCards(set);
  });

  section.appendChild(form);
  section.appendChild(statusMsg);

  app.appendChild(section);
}

// ---------- Rendering: add card form ----------

function renderAddCardForm() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "add-card-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Add Card";
  headerRow.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back to sets";
  backBtn.addEventListener("click", renderAllSets);
  headerRow.appendChild(backBtn);

  section.appendChild(headerRow);

  const form = document.createElement("form");
  form.className = "add-card-form";

  // Set selector
  const setLabel = document.createElement("label");
  setLabel.textContent = "Set";
  const setSelect = document.createElement("select");
  flashcardData.forEach((set) => {
    const opt = document.createElement("option");
    opt.value = set.id;
    opt.textContent = set.title;
    setSelect.appendChild(opt);
  });
  setLabel.appendChild(setSelect);
  form.appendChild(setLabel);

  // Front
  const frontLabel = document.createElement("label");
  frontLabel.textContent = "Front";
  const frontInput = document.createElement("textarea");
  frontInput.rows = 3;
  frontInput.required = true;
  frontInput.placeholder = "e.g. Solve $x^2 - 5x + 6 = 0$";
  frontLabel.appendChild(frontInput);
  form.appendChild(frontLabel);

  // Back
  const backLabel = document.createElement("label");
  backLabel.textContent = "Back";
  const backInput = document.createElement("textarea");
  backInput.rows = 3;
  backInput.required = true;
  backInput.placeholder = "e.g. $x = 2$ or $x = 3$";
  backLabel.appendChild(backInput);
  form.appendChild(backLabel);

  const latexHint = document.createElement("p");
  latexHint.className = "latex-hint";
  latexHint.textContent =
    "LaTeX supported: $...$ for inline math, $$...$$ for a display equation.";
  form.appendChild(latexHint);

  const statusMsg = document.createElement("p");
  statusMsg.className = "form-status";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "save-card-btn";
  saveBtn.textContent = "Save Card";
  form.appendChild(saveBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const front = frontInput.value.trim();
    const back = backInput.value.trim();

    if (!front || !back) {
      statusMsg.textContent = "Please fill in both sides of the card.";
      return;
    }

    addCard(setSelect.value, front, back);

    frontInput.value = "";
    backInput.value = "";
    statusMsg.textContent = "Card added! Add another or head back.";
    frontInput.focus();
  });

  section.appendChild(form);
  section.appendChild(statusMsg);

  app.appendChild(section);
}

// ---------- Rendering: manage / edit cards ----------

function truncate(text, max) {
  return text.length > max ? text.slice(0, max).trim() + "…" : text;
}

function renderManageCards(set) {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "manage-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Manage: " + set.title;
  headerRow.appendChild(title);

  const headerActions = document.createElement("div");
  headerActions.className = "review-header-actions";

  const renameBtn = document.createElement("button");
  renameBtn.className = "manage-btn";
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("click", () => {
    renderEditSetForm(set);
  });
  headerActions.appendChild(renameBtn);

  const deleteSetBtn = document.createElement("button");
  deleteSetBtn.className = "manage-btn delete-btn";
  deleteSetBtn.textContent = "Delete Set";
  deleteSetBtn.addEventListener("click", () => {
    const ok = confirm(
      'Delete the whole set "' +
        set.title +
        '" and all ' +
        set.cards.length +
        " card(s) in it? This can't be undone."
    );
    if (!ok) return;
    deleteSet(set.id);
    renderAllSets();
  });
  headerActions.appendChild(deleteSetBtn);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back to sets";
  backBtn.addEventListener("click", renderAllSets);
  headerActions.appendChild(backBtn);

  headerRow.appendChild(headerActions);

  section.appendChild(headerRow);

  if (set.cards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "This set has no cards yet.";
    section.appendChild(empty);
    app.appendChild(section);
    return;
  }

  const list = document.createElement("ul");
  list.className = "manage-list";

  set.cards.forEach((card) => {
    const li = document.createElement("li");
    li.className = "manage-item";

    const preview = document.createElement("span");
    preview.className = "manage-item-front";
    preview.textContent = truncate(card.front, 60);
    li.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "manage-item-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "manage-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      renderEditCardForm(set, card);
    });
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "manage-btn delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      const ok = confirm(
        "Delete this card? This can't be undone:\n\n" + truncate(card.front, 80)
      );
      if (!ok) return;
      deleteCard(set.id, card.id);
      renderManageCards(set);
    });
    actions.appendChild(deleteBtn);

    li.appendChild(actions);

    list.appendChild(li);
  });

  section.appendChild(list);
  app.appendChild(section);
}

function renderEditCardForm(set, card) {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const section = document.createElement("section");
  section.className = "add-card-section";

  const headerRow = document.createElement("div");
  headerRow.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Edit Card";
  headerRow.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => {
    renderManageCards(set);
  });
  headerRow.appendChild(backBtn);

  section.appendChild(headerRow);

  const form = document.createElement("form");
  form.className = "add-card-form";

  // Front
  const frontLabel = document.createElement("label");
  frontLabel.textContent = "Front";
  const frontInput = document.createElement("textarea");
  frontInput.rows = 3;
  frontInput.required = true;
  frontInput.value = card.front;
  frontLabel.appendChild(frontInput);
  form.appendChild(frontLabel);

  // Back
  const backLabel = document.createElement("label");
  backLabel.textContent = "Back";
  const backInput = document.createElement("textarea");
  backInput.rows = 3;
  backInput.required = true;
  backInput.value = card.back;
  backLabel.appendChild(backInput);
  form.appendChild(backLabel);

  const latexHint = document.createElement("p");
  latexHint.className = "latex-hint";
  latexHint.textContent =
    "LaTeX supported: $...$ for inline math, $$...$$ for a display equation.";
  form.appendChild(latexHint);

  const statusMsg = document.createElement("p");
  statusMsg.className = "form-status";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "save-card-btn";
  saveBtn.textContent = "Save Changes";
  form.appendChild(saveBtn);

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const front = frontInput.value.trim();
    const back = backInput.value.trim();

    if (!front || !back) {
      statusMsg.textContent = "Please fill in both sides of the card.";
      return;
    }

    editCard(card.id, front, back);
    renderManageCards(set);
  });

  section.appendChild(form);
  section.appendChild(statusMsg);

  app.appendChild(section);
}

// ---------- Rendering: one-card-at-a-time review session ----------

function startReviewSession(set, mode) {
  const queue = mode === "all" ? set.cards.slice() : set.cards.filter((card) => isDue(card.id));
  renderReviewSession(set, queue, 0, queue.length, mode);
}

function renderReviewSession(set, queue, index, totalDue, mode) {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const session = document.createElement("section");
  session.className = "review-session";

  const header = document.createElement("div");
  header.className = "review-header";

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = set.title + (mode === "all" ? " — Study All" : "");
  header.appendChild(title);

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.textContent = "Back to sets";
  backBtn.addEventListener("click", renderAllSets);
  header.appendChild(backBtn);

  session.appendChild(header);

  if (queue.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      mode === "all"
        ? "This set has no cards yet."
        : "No cards due for review right now. Nice work!";
    session.appendChild(empty);
    app.appendChild(session);
    return;
  }

  if (index >= queue.length) {
    const done = document.createElement("p");
    done.className = "empty-state";
    done.textContent = "Session complete! You reviewed " + totalDue + " card(s).";
    session.appendChild(done);
    app.appendChild(session);
    return;
  }

  const progress = document.createElement("p");
  progress.className = "progress-counter";
  progress.textContent = "Card " + (index + 1) + " of " + totalDue;
  session.appendChild(progress);

  const card = queue[index];

  const cardEl = document.createElement("article");
  cardEl.className = "card";

  const inner = document.createElement("div");
  inner.className = "card-inner";
  inner.innerHTML =
    '<p class="card-face card-front">' +
    card.front +
    '</p><p class="card-face card-back">' +
    card.back +
    "</p>";

  const ratingBar = document.createElement("div");
  ratingBar.className = "rating-bar";
  ratingBar.style.display = "none";

  const ratings = [
    { key: "again", label: "Again" },
    { key: "hard", label: "Hard" },
    { key: "good", label: "Good" },
    { key: "easy", label: "Easy" },
  ];

  const preview = previewIntervals(card.id);

  ratings.forEach((r) => {
    const btn = document.createElement("button");
    btn.className = "rating-btn rating-" + r.key;
    btn.innerHTML =
      r.label + '<span class="rating-interval">' + preview[r.key] + "</span>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      rateCard(card.id, r.key);
      renderReviewSession(set, queue, index + 1, totalDue, mode);
    });
    ratingBar.appendChild(btn);
  });

  inner.addEventListener("click", () => {
    const flipped = cardEl.classList.toggle("flipped");
    ratingBar.style.display = flipped ? "flex" : "none";
  });

  cardEl.appendChild(inner);
  session.appendChild(cardEl);
  session.appendChild(ratingBar);

  app.appendChild(session);

  renderMath(inner);
}

// ---------- Cloud sync (GitHub) ----------
//
// This app has no server of its own, so "sync between devices" means
// using something both devices can reach: a JSON file in a GitHub repo,
// read and written directly from the browser via GitHub's REST API.
//
// Everything that lives in localStorage (schedule, custom cards/sets,
// edits, deletions, retention) gets bundled into one JSON blob and
// pushed to that file. Conflict handling is last-write-wins, compared
// by an `updatedAt` timestamp: whichever side has the more recent
// change wins and overwrites the other. This is fine for one person
// using the app from a couple of their own devices; it is NOT designed
// for simultaneous multi-user editing.
//
// The GitHub token is stored in localStorage in plain text, same as
// everything else here — treat it like a password. Use a fine-grained
// personal access token scoped to just this one repo's Contents
// read/write permission, not a classic all-access token.

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("Could not read sync config, resetting.", err);
    return {};
  }
}

function saveSyncConfig(config) {
  localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
}

function hasSyncConfig() {
  const c = loadSyncConfig();
  return Boolean(c.token && c.owner && c.repo && c.path);
}

function loadSyncMeta() {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : { lastLocalChangeAt: 0, lastSyncedUpdatedAt: 0, sha: null };
  } catch (err) {
    return { lastLocalChangeAt: 0, lastSyncedUpdatedAt: 0, sha: null };
  }
}

function saveSyncMeta(meta) {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
}

// Bundles every piece of mutable state into one object to push to GitHub.
function gatherState(updatedAt) {
  return {
    updatedAt,
    schedule: loadSchedule(),
    customCards: loadCustomCards(),
    customSets: loadCustomSets(),
    edits: loadEdits(),
    setEdits: loadSetEdits(),
    deletedIds: loadDeletedIds(),
    deletedSetIds: loadDeletedSetIds(),
    retention: loadRetention(),
  };
}

// Writes a fetched state blob back into localStorage.
function applyState(state) {
  saveSchedule(state.schedule || {});
  saveCustomCards(state.customCards || {});
  saveCustomSets(state.customSets || []);
  saveEdits(state.edits || {});
  saveSetEdits(state.setEdits || {});
  saveDeletedIds(state.deletedIds || []);
  saveDeletedSetIds(state.deletedSetIds || []);
  saveRetention(state.retention || 0.9);
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

// Fetches the current state file from GitHub. Returns null if the file
// doesn't exist yet (first sync ever).
async function githubGetFile(config) {
  const url =
    "https://api.github.com/repos/" +
    config.owner +
    "/" +
    config.repo +
    "/contents/" +
    config.path +
    "?ref=" +
    (config.branch || "main");

  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + config.token,
      Accept: "application/vnd.github+json",
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error("GitHub GET failed (" + res.status + ")");

  const json = await res.json();
  const content = base64ToUtf8(json.content.replace(/\n/g, ""));
  return { sha: json.sha, data: JSON.parse(content) };
}

// Writes the state blob to GitHub, creating the file if it didn't exist.
async function githubPutFile(config, state, sha) {
  const url =
    "https://api.github.com/repos/" +
    config.owner +
    "/" +
    config.repo +
    "/contents/" +
    config.path;

  const body = {
    message: "Sync flashcards data — " + new Date().toISOString(),
    content: utf8ToBase64(JSON.stringify(state, null, 2)),
    branch: config.branch || "main",
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + config.token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error("GitHub PUT failed (" + res.status + "): " + (errBody.message || ""));
  }

  return res.json();
}

let syncDebounceHandle = null;
let syncStatusListeners = [];

function onSyncStatus(fn) {
  syncStatusListeners.push(fn);
}

function setSyncStatus(message) {
  syncStatusListeners.forEach((fn) => fn(message));
}

// Called by every mutating action (add/edit/delete card or set, rate a
// card, change retention). Records that local data changed, and
// schedules a debounced push so rapid edits get batched into one sync.
function markChanged() {
  const meta = loadSyncMeta();
  meta.lastLocalChangeAt = Date.now();
  saveSyncMeta(meta);

  if (!hasSyncConfig()) return;

  clearTimeout(syncDebounceHandle);
  syncDebounceHandle = setTimeout(() => {
    syncNow();
  }, SYNC_DEBOUNCE_MS);
}

// Pulls or pushes against GitHub, whichever side is newer. Safe to call
// often — it no-ops if sync isn't configured or the device is offline.
async function syncNow() {
  if (!hasSyncConfig()) return;
  if (!navigator.onLine) {
    setSyncStatus("Offline — will sync once connected.");
    return;
  }

  const config = loadSyncConfig();
  const meta = loadSyncMeta();

  setSyncStatus("Syncing…");

  try {
    const remote = await githubGetFile(config);

    if (remote && remote.data && remote.data.updatedAt > meta.lastLocalChangeAt) {
      // The cloud copy is newer than anything we've changed locally
      // (e.g. your other device synced more recently) — pull it in.
      applyState(remote.data);
      meta.sha = remote.sha;
      meta.lastLocalChangeAt = remote.data.updatedAt;
      meta.lastSyncedUpdatedAt = remote.data.updatedAt;
      saveSyncMeta(meta);

      rebuildFlashcardData();
      renderAllSets();

      setSyncStatus("Pulled newer data from GitHub just now.");
    } else {
      // Local data is the same age or newer — push it up.
      const updatedAt = meta.lastLocalChangeAt || Date.now();
      const state = gatherState(updatedAt);
      const sha = remote ? remote.sha : meta.sha || undefined;

      const result = await githubPutFile(config, state, sha);

      meta.sha = result.content.sha;
      meta.lastSyncedUpdatedAt = updatedAt;
      saveSyncMeta(meta);

      setSyncStatus("Synced to GitHub just now.");
    }
  } catch (err) {
    console.error("Sync failed", err);
    setSyncStatus("Sync failed: " + err.message);
  }
}

// ---------- Boot ----------

// The raw, unmerged content from flashcards.json, cached so sync pulls
// can rebuild flashcardData from scratch without re-fetching the file.
let baseFlashcardData = null;

function rebuildFlashcardData() {
  // Deep-clone so repeated rebuilds don't compound mutations onto the
  // cached base copy.
  const clone = JSON.parse(JSON.stringify(baseFlashcardData));
  flashcardData = filterDeleted(
    applyEdits(mergeCustomCards(filterDeletedSets(applySetEdits(mergeCustomSets(clone)))))
  );
}

async function renderContent() {
  try {
    baseFlashcardData = await loadData();

    if (hasSyncConfig() && navigator.onLine) {
      // Best-effort: pull/push before the first render so the app opens
      // already showing the latest synced state. Sync failures here are
      // non-fatal — renderContent still proceeds on local data.
      await syncNow().catch(() => {});
    }

    rebuildFlashcardData();
    renderAllSets();

    window.addEventListener("online", () => {
      syncNow();
    });
  } catch (err) {
    console.error(err);

    document.getElementById("app").textContent =
      "Could not load flashcards data.";
  }
}

renderContent();