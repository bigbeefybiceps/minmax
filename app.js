/* MinMax — web tracker for Jeff Nippard's Min-Max Program (5x/week).
   No dependencies. Data lives in localStorage. */
"use strict";

/* ---------------- Utilities ---------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
const KG_PER_LB = 0.45359237;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Local-date helpers: schedule math is done on 'YYYY-MM-DD' strings (local midnight).
function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, days) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + days);
  return ymd(d);
}
function todayYmd() { return ymd(new Date()); }
function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
function fmtDate(s) {
  return parseYmd(s).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtWeight(v) {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, "").replace(/\.$/, "");
}
function toDisplay(kg) { return state.settings.unit === "kg" ? kg : kg / KG_PER_LB; }
function toKg(v) { return state.settings.unit === "kg" ? v : v * KG_PER_LB; }
function weightStr(kg) { return `${fmtWeight(toDisplay(kg))} ${state.settings.unit}`; }

/* ---------------- State ---------------- */

const STORE_KEY = "minmax-store-v1";

function defaultState() {
  return {
    settings: {
      unit: "kg",
      programStartDate: todayYmd(),
      appearance: "system",           // system | light | dark
      restTimerSound: "tritone",      // none | tritone | bell | chime | alert
      barbells: [
        { id: uuid(), name: "Olympic Barbell", weightKg: 20 },
        { id: uuid(), name: "Women's Olympic Bar", weightKg: 15 },
        { id: uuid(), name: "EZ Curl Bar", weightKg: 7.5 },
        { id: uuid(), name: "Trap Bar", weightKg: 25 },
      ],
      plates: [25, 20, 15, 10, 5, 2.5, 1.25].map((w) => ({ id: uuid(), weightKg: w, pairCount: null })),
      selectedBarbellId: null,
      apiKeySet: false,
    },
    schedule: {
      weekOrder: Array.from({ length: 12 }, (_, i) => i + 1),
      dateOverrides: {},   // "w1d0" -> "YYYY-MM-DD"
      shifts: [],          // {id, fromSlot, days, reason}
      skippedKeys: [],     // ["w1d0"]
    },
    logs: [],              // see startSession for shape
    activeSessionId: null,
    coach: [],             // {role: "user"|"assistant", text}
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed, {
      settings: Object.assign(defaultState().settings, parsed.settings || {}),
      schedule: Object.assign(defaultState().schedule, parsed.schedule || {}),
    });
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

/* ---------------- Program helpers ---------------- */

function programWeek(weekNumber) {
  return PROGRAM.weeks.find((w) => w.week === weekNumber);
}
function programDay(key) {
  const { week, dayIndex } = parseKey(key);
  const w = programWeek(week);
  return w ? w.days[dayIndex] : null;
}
function parseKey(key) {
  const m = key.match(/^w(\d+)d(\d+)$/);
  return { week: Number(m[1]), dayIndex: Number(m[2]) };
}
function makeKey(week, dayIndex) { return `w${week}d${dayIndex}`; }

function dropSetCount(technique) {
  if (!technique || !/drop set/i.test(technique)) return 0;
  if (/two/i.test(technique)) return 2;
  if (/three/i.test(technique)) return 3;
  return 1;
}
function dropFraction(technique) {
  const m = technique && technique.match(/(\d+(?:\.\d+)?)\s*%/);
  const v = m ? Number(m[1]) : 25;
  return v > 0 && v < 100 ? v / 100 : 0.25;
}

/* ---------------- Schedule engine ---------------- */

function scheduledSessions() {
  const result = [];
  let slot = 0;
  state.schedule.weekOrder.forEach((weekNumber, weekPos) => {
    const week = programWeek(weekNumber);
    if (!week) return;
    week.days.forEach((day, dayIndex) => {
      const key = makeKey(weekNumber, dayIndex);
      const shiftDays = state.schedule.shifts
        .filter((s) => s.fromSlot <= slot)
        .reduce((acc, s) => acc + s.days, 0);
      let date = addDays(state.settings.programStartDate, weekPos * 7 + dayIndex + shiftDays);
      if (state.schedule.dateOverrides[key]) date = state.schedule.dateOverrides[key];
      result.push({
        key, slot, date,
        dayName: day.name,
        weekLabel: week.label || null,
        block: week.block || null,
        isRest: day.exercises.length === 0,
        performedWeekNumber: weekPos + 1,
        isDeload: week.label === "Deload Week",
      });
      slot += 1;
    });
  });
  return result;
}

function trainingSessions() { return scheduledSessions().filter((s) => !s.isRest); }
function sessionsOn(dateStr) { return scheduledSessions().filter((s) => s.date === dateStr); }
function positionLabel(s) {
  return s.block ? `Block ${s.block} · Week ${s.performedWeekNumber}` : `Week ${s.performedWeekNumber}`;
}

function logFor(key) {
  for (let i = state.logs.length - 1; i >= 0; i--) {
    if (state.logs[i].key === key) return state.logs[i];
  }
  return null;
}
function isCompleted(key) { const l = logFor(key); return l && l.status === "completed"; }
function isSkipped(key) { return state.schedule.skippedKeys.includes(key); }

function nextSession() {
  const pending = trainingSessions().filter((s) => !isCompleted(s.key) && !isSkipped(s.key));
  const today = todayYmd();
  return pending.find((s) => s.date >= today) || pending[0] || null;
}

function deloadSession() { return trainingSessions().find((s) => s.isDeload) || null; }

function postponeDeload() {
  const deloadWeek = PROGRAM.weeks.find((w) => w.label === "Deload Week");
  if (!deloadWeek) return;
  const order = state.schedule.weekOrder;
  const pos = order.indexOf(deloadWeek.week);
  if (pos >= 0 && pos + 1 < order.length) {
    [order[pos], order[pos + 1]] = [order[pos + 1], order[pos]];
    save(); render();
  }
}

/* ---------------- Logs / session lifecycle ---------------- */

function setVolumeKg(set) {
  return set.completed && !set.isWarmup && set.weightKg != null && set.reps != null
    ? set.weightKg * set.reps : 0;
}
function exVolumeKg(ex) { return ex.sets.reduce((a, s) => a + setVolumeKg(s), 0); }
function logVolumeKg(log) { return log.exercises.reduce((a, e) => a + exVolumeKg(e), 0); }
function setE1RM(set) {
  return set.completed && !set.isWarmup && set.weightKg != null && set.reps > 0
    ? set.weightKg * (1 + set.reps / 30) : null;
}
function exBestE1RM(ex) {
  const vals = ex.sets.map(setE1RM).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}
function completedLogs() {
  return state.logs.filter((l) => l.status === "completed")
    .slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/// Most recent completed performance of an exercise, matched to the SAME training
/// day — Leg Extension on Lower 1 references last week's Lower 1, not Lower 2.
function lastPerformance(exName, dayName, beforeIso) {
  const sorted = state.logs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const log of sorted) {
    if (log.status !== "completed" || log.startedAt >= beforeIso) continue;
    if (dayName && log.dayName !== dayName) continue;
    const ex = log.exercises.find((e) => e.performedName === exName && e.sets.some((s) => s.completed && !s.isWarmup));
    if (ex) return { ex, date: log.startedAt };
  }
  return null;
}

function startSession(key) {
  const existing = logFor(key);
  if (existing && existing.status === "inProgress") {
    state.activeSessionId = existing.id;
    save();
    openSessionSheet(existing.id);
    return;
  }
  const day = programDay(key);
  if (!day) return;
  const log = {
    id: uuid(),
    key,
    dayName: day.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "inProgress",
    exercises: day.exercises.map((ex) => ({
      id: uuid(),
      plannedName: ex.name,
      performedName: ex.name,
      notes: "",
      sets: [
        ...Array.from({ length: Math.max(1, ex.workingSets) }, () => blankSet(false)),
        ...Array.from({ length: dropSetCount(ex.intensityTechnique) }, () => blankSet(true)),
      ],
    })),
  };
  state.logs.push(log);
  state.activeSessionId = log.id;
  save();
  openSessionSheet(log.id);
}

function blankSet(isDropSet) {
  return { id: uuid(), weightKg: null, reps: null, isWarmup: false, isDropSet, completed: false };
}

function finishSession(logId) {
  const log = state.logs.find((l) => l.id === logId);
  if (!log) return;
  log.finishedAt = new Date().toISOString();
  log.status = "completed";
  state.schedule.skippedKeys = state.schedule.skippedKeys.filter((k) => k !== log.key);
  if (state.activeSessionId === logId) state.activeSessionId = null;
  save();
  if (navigator.vibrate) navigator.vibrate(200);
}

function reopenSession(logId) {
  const log = state.logs.find((l) => l.id === logId);
  if (!log) return;
  log.status = "inProgress";
  log.finishedAt = null;
  state.activeSessionId = logId;
  save();
}

function discardSession(logId) {
  state.logs = state.logs.filter((l) => l.id !== logId);
  if (state.activeSessionId === logId) state.activeSessionId = null;
  save();
}

function activeSession() {
  return state.activeSessionId ? state.logs.find((l) => l.id === state.activeSessionId) : null;
}

/* ---------------- Tabs / rendering shell ---------------- */

let currentTab = "today";

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

function render() {
  const view = $("#view");
  if (currentTab === "today") view.innerHTML = renderToday();
  else if (currentTab === "calendar") view.innerHTML = renderCalendar();
  else if (currentTab === "progress") { view.innerHTML = renderProgress(); drawChart(); }
  else if (currentTab === "coach") { view.innerHTML = renderCoach(); scrollChat(); }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.appearance;
}

/* ---------------- Today ---------------- */

function renderToday() {
  const active = activeSession();
  const today = todayYmd();
  const todaySessions = sessionsOn(today).filter((s) => !s.isRest);
  const isRestDay = sessionsOn(today).some((s) => s.isRest) && todaySessions.length === 0;
  const next = nextSession();

  let html = `<div style="display:flex; justify-content:space-between; align-items:center;">
      <h1>MinMax</h1>
      <button class="secondary" onclick="MX.openSettings()">⚙️</button>
    </div>`;

  if (active) {
    html += `<div class="card" onclick="MX.openSession('${active.id}')" style="cursor:pointer; border:1.5px solid var(--accent);">
      <div class="row" style="border:none; padding:4px 0;">
        <div><div class="bold">Session in progress</div><div class="muted">${esc(active.dayName)}</div></div>
        <button class="primary">Resume</button>
      </div></div>`;
  }

  html += `<h2 class="section">Today</h2><div class="card">`;
  if (todaySessions.length === 0) {
    html += isRestDay
      ? `<div class="row"><span>😴 Rest day — recover well</span></div>`
      : `<div class="row"><span class="muted">Nothing scheduled today.</span></div>`;
    if (next) {
      html += `<div class="row"><div>
          <div class="bold">Next up: ${esc(next.dayName)}</div>
          <div class="muted small">${positionLabel(next)}${next.weekLabel ? " · " + esc(next.weekLabel) : ""} — ${fmtDate(next.date)}</div>
        </div>
        <button class="primary" onclick="MX.startSession('${next.key}')">Start</button></div>`;
    }
  } else {
    for (const s of todaySessions) {
      const status = isCompleted(s.key)
        ? `<span class="badge done">Done</span>`
        : isSkipped(s.key)
          ? `<span class="badge skipped">Skipped</span>`
          : `<button class="primary" onclick="MX.startSession('${s.key}')">Start</button>`;
      html += `<div class="row"><div>
          <div class="bold">${esc(s.dayName)}</div>
          <div class="muted small ${s.isDeload ? "orange" : ""}">${positionLabel(s)}${s.weekLabel ? " · " + esc(s.weekLabel) : ""}</div>
        </div>${status}</div>`;
    }
  }
  html += `</div>`;

  // Deload notice
  const deload = deloadSession();
  if (deload && !isCompleted(deload.key)) {
    const days = daysBetween(today, deload.date);
    if (days >= 0 && days <= 10) {
      html += `<div class="card">
        <div class="bold orange">🧡 Deload week ${days === 0 ? "starts today" : `starts in ${days} day${days === 1 ? "" : "s"}`}</div>
        <div class="muted small" style="margin:6px 0 10px;">Lighter loads, further from failure. Push it back if you're feeling fresh.</div>
        <button class="secondary" onclick="MX.postponeDeload()">Postpone deload by one week</button>
      </div>`;
    }
  }

  // Week overview
  if (next) {
    const weekSessions = trainingSessions().filter((s) => s.performedWeekNumber === next.performedWeekNumber);
    html += `<h2 class="section">${positionLabel(next)} overview</h2><div class="card">`;
    for (const s of weekSessions) {
      const icon = isCompleted(s.key) ? "✅" : isSkipped(s.key) ? "⏭" : "○";
      html += `<div class="row"><span>${esc(s.dayName)}</span><span class="muted">${fmtDate(s.date)} &nbsp;${icon}</span></div>`;
    }
    html += `</div>`;
  }
  return html;
}

/* ---------------- Session editor (works on in-progress AND finished logs) ---------------- */

function openSessionSheet(logId) {
  closeModal("session");
  const modal = document.createElement("div");
  modal.className = "overlay";
  modal.id = "modal-session";
  modal.innerHTML = `<div class="sheet">
      <div class="sheet-header">
        <button class="linklike" onclick="MX.closeSession()">Close</button>
        <span class="title" id="session-title"></span>
        <button class="linklike bold" id="session-finish-btn"></button>
      </div>
      <div class="sheet-body" id="session-body"></div>
      <div class="sheet-footer" id="session-footer"></div>
    </div>`;
  $("#modals").appendChild(modal);
  renderSessionBody(logId);
  renderSessionFooter();
}

function renderSessionBody(logId) {
  const log = state.logs.find((l) => l.id === logId);
  if (!log) { closeModal("session"); return; }
  const day = programDay(log.key);
  const { week } = parseKey(log.key);
  const w = programWeek(week);
  const finished = log.status === "completed";

  $("#session-title").textContent = log.dayName;
  const finishBtn = $("#session-finish-btn");
  finishBtn.textContent = finished ? "Save" : "Finish";
  finishBtn.onclick = () => {
    if (!finished) finishSession(logId);
    closeModal("session");
    stopRestTimer(false);
    render();
  };

  let html = `<div class="card">
    <div class="bold">${w.block ? `Block ${w.block} · ` : ""}Week ${week}</div>
    ${w.label ? `<div class="small orange" style="margin-top:4px;">${w.label === "Deload Week" ? "Deload: stay 2-3 reps from failure, lighter loads." : "Intro week: don't push to failure yet."}</div>` : ""}
    ${finished ? `<div class="small blue" style="margin-top:4px;">Editing a finished workout — changes save automatically.
      <button class="linklike" onclick="MX.reopen('${log.id}')">Re-open workout</button></div>` : ""}
  </div>`;

  log.exercises.forEach((exLog, exIdx) => {
    const pEx = day.exercises.find((e) => e.name === exLog.plannedName);
    if (!pEx) return;
    html += renderExercise(log, exLog, exIdx, pEx);
  });

  html += `${!finished ? `<button class="linklike danger" style="margin-top:10px;" onclick="MX.discard('${log.id}')">Discard workout</button>` : ""}
    <div style="height:12px;"></div>`;

  $("#session-body").innerHTML = html;
}

/// Always-visible action bar pinned under the scrolling session body.
/// Shows the rest-timer + plate-calculator buttons, or the running countdown.
function renderSessionFooter() {
  const footer = $("#session-footer");
  if (!footer) return;
  footer.innerHTML = `
    <button class="secondary" style="flex:1;" onclick="MX.openRestMenu()">⏱ Rest timer</button>
    <button class="secondary" style="flex:1;" onclick="MX.openPlates()">⊙ Plates</button>`;
}

function renderExercise(log, exLog, exIdx, pEx) {
  const target = [
    pEx.warmupSets ? `${pEx.warmupSets} warm-up` : null,
    `${pEx.workingSets} working set${pEx.workingSets === 1 ? "" : "s"}`,
    pEx.repRange ? `${pEx.repRange} reps` : null,
    pEx.rest ? `rest ${pEx.rest}` : null,
  ].filter(Boolean).join(" · ");

  const prev = lastPerformance(exLog.performedName, log.dayName, log.startedAt);
  const prevSets = prev ? prev.ex.sets.filter((s) => s.completed && !s.isWarmup) : [];
  // Full local calendar date of the previous session (derived from its start timestamp)
  const prevDateLabel = prev ? fmtDate(ymd(new Date(prev.date))) : "";

  const subs = [pEx.sub1, pEx.sub2].filter((s) => s && s !== "See Notes");

  let html = `<div class="card">
    <div class="ex-head"><div>
      <div class="bold">${esc(exLog.performedName)}</div>
      ${exLog.performedName !== exLog.plannedName ? `<div class="small orange">substituted for ${esc(exLog.plannedName)}</div>` : ""}
      <div class="muted small">${esc(target)}</div>
      ${pEx.intensityTechnique ? `<div class="technique">🔥 Last set: ${esc(pEx.intensityTechnique)}</div>` : ""}
      ${prev ? `<div class="small blue" style="margin-top:2px;">Last ${esc(log.dayName)} (${prevDateLabel}): ${prevSummary(prevSets)}</div>` : ""}
      ${prev && prev.ex.notes ? `<div class="small muted" style="margin-top:2px; font-style:italic;">📝 Last time: ${esc(prev.ex.notes)}</div>` : ""}
    </div>
    <div style="display:flex; gap:6px;">
      ${pEx.notes ? `<button class="secondary" onclick="MX.showNotes('${log.id}',${exIdx})" title="Program notes">ℹ️</button>` : ""}
      ${subs.length || exLog.performedName !== exLog.plannedName || pEx.sub1 === "See Notes"
        ? `<button class="secondary" onclick="MX.openSubs('${log.id}',${exIdx})" title="Substitute">🔁</button>` : ""}
    </div></div>`;

  exLog.sets.forEach((set, setIdx) => {
    const rir = set.isDropSet ? null : setIdx === 0 ? pEx.rirSet1 : pEx.rirSet2;
    const prevSet = prevSets[setIdx];
    const prevTxt = prevSet && prevSet.weightKg != null
      ? (prevSet.isDropSet || prevSet.reps == null
          ? fmtWeight(toDisplay(prevSet.weightKg))
          : `${fmtWeight(toDisplay(prevSet.weightKg))}×${prevSet.reps}`)
      : "";
    html += `<div class="set-row">
      <div>${set.isDropSet ? `<span class="red bold small">Drop</span>` : `<span class="small">Set ${setIdx + 1}</span>`}
        ${prevTxt ? `<div class="prev">${prevTxt}</div>` : ""}</div>
      <input type="number" inputmode="decimal" step="any" placeholder="${prevSet && prevSet.weightKg != null ? fmtWeight(toDisplay(prevSet.weightKg)) : state.settings.unit}"
        value="${set.weightKg != null ? fmtWeight(toDisplay(set.weightKg)) : ""}"
        id="w-${set.id}"
        oninput="MX.setWeight('${log.id}',${exIdx},${setIdx},this.value)">
      ${set.isDropSet
        ? `<span class="muted small">to failure</span>`
        : `<input type="number" inputmode="numeric" placeholder="${prevSet && prevSet.reps != null ? prevSet.reps : "reps"}"
            value="${set.reps != null ? set.reps : ""}"
            oninput="MX.setReps('${log.id}',${exIdx},${setIdx},this.value)">`}
      <span class="muted small">${rir != null && rir !== "N/A" ? `RIR ${esc(rir)}` : ""}</span>
      <button class="check ${set.completed ? "done" : ""}" onclick="MX.toggleSet('${log.id}',${exIdx},${setIdx})">✓</button>
    </div>`;
  });

  html += `<button class="linklike" onclick="MX.addSet('${log.id}',${exIdx})">＋ Add set</button>
    <textarea placeholder="Notes (optional) — how did it feel?" rows="1"
      oninput="MX.setExNotes('${log.id}',${exIdx},this.value)">${esc(exLog.notes)}</textarea>
  </div>`;
  return html;
}

function prevSummary(sets) {
  return sets.map((s) => {
    if (s.weightKg == null) return null;
    const w = fmtWeight(toDisplay(s.weightKg));
    if (s.isDropSet) return `↓${w}`;
    return s.reps != null ? `${w}×${s.reps}` : w;
  }).filter(Boolean).join(", ");
}

/* --- session mutations --- */

function getSet(logId, exIdx, setIdx) {
  const log = state.logs.find((l) => l.id === logId);
  return log ? { log, ex: log.exercises[exIdx], set: log.exercises[exIdx].sets[setIdx] } : null;
}

const MX = {
  switchTab, startSession, postponeDeload,

  openSession: openSessionSheet,
  closeSession() { closeModal("session"); stopRestTimer(false); render(); },

  setWeight(logId, exIdx, setIdx, value) {
    const t = getSet(logId, exIdx, setIdx);
    if (!t) return;
    const v = parseFloat(String(value).replace(",", "."));
    t.set.weightKg = Number.isFinite(v) ? toKg(v) : null;
    if (!t.set.isDropSet) autoFillDrops(t.log, exIdx);
    save();
  },

  setReps(logId, exIdx, setIdx, value) {
    const t = getSet(logId, exIdx, setIdx);
    if (!t) return;
    const v = parseInt(value, 10);
    t.set.reps = Number.isFinite(v) ? v : null;
    save();
  },

  toggleSet(logId, exIdx, setIdx) {
    const t = getSet(logId, exIdx, setIdx);
    if (!t) return;
    t.set.completed = !t.set.completed;
    save();
    if (t.set.completed && t.log.status === "inProgress") {
      const pEx = programDay(t.log.key).exercises.find((e) => e.name === t.ex.plannedName);
      startRestFromPrescription(pEx ? pEx.rest : null);
    }
    renderSessionBody(logId);
  },

  addSet(logId, exIdx) {
    const log = state.logs.find((l) => l.id === logId);
    if (!log) return;
    log.exercises[exIdx].sets.push(blankSet(false));
    save();
    renderSessionBody(logId);
  },

  setExNotes(logId, exIdx, value) {
    const log = state.logs.find((l) => l.id === logId);
    if (!log) return;
    log.exercises[exIdx].notes = value;
    save();
  },

  showNotes(logId, exIdx) {
    const log = state.logs.find((l) => l.id === logId);
    if (!log) return;
    const ex = log.exercises[exIdx];
    const p = programDay(log.key).exercises.find((e) => e.name === ex.plannedName);
    alert(`${ex.plannedName}\n\n${(p && p.notes) || "No notes for this exercise."}`);
  },

  openSubs(logId, exIdx) {
    const log = state.logs.find((l) => l.id === logId);
    const ex = log.exercises[exIdx];
    const pEx = programDay(log.key).exercises.find((e) => e.name === ex.plannedName);
    const subs = [pEx.sub1, pEx.sub2].filter((s) => s && s !== "See Notes");
    let html = `<div class="card">`;
    subs.forEach((s) => {
      html += `<div class="row"><span>${esc(s)}</span><button class="secondary" onclick="MX.substitute('${logId}',${exIdx},'${esc(s).replace(/'/g, "\\'")}')">Use</button></div>`;
    });
    if (ex.performedName !== ex.plannedName) {
      html += `<div class="row"><span class="orange">Back to ${esc(ex.plannedName)}</span>
        <button class="secondary" onclick="MX.substitute('${logId}',${exIdx},'${esc(ex.plannedName).replace(/'/g, "\\'")}')">Use</button></div>`;
    }
    html += `</div>`;
    if (pEx.sub1 === "See Notes" && pEx.notes) {
      html += `<div class="card muted small">${esc(pEx.notes)}</div>`;
    }
    openSheet("subs", `Substitute ${ex.plannedName}`, html);
  },

  substitute(logId, exIdx, name) {
    const log = state.logs.find((l) => l.id === logId);
    log.exercises[exIdx].performedName = name;
    save();
    closeModal("subs");
    renderSessionBody(logId);
  },

  discard(logId) {
    if (!confirm("Discard this workout? Logged sets will be lost.")) return;
    discardSession(logId);
    closeModal("session");
    stopRestTimer(false);
    render();
  },

  reopen(logId) {
    reopenSession(logId);
    closeModal("detail");
    renderSessionBody(logId);
    render();
  },

  /* rest timer */
  openRestMenu() {
    const opts = [60, 90, 120, 180, 300];
    let html = `<div class="card">`;
    opts.forEach((sec) => {
      const label = sec % 60 === 0 ? `${sec / 60} min` : `${(sec / 60).toFixed(1)} min`;
      html += `<div class="row"><span>${label}</span><button class="secondary" onclick="MX.startRest(${sec})">Start</button></div>`;
    });
    html += `</div>`;
    openSheet("rest", "Rest timer", html);
  },
  startRest(seconds) {
    closeModal("rest");
    startRestTimer(seconds);
  },
  skipRest() { stopRestTimer(false); },

  /* plate calculator */
  openPlates: openPlateCalc,
  plateTargetChanged() { updatePlateResult(); },

  /* calendar */
  calPrev() { calMonth.setMonth(calMonth.getMonth() - 1); render(); },
  calNext() { calMonth.setMonth(calMonth.getMonth() + 1); render(); },
  calSelect(dateStr) { calSelected = dateStr; render(); },
  toggleSkip(key) {
    if (isSkipped(key)) state.schedule.skippedKeys = state.schedule.skippedKeys.filter((k) => k !== key);
    else state.schedule.skippedKeys.push(key);
    save(); render();
  },
  moveSession(key) {
    const current = scheduledSessions().find((s) => s.key === key);
    const to = prompt("Move session to date (YYYY-MM-DD):", current.date);
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
    state.schedule.dateOverrides[key] = to;
    save(); render();
  },
  clearMove(key) {
    delete state.schedule.dateOverrides[key];
    save(); render();
  },
  shiftProgram(key) {
    const s = scheduledSessions().find((x) => x.key === key);
    const days = prompt("Shift this session and everything after it by how many days? (negative pulls forward)", "7");
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n === 0) return;
    state.schedule.shifts.push({ id: uuid(), fromSlot: s.slot, days: n, reason: "" });
    save(); render();
  },
  viewLog(logId) {
    const log = state.logs.find((l) => l.id === logId);
    if (log) openDetailSheet(log);
  },
  editLog(logId) {
    closeModal("detail");
    openSessionSheet(logId);
  },

  /* progress */
  setMetric(m) { progMetric = m; render(); },
  setScope(s) { progScope = s; render(); },
  setDayFilter(v) { progDay = v; render(); },
  setExFilter(v) { progEx = v; render(); },
  setRangeStart(v) { progStart = v || null; render(); },
  setRangeEnd(v) { progEnd = v || null; render(); },
  resetRange() { progStart = null; progEnd = null; render(); },

  /* coach */
  sendCoach, coachKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCoach(); }
  },

  /* settings */
  openSettings, closeModalById: closeModal,
  setUnit(u) { state.settings.unit = u; save(); openSettings(); render(); },
  setTheme(t) { state.settings.appearance = t; save(); applyTheme(); openSettings(); },
  setStartDate(v) { if (v) { state.settings.programStartDate = v; save(); render(); } },
  setRestSound(v) { state.settings.restTimerSound = v; save(); },
  saveApiKey(v) {
    if (v && v.trim()) { localStorage.setItem("minmax-api-key", v.trim()); state.settings.apiKeySet = true; }
    else { localStorage.removeItem("minmax-api-key"); state.settings.apiKeySet = false; }
    save();
    alert("API key saved.");
  },
  addBarbell() {
    const name = $("#new-bar-name").value.trim();
    const w = parseFloat($("#new-bar-weight").value);
    if (!name || !Number.isFinite(w)) return;
    state.settings.barbells.push({ id: uuid(), name, weightKg: toKg(w) });
    save(); openSettings();
  },
  removeBarbell(id) {
    state.settings.barbells = state.settings.barbells.filter((b) => b.id !== id);
    save(); openSettings();
  },
  addPlate() {
    const w = parseFloat($("#new-plate-weight").value);
    if (!Number.isFinite(w)) return;
    state.settings.plates.push({ id: uuid(), weightKg: toKg(w), pairCount: null });
    state.settings.plates.sort((a, b) => b.weightKg - a.weightKg);
    save(); openSettings();
  },
  removePlate(id) {
    state.settings.plates = state.settings.plates.filter((p) => p.id !== id);
    save(); openSettings();
  },
  setPlateCount(id, v) {
    const p = state.settings.plates.find((x) => x.id === id);
    const n = parseInt(v, 10);
    p.pairCount = Number.isFinite(n) && n > 0 ? n : null;
    save();
  },
  resetSchedule() {
    if (!confirm("Reset all schedule adjustments (moves, shifts, skips, deload postponements)? Logged workouts are kept.")) return;
    state.schedule = defaultState().schedule;
    save(); render(); closeModal("settings");
  },
  exportXlsx, exportBackup, importBackup(files) {
    const file = files[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const parsed = JSON.parse(txt);
        if (!parsed.logs || !parsed.settings) throw new Error("not a MinMax backup");
        state = Object.assign(defaultState(), parsed);
        save(); applyTheme(); render(); closeModal("settings");
        alert("Backup imported.");
      } catch (err) {
        alert("Could not import: " + err.message);
      }
    });
  },
};
window.MX = MX;

