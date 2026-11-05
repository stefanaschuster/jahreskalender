"use strict";

/* ---------- Zustand ---------- */
const state = { version: null, me: null, year: 2027, events: [], holidays: new Map(), onlyMine: false, week: null, openEventId: null };

async function loadEvents() {
  const { v } = await api("GET", "/api/version");      // Version vor den Daten holen: verpasst keine Änderung
  state.events = await api("GET", "/api/events");
  state.version = v;
  hideTip();
  render();
}

/* Live-Aktualisierung: Versionszähler abfragen, nur bei Änderung neu laden */
const POLL_MS = 10000;
let polling = false;

async function checkForUpdates() {
  if (polling || document.hidden || drag) return;
  polling = true;
  try {
    const { v } = await api("GET", "/api/version");
    if (v !== state.version) await loadEvents();
  } catch { /* offline o. Ä.: beim nächsten Durchlauf erneut */ }
  finally { polling = false; }
}

setInterval(checkForUpdates, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdates(); });
window.addEventListener("focus", checkForUpdates);

function visibleEvents() {
  return state.events.filter((e) => (!state.onlyMine || e.my_status) && matchesPeople(e));
}

function renderPeopleFilter() {
  const n = peopleFilter.names.size;
  $("pf-btn").textContent = n ? `Teilnehmer (${n}) ▾` : "Teilnehmer ▾";
  $("pf-btn").classList.toggle("on", n > 0);
  buildPeopleBar($("pf-bar"), visibleEvents().length, onPeopleChange);
}

function onPeopleChange() {
  if ($("pf").open) buildPeoplePanel($("pf-panel"), onPeopleChange);
  render();
}

/* Spuren (Lanes) vergeben, damit sich überlappende Events nicht verdecken */
function assignLanes(segs) {
  segs.sort((a, b) => a.s - b.s || b.e - a.e);
  const laneEnd = [];
  for (const seg of segs) {
    let lane = laneEnd.findIndex((end) => end < seg.s);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(seg.e); } else laneEnd[lane] = seg.e;
    seg.lane = lane;
  }
  return laneEnd.length;
}

function eventButton(ev, cls) {
  const b = el("button", `ev ${ev.my_status || "none"} ${cls || ""}`);
  b.type = "button";
  b.dataset.id = ev.id;
  b.setAttribute("aria-label", ev.title);
  return b;
}

/* ---------- Jahresansicht ---------- */
const COLS = 37;                                           // max. 6 Versatz + 31 Tage

