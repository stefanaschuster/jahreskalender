"use strict";
/* Smartphone-Ansicht: Jahresübersicht (12 Mini-Monate) → Monat mit Terminliste */

const state = { version: null, me: null, year: 2027, events: [], groups: [], holidays: new Map(), onlyMine: false,
  month: null, day: null, openId: null, editId: null };
const RANK = { gebucht: 3, geplant: 2, offen: 1 };
const statusOf = (ev) => ev.my_status || "offen";
const byStatus = (a, b) => RANK[statusOf(b)] - RANK[statusOf(a)];

/* ---------- Daten ---------- */
async function loadEvents() {
  const { v } = await api("GET", "/api/version");
  [state.events, state.groups] = await Promise.all([api("GET", "/api/events"), api("GET", "/api/groups"), loadRefs()]);
  state.version = v;
  buildRefFilter($("m-rf"), state.groups, render);
  render();
}

async function reloadAll() {
  await loadEvents();
  if ($("m-groups").open) buildGroupsPanel($("m-groups-panel"), state.groups, reloadAll);
}

let polling = false;
async function checkForUpdates() {
  if (polling || document.hidden) return;
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
  } catch { /* offline: nächster Versuch */ }
  finally { polling = false; }
}
setInterval(checkForUpdates, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdates(); });

function applyRole() {
  $("m-admin").hidden = !state.me.is_admin;
  $("m-add").hidden = !canCreate(state.me);                     // Events anlegen nur als Admin oder Eventmanager
}

const visible = () => state.events.filter((e) => (!state.onlyMine || e.my_status) && matchesCat(e) && matchesRefs(e));
const eventsOn = (dIso, list) => list.filter((e) => e.start_date <= dIso && e.end_date >= dIso);

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
    head.append(el("span", null, monthName(m)));
    if (count) head.append(el("span", "m-count", String(count)));
    card.append(head);

    const grid = el("div", "m-mini-grid");
    for (let i = 0; i < wd(first); i++) grid.append(el("span"));
    for (let d = 1; d <= nDays; d++) {
      const dt = mk(state.year, m, d), dIso = iso(dt);
      const c = el("span", "md", String(d));
      const top = eventsOn(dIso, evs).sort(byStatus)[0];    // wichtigstes Event des Tages bestimmt die Farbe
      if (top) { c.classList.add(`s-${statusOf(top)}`); paint(c, top); }
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
  $("m-month-title").textContent = t("date.month_year", { month: monthName(m), y: state.year });
  $("m-prev").disabled = m === 0;
  $("m-next").disabled = m === 11;

  const evs = visible().filter((e) => e.end_date >= fIso && e.start_date <= lIso);
  const grid = $("m-grid");
  grid.replaceChildren();
  for (let i = 0; i < 7; i++) grid.append(el("span", "m-wd", wdShort(i)));
  for (let i = 0; i < wd(first); i++) grid.append(el("span"));
  const todayIso = iso(new Date());
  for (let d = 1; d <= nDays; d++) {
    const dt = mk(state.year, m, d), dIso = iso(dt);
    const cell = el("button", "m-day");
    cell.type = "button";
    cell.dataset.date = dIso;
    if (wd(dt) >= 5) cell.classList.add("we");
    if (state.holidays.get(dIso)) cell.classList.add("hol");
    if (dIso === todayIso) cell.classList.add("today");
    if (dIso === state.day) cell.classList.add("sel");
    cell.append(el("span", "m-num", String(d)));
    const bars = el("span", "m-bars");
    const on = eventsOn(dIso, evs).sort(byStatus);
    for (const e of on.slice(0, 3)) bars.append(paint(el("i", `s-${statusOf(e)}`), e));
    if (on.length > 3) bars.append(el("b", null, `+${on.length - 3}`));
    cell.append(bars);
    grid.append(cell);
  }

  const list = state.day ? eventsOn(state.day, evs) : evs;
  const hol = state.day && state.holidays.get(state.day);
  $("m-listhead").textContent = state.day
    ? `${fmt(state.day)}${hol ? " · " + hol : ""}` : t("m.events_in", { month: monthName(m) });
  const box = $("m-list");
  box.replaceChildren();
  if (!list.length) box.append(el("p", "muted m-empty", t(state.day ? "m.none_day" : "m.none_month")));
  for (const e of list) box.append(card(e));
}