function autoFillDrops(log, exIdx) {
  const ex = log.exercises[exIdx];
  const pEx = programDay(log.key).exercises.find((e) => e.name === ex.plannedName);
  const fraction = dropFraction(pEx && pEx.intensityTechnique);
  const base = [...ex.sets].reverse().find((s) => !s.isDropSet && !s.isWarmup && s.weightKg != null);
  if (!base) return;
  let dropIndex = 0;
  ex.sets.forEach((s) => {
    if (!s.isDropSet) return;
    dropIndex += 1;
    if (s.completed) return;
    s.weightKg = Math.round(base.weightKg * Math.pow(1 - fraction, dropIndex) * 4) / 4;
    const input = document.getElementById(`w-${s.id}`);
    if (input) input.value = fmtWeight(toDisplay(s.weightKg));
  });
}

/* ---------------- Rest timer ---------------- */

let restEndsAt = null;
let restInterval = null;

function startRestFromPrescription(restStr) {
  let minutes = 2;
  const m = restStr && restStr.match(/(\d+(?:\.\d+)?)/);
  if (m) minutes = Number(m[1]);
  startRestTimer(minutes * 60);
}

function startRestTimer(seconds) {
  stopRestTimer(false);
  const footer = $("#session-footer");
  if (!footer) return;
  restEndsAt = Date.now() + seconds * 1000;
  footer.innerHTML = `<span style="font-size:20px;">⏱</span>
    <span class="time" id="rest-time" style="font-size:22px; font-weight:800; font-variant-numeric:tabular-nums;"></span>
    <span class="muted">rest</span>
    <span style="flex:1"></span>
    <button class="secondary" onclick="MX.openPlates()">⊙</button>
    <button class="secondary" onclick="MX.skipRest()">Skip</button>`;
  const tick = () => {
    const left = Math.max(0, Math.round((restEndsAt - Date.now()) / 1000));
    const el = $("#rest-time");
    if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left <= 0) stopRestTimer(true);
  };
  tick();
  restInterval = setInterval(tick, 250);
}