function renderYear() {
  const root = $("year-view");
  const scroll = root.scrollTop;
  root.replaceChildren();
  const todayIso = iso(new Date());

  const head = el("div", "year-head");
  head.append(el("div", "mlabel"));
  for (let c = 0; c < COLS; c++) head.append(el("div", `wdh ${c % 7 >= 5 ? "we" : ""}`, WD_SHORT[c % 7]));
  root.append(head);

  const events = visibleEvents();
  for (let m = 0; m < 12; m++) {
    const first = mk(state.year, m, 1), last = mk(state.year, m + 1, 0);
    const off = wd(first), nDays = last.getUTCDate();
    const fIso = iso(first), lIso = iso(last);

    const segs = [];
    for (const ev of events) {
      if (ev.end_date < fIso || ev.start_date > lIso) continue;
      const s = ev.start_date < fIso ? 1 : parse(ev.start_date).getUTCDate();
      const e = ev.end_date > lIso ? nDays : parse(ev.end_date).getUTCDate();
      segs.push({ ev, s, e, contL: ev.start_date < fIso, contR: ev.end_date > lIso });
    }
    const lanes = Math.max(2, assignLanes(segs));

    const row = el("div", "month-row");
    row.style.gridTemplateRows = `var(--dayhead) repeat(${lanes}, var(--lane))`;
    const span = `1 / span ${lanes + 1}`;

    const label = el("div", "mlabel", MONTHS[m]);
    label.style.gridRow = span;
    row.append(label);

    for (let c = 0; c < COLS; c++) {
      const day = c - off + 1;
      let cell;
      if (day < 1 || day > nDays) {
        cell = el("div", `pad ${c % 7 >= 5 ? "we" : ""}`);
      } else {
        const dt = mk(state.year, m, day), dIso = iso(dt);
        const hol = state.holidays.get(dIso);
        cell = el("div", "day");
        if (c % 7 >= 5) cell.classList.add("we");
        if (hol) { cell.classList.add("hol"); cell.title = hol; }
        if (dIso === todayIso) cell.classList.add("today");
        cell.dataset.date = dIso;
        const num = el("span", "dnum", String(day));
        cell.append(num);
        if (wd(dt) === 0 || day === 1) {
          const kw = el("button", "kw", `KW${isoWeek(dt)}`);
          kw.type = "button";
          kw.dataset.week = iso(mondayOf(dt));
          kw.title = "Woche anzeigen";
          cell.append(kw);
        }
      }
      cell.style.gridColumn = String(c + 2);
      cell.style.gridRow = span;
      row.append(cell);
    }

    for (const seg of segs) {
      const b = eventButton(seg.ev, `${seg.contL ? "cont-l" : ""} ${seg.contR ? "cont-r" : ""}`);
      b.textContent = seg.ev.title;
      b.style.gridColumn = `${off + seg.s + 1} / span ${seg.e - seg.s + 1}`;
      b.style.gridRow = String(seg.lane + 2);
      row.append(b);
    }
    root.append(row);
  }
  root.scrollTop = scroll;
}

/* ---------- Wochenansicht ---------- */
function weekBounds() {
  const min = mondayOf(mk(state.year, 0, 1));
  const max = mondayOf(mk(state.year, 11, 31));
  return [min, max];
}

function renderWeek() {
  const root = $("week-view");
  root.replaceChildren();
  const mon = parse(state.week), sun = addDays(mon, 6);
  const mIso = iso(mon), sIso = iso(sun), todayIso = iso(new Date());
  $("week-label").textContent = `KW ${isoWeek(mon)} · ${fmtShort(mon)} – ${fmtShort(sun)}${sun.getUTCFullYear()}`;
  const [minW, maxW] = weekBounds();
  $("btn-prev").disabled = mon <= minW;
  $("btn-next").disabled = mon >= maxW;

  const grid = el("div", "week-grid");
  const segs = [];
  for (const ev of visibleEvents()) {
    if (ev.end_date < mIso || ev.start_date > sIso) continue;
    const s = ev.start_date < mIso ? 0 : daysBetween(mon, parse(ev.start_date));
    const e = ev.end_date > sIso ? 6 : daysBetween(mon, parse(ev.end_date));
    segs.push({ ev, s, e, contL: ev.start_date < mIso, contR: ev.end_date > sIso });
  }
  const lanes = Math.max(3, assignLanes(segs));
  grid.style.gridTemplateRows = `var(--whead) repeat(${lanes}, auto) 1fr`;

  for (let i = 0; i < 7; i++) {
    const dt = addDays(mon, i), dIso = iso(dt);
    const hol = state.holidays.get(dIso);
    const col = el("div", "wcol");
    if (i >= 5) col.classList.add("we");
    if (hol) col.classList.add("hol");
    if (dIso === todayIso) col.classList.add("today");
    if (dt.getUTCFullYear() !== state.year) col.classList.add("outside");
    col.dataset.date = dIso;
    col.style.gridColumn = String(i + 1);
    col.style.gridRow = "1 / -1";
    const h = el("div", "whead");
    h.append(el("span", "wname", WD_LONG[i]), el("span", "wdate", `${dt.getUTCDate()}. ${MONTHS[dt.getUTCMonth()]}`));
    if (hol) h.append(el("span", "whol", hol));
    col.append(h);
    grid.append(col);
  }

  for (const seg of segs) {
    const ev = seg.ev;
    const b = eventButton(ev, `big ${seg.contL ? "cont-l" : ""} ${seg.contR ? "cont-r" : ""}`);
    b.append(el("strong", null, ev.title));
    const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
    b.append(el("span", "meta", days > 1 ? `${fmtShort(parse(ev.start_date))} – ${fmtShort(parse(ev.end_date))} · ${days} Tage` : "1 Tag"));
    if (ev.participants.length) {
      b.append(el("span", "meta", ev.participants.map((p) => `${p.username} (${p.status})`).join(", ")));
    }
    if (ev.note) b.append(el("span", "meta note", ev.note));
    b.style.gridColumn = `${seg.s + 1} / span ${seg.e - seg.s + 1}`;
    b.style.gridRow = String(seg.lane + 2);
    grid.append(b);
  }
  root.append(grid);
}

