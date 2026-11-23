"use strict";

/* ---------- Zustand ---------- */
const state = { version: null, me: null, year: 2027, events: [], groups: [], holidays: new Map(),
  onlyMine: false, week: null, openEventId: null };

async function loadEvents() {
  const { v } = await api("GET", "/api/version");      // Version vor den Daten holen: verpasst keine Änderung
  [state.events, state.groups] = await Promise.all([api("GET", "/api/events"), api("GET", "/api/groups"), loadRefs()]);
  state.version = v;
  buildRefFilter($("rf"), state.groups, render);
  hideTip();
  render();
}

// Nach Gruppenänderungen: Daten und Gruppen-Panel neu
async function reloadAll() {
  await loadEvents();
  if ($("groups-dialog").open) buildGroupsPanel($("groups-panel"), state.groups, reloadAll);
}

/* Live-Aktualisierung: Versionszähler abfragen, nur bei Änderung neu laden */
const POLL_MS = 10000;
let polling = false;

async function checkForUpdates() {
  if (polling || document.hidden || drag) return;
  polling = true;
  try {
    const { v } = await api("GET", "/api/version");
    if (v !== state.version) {
      if (!state.me.guest) {                             // Rollen (z. B. Eventmanager) können sich geändert haben
        state.me = await api("GET", "/api/me");
        applyRole();
      }
      await loadEvents();
    }
  } catch { /* offline o. Ä.: beim nächsten Durchlauf erneut */ }
  finally { polling = false; }
}

setInterval(checkForUpdates, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdates(); });
window.addEventListener("focus", checkForUpdates);

function applyRole() {
  $("admin-link").hidden = !state.me.is_admin;
  $("admin-hint").hidden = !canCreate(state.me);
}