function stopRestTimer(fireAlert) {
  if (restInterval) clearInterval(restInterval);
  restInterval = null;
  restEndsAt = null;
  renderSessionFooter(); // restore the buttons if the session sheet is still open
  if (fireAlert) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playTimerSound(state.settings.restTimerSound);
  }
}

function playTimerSound(kind) {
  if (kind === "none") return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const patterns = {
      tritone: [[880, 0], [1100, 0.18], [1320, 0.36]],
      bell: [[1200, 0], [1200, 0.3]],
      chime: [[660, 0], [880, 0.22]],
      alert: [[980, 0], [980, 0.25], [980, 0.5]],
    };
    (patterns[kind] || patterns.tritone).forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.4);
    });
  } catch { /* audio unavailable */ }
}

/* ---------------- Generic sheet modal ---------------- */

function openSheet(id, title, bodyHtml, footerHtml = "") {
  closeModal(id);
  const modal = document.createElement("div");
  modal.className = "overlay";
  modal.id = `modal-${id}`;
  modal.innerHTML = `<div class="sheet">
      <div class="sheet-header">
        <button class="linklike" onclick="MX.closeModalById('${id}')">Close</button>
        <span class="title">${esc(title)}</span>
        <span style="width:44px;">${footerHtml}</span>
      </div>
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(id); });
  $("#modals").appendChild(modal);
}

function closeModal(id) {
  const el = $(`#modal-${id}`);
  if (el) el.remove();
}