/* ---------- Ansicht wechseln ---------- */
function render() {
  renderPeopleFilter();
  const inWeek = !!state.week;
  $("year-view").hidden = inWeek;
  $("week-view").hidden = !inWeek;
  $("weeknav").hidden = !inWeek;
  if (inWeek) renderWeek(); else renderYear();
  if (state.openEventId != null) refreshEventDialog();
}

function showWeek(mondayIso) {
  const [minW, maxW] = weekBounds();
  let mon = parse(mondayIso);
  if (mon < minW) mon = minW;
  if (mon > maxW) mon = maxW;
  if (state.week !== iso(mon)) track("ansicht_woche", weekDetail(iso(mon)));
  state.week = iso(mon);
  history.replaceState(null, "", `#w=${state.week}`);
  render();
}

function showYear() {
  const anchor = state.week;
  state.week = null;
  track("ansicht_jahr");
  history.replaceState(null, "", location.pathname);
  render();
  if (anchor) {                                            // Monat der Woche ins Bild holen
    const m = parse(anchor).getUTCFullYear() < state.year ? 0 : parse(anchor).getUTCMonth();
    $("year-view").querySelectorAll(".month-row")[m]?.scrollIntoView({ block: "center" });
  }
}

/* ---------- Event-Dialog ---------- */
function openEvent(id) {
  state.openEventId = id;
  const ev = state.events.find((e) => e.id === id);
  if (ev) track("event_angesehen", ev.title);
  refreshEventDialog();
  const dlg = $("event-dialog");
  if (!dlg.open) dlg.showModal();
}

