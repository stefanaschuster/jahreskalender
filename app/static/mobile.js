"use strict";
/* Smartphone-Ansicht: Jahresübersicht (12 Mini-Monate) → Monat mit Terminliste */

const state = { version: null, me: null, year: 2027, events: [], holidays: new Map(), onlyMine: false,
  month: null, day: null, openId: null, editId: null };
const RANK = { gebucht: 3, geplant: 2, offen: 1 };
const statusOf = (ev) => ev.my_status || "offen";

/* ---------- Daten ---------- */
async function loadEvents() {
  const { v } = await api("GET", "/api/version");
  state.events = await api("GET", "/api/events");
  state.version = v;
  render();
}

let polling = false;
async function checkForUpdates() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const { v } = await api("GET", "/api/version");
    if (v !== state.version) await loadEvents();
  } catch { /* offline: nächster Versuch */ }
  finally { polling = false; }
}
setInterval(checkForUpdates, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdates(); });

const visible = () => state.events.filter((e) => (!state.onlyMine || e.my_status) && matchesPeople(e));

function renderPeopleFilter() {
  const n = peopleFilter.names.size;
  $("m-pf-btn").textContent = n ? `Teilnehmer (${n})` : "Teilnehmer";
  $("m-pf-btn").classList.toggle("on", n > 0);
  buildPeopleBar($("m-pf-bar"), visible().length, render);
}
const eventsOn = (dIso, list) => list.filter((e) => e.start_date <= dIso && e.end_date >= dIso);

function bestStatus(list) {
  let best = null;
  for (const e of list) if (!best || RANK[statusOf(e)] > RANK[best]) best = statusOf(e);
  return best;
}

/* ---------- Jahresübersicht ---------- */
function renderYear() {
  const root = $("m-months");
  root.replaceChildren();
  const evs = visible(), todayIso = iso(new Date());
  for (let m = 0; m < 12; m++) {
    const first = mk(state.year, m, 1), nDays = mk(state.year, m + 1, 0).getUTCDate();
    const fIso = iso(first), lIso = iso(mk(state.year, m, nDays));
    const count = evs.filter((e) => e.end_date >= fIso && e.start_date <= lIso).length;

    const card = el("button", "m-mini");
    card.type = "button";
    card.dataset.month = m;
    const head = el("div", "m-mini-head");
    head.append(el("span", null, MONTHS[m]));
    if (count) head.append(el("span", "m-count", String(count)));
    card.append(head);

    const grid = el("div", "m-mini-grid");
    for (let i = 0; i < wd(first); i++) grid.append(el("span"));
    for (let d = 1; d <= nDays; d++) {
      const dt = mk(state.year, m, d), dIso = iso(dt);
      const c = el("span", "md", String(d));
      const st = bestStatus(eventsOn(dIso, evs));
      if (st) c.classList.add(`s-${st}`);
      if (wd(dt) >= 5) c.classList.add("we");
      if (state.holidays.has(dIso)) c.classList.add("hol");
      if (dIso === todayIso) c.classList.add("today");
      grid.append(c);
    }
    card.append(grid);
    root.append(card);
  }
}

/* ---------- Monat ---------- */
function renderMonth() {
  const m = state.month, first = mk(state.year, m, 1), nDays = mk(state.year, m + 1, 0).getUTCDate();
  const fIso = iso(first), lIso = iso(mk(state.year, m, nDays));
  $("m-month-title").textContent = `${MONTHS[m]} ${state.year}`;
  $("m-prev").disabled = m === 0;
  $("m-next").disabled = m === 11;

  const evs = visible().filter((e) => e.end_date >= fIso && e.start_date <= lIso);
  const grid = $("m-grid");
  grid.replaceChildren();
  for (const w of WD_SHORT) grid.append(el("span", "m-wd", w));
  for (let i = 0; i < wd(first); i++) grid.append(el("span"));
  const todayIso = iso(new Date());
  for (let d = 1; d <= nDays; d++) {
    const dt = mk(state.year, m, d), dIso = iso(dt);
    const cell = el("button", "m-day");
    cell.type = "button";
    cell.dataset.date = dIso;
    if (wd(dt) >= 5) cell.classList.add("we");
    const hol = state.holidays.get(dIso);
    if (hol) cell.classList.add("hol");
    if (dIso === todayIso) cell.classList.add("today");
    if (dIso === state.day) cell.classList.add("sel");
    cell.append(el("span", "m-num", String(d)));
    const bars = el("span", "m-bars");
    const on = eventsOn(dIso, evs).sort((a, b) => RANK[statusOf(b)] - RANK[statusOf(a)]);
    for (const e of on.slice(0, 3)) bars.append(el("i", `s-${statusOf(e)}`));
    if (on.length > 3) bars.append(el("b", null, `+${on.length - 3}`));
    cell.append(bars);
    grid.append(cell);
  }

  const list = state.day ? eventsOn(state.day, evs) : evs;
  const hol = state.day && state.holidays.get(state.day);
  $("m-listhead").textContent = state.day
    ? `${fmt(state.day)}${hol ? " · " + hol : ""}` : `Termine im ${MONTHS[m]}`;
  const box = $("m-list");
  box.replaceChildren();
  if (!list.length) box.append(el("p", "muted m-empty", state.day ? "Keine Termine an diesem Tag." : "Keine Termine in diesem Monat."));
  for (const e of list) box.append(card(e));
}