function people(ev, cls) {
  const wrap = el("div", cls);
  if (ev.visibility === "private") return wrap;
  for (const st of ["gebucht", "geplant"]) {
    const names = ev.participants.filter((p) => p.status === st).map((p) => p.username);
    if (!names.length) continue;
    const row = el("div", "m-people-row");
    row.append(el("span", `chip ${st}`, statusText(st)), el("span", null, names.join(", ")));
    wrap.append(row);
  }
  if (!ev.participants.length) wrap.append(el("div", "muted", noPeopleText(ev)));
  return wrap;
}

function statusButtons(ev) {
  const g = el("div", "m-status");
  for (const st of ["", "geplant", "gebucht"]) {
    const b = el("button", `m-seg ${st || "none"}`, statusText(st));
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
  return days > 1 ? `${fmt(ev.start_date)} – ${fmt(ev.end_date)} · ${daysText(days)}` : fmt(ev.start_date);
}

function card(ev) {
  const c = paint(el("article", `m-card s-${statusOf(ev)}`), ev);
  const head = el("button", "m-card-head");
  head.type = "button";
  head.dataset.open = ev.id;
  head.append(el("span", "m-card-cat", catName(ev)), el("strong", null, ev.title), el("span", "muted", dateText(ev)));
  c.append(head);
  if (ev.organizer_id || ev.track_id) c.append(refLinks(ev, el("div", "refs")));
  const gIn = groupNamesIn(ev, state.groups);
  if (gIn.length) c.append(el("div", "muted small", t("ev.group_in", { names: gIn.join(", ") })));
  if (!isGuest()) c.append(people(ev, "m-people"), statusButtons(ev));
  return c;
}

/* ---------- Navigation ---------- */
function render() {
  buildLegend($("m-cats"), state.groups, render);
  const inMonth = state.month !== null;
  $("m-year").hidden = inMonth;
  $("m-month").hidden = !inMonth;
  $("m-back").hidden = !inMonth;
  $("m-title").textContent = inMonth ? "" : t("app.title_year", { year: state.year });
  $("m-groups-count").textContent = state.groups.length ? String(state.groups.length) : "";
  if (inMonth) renderMonth(); else renderYear();
  if (state.openId !== null) fillDetail();
}

function showMonth(m) {
  if (m < 0 || m > 11) return;
  if (state.month !== m) track("ansicht_monat", `${MONTHS_DE[m]} ${state.year}`);
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
  track("event_angesehen", id);
  fillDetail();
  $("m-detail").showModal();
}

function fillDetail() {
  const ev = state.events.find((x) => x.id === state.openId);
  if (!ev) { $("m-detail").close(); return; }
  paint($("d-cat"), ev).textContent = catName(ev);
  $("d-title").textContent = ev.title;
  $("d-dates").textContent = dateText(ev);
  refLinks(ev, $("d-refs"));
  groupParticipation(ev, state.groups, $("d-groups"), setGroupParticipation);
  $("d-note").textContent = ev.note;
  $("d-note").hidden = !ev.note;
  $("d-status").replaceWith(Object.assign(statusButtons(ev), { id: "d-status" }));
  $("d-status").hidden = isGuest();
  $("d-people").replaceChildren(isGuest() ? "" : people(ev, "m-people"));
  $("d-creator").textContent = ev.creator && ev.visibility !== "private" && !isGuest() ? t("ev.created_by", { name: ev.creator }) : "";
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
  if (!ev || !confirm(t("ev.confirm_delete_short", { title: ev.title }))) return;
  try {
    await api("DELETE", `/api/events/${ev.id}`);
    $("m-detail").close();
    await loadEvents();
  } catch (err) { alert(err.message); }
});

async function setGroupParticipation(groupId, participates) {
  const id = state.openId;
  try {
    const updated = await api("PUT", `/api/events/${id}/groups/${groupId}`, { participates });
    state.events = state.events.map((e) => (e.id === id ? updated : e));
    render();
  } catch (err) { alert(err.message); render(); }
}

/* ---------- Anlegen / Bearbeiten ---------- */
function openEdit(ev) {
  state.editId = ev ? ev.id : null;
  const f = $("e-form");
  $("e-heading").textContent = t(ev ? "ev.edit" : "ev.new");
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
  fillVisibility(f.visibility, state.me, state.groups, ev);
  fillOrganizerSelect(f, state.me, ev?.organizer_id);
  fillRefSelect(f.track_id, "track", ev?.track_id);
  $("e-error").hidden = true;
  $("m-edit").showModal();
}