function refreshEventDialog() {
  const ev = state.events.find((e) => e.id === state.openEventId);
  if (!ev) { $("event-dialog").close(); return; }
  $("ev-title").textContent = ev.title;
  const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
  $("ev-dates").textContent = days > 1
    ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} (${days} Tage)` : fmt(ev.start_date);
  $("ev-note").textContent = ev.note;
  $("ev-note").hidden = !ev.note;
  for (const b of $("event-dialog").querySelectorAll("[data-status]")) {
    b.classList.toggle("active", (ev.my_status || "") === b.dataset.status);
  }
  const ul = $("ev-participants");
  ul.replaceChildren();
  if (!ev.participants.length) ul.append(el("li", "muted", "noch niemand"));
  for (const p of ev.participants) {
    const li = el("li");
    li.append(el("span", null, p.username), el("span", `chip ${p.status}`, p.status));
    ul.append(li);
  }
  $("ev-creator").textContent = ev.creator ? `angelegt von ${ev.creator}` : "";
  $("ev-admin").hidden = !ev.can_edit;
}

async function setStatus(status) {
  const id = state.openEventId;
  try {
    const updated = await api("PUT", `/api/events/${id}/mark`, { status: status || null });
    state.events = state.events.map((e) => (e.id === id ? updated : e));
    render();
  } catch (err) { alert(err.message); }
}

/* ---------- Admin: Event anlegen / bearbeiten ---------- */
let editId = null;

function openEdit(ev, start, end) {
  editId = ev ? ev.id : null;
  const f = $("edit-form");
  $("edit-heading").textContent = ev ? "Event bearbeiten" : "Neues Event";
  f.title.value = ev ? ev.title : "";
  f.start_date.value = ev ? ev.start_date : start;
  f.end_date.value = ev ? ev.end_date : (end || start);
  f.note.value = ev ? ev.note : "";
  $("edit-error").hidden = true;
  $("edit-dialog").showModal();
  f.title.focus();
}

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  let start = f.start_date.value, end = f.end_date.value;
  if (end < start) [start, end] = [end, start];
  const body = { title: f.title.value, start_date: start, end_date: end, note: f.note.value };
  try {
    if (editId) await api("PUT", `/api/events/${editId}`, body);
    else await api("POST", "/api/events", body);
    $("edit-dialog").close();
    await loadEvents();
  } catch (err) {
    $("edit-error").textContent = err.message;
    $("edit-error").hidden = false;
  }
});
$("edit-close").addEventListener("click", () => $("edit-dialog").close());
$("edit-form").start_date.addEventListener("change", (e) => {
  const end = $("edit-form").end_date;
  if (!end.value || end.value < e.target.value) end.value = e.target.value;
});

$("ev-edit").addEventListener("click", () => {
  const ev = state.events.find((e) => e.id === state.openEventId);
  $("event-dialog").close();
  openEdit(ev);
});
$("ev-delete").addEventListener("click", async () => {
  const ev = state.events.find((e) => e.id === state.openEventId);
  if (!ev || !confirm(`„${ev.title}“ wirklich löschen? Alle Markierungen gehen verloren.`)) return;
  try {
    await api("DELETE", `/api/events/${ev.id}`);
    $("event-dialog").close();
    await loadEvents();
  } catch (err) { alert(err.message); }
});
$("event-dialog").addEventListener("close", () => { state.openEventId = null; });
for (const b of $("event-dialog").querySelectorAll("[data-status]")) {
  b.addEventListener("click", () => setStatus(b.dataset.status));
}

/* ---------- Klicks & Ziehen in der Jahresansicht ---------- */
let drag = null;

function highlightRange(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (const c of $("year-view").querySelectorAll(".day")) {
    c.classList.toggle("sel", c.dataset.date >= lo && c.dataset.date <= hi);
  }
}

$("year-view").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".ev, .kw")) return;
  const cell = e.target.closest(".day");
  if (!cell) return;
  e.preventDefault();
  drag = { start: cell.dataset.date, end: cell.dataset.date };
  hideTip();
  highlightRange(drag.start, drag.end);
});
$("year-view").addEventListener("mouseover", (e) => {
  if (!drag) return;
  const cell = e.target.closest(".day");
  if (cell && cell.dataset.date !== drag.end) { drag.end = cell.dataset.date; highlightRange(drag.start, drag.end); }
});
document.addEventListener("mouseup", () => {
  if (!drag) return;
  const { start, end } = drag;
  drag = null;
  highlightRange("9999", "9999");
  if (start !== end) {
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    openEdit(null, lo, hi);
    suppressClick = true;
  }
});
let suppressClick = false;

$("year-view").addEventListener("click", (e) => {
  if (suppressClick) { suppressClick = false; return; }
  const ev = e.target.closest(".ev");
  if (ev) { openEvent(Number(ev.dataset.id)); return; }
  const kw = e.target.closest(".kw");
  if (kw) { showWeek(kw.dataset.week); return; }
  const day = e.target.closest(".day");
  if (day) showWeek(iso(mondayOf(parse(day.dataset.date))));
});

$("week-view").addEventListener("click", (e) => {
  const ev = e.target.closest(".ev");
  if (ev) { openEvent(Number(ev.dataset.id)); return; }
  const col = e.target.closest(".wcol");
  if (col && !col.classList.contains("outside")) openEdit(null, col.dataset.date);
});

/* ---------- Tooltip: wer hat geplant / gebucht ---------- */
const tip = $("tip");

function fillTip(ev) {
  tip.replaceChildren();
  tip.append(el("strong", null, ev.title));
  const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
  tip.append(el("div", "tip-dates", days > 1 ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} (${days} Tage)` : fmt(ev.start_date)));
  for (const status of ["gebucht", "geplant"]) {
    const names = ev.participants.filter((p) => p.status === status).map((p) => p.username);
    if (!names.length) continue;
    const row = el("div", "tip-row");
    row.append(el("span", `chip ${status}`, status), el("span", null, names.join(", ")));
    tip.append(row);
  }
  if (!ev.participants.length) tip.append(el("div", "tip-empty", "noch niemand eingetragen"));
  if (ev.creator) tip.append(el("div", "tip-empty", `angelegt von ${ev.creator}`));
}

