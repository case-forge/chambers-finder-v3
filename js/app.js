"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
// PREFS_KEY kept identical to v3/v4 so existing user prefs carry over seamlessly
const PREFS_KEY    = "cf3_prefs";
const CONTACTED_KEY = "cf8_contacted";
const ACTIVITY_KEY  = "cf9_activity";
// Radii populated from finder-data.json after load (travelRadiusOptions + default)
let RADII        = [20, 35, 50];
let RADIUS_LABELS = ["20 mi", "35 mi", "50 mi"];
const MAX_SEARCH_RESULTS_PER_GROUP = 8;
const BALANCED_SEARCH_RESULTS_PER_GROUP = 6;
// ─── Application state ────────────────────────────────────────────────────────
const state = {
  data:            null,   // parsed finder-data.json
  searchResults:   [],     // current dropdown entries
  view:            "none", // "none" | "court" | "chamber" | browse views
  selectedCourt:   null,
  selectedChamber: null,
  fromCourt:       null,   // court context when drilling into a chamber
  radiusMiles:     35,     // active radius; null = unlimited
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function icon(name, extraClass = "") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `<span class="material-symbols-outlined${cls}" aria-hidden="true">${escapeHtml(name)}</span>`;
}

/** Haversine great-circle distance in statute miles */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── Preferences (localStorage) ───────────────────────────────────────────────
function normalizePrefs(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = {};
  Object.entries(source).forEach(([id, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entry = {};
    if (raw.starred) entry.starred = true;
    if (raw.hidden) entry.hidden = true;
    if (raw.seen) entry.seen = raw.seen;
    if (typeof raw.notes === "string" && raw.notes.trim()) entry.notes = raw.notes;
    if (Object.keys(entry).length) next[id] = entry;
  });
  return next;
}

function getPrefs() {
  try { return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); }
  catch { return {}; }
}

function setPrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(normalizePrefs(p)));
}

function getChamberPrefs(id) {
  const p = getPrefs();
  return Object.assign(
    { starred: false, hidden: false, seen: false, notes: "" },
    p[id] || {}
  );
}

function setChamberPrefs(id, updates) {
  const p = getPrefs();
  const existing = getChamberPrefs(id);
  const merged = { ...existing, ...updates };
  // Remove entry entirely if it holds no meaningful data (keeps storage tidy)
  const isEmpty =
    !merged.starred &&
    !merged.hidden &&
    !merged.seen &&
    !merged.notes;
  if (isEmpty) delete p[id]; else p[id] = merged;
  setPrefs(p);
  touchActivity(id, "lastPrefsChange");
  updatePrefsBar();
}

// ─── Contacted tracking (per-branch, per-session) ──────────────────────────────
function getContacted() {
  try { return JSON.parse(localStorage.getItem(CONTACTED_KEY) || "{}"); }
  catch { return {}; }
}

function setContacted(data) {
  localStorage.setItem(CONTACTED_KEY, JSON.stringify(data));
}

/** Normalise old single-via { ts, via, chamberName } → new per-via { phone/email: { ts, chamberName } } */
function _normalizeContactRec(rec) {
  if (!rec || rec.ts === undefined) return rec;
  return { [rec.via || "phone"]: { ts: rec.ts, chamberName: rec.chamberName || "" } };
}

/**
 * Mark a specific branch as contacted.
 * Storage key = chambersId + "||" + branchCity
 */
function markContacted(chambersId, branchCity, chambersName, via) {
  const data = getContacted();
  const key  = chambersId + "||" + (branchCity || "");
  data[key] = _normalizeContactRec(data[key]) || {};
  data[key][via || "phone"] = { ts: Date.now(), chamberName: chambersName || "" };
  setContacted(data);
  updateContactedBar();
  if (state.data) renderStatusStrip();
}

function isContacted(chambersId, branchCity) {
  return _normalizeContactRec(getContacted()[chambersId + "||" + (branchCity || "")]) || null;
}

function _contactedMarkInner(rec) {
  if (!rec) return "";
  const parts = [];
  if (rec.phone) parts.push(`${icon("call")} Called ${_formatContactTime(rec.phone.ts)}`);
  if (rec.email) parts.push(`${icon("mail")} Emailed ${_formatContactTime(rec.email.ts)}`);
  return parts.join("<br>");
}

function _buildContactedMark(contRecord) {
  const inner = _contactedMarkInner(contRecord);
  return inner ? `<div class="branch-contacted-mark">${inner}</div>` : "";
}

function resetSession() {
  if (!confirm("Clear the contacted list for this session?\n\nYour stars, notes and other preferences are kept.")) return;
  localStorage.removeItem(CONTACTED_KEY);
  updateContactedBar();
  if (state.data) renderStatusStrip();
  if (state.view !== "none") renderSelection();
  showToast("Contacted list cleared for this session");
}

function _formatContactTime(ts) {
  if (!ts) return "";
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
           " on " + d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) +
         " at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateContactedBar() {
  const data    = getContacted();
  const entries = Object.keys(data);
  const bar     = document.getElementById("contacted-bar");
  const info    = document.getElementById("contacted-bar-info");
  if (!bar || !info) return;
  if (!entries.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const chamberIds = new Set(entries.map(k => k.split("||")[0]));
  info.innerHTML =
    `<strong>${entries.length}</strong> branch${entries.length === 1 ? "" : "es"} contacted ` +
    `at <strong>${chamberIds.size}</strong> set${chamberIds.size === 1 ? "" : "s"} this session`;
}