/* ---------------- Plate calculator ---------------- */

function openPlateCalc() {
  const bars = state.settings.barbells;
  const selected = state.settings.selectedBarbellId || (bars[0] && bars[0].id);
  let html = `
    <label class="field"><span>Target weight (${state.settings.unit})</span>
      <input type="number" inputmode="decimal" step="any" id="plate-target" oninput="MX.plateTargetChanged()"></label>
    <label class="field"><span>Percentage: <b id="plate-pct-label">100%</b></span>
      <input type="range" min="0" max="100" value="100" id="plate-pct" oninput="MX.plateTargetChanged()" style="width:100%;"></label>
    <label class="field"><span>Barbell</span>
      <select id="plate-bar" onchange="MX.plateTargetChanged()">
        ${bars.map((b) => `<option value="${b.id}" ${b.id === selected ? "selected" : ""}>${esc(b.name)} — ${weightStr(b.weightKg)}</option>`).join("")}
      </select></label>
    <div class="card" id="plate-result"><span class="muted">Enter a target weight above.</span></div>
    <div class="muted small">Edit barbells and plates in Settings → Equipment.</div>`;
  openSheet("plates", "Plate Calculator", html);
  updatePlateResult();
}

function updatePlateResult() {
  const out = $("#plate-result");
  if (!out) return;
  const target = parseFloat($("#plate-target").value);
  const pct = Number($("#plate-pct").value);
  $("#plate-pct-label").textContent = `${pct}%`;
  const bar = state.settings.barbells.find((b) => b.id === $("#plate-bar").value) || state.settings.barbells[0];
  if (!Number.isFinite(target)) {
    out.innerHTML = `<span class="muted">Enter a target weight above.</span>`;
    return;
  }
  state.settings.selectedBarbellId = bar.id;
  save();
  const effectiveKg = toKg(target) * pct / 100;
  if (effectiveKg < bar.weightKg) {
    out.innerHTML = `<span class="orange">⚠️ Target is below the bar weight (${weightStr(bar.weightKg)})</span>`;
    return;
  }
  let remaining = (effectiveKg - bar.weightKg) / 2;
  const rows = [];
  let loaded = 0;
  for (const plate of [...state.settings.plates].sort((a, b) => b.weightKg - a.weightKg)) {
    if (plate.weightKg <= 0) continue;
    const byWeight = Math.floor(remaining / plate.weightKg + 1e-9);
    const count = Math.min(byWeight, plate.pairCount ?? Infinity);
    if (count > 0) {
      rows.push(`<div class="row"><span class="plate-badge">${fmtWeight(toDisplay(plate.weightKg))}</span><span class="bold">× ${count}</span></div>`);
      remaining -= count * plate.weightKg;
      loaded += count * plate.weightKg;
    }
  }
  const total = bar.weightKg + loaded * 2;
  let html = rows.length ? rows.join("") : `<div class="row"><span>Empty bar — ${weightStr(bar.weightKg)}</span></div>`;
  html += `<div class="row"><span class="bold">Total on bar</span><span class="bold">${weightStr(total)}</span></div>`;
  if (pct < 100) html += `<div class="muted small">Working target: ${weightStr(effectiveKg)}</div>`;
  if (Math.abs(effectiveKg - total) > 0.01) {
    html += `<div class="muted small">Closest loadable — ${weightStr(effectiveKg - total)} short with your plates.</div>`;
  }
  out.innerHTML = html;
}