function placeTip(x, y) {
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > innerWidth - 8) left = x - w - pad;
  if (top + h > innerHeight - 8) top = y - h - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() { tip.hidden = true; }

document.addEventListener("mouseover", (e) => {
  const b = e.target.closest?.(".ev");
  if (!b || drag || document.querySelector("dialog[open]")) return;
  const ev = state.events.find((x) => x.id === Number(b.dataset.id));
  if (!ev) return;
  fillTip(ev);
  tip.hidden = false;
  placeTip(e.clientX, e.clientY);
});
document.addEventListener("mousemove", (e) => { if (!tip.hidden) placeTip(e.clientX, e.clientY); });
document.addEventListener("mouseout", (e) => {
  const b = e.target.closest?.(".ev");
  if (b && !b.contains(e.relatedTarget)) hideTip();
});
document.addEventListener("click", hideTip, true);

/* ---------- Navigation ---------- */
$("btn-year").addEventListener("click", showYear);
$("btn-prev").addEventListener("click", () => showWeek(iso(addDays(parse(state.week), -7))));
$("btn-next").addEventListener("click", () => showWeek(iso(addDays(parse(state.week), 7))));
document.addEventListener("keydown", (e) => {
  if (!state.week || document.querySelector("dialog[open]")) return;
  if (e.target.closest("input, textarea")) return;
  if (e.key === "Escape") showYear();
  else if (e.key === "ArrowLeft" && !$("btn-prev").disabled) $("btn-prev").click();
  else if (e.key === "ArrowRight" && !$("btn-next").disabled) $("btn-next").click();
});

$("pf").addEventListener("toggle", () => { if ($("pf").open) buildPeoplePanel($("pf-panel"), onPeopleChange); });
document.addEventListener("click", (e) => { if ($("pf").open && !e.target.closest("#pf")) $("pf").open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("pf").open) { $("pf").open = false; e.stopImmediatePropagation(); } }, true);

$("only-mine").addEventListener("change", (e) => {
  state.onlyMine = e.target.checked;
  try { localStorage.setItem("kal-only-mine", state.onlyMine ? "1" : "0"); } catch {}
  render();
});

$("btn-logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } finally { location.href = "/login"; }
});

/* ---------- Start ---------- */
(async function init() {
  state.me = await api("GET", "/api/me");
  state.year = state.me.year;
  state.holidays = holidays(state.year);
  document.title = `Kalender ${state.year}`;
  $("title").textContent = `Kalender ${state.year}`;
  $("username").textContent = state.me.username + (state.me.is_admin ? " (Admin)" : "");
  try { state.onlyMine = localStorage.getItem("kal-only-mine") === "1"; } catch {}
  $("only-mine").checked = state.onlyMine;
  loadPeopleFilter(await api("GET", "/api/users"));
  const m = location.hash.match(/^#w=(\d{4}-\d{2}-\d{2})$/);
  if (m) state.week = iso(mondayOf(parse(m[1])));
  $("admin-link").hidden = !state.me.is_admin;
  await loadEvents();
  track(state.week ? "ansicht_woche" : "ansicht_jahr", state.week ? weekDetail(state.week) : "");
})();