function people(ev, cls) {
  const wrap = el("div", cls);
  for (const st of ["gebucht", "geplant"]) {
    const names = ev.participants.filter((p) => p.status === st).map((p) => p.username);
    if (!names.length) continue;
    const row = el("div", "m-people-row");
    row.append(el("span", `chip ${st}`, st), el("span", null, names.join(", ")));
    wrap.append(row);
  }
  if (!ev.participants.length) wrap.append(el("div", "muted", "noch niemand eingetragen"));
  return wrap;
}

function statusButtons(ev) {
  const g = el("div", "m-status");
  for (const [st, label] of [["", "offen"], ["geplant", "geplant"], ["gebucht", "gebucht"]]) {
    const b = el("button", `m-seg ${st || "none"}`, label);
    b.type = "button";
    b.dataset.status = st;
    b.dataset.id = ev.id;
    if ((ev.my_status || "") === st) b.classList.add("active");
    g.append(b);
  }
  return g;
}

function dateText(ev) {
  const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
  return days > 1 ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} · ${days} Tage` : fmt(ev.start_date);
}

function card(ev) {
  const c = el("article", `m-card s-${statusOf(ev)}`);
  const head = el("button", "m-card-head");
  head.type = "button";
  head.dataset.open = ev.id;
  head.append(el("strong", null, ev.title), el("span", "muted", dateText(ev)));
  c.append(head, people(ev, "m-people"), statusButtons(ev));
  return c;
}

/* ---------- Navigation ---------- */
function render() {
  renderPeopleFilter();
  const inMonth = state.month !== null;
  $("m-year").hidden = inMonth;
  $("m-month").hidden = !inMonth;
  $("m-back").hidden = !inMonth;
  $("m-title").textContent = inMonth ? "" : `Kalender ${state.year}`;
  if (inMonth) renderMonth(); else renderYear();
  if (state.openId !== null) fillDetail();
}

function showMonth(m) {
  if (m < 0 || m > 11) return;
  if (state.month !== m) track("ansicht_monat", `${MONTHS[m]} ${state.year}`);
  state.month = m;
  state.day = null;
  history.replaceState(null, "", `#m=${m + 1}`);
  render();
  window.scrollTo(0, 0);
}

function showYear() {
  state.month = null;
  state.day = null;
  history.replaceState(null, "", location.pathname);
  track("ansicht_jahr", "Handy");
  render();
}

$("m-months").addEventListener("click", (e) => {
  const c = e.target.closest(".m-mini");
  if (c) showMonth(Number(c.dataset.month));
});
$("m-back").addEventListener("click", showYear);
$("m-prev").addEventListener("click", () => showMonth(state.month - 1));
$("m-next").addEventListener("click", () => showMonth(state.month + 1));

$("m-grid").addEventListener("click", (e) => {
  const d = e.target.closest(".m-day");
  if (!d) return;
  state.day = state.day === d.dataset.date ? null : d.dataset.date;
  renderMonth();
});

// Wischen links/rechts im Monat
let touchX = null, touchY = null;
$("m-month").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
$("m-month").addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) showMonth(state.month + (dx < 0 ? 1 : -1));
});

/* ---------- Status setzen ---------- */
async function setStatus(id, status) {
  try {
    const updated = await api("PUT", `/api/events/${id}/mark`, { status: status || null });
    state.events = state.events.map((e) => (e.id === id ? updated : e));
    render();
  } catch (err) { alert(err.message); }
}

document.addEventListener("click", (e) => {
  const seg = e.target.closest(".m-seg");
  if (seg) { setStatus(Number(seg.dataset.id), seg.dataset.status); return; }
  const open = e.target.closest("[data-open]");
  if (open) { openDetail(Number(open.dataset.open)); return; }
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});