function visibleEvents() {
  return state.events.filter((e) => (!state.onlyMine || e.my_status) && matchesCat(e) && matchesRefs(e));
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
  b.setAttribute("aria-label", `${ev.title} (${catName(ev)})`);
  return paint(b, ev);
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
  for (let c = 0; c < COLS; c++) head.append(el("div", `wdh ${c % 7 >= 5 ? "we" : ""}`, wdShort(c % 7)));
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

    const label = el("div", "mlabel", monthName(m));
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
        cell.append(el("span", "dnum", String(day)));
        if (wd(dt) === 0 || day === 1) {
          const kw = el("button", "kw", t("week.short", { n: isoWeek(dt) }));
          kw.type = "button";
          kw.dataset.week = iso(mondayOf(dt));
          kw.title = t("week.show");
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
  return [mondayOf(mk(state.year, 0, 1)), mondayOf(mk(state.year, 11, 31))];
}

function renderWeek() {
  const root = $("week-view");
  root.replaceChildren();
  const mon = parse(state.week), sun = addDays(mon, 6);
  const mIso = iso(mon), sIso = iso(sun), todayIso = iso(new Date());
  $("week-label").textContent = t("week.label", { n: isoWeek(mon), from: fmtShort(mon), to: fmtShortYear(sun) });
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
    h.append(el("span", "wname", wdLong(i)), el("span", "wdate", t("date.day_month", { d: dt.getUTCDate(), month: monthName(dt.getUTCMonth()) })));
    if (hol) h.append(el("span", "whol", hol));
    col.append(h);
    grid.append(col);
  }

  for (const seg of segs) {
    const ev = seg.ev;
    const b = eventButton(ev, `big ${seg.contL ? "cont-l" : ""} ${seg.contR ? "cont-r" : ""}`);
    b.append(el("span", "meta cat-line", catName(ev)), el("strong", null, ev.title));
    const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
    b.append(el("span", "meta", days > 1 ? `${fmtShort(parse(ev.start_date))} – ${fmtShort(parse(ev.end_date))} · ${daysText(days)}` : daysText(1)));
    if (refText(ev)) b.append(el("span", "meta", refText(ev)));
    const gIn = groupNamesIn(ev, state.groups);
    if (gIn.length) b.append(el("span", "meta", t("ev.group_short", { names: gIn.join(", ") })));
    if (ev.participants.length && ev.visibility !== "private") {
      b.append(el("span", "meta", ev.participants.map((p) => `${p.username} (${statusText(p.status)})`).join(", ")));
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
  buildLegend($("cats"), state.groups, render);
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
  if (anchor) {
    const m = parse(anchor).getUTCFullYear() < state.year ? 0 : parse(anchor).getUTCMonth();
    $("year-view").querySelectorAll(".month-row")[m]?.scrollIntoView({ block: "center" });
  }
}

/* ---------- Event-Dialog ---------- */
function openEvent(id) {
  state.openEventId = id;
  track("event_angesehen", id);
  refreshEventDialog();
  const dlg = $("event-dialog");
  if (!dlg.open) dlg.showModal();
}

function refreshEventDialog() {
  const ev = state.events.find((e) => e.id === state.openEventId);
  if (!ev) { $("event-dialog").close(); return; }
  paint($("ev-cat"), ev).textContent = catName(ev);
  $("ev-title").textContent = ev.title;
  const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
  $("ev-dates").textContent = days > 1
    ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} (${daysText(days)})` : fmt(ev.start_date);
  refLinks(ev, $("ev-refs"));
  groupParticipation(ev, state.groups, $("ev-groups"), setGroupParticipation);
  $("ev-note").textContent = ev.note;
  $("ev-note").hidden = !ev.note;
  for (const b of $("event-dialog").querySelectorAll("[data-status]")) {
    b.classList.toggle("active", (ev.my_status || "") === b.dataset.status);
  }
  const priv = ev.visibility === "private" || isGuest();
  $("ev-people-head").hidden = priv;
  const ul = $("ev-participants");
  ul.replaceChildren();
  ul.hidden = priv;
  if (!ev.participants.length) ul.append(el("li", "muted", noPeopleText(ev)));
  for (const p of ev.participants) {
    const li = el("li");
    li.append(el("span", null, p.username), el("span", `chip ${p.status}`, statusText(p.status)));
    ul.append(li);
  }
  $("ev-creator").textContent = ev.creator && !priv ? t("ev.created_by", { name: ev.creator }) : "";
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

async function setGroupParticipation(groupId, participates) {
  const id = state.openEventId;
  try {
    const updated = await api("PUT", `/api/events/${id}/groups/${groupId}`, { participates });
    state.events = state.events.map((e) => (e.id === id ? updated : e));
    render();
  } catch (err) { alert(err.message); render(); }
}

/* ---------- Event anlegen / bearbeiten ---------- */
let editId = null;

function openEdit(ev, start, end) {
  editId = ev ? ev.id : null;
  const f = $("edit-form");
  $("edit-heading").textContent = t(ev ? "ev.edit" : "ev.new");
  f.title.value = ev ? ev.title : "";
  f.start_date.value = ev ? ev.start_date : start;
  f.end_date.value = ev ? ev.end_date : (end || start);
  f.note.value = ev ? ev.note : "";
  fillVisibility(f.visibility, state.me, state.groups, ev);
  fillOrganizerSelect(f, state.me, ev?.organizer_id);
  fillRefSelect(f.track_id, "track", ev?.track_id);
  $("edit-error").hidden = true;
  $("edit-dialog").showModal();
  f.title.focus();
}

$("edit-form").visibility.addEventListener("change", (e) => {
  tintSelect(e.target);
  const f = $("edit-form");
  fillOrganizerSelect(f, state.me, refValue(f.organizer_id));
});
$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  let start = f.start_date.value, end = f.end_date.value;
  if (end < start) [start, end] = [end, start];
  const body = { title: f.title.value, start_date: start, end_date: end, note: f.note.value,
    organizer_id: refValue(f.organizer_id), track_id: refValue(f.track_id), ...visibilityBody(f.visibility) };
  const old = editId && state.events.find((x) => x.id === editId);
  if (old && old.participants.some((p) => p.username !== state.me.username) && catKey(old) !== f.visibility.value
      && !confirm(t("ev.confirm_vis"))) return;
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
  if (!ev || !confirm(t("ev.confirm_delete", { title: ev.title }))) return;
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

/* ---------- Gruppen ---------- */
$("btn-groups").addEventListener("click", () => {
  buildGroupsPanel($("groups-panel"), state.groups, reloadAll);
  $("groups-dialog").showModal();
});
$("groups-dialog").querySelector("[data-close]").addEventListener("click", () => $("groups-dialog").close());

/* ---------- Klicks & Ziehen in der Jahresansicht ---------- */
let drag = null;

function highlightRange(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (const c of $("year-view").querySelectorAll(".day")) {
    c.classList.toggle("sel", c.dataset.date >= lo && c.dataset.date <= hi);
  }
}

$("year-view").addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !canCreate(state.me)) return;          // Events anlegen nur als Admin oder Eventmanager
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
  if (col && !col.classList.contains("outside") && canCreate(state.me)) openEdit(null, col.dataset.date);
});

/* ---------- Tooltip: Kategorie, wer hat geplant / gebucht ---------- */
const tip = $("tip");

function fillTip(ev) {
  tip.replaceChildren();
  tip.append(paint(el("span", "cat-badge", catName(ev)), ev), el("strong", null, ev.title));
  const days = daysBetween(parse(ev.start_date), parse(ev.end_date)) + 1;
  tip.append(el("div", "tip-dates", days > 1 ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} (${daysText(days)})` : fmt(ev.start_date)));
  if (refText(ev)) tip.append(el("div", "tip-dates", refText(ev)));
  const gIn = groupNamesIn(ev, state.groups);
  if (gIn.length) tip.append(el("div", "tip-dates", t("ev.group_in", { names: gIn.join(", ") })));
  if (isGuest()) return;
  if (ev.visibility === "private") {
    tip.append(el("div", "tip-empty", ev.my_status ? t("status.line", { status: statusText(ev.my_status) }) : t("ev.only_you")));
    return;
  }
  for (const status of ["gebucht", "geplant"]) {
    const names = ev.participants.filter((p) => p.status === status).map((p) => p.username);
    if (!names.length) continue;
    const row = el("div", "tip-row");
    row.append(el("span", `chip ${status}`, statusText(status)), el("span", null, names.join(", ")));
    tip.append(row);
  }
  if (!ev.participants.length) tip.append(el("div", "tip-empty", noPeopleText(ev)));
  if (ev.creator) tip.append(el("div", "tip-empty", t("ev.created_by", { name: ev.creator })));
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
  if (e.target.closest("input, textarea, select")) return;
  if (e.key === "Escape") showYear();
  else if (e.key === "ArrowLeft" && !$("btn-prev").disabled) $("btn-prev").click();
  else if (e.key === "ArrowRight" && !$("btn-next").disabled) $("btn-next").click();
});