$("m-add").addEventListener("click", () => openEdit(null));
$("e-form").visibility.addEventListener("change", (e) => {
  tintSelect(e.target);
  const f = $("e-form");
  fillOrganizerSelect(f, state.me, refValue(f.organizer_id));
});
$("e-form").start_date.addEventListener("change", (e) => {
  const end = $("e-form").end_date;
  if (!end.value || end.value < e.target.value) end.value = e.target.value;
});
$("e-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  let start = f.start_date.value, end = f.end_date.value;
  if (end < start) [start, end] = [end, start];
  const body = { title: f.title.value, start_date: start, end_date: end, note: f.note.value,
    organizer_id: refValue(f.organizer_id), track_id: refValue(f.track_id), ...visibilityBody(f.visibility) };
  const old = state.editId && state.events.find((x) => x.id === state.editId);
  if (old && old.participants.some((p) => p.username !== state.me.username) && catKey(old) !== f.visibility.value
      && !confirm(t("ev.confirm_vis"))) return;
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
$("m-intro-btn").addEventListener("click", () => $("m-menu").close());
setupIntro("mobil", { banner: $("intro"), thumb: $("intro-thumb"), play: $("intro-play"), close: $("intro-close"),
  buttons: [$("m-intro-btn")], dialog: $("video-dialog"), player: $("video-player") });
$("m-groups-btn").addEventListener("click", () => {
  $("m-menu").close();
  buildGroupsPanel($("m-groups-panel"), state.groups, reloadAll);
  $("m-groups").showModal();
  document.activeElement?.blur();                     // keine Tastatur beim Öffnen
});
$("m-only-mine").addEventListener("change", (e) => {
  state.onlyMine = e.target.checked;
  try { localStorage.setItem("kal-only-mine", state.onlyMine ? "1" : "0"); } catch {}
  render();
});
setupPasswordDialog($("m-pw"), $("m-password"));
$("m-password").addEventListener("click", () => $("m-menu").close(), true);
$("m-feed").addEventListener("click", () => { $("m-menu").close(); openFeedDialog(state.groups); });

$("m-logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } finally { location.href = "/login"; }
});

/* ---------- Sprache: Texte, die das Skript selbst setzt ---------- */
function applyTexts() {
  state.holidays = holidays(state.year);
  document.title = t("app.title_year", { year: state.year });
  $("m-user").textContent = state.me.guest ? t("m.not_logged_in") : t("m.logged_in_as", { name: state.me.username });
  if (state.me.guest) {
    $("guest-bar").replaceChildren(guestHint(t("guest.bar")));
    $("d-guest").replaceChildren(guestHint());
  }
  if ($("m-edit").open) $("e-heading").textContent = t(state.editId ? "ev.edit" : "ev.new");
}

// Sprachwechsel: alles, was gezeichnet wurde, neu aufbauen (Daten bleiben)
document.addEventListener("i18n", () => {
  if (!state.me) return;
  applyTexts();
  syncManagerMenu();
  buildRefFilter($("m-rf"), state.groups, render);
  render();
  if ($("m-groups").open) buildGroupsPanel($("m-groups-panel"), state.groups, reloadAll);
});

/* ---------- Start ---------- */
(async function init() {
  [state.me] = await Promise.all([api("GET", "/api/me"), textsReady]);
  state.year = state.me.year;
  if (state.me.guest) {                                          // ohne Konto: nur ansehen
    await loadGuestCfg();
    for (const id of ["m-groups-btn", "m-only-mine-row", "m-feed", "m-password", "m-logout"]) $(id).hidden = true;
    $("m-login").hidden = false;
    $("m-register").hidden = !guestCfg.registration;
    document.querySelector(".m-legend .status-legend").hidden = true;
    $("guest-bar").hidden = false;
    $("d-guest").hidden = false;
  }
  applyTexts();
  applyRole();
  try { state.onlyMine = !state.me.guest && localStorage.getItem("kal-only-mine") === "1"; } catch {}
  $("m-only-mine").checked = state.onlyMine;
  loadCatFilter();
  loadRefFilter();
  const h = location.hash.match(/^#m=(\d{1,2})$/);
  if (h && h[1] >= 1 && h[1] <= 12) state.month = Number(h[1]) - 1;
  await loadEvents();
  track(state.month !== null ? "ansicht_monat" : "ansicht_jahr",
    state.month !== null ? `${MONTHS_DE[state.month]} ${state.year}` : "Handy");
  await handleJoinHash(async () => {
    await reloadAll();
    buildGroupsPanel($("m-groups-panel"), state.groups, reloadAll);
    $("m-groups").showModal();
  });
})();