// ─── Save / restore contacted state via URL hash ───────────────────────────────
// UTF-8-safe base64; byte-compatible with the btoa(unescape(encodeURIComponent()))
// encoding of older save links.
function _b64EncodeUtf8(str) {
  let bin = "";
  new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function _b64DecodeUtf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

/** Accept only well-formed contacted records from an untrusted save link */
function _sanitizeContactedImport(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (!key.includes("||")) return;
    const rec = _normalizeContactRec(value);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
    const entry = {};
    ["phone", "email"].forEach(via => {
      const v = rec[via];
      if (v && typeof v === "object" && typeof v.ts === "number" && isFinite(v.ts)) {
        entry[via] = { ts: v.ts, chamberName: typeof v.chamberName === "string" ? v.chamberName : "" };
      }
    });
    if (Object.keys(entry).length) clean[key] = entry;
  });
  return Object.keys(clean).length ? clean : null;
}

function buildSaveLink() {
  const data = getContacted();
  if (!Object.keys(data).length) { showToast("Contacted chambers will appear here after you copy a phone number or email"); return; }
  try {
    const encoded = _b64EncodeUtf8(JSON.stringify(data));
    const url     = location.origin + location.pathname + "#cf8=" + encoded;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => showToast("Save link copied to clipboard", 3500),
        () => { prompt("Copy this save link:", url); }
      );
    } else {
      prompt("Copy this save link:", url);
    }
  } catch { showToast("Could not build save link"); }
}

function loadFromHash() {
  const hash = location.hash;
  if (!hash.startsWith("#cf8=")) return;
  try {
    const data = _sanitizeContactedImport(JSON.parse(_b64DecodeUtf8(hash.slice(5))));
    if (data) {
      setContacted(data);
      const count = Object.keys(data).length;
      showToast(`Restored ${count} contacted branch${count === 1 ? "" : "es"} from link`, 3500);
      updateContactedBar();
      // Clean the hash from the URL without a reload
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch { /* ignore malformed hash */ }
}

// ─── Activity tracking ─────────────────────────────────────────────────────────
function getActivity() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "{}"); }
  catch { return {}; }
}

function touchActivity(chambersId, type) {
  const data = getActivity();
  if (!data[chambersId]) data[chambersId] = {};
  data[chambersId][type] = Date.now();
  touchPreferenceActivity(data);
}

function touchPreferenceActivity(existingData) {
  const data = existingData || getActivity();
  if (!data._meta) data._meta = {};
  data._meta.lastModified = Date.now();
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
}

