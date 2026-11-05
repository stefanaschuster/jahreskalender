"use strict";
/* Gemeinsame Helfer für Desktop (app.js) und Smartphone (mobile.js) */

/* ---------- Datums-Helfer (alles in UTC, Strings im Format YYYY-MM-DD) ---------- */
const MS_DAY = 86400000;
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
  "August", "September", "Oktober", "November", "Dezember"];
const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const mk = (y, m, d) => new Date(Date.UTC(y, m, d));
const iso = (dt) => dt.toISOString().slice(0, 10);
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return mk(y, m - 1, d); };
const addDays = (dt, n) => new Date(dt.getTime() + n * MS_DAY);
const wd = (dt) => (dt.getUTCDay() + 6) % 7;                // Montag = 0
const mondayOf = (dt) => addDays(dt, -wd(dt));
const daysBetween = (a, b) => Math.round((b - a) / MS_DAY);
const fmt = (s) => { const d = parse(s); return `${WD_SHORT[wd(d)]}, ${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`; };
const fmtShort = (dt) => `${dt.getUTCDate()}.${dt.getUTCMonth() + 1}.`;

function isoWeek(dt) {
  const thu = addDays(dt, 3 - wd(dt));
  const jan1 = mk(thu.getUTCFullYear(), 0, 1);
  return 1 + Math.floor(daysBetween(jan1, thu) / 7);
}

function easter(y) {                                       // Gauß/Meeus, gregorianisch
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return mk(y, month - 1, day);
}

// Gesetzliche Feiertage Baden-Württemberg
function holidays(y) {
  const e = easter(y), map = new Map();
  const add = (dt, name) => map.set(iso(dt), name);
  add(mk(y, 0, 1), "Neujahr");
  add(mk(y, 0, 6), "Heilige Drei Könige");
  add(addDays(e, -2), "Karfreitag");
  add(addDays(e, 1), "Ostermontag");
  add(mk(y, 4, 1), "Tag der Arbeit");
  add(addDays(e, 39), "Christi Himmelfahrt");
  add(addDays(e, 50), "Pfingstmontag");
  add(addDays(e, 60), "Fronleichnam");
  add(mk(y, 9, 3), "Tag der Deutschen Einheit");
  add(mk(y, 10, 1), "Allerheiligen");
  add(mk(y, 11, 25), "1. Weihnachtstag");
  add(mk(y, 11, 26), "2. Weihnachtstag");
  return map;
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

/* ---------- API ---------- */
function track(action, detail = "") {                        // Aktivitätsprotokoll, Fehler egal
  fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, detail: String(detail).slice(0, 200) }) }).catch(() => {});
}
const weekDetail = (mIso) => `KW ${isoWeek(parse(mIso))} (${fmtShort(parse(mIso))}${parse(mIso).getUTCFullYear()})`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join(", ") : d || `Fehler ${res.status}`);
  }
  return data;
}

/* ---------- Eigenes Passwort ändern (Desktop + Handy) ---------- */
function setupPasswordDialog(dialog, openBtn) {
  const form = dialog.querySelector("form");
  const err = form.querySelector(".error");
  openBtn.addEventListener("click", () => {
    form.reset();
    err.hidden = true;
    form.querySelector("[data-ok]").hidden = true;
    form.querySelector("[data-fields]").hidden = false;
    form.querySelector("[type=submit]").hidden = false;
    dialog.showModal();
    form.old_password.focus();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (form.new_password.value !== form.new_password2.value) {
      err.textContent = "Die neuen Passwörter stimmen nicht überein";
      err.hidden = false;
      return;
    }
    try {
      await api("POST", "/api/password", { old_password: form.old_password.value, new_password: form.new_password.value });
      form.reset();
      form.querySelector("[data-fields]").hidden = true;
      form.querySelector("[type=submit]").hidden = true;
      form.querySelector("[data-ok]").hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

/* ---------- Teilnehmer-Filter (Desktop + Handy) ----------
   Mehrfachauswahl von Personen; "geplant" und "gebucht" zählen gleich als "dabei".
   Modus "alle":  Event wird gezeigt, wenn ALLE gewählten Personen dabei sind.
   Modus "einer": Event wird gezeigt, wenn MINDESTENS EINE gewählte Person dabei ist. */
const peopleFilter = { names: new Set(), mode: "alle", users: [] };

function loadPeopleFilter(users) {
  peopleFilter.users = users;
  try {
    const d = JSON.parse(localStorage.getItem("kal-people") || "{}");
    peopleFilter.names = new Set((d.names || []).filter((n) => users.includes(n)));   // gelöschte User raus
    peopleFilter.mode = d.mode === "einer" ? "einer" : "alle";
  } catch { /* Speicher nicht verfügbar */ }
}

function savePeopleFilter() {
  try { localStorage.setItem("kal-people", JSON.stringify({ names: [...peopleFilter.names], mode: peopleFilter.mode })); } catch {}
}

function matchesPeople(ev) {
  if (!peopleFilter.names.size) return true;
  const there = new Set(ev.participants.map((p) => p.username));
  const sel = [...peopleFilter.names];
  return peopleFilter.mode === "einer" ? sel.some((n) => there.has(n)) : sel.every((n) => there.has(n));
}

// Auswahl-Panel: Modus-Umschalter + Checkbox je Person
function buildPeoplePanel(container, onChange) {
  container.replaceChildren();
  const mode = el("div", "pf-mode");
  for (const [m, label] of [["alle", "alle zusammen"], ["einer", "mindestens einer"]]) {
    const b = el("button", "pf-seg", label);
    b.type = "button";
    b.classList.toggle("active", peopleFilter.mode === m);
    b.addEventListener("click", () => { peopleFilter.mode = m; savePeopleFilter(); buildPeoplePanel(container, onChange); onChange(); });
    mode.append(b);
  }
  const list = el("div", "pf-list");
  for (const name of peopleFilter.users) {
    const lab = el("label", "pf-item");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = peopleFilter.names.has(name);
    cb.addEventListener("change", () => {
      if (cb.checked) peopleFilter.names.add(name); else peopleFilter.names.delete(name);
      savePeopleFilter();
      onChange();
    });
    lab.append(cb, el("span", null, name));
    list.append(lab);
  }
  const reset = el("button", "btn pf-reset", "Auswahl löschen");
  reset.type = "button";
  reset.addEventListener("click", () => { peopleFilter.names.clear(); savePeopleFilter(); buildPeoplePanel(container, onChange); onChange(); });
  container.append(el("div", "pf-hint", "Zeigt Events, bei denen die Gewählten geplant oder gebucht haben."), mode, list, reset);
}

// Leiste mit aktiver Auswahl: "Sergio + Oli · 3 Events" mit × je Person
function buildPeopleBar(container, count, onChange) {
  container.replaceChildren();
  container.hidden = !peopleFilter.names.size;
  if (!peopleFilter.names.size) return;
  const sep = peopleFilter.mode === "einer" ? " oder " : " + ";
  container.append(el("span", "pf-label", "Dabei:"));
  [...peopleFilter.names].forEach((n, i) => {
    if (i) container.append(el("span", "pf-sep", sep.trim()));
    const chip = el("button", "pf-chip", n);
    chip.type = "button";
    chip.title = `${n} entfernen`;
    chip.addEventListener("click", () => { peopleFilter.names.delete(n); savePeopleFilter(); onChange(); });
    container.append(chip);
  });
  container.append(el("span", "pf-count", `· ${count} ${count === 1 ? "Event" : "Events"}`));
}