/* ---------------- Calendar ---------------- */

let calMonth = new Date();
let calSelected = todayYmd();

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const monthName = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const firstDay = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = firstDay.getDay(); // Sunday-start

  const byDate = {};
  for (const s of scheduledSessions()) {
    if (s.isRest) continue;
    (byDate[s.date] = byDate[s.date] || []).push(s);
  }

  let html = `<h1>Calendar</h1>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <button class="secondary" onclick="MX.calPrev()">‹</button>
      <span class="bold">${monthName}</span>
      <button class="secondary" onclick="MX.calNext()">›</button>
    </div>
    <div class="cal-grid">`;
  for (const d of ["S", "M", "T", "W", "T", "F", "S"]) html += `<div class="cal-head">${d}</div>`;
  for (let i = 0; i < lead; i++) html += `<div></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = ymd(new Date(y, m, day));
    const sessions = byDate[dateStr] || [];
    const dots = sessions.slice(0, 3).map((s) => {
      const color = isCompleted(s.key) ? "var(--green)" : isSkipped(s.key) ? "var(--text2)" : s.isDeload ? "var(--orange)" : "var(--accent)";
      return `<span class="dot" style="background:${color}"></span>`;
    }).join("");
    html += `<div class="cal-cell ${dateStr === calSelected ? "selected" : ""} ${dateStr === todayYmd() ? "today" : ""}"
        onclick="MX.calSelect('${dateStr}')">
      <span class="daynum">${day}</span><div class="dots">${dots}</div></div>`;
  }
  html += `</div><h2 class="section">${fmtDate(calSelected)}</h2>`;

  const daySessions = sessionsOn(calSelected);
  if (!daySessions.length) html += `<div class="card muted">Nothing scheduled.</div>`;
  for (const s of daySessions) {
    html += renderCalendarCard(s);
  }
  return html;
}

function renderCalendarCard(s) {
  const log = logFor(s.key);
  const done = log && log.status === "completed";
  const inProgress = log && log.status === "inProgress";
  let html = `<div class="card">
    <div class="row" style="border:none; padding:2px 0;">
      <div>
        <div class="bold">${s.isRest ? "Rest Day" : esc(s.dayName)}</div>
        <div class="muted small">${positionLabel(s)}
          ${s.weekLabel ? `<span class="badge ${s.isDeload ? "deload" : "intro"}">${esc(s.weekLabel)}</span>` : ""}</div>
      </div>
      <div>${done ? `<span class="badge done">Done</span>` : inProgress ? `<span class="badge inprogress">In progress</span>` : isSkipped(s.key) ? `<span class="badge skipped">Skipped</span>` : ""}</div>
    </div>`;

  if (done) {
    html += `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
      <button class="secondary" onclick="MX.viewLog('${log.id}')">🔍 View workout — ${weightStr(logVolumeKg(log))}</button>
      <button class="secondary" onclick="MX.editLog('${log.id}')">✏️ Edit</button>
    </div>`;
  } else if (inProgress) {
    html += `<button class="secondary" style="margin-top:8px;" onclick="MX.openSession('${log.id}')">▶ Resume workout</button>`;
  } else if (!s.isRest) {
    html += `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
      <button class="secondary" onclick="MX.startSession('${s.key}')">▶ Start</button>
      <button class="secondary" onclick="MX.moveSession('${s.key}')">📆 Move</button>
      <button class="secondary" onclick="MX.shiftProgram('${s.key}')">⇥ Shift from here</button>
      <button class="secondary" onclick="MX.toggleSkip('${s.key}')">${isSkipped(s.key) ? "↩︎ Un-skip" : "⏭ Skip"}</button>
      ${state.schedule.dateOverrides[s.key] ? `<button class="secondary" onclick="MX.clearMove('${s.key}')">Reset date</button>` : ""}
      ${s.isDeload ? `<button class="secondary orange" onclick="MX.postponeDeload()">Postpone deload</button>` : ""}
    </div>`;
  }

  const day = programDay(s.key);
  if (day && day.exercises.length) {
    html += `<div class="muted small" style="margin-top:8px;">${day.exercises.map((e) => esc(e.name)).join(" · ")}</div>`;
  }
  html += `</div>`;
  return html;
}

/* --- past workout detail --- */

function openDetailSheet(log) {
  const { week } = parseKey(log.key);
  const w = programWeek(week);
  const duration = log.finishedAt ? Math.max(0, Math.round((new Date(log.finishedAt) - new Date(log.startedAt)) / 60000)) : null;
  let html = `<div class="card">
    <div class="row"><span class="muted">Date</span><span>${fmtDateTime(log.startedAt)}</span></div>
    <div class="row"><span class="muted">Position</span><span>${w.block ? `Block ${w.block} · ` : ""}Week ${week}${w.label ? ` (${w.label})` : ""}</span></div>
    ${duration != null ? `<div class="row"><span class="muted">Duration</span><span>${duration} min</span></div>` : ""}
    <div class="row"><span class="muted">Total volume</span><span class="bold">${weightStr(logVolumeKg(log))}</span></div>
  </div>`;

  for (const ex of log.exercises) {
    const sets = ex.sets.filter((s) => s.completed);
    html += `<div class="card"><div class="bold">${esc(ex.performedName)}</div>
      ${ex.performedName !== ex.plannedName ? `<div class="small orange">substituted for ${esc(ex.plannedName)}</div>` : ""}`;
    if (!sets.length) html += `<div class="muted small" style="margin-top:4px;">No sets completed</div>`;
    sets.forEach((s, i) => {
      const label = s.isDropSet ? `<span class="red">Drop</span>` : s.isWarmup ? "Warm-up" : `Set ${i + 1}`;
      const val = s.weightKg == null ? "—"
        : s.isDropSet ? `${weightStr(s.weightKg)} · to failure`
        : s.reps != null ? `${weightStr(s.weightKg)} × ${s.reps}` : weightStr(s.weightKg);
      html += `<div class="row"><span>${label}</span><span>${val}</span></div>`;
    });
    const best = exBestE1RM(ex);
    if (best) html += `<div class="row"><span class="muted small">Best est. 1RM</span><span class="small">${weightStr(best)}</span></div>`;
    if (ex.notes) html += `<div class="muted small" style="margin-top:6px; font-style:italic;">${esc(ex.notes)}</div>`;
    html += `</div>`;
  }

  html += `<div style="display:flex; gap:10px;">
    <button class="secondary" style="flex:1;" onclick="MX.editLog('${log.id}')">✏️ Edit workout</button>
    <button class="secondary" style="flex:1;" onclick="MX.reopen('${log.id}')">▶ Re-open workout</button>
  </div>`;
  openSheet("detail", `${log.dayName}`, html);
}

/* ---------------- Progress ---------------- */

let progMetric = "volume";
let progScope = "weekly"; // daily | weekly | monthly
let progDay = "all";
let progEx = "all";
let progStart = null; // null = program start
let progEnd = null;   // null = today

/// Calendar bucket (local) a timestamp falls into: day, Monday-started week, or month.
function bucketStart(t) {
  const d = new Date(t);
  if (progScope === "daily") return ymd(d);
  if (progScope === "monthly") return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(monday);
}

function chartPoints() {
  const start = progStart || state.settings.programStartDate;
  const end = progEnd || todayYmd();
  const from = parseYmd(start).getTime();
  const to = parseYmd(end).getTime() + 86400000;
  const raw = [];
  for (const log of completedLogs()) {
    const t = new Date(log.startedAt).getTime();
    if (t < from || t >= to) continue;
    if (progMetric === "volume") {
      if (progDay !== "all" && log.dayName !== progDay) continue;
      const vol = progEx === "all"
        ? logVolumeKg(log)
        : log.exercises.filter((e) => e.performedName === progEx).reduce((a, e) => a + exVolumeKg(e), 0);
      if (vol > 0) raw.push({ t, v: vol });
    } else {
      const cands = log.exercises.filter((e) => progEx === "all" || e.performedName === progEx);
      const best = cands.map(exBestE1RM).filter((v) => v != null);
      if (best.length) raw.push({ t, v: Math.max(...best) });
    }
  }
  // Aggregate into scope buckets: volume sums within a bucket, est. 1RM takes the best.
  const buckets = new Map();
  for (const p of raw) {
    const key = bucketStart(p.t);
    const cur = buckets.get(key);
    if (cur == null) buckets.set(key, p.v);
    else buckets.set(key, progMetric === "volume" ? cur + p.v : Math.max(cur, p.v));
  }
  return [...buckets.entries()]
    .map(([key, v]) => ({ t: parseYmd(key).getTime(), v }))
    .sort((a, b) => a.t - b.t);
}

function loggedExerciseNames() {
  const names = new Set();
  for (const log of completedLogs()) for (const ex of log.exercises) if (exVolumeKg(ex) > 0) names.add(ex.performedName);
  return [...names].sort();
}

function renderProgress() {
  const pts = chartPoints();
  const start = progStart || state.settings.programStartDate;
  const end = progEnd || todayYmd();
  let change = null;
  if (pts.length >= 2 && pts[0].v > 0) change = (pts[pts.length - 1].v - pts[0].v) / pts[0].v * 100;

  const dayNames = ["Upper 1", "Lower 1", "Upper 2", "Lower 2", "Arms/Delts"];
  let html = `<h1>Progress</h1>
    <div class="card">
      <div class="segmented" style="margin-bottom:10px;">
        <button class="${progMetric === "volume" ? "on" : ""}" onclick="MX.setMetric('volume')">Volume</button>
        <button class="${progMetric === "e1rm" ? "on" : ""}" onclick="MX.setMetric('e1rm')">Est. 1RM</button>
      </div>
      <div class="segmented" style="margin-bottom:10px;">
        ${["daily", "weekly", "monthly"].map((s) =>
          `<button class="${progScope === s ? "on" : ""}" onclick="MX.setScope('${s}')">${s[0].toUpperCase() + s.slice(1)}</button>`
        ).join("")}
      </div>
      ${progMetric === "volume" ? `<label class="field"><span>Day</span>
        <select onchange="MX.setDayFilter(this.value)">
          <option value="all" ${progDay === "all" ? "selected" : ""}>All days</option>
          ${dayNames.map((d) => `<option ${progDay === d ? "selected" : ""}>${d}</option>`).join("")}
        </select></label>` : ""}
      <label class="field"><span>Exercise</span>
        <select onchange="MX.setExFilter(this.value)">
          <option value="all" ${progEx === "all" ? "selected" : ""}>All exercises</option>
          ${loggedExerciseNames().map((n) => `<option ${progEx === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
        </select></label>
      <div style="display:flex; gap:8px;">
        <label class="field" style="flex:1;"><span>From</span>
          <input type="date" value="${start}" onchange="MX.setRangeStart(this.value)"></label>
        <label class="field" style="flex:1;"><span>To</span>
          <input type="date" value="${end}" onchange="MX.setRangeEnd(this.value)"></label>
      </div>
      ${progStart || progEnd ? `<button class="linklike" onclick="MX.resetRange()">Reset to Week 1 → today</button>` : ""}
    </div>`;

  html += `<div class="card">`;
  if (change != null) {
    const up = change >= 0;
    html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
      <span style="font-size:24px;">${up ? "📈" : "📉"}</span>
      <div><div class="bold ${up ? "green" : "red"}" style="font-size:20px;">${up ? "+" : ""}${change.toFixed(1)}%</div>
      <div class="muted small">${progScope} ${progMetric === "volume" ? "volume" : "est. 1RM"} · ${fmtDate(start)} → ${fmtDate(end)}</div></div>
    </div>`;
  }
  if (!pts.length) {
    html += `<div class="muted" style="padding:40px 0; text-align:center;">No data in range.<br><span class="small">Finish a session (or widen the range) and your progression shows up here.</span></div>`;
  } else {
    html += `<canvas id="chart"></canvas>`;
  }
  html += `</div>`;

  const logs = completedLogs();
  if (logs.length) {
    html += `<div class="card">
      <div class="row"><span class="muted">Sessions logged</span><span>${logs.length}</span></div>
      ${pts.length ? `<div class="row"><span class="muted">Best in range</span><span>${weightStr(Math.max(...pts.map((p) => p.v)))}</span></div>` : ""}
    </div>`;
  }
  return html;
}

function drawChart() {
  const canvas = $("#chart");
  if (!canvas) return;
  const pts = chartPoints();
  if (!pts.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 240;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const pad = { l: 44, r: 10, t: 12, b: 24 };
  const xs = pts.map((p) => p.t);
  const vals = pts.map((p) => toDisplay(p.v));
  const minX = Math.min(...xs), maxX = Math.max(...xs) === minX ? minX + 1 : Math.max(...xs);
  let minV = Math.min(...vals), maxV = Math.max(...vals);
  if (minV === maxV) { minV *= 0.9; maxV *= 1.1; }
  const padV = (maxV - minV) * 0.1;
  minV -= padV; maxV += padV;
  if (minV < 0) minV = 0;

  const X = (t) => pad.l + (t - minX) / (maxX - minX) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - minV) / (maxV - minV)) * (h - pad.t - pad.b);

  const css = getComputedStyle(document.documentElement);
  const lineColor = css.getPropertyValue("--accent").trim() || "#f28f4a";
  const gridColor = css.getPropertyValue("--line").trim() || "#444";
  const textColor = css.getPropertyValue("--text2").trim() || "#888";

  // grid + y labels
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = "10px -apple-system, sans-serif";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const v = minV + (maxV - minV) * i / 4;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(fmtWeight(v), 4, y + 3);
  }
  // x labels: first and last date
  const d0 = new Date(minX), d1 = new Date(maxX);
  ctx.fillText(d0.toLocaleDateString(undefined, { month: "short", day: "numeric" }), pad.l, h - 8);
  const lastLabel = d1.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  ctx.fillText(lastLabel, w - pad.r - ctx.measureText(lastLabel).width, h - 8);

  // line
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = X(p.t), y = Y(toDisplay(p.v));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  // points
  ctx.fillStyle = lineColor;
  pts.forEach((p) => {
    ctx.beginPath();
    ctx.arc(X(p.t), Y(toDisplay(p.v)), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

/* ---------------- Coach ---------------- */

let coachStreaming = false;

function renderCoach() {
  const hasKey = !!localStorage.getItem("minmax-api-key");
  let html = `<h1>AI Coach</h1>`;
  if (!hasKey) {
    html += `<div class="card"><div class="bold">🔑 Coach is offline</div>
      <div class="muted small" style="margin-top:4px;">Add your Anthropic API key in Settings → AI Coach. The coach sees your program position, recent sessions, and progression.</div></div>`;
  }
  html += `<div class="chat" id="chat">`;
  if (!state.coach.length) {
    const suggestions = [
      "How am I progressing on my upper body lifts?",
      "What weight should I use for incline press next session?",
      "Should I postpone the deload week?",
    ];
    html += `<div class="muted small">Ask anything — the coach sees your program position and logged sessions.</div>`;
    suggestions.forEach((s) => {
      html += `<button class="secondary" style="text-align:left;" ${hasKey ? `onclick="MX.sendCoach('${s.replace(/'/g, "\\'")}')"` : "disabled"}>${s}</button>`;
    });
  }
  for (const msg of state.coach) {
    html += `<div class="bubble ${msg.role}">${esc(msg.text)}${msg.text === "" && coachStreaming ? '<span class="spin"></span>' : ""}</div>`;
  }
  html += `</div>
    <div class="chat-input">
      <textarea id="coach-input" rows="1" placeholder="Message your coach…" onkeydown="MX.coachKeyDown(event)"></textarea>
      <button class="primary" onclick="MX.sendCoach()" ${coachStreaming || !hasKey ? "disabled" : ""}>↑</button>
    </div>`;
  return html;
}

function scrollChat() {
  const view = $("#view");
  if (currentTab === "coach") view.scrollTop = view.scrollHeight;
}

function coachSystemPrompt() {
  const lines = [];
  lines.push(`You are the built-in strength coach of MinMax, a web app tracking the user's run through Jeff Nippard's Min-Max Program (5x/week: Upper 1, Lower 1, Upper 2, Lower 2, Arms/Delts; 12 weeks in two blocks — Block 1 weeks 1-6, Block 2 weeks 7-12; week 1 intro, one deload week; Block 2 adds last-set intensity techniques like drop sets, myo-reps, and lengthened partials). Sets go to 0-1 RIR except intro/deload weeks. Give concise, practical coaching grounded in the data below. Use ${state.settings.unit} for weights and respect the program's rep ranges and RIR targets.`);
  const next = nextSession();
  if (next) {
    lines.push(`\nPROGRAM POSITION: next session is ${next.dayName}, ${positionLabel(next)} of 12 weeks${next.weekLabel ? ` (${next.weekLabel})` : ""}, scheduled ${fmtDate(next.date)}.`);
    const day = programDay(next.key);
    if (day) {
      lines.push("Next session plan: " + day.exercises.map((ex) =>
        `${ex.name} — ${ex.workingSets}x${ex.repRange || "?"} reps, RIR ${ex.rirSet1 || "?"}/${ex.rirSet2 || "-"}${ex.intensityTechnique ? `, last set: ${ex.intensityTechnique}` : ""}`
      ).join("; "));
    }
  }
  const recent = completedLogs().slice(-6);
  if (!recent.length) {
    lines.push("\nTRAINING HISTORY: none logged yet.");
  } else {
    lines.push("\nRECENT SESSIONS (oldest to newest):");
    for (const log of recent) {
      const exs = log.exercises.filter((e) => exVolumeKg(e) > 0).map((e) => {
        const sets = e.sets.filter((s) => s.completed && !s.isWarmup)
          .map((s) => s.weightKg == null ? null : s.isDropSet ? `drop ${fmtWeight(toDisplay(s.weightKg))}` : `${fmtWeight(toDisplay(s.weightKg))}x${s.reps ?? "?"}`)
          .filter(Boolean).join(",");
        const sub = e.performedName !== e.plannedName ? ` (sub for ${e.plannedName})` : "";
        const note = e.notes ? ` [note: ${e.notes}]` : "";
        return `${e.performedName}${sub}: ${sets}${note}`;
      }).join(" | ");
      lines.push(`- ${fmtDateTime(log.startedAt)} ${log.dayName} [total volume ${weightStr(logVolumeKg(log))}]: ${exs}`);
    }
  }
  if (state.schedule.skippedKeys.length) lines.push(`Skipped sessions so far: ${state.schedule.skippedKeys.length}.`);
  return lines.join("\n");
}

async function sendCoach(preset) {
  const input = $("#coach-input");
  const text = (preset || (input && input.value) || "").trim();
  if (!text || coachStreaming) return;
  const apiKey = localStorage.getItem("minmax-api-key");
  if (!apiKey) return;

  state.coach.push({ role: "user", text });
  state.coach.push({ role: "assistant", text: "" });
  coachStreaming = true;
  save(); render();

  try {
    const messages = state.coach
      .filter((m) => !(m.role === "assistant" && m.text === ""))
      .map((m) => ({ role: m.role, content: m.text }));

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 4096,
        stream: true,
        thinking: { type: "adaptive" },
        system: coachSystemPrompt(),
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const assistant = state.coach[state.coach.length - 1];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
            assistant.text += event.delta.text;
            const chat = $("#chat");
            if (chat && chat.lastElementChild) {
              chat.lastElementChild.textContent = assistant.text;
              scrollChat();
            }
          }
        } catch { /* partial line */ }
      }
    }
    if (!assistant.text) assistant.text = "(No response — try rephrasing.)";
  } catch (err) {
    state.coach.pop(); // drop empty assistant bubble
    state.coach.push({ role: "assistant", text: `⚠️ ${err.message}` });
  } finally {
    coachStreaming = false;
    save(); render();
  }
}