function _relativeTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)    return "just now";
  if (mins < 60)   return `${mins} min ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days === 1)  return "yesterday";
  if (days < 30)   return `${days} days ago`;
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

// ─── Prefs summary bar ────────────────────────────────────────────────────────
function updatePrefsBar() {
  const prefs = getPrefs();
  const entries = Object.entries(prefs);
  const bar  = document.getElementById("prefs-bar");
  const info = document.getElementById("prefs-bar-info");

  if (entries.length === 0) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");
  const actMeta    = getActivity()._meta || {};
  const lastChange = actMeta.lastModified ? _relativeTime(actMeta.lastModified) : "";
  info.innerHTML = lastChange
    ? `Local preferences changed <strong>${escapeHtml(lastChange)}</strong>`
    : "Local preferences saved on this device";
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("visible"), duration);
}

async function copyToClipboard(value, label) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
    return true;
  } catch {
    prompt(`Copy ${label.toLowerCase()}:`, text);
    return false;
  }
}

// ─── Fuzzy / typo-tolerant matching ───────────────────────────────────────────
function _editDist(a, b) {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, row[j], row[j-1]);
      prev = tmp;
    }
  }
  return row[n];
}

/** Returns true if query approximately matches target (handles 1-2 char typos) */
function _fuzzyMatch(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  // Word-level: every query word must loosely match at least one target word
  const qWords = q.split(/\s+/).filter(Boolean);
  const tWords = t.split(/[\s\-'|]+/).filter(Boolean);
  return qWords.every(qw =>
    tWords.some(tw => {
      if (tw.includes(qw)) return true;
      if (qw.length >= 4 && tw.length >= 4 && qw.includes(tw)) return true;
      if (qw.length < 3 || tw.length < 3) return false;
      return _editDist(qw, tw) <= Math.max(1, Math.floor(qw.length / 4));
    })
  );
}

function _matchesSearchText(query, value) {
  return typeof value === "string" && value.trim() && _fuzzyMatch(query, value);
}

function _branchCountLabel(ch) {
  return `${ch.branches.length} branch${ch.branches.length === 1 ? "" : "es"}`;
}

function _matchingBranchLabels(query, ch) {
  const labels = [];
  ch.branches.forEach(branch => {
    const fields = [branch.city, branch.name, branch.address].filter(Boolean);
    if (!fields.some(field => _matchesSearchText(query, field))) return;
    const label = branch.city || branch.name || branch.address;
    if (label && !labels.includes(label)) labels.push(label);
  });
  return labels;
}

function _courtSearchEntry(court, query) {
  const matches =
    _matchesSearchText(query, court.name) ||
    _matchesSearchText(query, court.location) ||
    (court.aliases && court.aliases.some(alias => _matchesSearchText(query, alias)));
  if (!matches) return null;
  return {
    type:     "court",
    label:    court.name,
    sublabel: court.location || "",
    obj:      court,
  };
}

function _chamberSearchEntry(ch, query) {
  const branchMatches = _matchingBranchLabels(query, ch);
  const matches =
    _matchesSearchText(query, ch.name) ||
    (ch.aliases && ch.aliases.some(alias => _matchesSearchText(query, alias))) ||
    branchMatches.length > 0;
  if (!matches) return null;

  let sublabel = _branchCountLabel(ch);
  if (branchMatches.length) {
    const visibleBranches = branchMatches.slice(0, 2).join(", ");
    const moreBranches = branchMatches.length > 2 ? ` +${branchMatches.length - 2}` : "";
    sublabel = `${visibleBranches}${moreBranches} · ${sublabel}`;
  }

  return {
    type:     "chambers",
    label:    ch.name,
    sublabel,
    obj:      ch,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────
function doSearch(query) {
  if (!state.data || !query.trim()) {
    state.searchResults = [];
    renderSearchResults();
    return;
  }
  const q = query.toLowerCase();

  const courts = state.data.courts
    .map(c => _courtSearchEntry(c, q))
    .filter(Boolean);

  const chambers = state.data.chambers
    .map(ch => _chamberSearchEntry(ch, q))
    .filter(Boolean);

  const perGroupLimit = courts.length && chambers.length
    ? BALANCED_SEARCH_RESULTS_PER_GROUP
    : MAX_SEARCH_RESULTS_PER_GROUP;

  state.searchResults = [
    ...courts.slice(0, perGroupLimit),
    ...chambers.slice(0, perGroupLimit),
  ];
  renderSearchResults();
}

// ─── Search dropdown combobox state (ARIA combobox/listbox pattern) ──────────
// Focus stays in the input; arrow keys move an active option referenced via
// aria-activedescendant. _searchActiveIndex indexes into state.searchResults,
// which is rendered in the same order (courts first, then chambers).
let _searchActiveIndex = -1;

function _setSearchExpanded(expanded) {
  const input = document.getElementById("search-input");
  input.setAttribute("aria-expanded", String(expanded));
  if (!expanded) input.removeAttribute("aria-activedescendant");
}

function _closeSearchResults() {
  document.getElementById("search-results").style.display = "none";
  _searchActiveIndex = -1;
  _setSearchExpanded(false);
}

function _updateSearchActive() {
  const options = document.querySelectorAll("#search-results .search-item");
  options.forEach((opt, i) => {
    const active = i === _searchActiveIndex;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-selected", String(active));
  });
  const input    = document.getElementById("search-input");
  const activeEl = options[_searchActiveIndex];
  if (activeEl) {
    input.setAttribute("aria-activedescendant", activeEl.id);
    activeEl.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function _moveSearchActive(delta) {
  const n = state.searchResults.length;
  if (!n) return;
  // From "nothing active": ArrowDown starts at the first option, ArrowUp at the last
  _searchActiveIndex = _searchActiveIndex === -1
    ? (delta > 0 ? 0 : n - 1)
    : (_searchActiveIndex + delta + n) % n;
  _updateSearchActive();
}

/** Renders grouped dropdown with court and chambers section headers */
function renderSearchResults() {
  const el = document.getElementById("search-results");
  el.innerHTML = "";
  _searchActiveIndex = -1;
  if (!state.searchResults.length) { _closeSearchResults(); return; }

  const courts   = state.searchResults.filter(e => e.type === "court");
  const chambers = state.searchResults.filter(e => e.type === "chambers");

  let optIndex = 0;
  function addGroup(label, items) {
    if (!items.length) return;
    const header = document.createElement("div");
    header.className = "search-group-label";
    header.textContent = label;
    header.setAttribute("role", "presentation");
    el.appendChild(header);
    items.forEach(entry => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-item";
      btn.id = `search-option-${optIndex++}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", "false");
      btn.tabIndex = -1; // keyboard access goes through the input, not Tab
      btn.innerHTML =
        `<strong>${escapeHtml(entry.label)}</strong>` +
        `<small>${escapeHtml(entry.sublabel)}</small>`;
      btn.addEventListener("click", () => chooseResult(entry));
      el.appendChild(btn);
    });
  }

  addGroup("Courts", courts);
  addGroup("Chambers", chambers);
  el.style.display = "block";
  _setSearchExpanded(true);
}

function chooseResult(entry) {
  document.getElementById("search-input").value = entry.label;
  _closeSearchResults();
  state.searchResults = [];

  if (entry.type === "court") {
    state.view           = "court";
    state.selectedCourt  = entry.obj;
    state.selectedChamber = null;
    state.fromCourt      = null;
  } else {
    state.view            = "chamber";
    state.selectedChamber = entry.obj;
    state.selectedCourt   = null;
    state.fromCourt       = null;
  }
  renderSelection();
}

// ─── Radius buttons ───────────────────────────────────────────────────────────
function renderRadiusButtons() {
  const group = document.getElementById("radius-group");
  // Keep the label element, replace buttons only
  const label = group.querySelector(".radius-label");
  group.innerHTML = "";
  if (label) group.appendChild(label);

  RADII.forEach((r, i) => {
    const btn = document.createElement("button");
    btn.className = "radius-btn" + (state.radiusMiles === r ? " active" : "");
    btn.textContent = RADIUS_LABELS[i];
    btn.addEventListener("click", () => {
      state.radiusMiles = r;
      renderRadiusButtons();
      if (state.view !== "none") renderSelection();
    });
    group.appendChild(btn);
  });
}

// ─── chambersForCourt: sorted list with distances ─────────────────────────────
function chambersForCourt(court) {
  const prefs = getPrefs();
  return state.data.chambers.map(ch => {
    const cp = prefs[ch.id] || {};
    let minDist = Infinity;
    let nearestBranch = null;
    ch.branches.forEach(b => {
      const d = haversine(court.lat, court.lon, b.lat, b.lon);
      if (d < minDist) { minDist = d; nearestBranch = b; }
    });
    return {
      chambers:      ch,
      distance:      minDist,
      nearestBranch,
      starred:       !!cp.starred,
      hidden:        !!cp.hidden,
    };
  }).sort((a, b) => {
    // Hidden items are excluded from normal court results; keep the sort stable for hidden-list views.
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    // Starred items to the top
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    // Then nearest first
    if (a.distance !== b.distance) return a.distance - b.distance;
    // Alphabetical tiebreak
    return a.chambers.name.localeCompare(b.chambers.name);
  });
}