// Tippen auf den abgedunkelten Hintergrund schließt ein Sheet
for (const d of document.querySelectorAll("dialog.sheet")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

/* ---------- Details ---------- */
function openDetail(id) {
  state.openId = id;
  const ev = state.events.find((x) => x.id === id);
  if (ev) track("event_angesehen", ev.title);
  fillDetail();
  $("m-detail").showModal();
}

function fillDetail() {
  const ev = state.events.find((x) => x.id === state.openId);
  if (!ev) { $("m-detail").close(); return; }
  $("d-title").textContent = ev.title;
  $("d-dates").textContent = dateText(ev);
  $("d-note").textContent = ev.note;
  $("d-note").hidden = !ev.note;
  $("d-status").replaceWith(Object.assign(statusButtons(ev), { id: "d-status" }));
  $("d-people").replaceChildren(people(ev, "m-people"));
  $("d-creator").textContent = ev.creator ? `angelegt von ${ev.creator}` : "";
  $("d-actions").hidden = !ev.can_edit;
}
$("m-detail").addEventListener("close", () => { state.openId = null; });

$("d-edit").addEventListener("click", () => {
  const ev = state.events.find((x) => x.id === state.openId);
  $("m-detail").close();
  openEdit(ev);
});
$("d-delete").addEventListener("click", async () => {
  const ev = state.events.find((x) => x.id === state.openId);
  if (!ev || !confirm(`„${ev.title}“ wirklich löschen?`)) return;
  try {
    await api("DELETE", `/api/events/${ev.id}`);
    $("m-detail").close();
    await loadEvents();
  } catch (err) { alert(err.message); }
});

/* ---------- Anlegen / Bearbeiten ---------- */
function openEdit(ev) {
  state.editId = ev ? ev.id : null;
  const f = $("e-form");
  $("e-heading").textContent = ev ? "Event bearbeiten" : "Neues Event";
  let start = state.day;
  if (!start) {
    const today = iso(new Date());
    start = state.month !== null ? iso(mk(state.year, state.month, 1))
      : (today.startsWith(String(state.year)) ? today : `${state.year}-01-01`);
  }
  f.title.value = ev ? ev.title : "";
  f.start_date.value = ev ? ev.start_date : start;
  f.end_date.value = ev ? ev.end_date : start;
  f.note.value = ev ? ev.note : "";
  $("e-error").hidden = true;
  $("m-edit").showModal();
}

$("m-add").addEventListener("click", () => openEdit(null));
$("e-form").start_date.addEventListener("change", (e) => {
  const end = $("e-form").end_date;
  if (!end.value || end.value < e.target.value) end.value = e.target.value;
});
$("e-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  let start = f.start_date.value, end = f.end_date.value;
  if (end < start) [start, end] = [end, start];
  const body = { title: f.title.value, start_date: start, end_date: end, note: f.note.value };
  try {
    if (state.editId) await api("PUT", `/api/events/${state.editId}`, body);
    else await api("POST", "/api/events", body);
    $("m-edit").close();
    await loadEvents();
  } catch (err) {
    $("e-error").textContent = err.message;
    $("e-error").hidden = false;
  }
});

/* ---------- Menü ---------- */
$("m-menu-btn").addEventListener("click", () => $("m-menu").showModal());
$("m-pf-btn").addEventListener("click", () => {
  buildPeoplePanel($("m-pf-panel"), render);
  $("m-pf").showModal();
});
$("m-only-mine").addEventListener("change", (e) => {
  state.onlyMine = e.target.checked;
  try { localStorage.setItem("kal-only-mine", state.onlyMine ? "1" : "0"); } catch {}
  render();
});
$("m-logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } finally { location.href = "/login"; }
});

/* ---------- Start ---------- */
(async function init() {
  state.me = await api("GET", "/api/me");
  state.year = state.me.year;
  state.holidays = holidays(state.year);
  document.title = `Kalender ${state.year}`;
  $("m-user").textContent = `Angemeldet als ${state.me.username}`;
  $("m-admin").hidden = !state.me.is_admin;
  try { state.onlyMine = localStorage.getItem("kal-only-mine") === "1"; } catch {}
  $("m-only-mine").checked = state.onlyMine;
  loadPeopleFilter(await api("GET", "/api/users"));
  const h = location.hash.match(/^#m=(\d{1,2})$/);
  if (h && h[1] >= 1 && h[1] <= 12) state.month = Number(h[1]) - 1;
  await loadEvents();
  track(state.month !== null ? "ansicht_monat" : "ansicht_jahr",
    state.month !== null ? `${MONTHS[state.month]} ${state.year}` : "Handy");
})();