/* ---------------- Settings ---------------- */

function openSettings() {
  const s = state.settings;
  const html = `
    <h2 class="section">Units</h2>
    <div class="card"><div class="segmented">
      <button class="${s.unit === "kg" ? "on" : ""}" onclick="MX.setUnit('kg')">kg</button>
      <button class="${s.unit === "lbs" ? "on" : ""}" onclick="MX.setUnit('lbs')">lbs</button>
    </div></div>

    <h2 class="section">Appearance</h2>
    <div class="card"><div class="segmented">
      ${["system", "light", "dark"].map((t) => `<button class="${s.appearance === t ? "on" : ""}" onclick="MX.setTheme('${t}')">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
    </div></div>

    <h2 class="section">Program schedule</h2>
    <div class="card">
      <label class="field"><span>Week 1 start date</span>
        <input type="date" value="${s.programStartDate}" onchange="MX.setStartDate(this.value)"></label>
      <div class="muted small" style="margin-bottom:10px;">Week 1 begins on a ${parseYmd(s.programStartDate).toLocaleDateString(undefined, { weekday: "long" })} — each session lands on the same weekday every week, so pick the weekday you actually start on.</div>
      <button class="secondary" onclick="MX.postponeDeload()">Postpone deload by one week</button>
    </div>

    <h2 class="section">Rest timer</h2>
    <div class="card">
      <label class="field"><span>Sound when timer ends</span>
        <select onchange="MX.setRestSound(this.value)">
          ${["none", "tritone", "bell", "chime", "alert"].map((k) => `<option value="${k}" ${s.restTimerSound === k ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}
        </select></label>
      <div class="muted small">The timer also vibrates on devices that support it.</div>
    </div>

    <h2 class="section">Equipment</h2>
    <div class="card">
      <div class="bold small" style="margin-bottom:4px;">Barbells</div>
      ${s.barbells.map((b) => `<div class="row"><span>${esc(b.name)} — ${weightStr(b.weightKg)}</span>
        <button class="linklike danger" onclick="MX.removeBarbell('${b.id}')">Remove</button></div>`).join("")}
      <div style="display:flex; gap:6px; margin-top:8px;">
        <input type="text" id="new-bar-name" placeholder="Name" style="flex:2;">
        <input type="number" id="new-bar-weight" placeholder="${s.unit}" style="flex:1;">
        <button class="secondary" onclick="MX.addBarbell()">Add</button>
      </div>
      <div class="bold small" style="margin:14px 0 4px;">Plates <span class="muted">(count per side, blank = unlimited)</span></div>
      ${s.plates.map((p) => `<div class="row"><span class="plate-badge">${fmtWeight(toDisplay(p.weightKg))}</span>
        <input type="number" placeholder="∞" value="${p.pairCount ?? ""}" style="width:70px;" onchange="MX.setPlateCount('${p.id}', this.value)">
        <button class="linklike danger" onclick="MX.removePlate('${p.id}')">Remove</button></div>`).join("")}
      <div style="display:flex; gap:6px; margin-top:8px;">
        <input type="number" id="new-plate-weight" placeholder="Plate weight (${s.unit})" style="flex:1;">
        <button class="secondary" onclick="MX.addPlate()">Add</button>
      </div>
    </div>

    <h2 class="section">AI Coach</h2>
    <div class="card">
      <label class="field"><span>Anthropic API key ${localStorage.getItem("minmax-api-key") ? "(saved ✓)" : ""}</span>
        <input type="password" id="api-key-input" placeholder="sk-ant-…"></label>
      <button class="secondary" onclick="MX.saveApiKey(document.getElementById('api-key-input').value)">Save API key</button>
      <div class="muted small" style="margin-top:6px;">Stored only in this browser (localStorage) and sent only to Anthropic's API.</div>
    </div>

    <h2 class="section">Data</h2>
    <div class="card">
      <button class="secondary" style="width:100%; margin-bottom:8px;" onclick="MX.exportXlsx()">📊 Export data to Excel (.xlsx)</button>
      <button class="secondary" style="width:100%; margin-bottom:8px;" onclick="MX.exportBackup()">💾 Download backup (JSON)</button>
      <label class="secondary" style="display:block; text-align:center; padding:9px 14px; border-radius:12px; cursor:pointer; background:var(--card2); font-weight:600; font-size:14px;">
        📥 Import backup<input type="file" accept=".json" style="display:none;" onchange="MX.importBackup(this.files)"></label>
    </div>
    <div class="card">
      <button class="linklike danger" onclick="MX.resetSchedule()">Reset all schedule adjustments</button>
    </div>`;
  openSheet("settings", "Settings", html);
}

/* ---------------- Export (xlsx + backup) ---------------- */

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportBackup() {
  download("minmax-backup.json", new Blob([JSON.stringify(state, null, 1)], { type: "application/json" }));
}

function exportXlsx() {
  const unit = state.settings.unit;
  const setRows = [["Date", "Block", "Program Week", "Day", "Exercise (planned)", "Exercise (performed)", "Set", "Set Type", `Weight (${unit})`, "Reps", `Volume (${unit})`, "Notes"]];
  const sessionRows = [["Date", "Block", "Program Week", "Day", "Status", "Duration (min)", `Total Volume (${unit})`]];

  for (const log of state.logs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const { week } = parseKey(log.key);
    const w = programWeek(week);
    const dur = log.finishedAt ? Math.round((new Date(log.finishedAt) - new Date(log.startedAt)) / 60000) : "";
    sessionRows.push([fmtIsoForExcel(log.startedAt), w.block ?? "", week, log.dayName, log.status, dur, round2(toDisplay(logVolumeKg(log)))]);
    if (log.status !== "completed") continue;
    for (const ex of log.exercises) {
      let n = 0;
      for (const set of ex.sets) {
        if (!set.completed) continue;
        n += 1;
        setRows.push([
          fmtIsoForExcel(log.startedAt), w.block ?? "", week, log.dayName,
          ex.plannedName, ex.performedName, n,
          set.isWarmup ? "warm-up" : set.isDropSet ? "drop" : "working",
          set.weightKg != null ? round2(toDisplay(set.weightKg)) : "",
          set.reps ?? "",
          round2(toDisplay(setVolumeKg(set))),
          ex.notes || "",
        ]);
      }
    }
  }
  const blob = buildXlsx([
    { name: "Workout Log", rows: setRows },
    { name: "Sessions", rows: sessionRows },
  ]);
  download("MinMax-Export.xlsx", blob);
}

function round2(v) { return Math.round(v * 100) / 100; }
function fmtIsoForExcel(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* Minimal XLSX writer: zip of XML parts with stored (uncompressed) entries. */
function buildXlsx(sheets) {
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colName = (i) => {
    let name = "";
    do { name = String.fromCharCode(65 + (i % 26)) + name; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return name;
  };
  const worksheet = (sheet) => {
    let rows = "";
    sheet.rows.forEach((row, r) => {
      let cells = "";
      row.forEach((cell, c) => {
        if (cell === "" || cell == null) return;
        const ref = `${colName(c)}${r + 1}`;
        if (typeof cell === "number") cells += `<c r="${ref}"><v>${cell}</v></c>`;
        else cells += `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(cell)}</t></is></c>`;
      });
      rows += `<row r="${r + 1}">${cells}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, worksheet(s)]),
  ];
  return new Blob([zipStored(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ZIP with stored entries + CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStored(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
  const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  for (const [path, content] of files) {
    const name = enc.encode(path);
    const data = enc.encode(content);
    const crc = crc32(data);
    const header = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(name.length), ...le16(0),
    ]);
    chunks.push(header, name, data);
    central.push(new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(name.length),
      ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset),
    ]), name);
    offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length),
    ...le32(centralSize), ...le32(offset), ...le16(0),
  ]);
  const total = [...chunks, ...central, eocd];
  const size = total.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of total) { out.set(c, pos); pos += c.length; }
  return out;
}

/* ---------------- Init ---------------- */

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
applyTheme();
switchTab("today");

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