// ─── Master render dispatcher ─────────────────────────────────────────────────
function renderSelection() {
  if      (state.view === "court")          renderCourt(state.selectedCourt);
  else if (state.view === "chamber")        renderChamber(state.selectedChamber);
  else if (state.view === "all-chambers")   renderBrowseChambers(state.data.chambers.slice().sort((a,b)=>a.name.localeCompare(b.name)));
  else if (state.view === "all-courts")     renderBrowseCourts(state.data.courts.slice().sort((a,b)=>a.name.localeCompare(b.name)));
  else if (state.view === "starred")        renderBrowseChambers(state.data.chambers.filter(ch => (getPrefs()[ch.id]||{}).starred).sort((a,b)=>a.name.localeCompare(b.name)), "Starred Chambers");
  else if (state.view === "hidden")         renderBrowseChambers(state.data.chambers.filter(ch => (getPrefs()[ch.id]||{}).hidden).sort((a,b)=>a.name.localeCompare(b.name)), "Hidden Chambers");
  else if (state.view === "contacted")      renderContactedList();
}

// ─── Court view ───────────────────────────────────────────────────────────────
function renderCourt(court) {
  const all          = chambersForCourt(court);
  const visibleRows  = all.filter(r => !r.hidden);
  const inRadius     = state.radiusMiles === null
    ? visibleRows
    : visibleRows.filter(r => r.distance <= state.radiusMiles);
  const outOfRadius  = state.radiusMiles === null
    ? []
    : visibleRows.filter(r => r.distance > state.radiusMiles);
  const starredCount = visibleRows.filter(r => r.starred).length;
  const radiusLabel  = state.radiusMiles ? `${state.radiusMiles} mi` : "all distances";

  let html = `
    <div class="court-header">
      <h2>${icon("account_balance")} ${escapeHtml(court.name)}</h2>
      <div class="court-meta">${escapeHtml(court.location || "")}</div>
      <div class="court-stats">
        ${inRadius.length} chambers within ${radiusLabel}${outOfRadius.length ? ` · ${outOfRadius.length} further away` : ""}${starredCount ? ` · ${icon("star", "icon-fill")} ${starredCount} starred` : ""}
      </div>
    </div>
    <div class="chambers-list" id="chambers-list-inner">
  `;

  if (inRadius.length === 0 && outOfRadius.length === 0) {
    html += `<div class="empty-msg">Try a wider travel radius, or check back as more data is added.</div>`;
  }

  inRadius.forEach(row => { html += _chamberListItemHtml(row, false); });

  if (outOfRadius.length > 0) {
    html += `<div class="outside-radius-header">Beyond ${state.radiusMiles} miles · ${outOfRadius.length} more chamber${outOfRadius.length === 1 ? "" : "s"}</div>`;
    outOfRadius.forEach(row => { html += _chamberListItemHtml(row, true); });
  }

  html += `</div>`;
  document.getElementById("results").innerHTML = html;
  _bindListItemEvents(court);
}

function _branchKey(branch) {
  return branch?.city || branch?.name || "";
}

function _contactValue(ch, branch, via) {
  if (via === "phone") return branch?.phone || ch?.phone || "";
  if (via === "email") return ch?.email || "";
  if (via === "address") return branch?.address || "";
  return "";
}

function _contactLabel(via) {
  if (via === "phone") return "Phone";
  if (via === "email") return "Email";
  if (via === "address") return "Address";
  return "Value";
}

function _contactIcon(via) {
  if (via === "phone") return "call";
  if (via === "email") return "mail";
  if (via === "address") return "location_on";
  return "content_copy";
}

function _copyContactButtonHtml(ch, branch, via, compact = false) {
  const value = _contactValue(ch, branch, via);
  if (!value) return "";
  const label = _contactLabel(via);
  const iconName = _contactIcon(via);
  return `
    <button class="copy-contact-btn${compact ? " compact" : ""}" type="button"
      data-copy-contact="1"
      data-contact-id="${escapeHtml(ch.id)}"
      data-contact-branch="${escapeHtml(_branchKey(branch))}"
      data-contact-name="${escapeHtml(ch.name)}"
      data-contact-via="${escapeHtml(via)}"
      data-contact-value="${escapeHtml(value)}"
      title="Copy ${escapeHtml(label.toLowerCase())}${via === "address" ? "" : " and update contacted tracking"}">
      ${icon(iconName)}
      <span class="contact-value">${escapeHtml(value)}</span>
    </button>`;
}

function _branchContactButtonsHtml(ch, branch, compact = false) {
  const buttons = [
    _copyContactButtonHtml(ch, branch, "phone", compact),
    _copyContactButtonHtml(ch, branch, "email", compact),
    _copyContactButtonHtml(ch, branch, "address", compact),
    ch.website && !compact && /^https?:\/\//i.test(ch.website)
      ? `<a class="website-link" href="${escapeHtml(ch.website)}" target="_blank" rel="noopener noreferrer">${icon("language")} Website</a>`
      : "",
  ].filter(Boolean).join("");
  return buttons ? `<div class="branch-contact${compact ? " compact-contact" : ""}">${buttons}</div>` : "";
}