$("only-mine").addEventListener("change", (e) => {
  state.onlyMine = e.target.checked;
  try { localStorage.setItem("kal-only-mine", state.onlyMine ? "1" : "0"); } catch {}
  render();
});

setupPasswordDialog($("pw-dialog"), $("btn-password"));
$("btn-feed").addEventListener("click", () => openFeedDialog(state.groups));
$("pw-dialog").querySelector("[data-close]").addEventListener("click", () => $("pw-dialog").close());

$("btn-logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } finally { location.href = "/login"; }
});

// Benutzer-Menü oben rechts
function setUserMenu(open) {
  $("user-menu").hidden = !open;
  $("btn-user").setAttribute("aria-expanded", String(open));
}
$("btn-user").addEventListener("click", (e) => { e.stopPropagation(); setUserMenu($("user-menu").hidden); });
$("user-menu").addEventListener("click", () => setUserMenu(false));
document.addEventListener("click", (e) => { if (!e.target.closest(".usermenu")) setUserMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("user-menu").hidden) setUserMenu(false); });

setupIntro("desktop", { banner: $("intro"), thumb: $("intro-thumb"), play: $("intro-play"), close: $("intro-close"),
  buttons: [$("btn-intro")], dialog: $("video-dialog"), player: $("video-player") });

/* ---------- Sprache: Texte, die das Skript selbst setzt ---------- */
function applyTexts() {
  state.holidays = holidays(state.year);
  document.title = t("app.title_year", { year: state.year });
  $("title").textContent = t("app.title_year", { year: state.year });
  if (state.me?.guest) {
    $("ev-guest").replaceChildren(guestHint());
  }
  if ($("edit-dialog").open) $("edit-heading").textContent = t(editId ? "ev.edit" : "ev.new");
}

// Sprachwechsel: alles, was gezeichnet wurde, neu aufbauen (Daten bleiben)
document.addEventListener("i18n", () => {
  if (!state.me) return;
  applyTexts();
  syncManagerMenu();
  buildRefFilter($("rf"), state.groups, render);
  render();
  if ($("groups-dialog").open) buildGroupsPanel($("groups-panel"), state.groups, reloadAll);
});

/* ---------- Start ---------- */
(async function init() {
  [state.me] = await Promise.all([api("GET", "/api/me"), textsReady]);
  state.year = state.me.year;
  $("username").textContent = state.me.username;
  if (state.me.guest) {                                          // ohne Konto: nur ansehen
    await loadGuestCfg();
    for (const id of ["btn-groups", "btn-feed", "only-mine-label"]) $(id).hidden = true;
    document.querySelector(".usermenu").hidden = true;
    document.querySelector(".tb-filters .status-legend").hidden = true;
    $("btn-login").hidden = false;
    $("btn-register").hidden = !guestCfg.registration;
    document.querySelector("#event-dialog .status-buttons").hidden = true;
    $("ev-guest").hidden = false;
  }
  applyTexts();
  try { state.onlyMine = !state.me.guest && localStorage.getItem("kal-only-mine") === "1"; } catch {}
  $("only-mine").checked = state.onlyMine;
  loadCatFilter();
  loadRefFilter();
  const m = location.hash.match(/^#w=(\d{4}-\d{2}-\d{2})$/);
  if (m) state.week = iso(mondayOf(parse(m[1])));
  applyRole();
  await loadEvents();
  track(state.week ? "ansicht_woche" : "ansicht_jahr", state.week ? weekDetail(state.week) : "");
  await handleJoinHash(async () => {
    await reloadAll();
    buildGroupsPanel($("groups-panel"), state.groups, reloadAll);
    $("groups-dialog").showModal();
  });
})();