function _chamberListItemHtml(row, dimmed) {
  const cp        = getChamberPrefs(row.chambers.id);
  const starClass = cp.starred ? "star-btn starred" : "star-btn";
  const itemClass = "chambers-item" + (row.hidden ? " hidden-item" : "") + (cp.seen ? " seen-item" : "");
  const inR       = !dimmed && (state.radiusMiles === null || row.distance <= state.radiusMiles);
  const distLabel = row.distance === Infinity ? "—" : row.distance.toFixed(1) + " mi";

  const metaParts = [];
  if (cp.starred) metaParts.push(`<span class="badge starred">${icon("star", "icon-fill")} Starred</span>`);
  if (row.hidden) metaParts.push(`<span class="badge" style="opacity:.55">Hidden</span>`);
  if (row.nearestBranch) {
    const loc = row.nearestBranch.city || row.nearestBranch.address || "";
    if (loc) metaParts.push(escapeHtml(loc));
  }
  if (row.chambers.branches.length > 1) {
    metaParts.push(`<span class="badge green">${row.chambers.branches.length} branches</span>`);
  }
  // Show "contacted" badge if any branch was called/emailed this session
  const contData = getContacted();
  const anyContacted = row.chambers.branches.some(b =>
    contData[row.chambers.id + "||" + (b.city || b.name || "")]
  );
  if (anyContacted) {
    metaParts.push(`<span class="badge contacted">${icon("done")} Contacted</span>`);
  }
  return `
    <div class="${itemClass}" data-id="${escapeHtml(row.chambers.id)}" data-court-item="1" tabindex="0" role="button" aria-label="${escapeHtml(row.chambers.name)}">
      <div class="chambers-item-main">
        <div class="chambers-item-name">${escapeHtml(row.chambers.name)}</div>
        <div class="chambers-item-meta">${metaParts.join("")}</div>
        ${row.nearestBranch ? _branchContactButtonsHtml(row.chambers, row.nearestBranch, true) : ""}
      </div>
      <div class="chambers-item-actions">
        <span class="badge ${inR ? "orange" : ""}">${distLabel}</span>
        <button class="eye-btn${cp.seen ? " seen" : ""}" data-eye="${escapeHtml(row.chambers.id)}"
          title="${cp.seen ? "Viewed " + _formatContactTime(typeof cp.seen === "number" ? cp.seen : 0) + " · click to mark unseen" : "Mark as seen"}"
          aria-label="${cp.seen ? "Mark unseen" : "Mark seen"}">
          ${cp.seen ? icon("visibility_off") : icon("visibility")}
        </button>
        <button class="${starClass}" data-star="${escapeHtml(row.chambers.id)}"
          title="${cp.starred ? "Remove star" : "Star this chambers"}"
          aria-label="${cp.starred ? "Unstar" : "Star"}">${cp.starred ? icon("star", "icon-fill") : icon("star")}</button>
      </div>
    </div>
  `;
}

function _bindListItemEvents(court) {
  const list = document.getElementById("chambers-list-inner");
  if (!list) return;

  // Star buttons — stop propagation so row click doesn't fire
  list.querySelectorAll("[data-star]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.star;
      const cp = getChamberPrefs(id);
      setChamberPrefs(id, { starred: !cp.starred });
      showToast(cp.starred ? "Removed from starred" : "Starred");
      renderCourt(court);
      renderStatusStrip();
    });
  });

  // Eye buttons — toggle seen/unseen without drilling in
  list.querySelectorAll("[data-eye]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.eye;
      const cp = getChamberPrefs(id);
      setChamberPrefs(id, { seen: !cp.seen ? Date.now() : 0 });
      renderCourt(court);
    });
  });

  _bindContactButtons();

  // Row click → drill into chamber detail
  list.querySelectorAll("[data-court-item]").forEach(item => {
    const open = () => {
      const id = item.dataset.id;
      const ch = state.data.chambers.find(c => c.id === id);
      if (ch) {
        if (!getChamberPrefs(id).seen) setChamberPrefs(id, { seen: Date.now() });
        state.selectedChamber = ch;
        state.fromCourt = court;
        renderChamberDetail(ch, court);
      }
    };
    item.addEventListener("click", e => {
      if (e.target.closest("[data-star]") || e.target.closest("[data-eye]") || e.target.closest("[data-copy-contact]")) return;
      open();
    });
    item.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}

// ─── Chamber detail (opened from court list) ──────────────────────────────────
function renderChamberDetail(ch, court) {
  const cp = getChamberPrefs(ch.id);
  const sortedBranches = _branchesSortedByDistance(ch, court);

  let branchesHtml = "";
  sortedBranches.forEach(b => {
    let distHtml = "";
    if (court) {
      const d   = haversine(court.lat, court.lon, b.lat, b.lon);
      const inR = state.radiusMiles === null || d <= state.radiusMiles;
      distHtml  = `<span class="badge ${inR ? "orange" : ""}">${isFinite(d) ? d.toFixed(1) + " mi" : "—"}</span>`;
    }
    const contRecord = isContacted(ch.id, b.city || b.name || "");
    const contactedHtml = _buildContactedMark(contRecord);
    branchesHtml += `
      <div class="branch-item">
        <div class="branch-item-header">
          <div class="branch-city">${escapeHtml(b.city || "Branch")}</div>
          ${distHtml}
        </div>
        <div class="branch-address">${escapeHtml(b.address || "")}</div>
        ${_branchContactButtonsHtml(ch, b)}
        ${contactedHtml}
      </div>`;
  });

  document.getElementById("results").innerHTML = `
    <div class="chamber-detail-wrap" id="chamber-detail">
      <div class="chamber-detail-header">
        <h3>${icon("gavel")} ${escapeHtml(ch.name)}</h3>
        <button class="chamber-back-btn" id="chamber-back-btn">← Back to ${escapeHtml(court ? court.name : "court")}</button>
      </div>
      <div class="branches-list">${branchesHtml}</div>
      ${_buildPrefsPanel(ch.id, cp)}
    </div>`;

  document.getElementById("chamber-back-btn").addEventListener("click", () => {
    if (court) { state.view = "court"; renderCourt(court); }
    else renderPlaceholder();
  });

  _bindPrefsActions(ch.id, court, /* detailMode */ true);
  _bindContactButtons();
}

// ─── Chamber view (searched directly) ────────────────────────────────────────
function renderChamber(ch) {
  const cp = getChamberPrefs(ch.id);
  const sortedBranches = _branchesSortedByDistance(ch, null);

  let branchesHtml = "";
  sortedBranches.forEach(b => {
    const contRecord    = isContacted(ch.id, b.city || b.name || "");
    const contactedHtml = _buildContactedMark(contRecord);
    branchesHtml += `
      <div class="branch-item">
        <div class="branch-city">${escapeHtml(b.city || "Branch")}</div>
        <div class="branch-address">${escapeHtml(b.address || "")}</div>
        ${_branchContactButtonsHtml(ch, b)}
        ${contactedHtml}
      </div>`;
  });

  document.getElementById("results").innerHTML = `
    <div class="view-header">
      <h2>${icon("gavel")} ${escapeHtml(ch.name)}</h2>
    </div>
    <div class="chamber-detail-wrap">
      <div class="branches-list">${branchesHtml}</div>
      ${_buildPrefsPanel(ch.id, cp)}
    </div>`;

  _bindPrefsActions(ch.id, null, /* detailMode */ false);
  _bindContactButtons();
}

function _branchesSortedByDistance(ch, court) {
  return [...ch.branches].sort((a, b) => {
    if (court) {
      return haversine(court.lat, court.lon, a.lat, a.lon) -
             haversine(court.lat, court.lon, b.lat, b.lon);
    }
    return (a.city || "").localeCompare(b.city || "");
  });
}

// ─── Bind copy buttons → clipboard, then update contacted tracking ────────────
// Always called straight after an innerHTML replacement of #results, so every
// button is freshly created and can be bound directly.
function _bindContactButtons() {
  document.querySelectorAll("[data-copy-contact]").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const via = button.dataset.contactVia;
      const value = button.dataset.contactValue || "";
      const label = _contactLabel(via);
      await copyToClipboard(value, label);

      if (via !== "phone" && via !== "email") return;

      const branch = button.dataset.contactBranch;
      const name   = button.dataset.contactName;
      markContacted(button.dataset.contactId, branch, name, via);

      const branchItem = button.closest(".branch-item");
      if (branchItem) {
        let mark = branchItem.querySelector(".branch-contacted-mark");
        if (!mark) {
          mark = document.createElement("div");
          mark.className = "branch-contacted-mark";
          branchItem.appendChild(mark);
        }
        mark.innerHTML = _contactedMarkInner(isContacted(button.dataset.contactId, button.dataset.contactBranch));
      }
    });
  });
}

// ─── Prefs panel HTML builder ─────────────────────────────────────────────────
function _buildPrefsPanel(id, cp) {
  const eid       = escapeHtml(id);
  const starClass = cp.starred ? "pref-toggle-btn on-star" : "pref-toggle-btn";
  const hideClass = cp.hidden  ? "pref-toggle-btn on-hide" : "pref-toggle-btn";
  const starLabel = cp.starred
    ? `${icon("star", "icon-fill")} Starred`
    : `${icon("star")} Star this chambers`;
  const hideLabel = cp.hidden
    ? `${icon("visibility")} Unhide`
    : `${icon("visibility_off")} Hide this chambers`;

  return `
    <div class="prefs-panel" id="prefs-panel-${eid}">
      <div class="prefs-panel-title">Your preferences</div>
      <div class="prefs-actions-row">
        <button class="${starClass}" data-pref-star="${eid}">${starLabel}</button>
        <button class="${hideClass}" data-pref-hide="${eid}">${hideLabel}</button>
      </div>

      <div class="notes-section">
        <label for="notes-${eid}">${icon("edit_note")} Notes</label>
        <textarea class="notes-area" id="notes-${eid}" placeholder="Local chambers notes only…">${escapeHtml(cp.notes || "")}</textarea>
      </div>
    </div>`;
}

// ─── Bind prefs panel interactions ────────────────────────────────────────────
function _bindPrefsActions(id, court, detailMode) {
  // Star toggle
  document.querySelector(`[data-pref-star="${id}"]`)?.addEventListener("click", () => {
    const cp = getChamberPrefs(id);
    setChamberPrefs(id, { starred: !cp.starred });
    showToast(cp.starred ? "Removed from starred" : "Starred");
    _rerender(id, court, detailMode);
  });

  // Hide toggle
  document.querySelector(`[data-pref-hide="${id}"]`)?.addEventListener("click", () => {
    const cp = getChamberPrefs(id);
    setChamberPrefs(id, { hidden: !cp.hidden });
    showToast(cp.hidden ? "Chambers will now be hidden" : "Chambers is now visible again");
    _rerender(id, court, detailMode);
  });

  // Notes — autosave after 800 ms idle
  const notesEl = document.getElementById(`notes-${id}`);
  let notesTimer;
  notesEl?.addEventListener("input", () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      setChamberPrefs(id, { notes: notesEl.value });
      showToast("Notes saved");
    }, 800);
  });
}

/** Re-render the appropriate view after a prefs change within the detail panel */
function _rerender(id, court, detailMode) {
  const ch = state.data.chambers.find(c => c.id === id);
  if (!ch) return;
  if (detailMode && court) renderChamberDetail(ch, court);
  else renderChamber(ch);
  renderStatusStrip();
}

// ─── Placeholder ─────────────────────────────────────────────────────────────
function renderPlaceholder() {
  document.getElementById("results").innerHTML = `
    <div class="results-placeholder">
      <div class="big-icon">${icon("balance")}</div>
      <p>Search for a court to see nearby chambers, or search for a chambers to see all its branches.</p>
    </div>`;
}

// ─── Contacted list view ──────────────────────────────────────────────────────
function renderContactedList() {
  const data    = getContacted();
  const entries = Object.entries(data);
  const el      = document.getElementById("results");

  if (!entries.length) {
    el.innerHTML = `
      <div class="results-placeholder">
        <div class="big-icon">${icon("content_copy")}</div>
        <p>Copied phone numbers and emails will appear here for this session.</p>
      </div>`;
    return;
  }

  // Sort most-recently-contacted first
  entries.sort((a, b) => {
    const lastTs = rec => { const n = _normalizeContactRec(rec); return Math.max(n?.phone?.ts || 0, n?.email?.ts || 0); };
    return lastTs(b[1]) - lastTs(a[1]);
  });

  const rows = entries.map(([key, val]) => {
    const [chambersId, branchCity] = key.split("||");
    const ch = state.data?.chambers.find(c => c.id === chambersId);
    const norm = _normalizeContactRec(val);
    if (!norm || typeof norm !== "object") return ""; // skip malformed stored entries
    const name   = norm.phone?.chamberName || norm.email?.chamberName || ch?.name || chambersId;
    const lastTs = Math.max(norm.phone?.ts || 0, norm.email?.ts || 0);
    const time   = lastTs ? _formatContactTime(lastTs) : "";
    const badges = [
      norm.phone ? `<span class="badge contacted">${icon("call")} Called</span>` : "",
      norm.email ? `<span class="badge contacted emailed">${icon("mail")} Emailed</span>` : "",
    ].filter(Boolean).join(" ");
    return `
      <div class="browse-row" data-ch-id="${escapeHtml(chambersId)}" role="button" tabindex="0">
        <div class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(name)}</span>
          ${badges}
        </div>
        <div class="browse-row-meta">${escapeHtml(branchCity)} · ${escapeHtml(time)}</div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="browse-header">${icon("content_copy")} Contacted this session (${entries.length})</div>
      <div class="browse-list">${rows}</div>
    </div>`;

  el.querySelectorAll("[data-ch-id]").forEach(row => {
    const open = () => {
      const ch = state.data?.chambers.find(c => c.id === row.dataset.chId);
      if (ch) { state.view = "chamber"; state.selectedChamber = ch; state.fromCourt = null; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") open(); });
  });
}

// ─── Browse: all chambers (or filtered subset) ───────────────────────────────
function renderBrowseChambers(list, heading) {
  const el = document.getElementById("results");
  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><div class="big-icon">${icon("star")}</div><p>None here yet.</p></div>`;
    return;
  }
  const title = heading || `All Chambers (${list.length})`;
  const rows = list.map(ch => {
    const cp = (getPrefs()[ch.id] || {});
    const badges = [
      cp.starred ? `<span class="badge starred">${icon("star", "icon-fill")} Starred</span>` : "",
      cp.hidden  ? `<span class="badge" style="opacity:.5">Hidden</span>` : "",
    ].filter(Boolean).join("");
    const branchList = (ch.branches||[]).map(b => escapeHtml(b.city||b.name)).join(" · ");
    return `
      <div class="browse-row" data-ch-id="${escapeHtml(ch.id)}" role="button" tabindex="0"
           title="View ${escapeHtml(ch.name)}">
        <div class="browse-row-main">
          <span class="browse-row-name">${escapeHtml(ch.name)}</span>
          ${badges}
        </div>
        <div class="browse-row-meta">
          ${(ch.branches||[]).length} branch${(ch.branches||[]).length===1?'':'es'}
          ${branchList ? ` · ${branchList}` : ""}
        </div>
      </div>`;
  }).join("");
  el.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="browse-header">${escapeHtml(title)}</div>
      <div class="browse-list">${rows}</div>
    </div>`;
  el.querySelectorAll(".browse-row").forEach(row => {
    const open = () => {
      const ch = state.data.chambers.find(c => c.id === row.dataset.chId);
      if (ch) { state.view = "chamber"; state.selectedChamber = ch; state.fromCourt = null; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", e => { if (e.key==="Enter"||e.key===" ") open(); });
  });
}

// ─── Browse: all courts ───────────────────────────────────────────────────────
function renderBrowseCourts(list) {
  const el = document.getElementById("results");
  const rows = list.map(court => `
    <div class="browse-row" data-court-id="${escapeHtml(court.id)}" role="button" tabindex="0"
         title="View ${escapeHtml(court.name)}">
      <div class="browse-row-main">
        <span class="browse-row-name">${escapeHtml(court.name)}</span>
      </div>
      <div class="browse-row-meta">${escapeHtml(court.location||"")}</div>
    </div>`).join("");
  el.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="browse-header">All Courts (${list.length})</div>
      <div class="browse-list">${rows}</div>
    </div>`;
  el.querySelectorAll(".browse-row").forEach(row => {
    const open = () => {
      const court = state.data.courts.find(c => c.id === row.dataset.courtId);
      if (court) { state.view = "court"; state.selectedCourt = court; renderSelection(); syncStatusHighlight(); }
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", e => { if (e.key==="Enter"||e.key===" ") open(); });
  });
}

// ─── Sync active highlight on status strip ────────────────────────────────────
function syncStatusHighlight() {
  document.querySelectorAll(".status-block").forEach(b => {
    b.classList.toggle("active-view", b.dataset.view === state.view);
  });
}

// ─── Status strip ─────────────────────────────────────────────────────────────
function renderStatusStrip() {
  const { courts, chambers } = state.data;
  const prefs       = getPrefs();
  const contacted   = getContacted();
  const starred     = Object.values(prefs).filter(p => p.starred).length;
  const hidden      = Object.values(prefs).filter(p => p.hidden).length;
  const branches    = chambers.reduce((n, ch) => n + ch.branches.length, 0);
  const contactedN  = Object.keys(contacted).length;

  // role="button" + tabindex so the blocks work from the keyboard too
  const interactive = `role="button" tabindex="0"`;

  const hiddenBlock = hidden
    ? `<div class="status-block hidden-block" data-view="hidden" ${interactive} title="Click to see hidden chambers">
        <strong>${hidden}</strong><small>hidden by you</small>
      </div>`
    : `<div class="status-block hidden-block" title="No hidden chambers">
        <strong>—</strong><small>hidden by you</small>
      </div>`;

  document.getElementById("status-strip").innerHTML = `
    <div class="status-block" data-view="all-chambers" ${interactive} title="Click to browse all chambers">
      <strong>${chambers.length}</strong><small>chambers sets</small>
    </div>
    <div class="status-block" data-view="all-courts" ${interactive} title="Click to browse all courts">
      <strong>${courts.length}</strong><small>courts on file</small>
    </div>
    <div class="status-block" data-view="all-chambers" ${interactive} title="Total mapped branches">
      <strong>${branches}</strong><small>mapped branches</small>
    </div>
    <div class="status-block starred-block" data-view="starred" ${interactive} title="Click to see your starred chambers">
      <strong>${starred || "—"}</strong><small>starred by you</small>
    </div>
    <div class="status-block contacted-block" data-view="contacted" ${interactive} title="Click to see contacted chambers">
      <strong>${contactedN || "—"}</strong><small>contacted</small>
    </div>
    ${hiddenBlock}`;

  document.querySelectorAll(".status-block").forEach(block => {
    const open = () => {
      const view = block.dataset.view;
      if (!view) return;
      state.view = view;
      renderSelection();
      syncStatusHighlight();
    };
    block.addEventListener("click", open);
    block.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  syncStatusHighlight();
}

// ─── Export / Import prefs ────────────────────────────────────────────────────
function exportPrefs() {
  const json = JSON.stringify(getPrefs(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "chambers-finder-prefs.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Preferences exported");
}

function importPrefs() {
  const input  = document.createElement("input");
  input.type   = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (typeof data !== "object" || Array.isArray(data)) throw new Error("Unexpected format");
        setPrefs(data);
        touchPreferenceActivity();
        updatePrefsBar();
        if (state.data) renderStatusStrip();
        showToast("Preferences imported");
        if (state.view !== "none") renderSelection();
      } catch {
        showToast("Import could not be completed. Check the file format.", 3500);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Radius buttons
  renderRadiusButtons();

  // Search input
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => doSearch(searchInput.value));
  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim() && state.searchResults.length) {
      document.getElementById("search-results").style.display = "block";
      _setSearchExpanded(true);
    } else if (searchInput.value.trim()) {
      doSearch(searchInput.value);
    }
  });

  // Combobox keyboard support: arrows move the active option, Enter selects,
  // Escape closes, Tab closes and moves on
  searchInput.addEventListener("keydown", e => {
    const isOpen = document.getElementById("search-results").style.display === "block";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) {
        if (!searchInput.value.trim()) return;
        doSearch(searchInput.value);
        if (!state.searchResults.length) return;
      }
      _moveSearchActive(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      if (isOpen && _searchActiveIndex >= 0 && state.searchResults[_searchActiveIndex]) {
        e.preventDefault();
        chooseResult(state.searchResults[_searchActiveIndex]);
      }
    } else if (e.key === "Escape") {
      if (isOpen) { e.preventDefault(); _closeSearchResults(); }
    } else if (e.key === "Tab") {
      if (isOpen) _closeSearchResults();
    }
  });

  // Click-outside to close dropdown
  document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap")) _closeSearchResults();
  });

  // Prefs bar buttons
  document.getElementById("export-prefs-btn").addEventListener("click", exportPrefs);
  document.getElementById("import-prefs-btn").addEventListener("click", importPrefs);
  document.getElementById("clear-prefs-btn").addEventListener("click", () => {
    if (!confirm("Clear ALL your saved preferences? This cannot be undone.")) return;
    setPrefs({});
    updatePrefsBar();
    if (state.data) renderStatusStrip();
    showToast("All preferences cleared");
    if (state.view !== "none") renderSelection();
  });

  // Contacted bar buttons
  document.getElementById("save-link-btn").addEventListener("click", buildSaveLink);
  document.getElementById("reset-session-btn").addEventListener("click", resetSession);

  // Load data
  try {
    const resp = await fetch("/finder-data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    state.data = await resp.json();

    if (!Array.isArray(state.data.courts) || !Array.isArray(state.data.chambers)) {
      throw new Error("finder-data.json is missing 'courts' or 'chambers' arrays");
    }

    // Load radii from JSON config, capped at 50 miles
    if (Array.isArray(state.data.travelRadiusOptions) && state.data.travelRadiusOptions.length) {
      RADII        = state.data.travelRadiusOptions.map(Number).filter(r => r > 0 && r <= 50);
      if (!RADII.length) RADII = [20, 35, 50];
      RADIUS_LABELS = RADII.map(r => `${r} mi`);
    }
    const defaultRadius = Number(state.data.defaultTravelMiles) || 35;
    state.radiusMiles = RADII.includes(defaultRadius) ? defaultRadius : RADII[1] || 35;
    renderRadiusButtons();

    document.getElementById("hero-meta").textContent =
      `${state.data.chambers.length} sets · ${state.data.courts.length} courts`;

    renderStatusStrip();
    updatePrefsBar();
    updateContactedBar();
    loadFromHash();

    // Re-run search if the user typed before data finished loading.
    if (searchInput.value.trim()) doSearch(searchInput.value);

  } catch (err) {
    const errEl = document.getElementById("load-error");
    errEl.style.display = "block";
    errEl.innerHTML =
      `<strong>Data could not be loaded.</strong> ` +
      `Ensure <code>finder-data.json</code> is served from the site root. ` +
      `<br><small style="color:var(--muted)">${escapeHtml(err.message)}</small>`;
    document.getElementById("hero-meta").textContent = "Data unavailable";
  }
}

document.addEventListener("DOMContentLoaded", init);
