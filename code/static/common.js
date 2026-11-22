"use strict";
/* Gemeinsame Helfer für Desktop (app.js) und Smartphone (mobile.js) */
document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));

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

/* ---------- Besucher ohne Konto: sehen öffentliche Events, können nichts ändern ---------- */
const isGuest = () => typeof state !== "undefined" && !!state.me?.guest;
let guestCfg = null;
// Hinweis mit Anmelden / Registrieren (Registrieren nur, wenn freigeschaltet)
function guestHint(text) {
  const box = el("div", "guest-hint");
  box.append(el("p", null, text || "Melde dich an, um Events als geplant oder gebucht zu markieren, eine Crew zu gründen und zusammen zu planen."));
  const acts = el("div", "guest-acts");
  const login = el("a", "btn", "Anmelden");
  login.href = "/login";
  acts.append(login);
  const reg = el("a", "btn primary", "Kostenlos registrieren");
  reg.href = "/login#register";
  reg.hidden = !(guestCfg && guestCfg.registration);
  acts.append(reg);
  box.append(acts);
  return box;
}
async function loadGuestCfg() {
  try { guestCfg = await api("GET", "/api/config"); } catch { guestCfg = {}; }
  return guestCfg;
}

/* ---------- Rollen: Admin legt alles an, Eventmanager öffentliche Events seiner Veranstalter ---------- */
const managedIds = (me) => (me && me.managed_organizers) || [];
const isManager = (me) => !!me && !me.is_admin && managedIds(me).length > 0;
const canCreate = (me) => !!me && !me.guest;               // private Termine darf jeder angemeldete Benutzer anlegen
const currentMe = () => (typeof state !== "undefined" ? state.me : null);
// Angaben eines Veranstalters pflegen: Admin oder Eventmanager dieses Veranstalters
const canEditOrganizer = (id) => { const me = currentMe(); return !!me && (me.is_admin || managedIds(me).includes(id)); };

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

/* ---------- Kategorien: Öffentlich · je Gruppe · Privat ---------- */
const catKey = (ev) => (ev.visibility === "group" ? `g${ev.group_id}` : ev.visibility);
const catColor = (visibility, color) => (visibility === "public" ? "var(--c-public)"
  : visibility === "private" ? "var(--c-private)" : `var(--g${color})`);
const evColor = (ev) => catColor(ev.visibility, ev.group_color);
const catName = (ev) => (ev.visibility === "public" ? "Öffentlich"
  : ev.visibility === "private" ? "Privat" : ev.group_name);
const paint = (node, ev) => { node.style.setProperty("--c", evColor(ev)); return node; };

function categories(groups) {
  return [
    { key: "public", name: "Öffentlich", color: catColor("public") },
    ...groups.map((g) => ({ key: `g${g.id}`, name: g.name, color: catColor("group", g.color) })),
    { key: "private", name: "Privat", color: catColor("private") },
  ];
}

// Kategorie-Filter: ausgeblendete Kategorien, im Browser gemerkt
const catFilter = { hidden: new Set() };
function loadCatFilter() {
  try { catFilter.hidden = new Set(JSON.parse(localStorage.getItem("kal-cats") || "[]")); } catch { /* egal */ }
}
function saveCatFilter() {
  try { localStorage.setItem("kal-cats", JSON.stringify([...catFilter.hidden])); } catch {}
}
// Sichtbar, wenn die eigene Kategorie eingeblendet ist – oder eine teilnehmende Gruppe des Benutzers
const matchesCat = (ev) => !catFilter.hidden.has(catKey(ev))
  || (ev.groups_in || []).some((g) => !catFilter.hidden.has(`g${g}`));

// Legende = Filter: Klick blendet eine Kategorie aus/ein
function buildLegend(container, groups, onChange) {
  container.replaceChildren();
  container.hidden = isGuest();                     // Besucher sehen nur öffentliche Events
  if (isGuest()) return;
  for (const c of categories(groups)) {
    const b = el("button", "cat");
    b.type = "button";
    b.style.setProperty("--c", c.color);
    b.append(el("i"), el("span", null, c.name));
    const off = catFilter.hidden.has(c.key);
    b.classList.toggle("off", off);
    b.setAttribute("aria-pressed", String(!off));
    b.title = off ? `${c.name} einblenden` : `${c.name} ausblenden`;
    b.addEventListener("click", () => {
      if (catFilter.hidden.has(c.key)) catFilter.hidden.delete(c.key); else catFilter.hidden.add(c.key);
      saveCatFilter();
      onChange();
    });
    container.append(b);
  }
}

// Auswahl der Sichtbarkeit im Anlegen-/Bearbeiten-Formular
// Admin: alles. Andere: neue Termine privat (Eventmanager zusätzlich öffentlich);
// private bleiben privat, öffentliche bleiben öffentlich; Gruppen-Events (Owner) wie bisher
function fillVisibility(select, me, groups, ev) {
  select.replaceChildren();
  const add = (value, label, color) => {
    const o = new Option(label, value);
    o.dataset.color = color;
    select.append(o);
  };
  const vis = ev ? ev.visibility : null;
  if (me.is_admin || vis !== "public") add("private", "Privat – nur ich", catColor("private"));
  if (me.is_admin || vis === "group") {
    for (const g of groups) add(`g${g.id}`, `Gruppe: ${g.name}`, catColor("group", g.color));
  }
  if (me.is_admin || (isManager(me) && vis !== "private" && vis !== "group")) add("public", "Öffentlich – alle", catColor("public"));
  let cur = ev ? catKey(ev) : null;
  if (!cur) { try { cur = localStorage.getItem("kal-vis"); } catch {} }
  if (![...select.options].some((o) => o.value === cur)) cur = select.options[0]?.value || "private";
  select.value = cur;
  tintSelect(select);
}
function tintSelect(select) {
  select.style.setProperty("--c", select.selectedOptions[0]?.dataset.color || "var(--line)");
}
function visibilityBody(select) {
  const v = select.value;
  try { localStorage.setItem("kal-vis", v); } catch {}
  return v.startsWith("g") ? { visibility: "group", group_id: Number(v.slice(1)) } : { visibility: v, group_id: null };
}

/* ---------- Gruppen ---------- */
const inviteLink = (code) => `${location.origin}/join/${code}`;
function parseCode(s) {
  s = s.trim();
  const m = s.match(/(?:\/join\/|#join=)([A-Za-z0-9_-]{8,32})/);
  return m ? m[1] : s;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { prompt("Zum Kopieren markieren:", text); return; }
  const old = btn.textContent;
  btn.textContent = "Kopiert ✓";
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// Panel zum Gründen, Beitreten und Verwalten; onChange lädt Daten neu und baut das Panel neu auf
function buildGroupsPanel(container, groups, onChange) {
  container.replaceChildren();
  const err = el("p", "error");
  err.hidden = true;
  const run = async (fn) => {
    err.hidden = true;
    try { await fn(); await onChange(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  const form = (placeholder, label, handler) => {
    const f = el("form", "gp-form");
    const input = el("input");
    input.placeholder = placeholder;
    input.maxLength = 200;
    input.required = true;
    const b = el("button", "btn primary", label);
    b.type = "submit";
    f.append(input, b);
    f.addEventListener("submit", (e) => { e.preventDefault(); run(() => handler(input.value)); });
    return f;
  };

  container.append(
    el("h3", null, "Neue Gruppe gründen"),
    form("Name, z. B. Trackday-Crew", "Gründen", (name) => api("POST", "/api/groups", { name })),
    el("h3", null, "Einer Gruppe beitreten"),
    form("Einladungslink oder Code", "Beitreten", async (text) => {
      const code = parseCode(text);
      const p = await api("GET", `/api/groups/preview?code=${encodeURIComponent(code)}`);
      if (p.already_member) throw new Error(`Du bist bereits Mitglied von „${p.name}“`);
      await api("POST", "/api/groups/join", { code });
    }),
    err,
    el("h3", null, groups.length ? "Meine Gruppen" : "Du bist noch in keiner Gruppe"),
  );

  for (const g of groups) {
    const card = el("article", "gp-card");
    card.style.setProperty("--c", catColor("group", g.color));
    const head = el("div", "gp-head");
    head.append(el("i", "gp-dot"), el("strong", null, g.name));
    if (g.is_owner) head.append(el("span", "gp-badge", "Owner"));
    head.append(el("span", "muted small gp-count", `${g.events} ${g.events === 1 ? "Event" : "Events"}`));
    card.append(head);

    const mem = el("div", "gp-members");
    for (const m of g.members) {
      const chip = el("span", "gp-member", m.username + (m.is_owner ? " ★" : ""));
      chip.title = m.is_owner ? "Owner" : "Mitglied";
      const others = g.members.filter((x) => x.is_owner).length;
      if (g.is_owner && (!m.is_owner || others > 1)) {
        const s = el("button", "gp-star", m.is_owner ? "−★" : "+★");
        s.type = "button";
        s.title = m.is_owner ? `${m.username} das Owner-Recht entziehen` : `${m.username} zum Owner machen`;
        s.addEventListener("click", () => {
          const msg = m.is_owner ? `${m.username} das Owner-Recht in „${g.name}“ entziehen?`
            : `${m.username} zum Owner von „${g.name}“ machen? Owner können Mitglieder verwalten, Events der Gruppe bearbeiten, die Teilnahme festlegen und die Gruppe löschen.`;
          if (confirm(msg)) run(() => api("PUT", `/api/groups/${g.id}/members/${m.id}/owner`, { is_owner: !m.is_owner }));
        });
        chip.append(s);
      }
      if (g.is_owner && !m.is_owner) {
        const x = el("button", "gp-x", "×");
        x.type = "button";
        x.title = `${m.username} entfernen`;
        x.addEventListener("click", () => {
          if (confirm(`${m.username} aus „${g.name}“ entfernen?`)) {
            run(() => api("DELETE", `/api/groups/${g.id}/members/${m.id}`, {}));
          }
        });
        chip.append(x);
      }
      mem.append(chip);
    }
    card.append(mem);

    const inv = el("div", "gp-invite");
    const link = el("input");
    link.readOnly = true;
    link.value = inviteLink(g.invite_code);
    link.addEventListener("focus", () => link.select());
    const copy = el("button", "btn", "Link kopieren");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(link.value, copy));
    inv.append(link, copy);
    card.append(el("div", "muted small", "Einladung – wer den Link hat, kann beitreten:"), inv);

    const actions = el("div", "gp-actions");
    const act = (label, cls, handler) => {
      const b = el("button", `btn small ${cls || ""}`, label);
      b.type = "button";
      b.addEventListener("click", handler);
      actions.append(b);
    };
    if (g.is_owner) {
      act("Umbenennen", "", () => {
        const name = prompt("Neuer Name der Gruppe:", g.name);
        if (name && name.trim() && name.trim() !== g.name) run(() => api("PUT", `/api/groups/${g.id}`, { name: name.trim() }));
      });
      act("Neuer Link", "", () => {
        if (confirm("Neuen Einladungslink erzeugen? Der bisherige Link funktioniert dann nicht mehr.")) {
          run(() => api("POST", `/api/groups/${g.id}/code`, {}));
        }
      });
    }
    act("Verlassen", "", () => {
      const last = g.members.length === 1;
      const msg = last
        ? `Du bist das letzte Mitglied. „${g.name}“ wird mit allen ${g.events} Events gelöscht. Fortfahren?`
        : `„${g.name}“ verlassen? Deine Gruppen-Events bleiben in der Gruppe.${g.is_owner && g.members.filter((x) => x.is_owner).length === 1 ? " Das nächste Mitglied wird Owner." : ""}`;
      if (confirm(msg)) run(() => api("POST", `/api/groups/${g.id}/leave`, {}));
    });
    if (g.is_owner) {
      act("Gruppe löschen", "danger", () => {
        if (confirm(`„${g.name}“ mit allen ${g.events} Events für alle Mitglieder löschen?`)) {
          run(() => api("DELETE", `/api/groups/${g.id}`, {}));
        }
      });
    }
    card.append(actions);
    container.append(card);
  }
}

// Einladungslink #join=CODE nach dem Laden auswerten
async function handleJoinHash(onJoined) {
  const m = location.hash.match(/^#join=([A-Za-z0-9_-]{8,32})$/);
  if (!m) return;
  if (isGuest()) { location.href = `/login${location.hash}`; return; }   // erst anmelden, dann beitreten
  history.replaceState(null, "", location.pathname);
  try {
    const p = await api("GET", `/api/groups/preview?code=${encodeURIComponent(m[1])}`);
    if (p.already_member) { alert(`Du bist bereits Mitglied von „${p.name}“.`); return; }
    const ok = confirm(`Der Gruppe „${p.name}“ (${p.members} ${p.members === 1 ? "Mitglied" : "Mitglieder"}) beitreten?\n\n`
      + "Du siehst dann die Gruppen-Events, und die Mitglieder sehen deine Einträge dort.");
    if (!ok) return;
    await api("POST", "/api/groups/join", { code: m[1] });
    await onJoined();
  } catch (ex) { alert(ex.message); }
}

/* ---------- Veranstalter & Rennstrecken (Stammdaten vom Admin) ---------- */
const refs = { organizers: [], tracks: [] };
const REF_KINDS = {
  organizer: { list: "organizers", idKey: "organizer_id", nameKey: "organizer_name", title: "Veranstalter", none: "– kein Veranstalter –",
    fields: [["website", "Website", "url"], ["email", "E-Mail", "mail"], ["phone", "Telefon", "tel"], ["note", "Notiz", "text"]] },
  track: { list: "tracks", idKey: "track_id", nameKey: "track_name", title: "Rennstrecke", none: "– keine Rennstrecke –",
    fields: [["location", "Ort", "text"], ["length", "Länge", "text"], ["website", "Website", "url"], ["note", "Notiz", "text"]] },
};

async function loadRefs() {
  [refs.organizers, refs.tracks] = await Promise.all([api("GET", "/api/organizers"), api("GET", "/api/tracks")]);
  syncManagerMenu();
}

function fillRefSelect(select, kind, currentId) {
  const k = REF_KINDS[kind];
  select.replaceChildren(new Option(k.none, ""));
  for (const r of refs[k.list]) select.append(new Option(r.name, r.id));
  select.value = currentId && refs[k.list].some((r) => r.id === currentId) ? String(currentId) : "";
}
const refValue = (select) => (select.value ? Number(select.value) : null);

// Veranstalter-Auswahl im Formular: Eventmanager sehen bei öffentlichen Events nur ihre Veranstalter (Pflichtfeld)
function fillOrganizerSelect(form, me, currentId) {
  const sel = form.organizer_id;
  if (me.is_admin || form.visibility.value !== "public") {
    sel.required = false;
    fillRefSelect(sel, "organizer", currentId);
    return;
  }
  const ids = managedIds(me);
  sel.replaceChildren();
  for (const r of refs.organizers) if (ids.includes(r.id)) sel.append(new Option(r.name, r.id));
  sel.required = true;
  if (ids.includes(currentId)) sel.value = String(currentId);
}

// Kurztext "Veranstalter · Strecke" für Tooltip und Wochenansicht
const refText = (ev) => [ev.organizer_name, ev.track_name].filter(Boolean).join(" · ");

// Klickbare Verweise auf Veranstalter und Rennstrecke; leer, wenn keins gesetzt ist
function refLinks(ev, container) {
  container.replaceChildren();
  for (const kind of ["organizer", "track"]) {
    const k = REF_KINDS[kind];
    if (!ev[k.idKey]) continue;
    const row = el("span", "ref-item");
    const b = el("button", "ref-link", ev[k.nameKey]);
    b.type = "button";
    b.dataset.refKind = kind;
    b.dataset.refId = ev[k.idKey];
    b.title = `${k.title}: Details anzeigen`;
    row.append(el("span", "ref-label", k.title), b);
    container.append(row);
  }
  container.hidden = !container.childElementCount;
  return container;
}

/* Ein gemeinsamer Dialog für Details, Bearbeiten und „Meine Veranstalter“ (Desktop: Fenster, Handy: Sheet) */
let refDialog = null;
const isMobile = () => document.body.classList.contains("m");

function refFrame(sub, title) {
  const mobile = isMobile();
  if (!refDialog) {
    refDialog = el("dialog", mobile ? "sheet ref-dlg" : "ref-dlg");
    refDialog.addEventListener("click", (e) => { if (e.target === refDialog) refDialog.close(); });
    document.body.append(refDialog);
  }
  const body = el("div", mobile ? "sheet-body" : "dlg");
  const head = el("header");
  const titles = el("div");
  titles.append(el("span", "muted small", sub), el("h2", null, title));
  head.append(titles);
  const close = el("button", mobile ? "btn m-close" : "btn icon", mobile ? "Schließen" : "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Schließen");
  close.addEventListener("click", () => refDialog.close());
  if (!mobile) head.append(close);
  body.append(head);
  return { body, close, mobile };
}

function refShow(f) {
  if (f.mobile) f.body.append(f.close);
  refDialog.replaceChildren(f.body);
  if (!refDialog.open) refDialog.showModal();
}

function showRef(kind, id) {
  const k = REF_KINDS[kind];
  const r = refs[k.list].find((x) => x.id === id);
  if (!r) return;
  const f = refFrame(k.title, r.name);

  const dl = el("dl", "ref-details");
  for (const [key, label, type] of k.fields) {
    const v = (r[key] || "").trim();
    if (!v) continue;
    let dd = el("dd", type === "text" ? "note" : null);
    if (type === "url" && /^https?:\/\//i.test(v)) {
      const a = el("a", null, v.replace(/^https?:\/\//i, "").replace(/\/$/, ""));
      a.href = v; a.target = "_blank"; a.rel = "noopener noreferrer";
      dd.append(a);
    } else if (type === "mail") {
      const a = el("a", null, v); a.href = `mailto:${v}`; dd.append(a);
    } else if (type === "tel") {
      const a = el("a", null, v); a.href = `tel:${v.replace(/[^\d+]/g, "")}`; dd.append(a);
    } else dd.textContent = v;
    dl.append(el("dt", null, label), dd);
  }
  if (!dl.childElementCount) dl.append(el("dd", "muted", "Keine weiteren Angaben hinterlegt."));
  f.body.append(dl);
  if (kind === "organizer" && canEditOrganizer(id)) {
    const ed = el("button", "btn", "Angaben bearbeiten");
    ed.type = "button";
    ed.addEventListener("click", () => editOrganizer(id));
    f.body.append(ed);
  }
  refShow(f);
}

// Eventmanager pflegen Website, E-Mail, Telefon und Notiz ihres Veranstalters (Name ändert der Admin)
function editOrganizer(id) {
  const r = refs.organizers.find((x) => x.id === id);
  if (!r) return;
  const f = refFrame("Veranstalter bearbeiten", r.name);
  const form = el("form", "ref-edit");
  const max = { website: 300, email: 200, phone: 60, note: 2000 };
  for (const [key, label, type] of REF_KINDS.organizer.fields) {
    const lab = el("label", null, `${label} `);
    const inp = el(type === "text" ? "textarea" : "input");
    inp.name = key;
    if (type === "text") inp.rows = 4;
    else inp.type = type === "mail" ? "email" : type === "tel" ? "tel" : "text";
    if (type === "url") inp.placeholder = "www.beispiel.de";
    inp.maxLength = max[key];
    inp.value = r[key] || "";
    lab.append(inp);
    form.append(lab);
  }
  const err = el("p", "error");
  err.hidden = true;
  const acts = el("footer");
  const back = el("button", "btn", "Zurück");
  back.type = "button";
  back.addEventListener("click", () => showRef("organizer", id));
  const save = el("button", "btn primary", "Speichern");
  save.type = "submit";
  acts.append(back, save);
  form.append(err, acts);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    for (const [key] of REF_KINDS.organizer.fields) body[key] = form.elements[key].value;
    save.disabled = true;
    try {
      await api("PUT", `/api/organizers/${id}`, body);
      if (typeof loadEvents === "function") await loadEvents(); else await loadRefs();
      showRef("organizer", id);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      save.disabled = false;
    }
  });
  f.body.append(el("p", "muted small", "Den Namen des Veranstalters ändert der Admin."), form);
  refShow(f);
}

// „Meine Veranstalter“ für Eventmanager: ein Veranstalter → direkt bearbeiten, mehrere → Auswahl
function openMyOrganizers() {
  const ids = managedIds(currentMe());
  const mine = refs.organizers.filter((r) => ids.includes(r.id));
  if (mine.length === 1) { showRef("organizer", mine[0].id); return; }
  const f = refFrame("Eventmanager", "Meine Veranstalter");
  const list = el("div", "feed-list");
  if (!mine.length) list.append(el("p", "muted", "Dir sind keine Veranstalter zugeordnet."));
  for (const r of mine) {
    const row = el("div", "feed-row");
    const txt = el("div", "feed-txt");
    txt.append(el("strong", null, r.name), el("span", "muted small", r.website || "keine Website hinterlegt"));
    const acts = el("div", "feed-acts");
    const b = el("button", "btn small", "Bearbeiten");
    b.type = "button";
    b.addEventListener("click", () => editOrganizer(r.id));
    acts.append(b);
    row.append(txt, acts);
    list.append(row);
  }
  f.body.append(list);
  refShow(f);
}

// Menüeintrag „Meine Veranstalter“ – nur für Eventmanager; wird nach jedem Laden der Stammdaten abgeglichen
function syncManagerMenu() {
  const me = currentMe();
  const show = isManager(me);
  let b = $("my-orgs");
  if (!show) { if (b) b.remove(); return; }
  if (b) return;
  const desktop = $("user-menu"), mobile = $("m-menu");
  if (desktop) {
    b = el("button", null, "Meine Veranstalter");
    desktop.insertBefore(b, $("btn-password"));
  } else if (mobile) {
    b = el("button", "m-row", "Meine Veranstalter");
    mobile.querySelector(".sheet-body").insertBefore(b, $("m-feed"));
    b.addEventListener("click", () => mobile.close());
  } else return;
  b.type = "button";
  b.id = "my-orgs";
  b.addEventListener("click", openMyOrganizers);
}

document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-ref-kind]");
  if (!b) return;
  e.preventDefault();
  showRef(b.dataset.refKind, Number(b.dataset.refId));
});

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

/* ---------- Kalender-Abo (ICS-Feed) ----------
   Geheimer Link je Benutzer; Kalender-Apps rufen ihn regelmäßig ab. */
let feedDialog = null;
function openFeedDialog(groups) {
  const mobile = document.body.classList.contains("m");
  if (!feedDialog) {
    feedDialog = el("dialog", mobile ? "sheet feed-dlg" : "wide feed-dlg");
    feedDialog.addEventListener("click", (e) => { if (e.target === feedDialog) feedDialog.close(); });
    document.body.append(feedDialog);
  }
  const body = el("div", mobile ? "sheet-body" : "dlg");
  const head = el("header");
  head.append(el("h2", null, "Kalender-Abo"));
  const close = el("button", mobile ? "btn m-close" : "btn icon", mobile ? "Schließen" : "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Schließen");
  close.addEventListener("click", () => feedDialog.close());
  if (!mobile) head.append(close);
  body.append(head, el("p", "muted small",
    "Abonniere deine Termine im Kalender deines Handys oder Rechners. Änderungen kommen automatisch an "
    + "(je nach App nach einigen Minuten bis Stunden). Der Link ist geheim – wer ihn hat, sieht deine Termine."));
  const list = el("div", "feed-list");
  const err = el("p", "error");
  err.hidden = true;
  body.append(list, err);

  const fill = (url) => {
    list.replaceChildren();
    const feeds = [
      ["Meine Termine", "geplant, gebucht, private Termine und alles, woran eine deiner Gruppen teilnimmt", url],
      ["Alle Termine", "alles, was du bei racingkalender.de siehst", `${url}?umfang=alle`],
      ...groups.map((g) => [`Gruppe: ${g.name}`, "Termine der Gruppe und alles, woran sie teilnimmt", `${url}?gruppe=${g.id}`]),
    ];
    for (const [title, hint, link] of feeds) {
      const row = el("div", "feed-row");
      const txt = el("div", "feed-txt");
      txt.append(el("strong", null, title), el("span", "muted small", hint));
      const acts = el("div", "feed-acts");
      const sub = el("a", "btn small primary", "Abonnieren");
      sub.href = link.replace(/^https?:/, "webcal:");          // öffnet Apple-Kalender / Outlook direkt
      const copy = el("button", "btn small", "Link kopieren");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(link, copy));
      acts.append(sub, copy);
      row.append(txt, acts);
      list.append(row);
    }
    list.append(el("p", "muted small",
      "Google Kalender: „Link kopieren“, dann im Browser unter Weitere Kalender → „Per URL“ einfügen. "
      + "iPhone, Mac und Outlook: „Abonnieren“ öffnet die Kalender-App direkt."));
    const renew = el("button", "btn small", "Neuen Link erzeugen");
    renew.type = "button";
    renew.addEventListener("click", async () => {
      if (!confirm("Neuen Link erzeugen? Alle bisherigen Abos hören auf zu funktionieren und müssen neu eingerichtet werden.")) return;
      try { fill((await api("POST", "/api/feed/renew", {})).url); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    list.append(renew);
  };

  if (mobile) body.append(close);
  feedDialog.replaceChildren(body);
  list.append(el("p", "muted", "Lade …"));
  if (!feedDialog.open) feedDialog.showModal();
  document.activeElement?.blur();
  api("GET", "/api/feed").then((r) => fill(r.url)).catch((ex) => { err.textContent = ex.message; err.hidden = false; });
}

/* ---------- Gruppen-Teilnahme ----------
   Owner einer Gruppe legen fest, ob ihre Gruppe an einem Event teilnimmt
   (möglich bei öffentlichen Events und bei Events der eigenen Gruppe). */
const canParticipate = (ev, g) => ev.visibility === "public" || (ev.visibility === "group" && ev.group_id === g.id);
// Text, wenn keine sichtbaren Teilnehmer: andere sieht man nur, wenn man mit ihnen in einer Gruppe ist
const noPeopleText = (ev) => (ev.visibility === "public" ? "noch niemand aus deinen Gruppen eingetragen" : "noch niemand eingetragen");
const groupNamesIn = (ev, groups) => groups.filter((g) => ev.groups_in.includes(g.id)).map((g) => g.name);

// Anzeige im Event: Owner bekommen ein Häkchen je eigener Gruppe, andere sehen, welche ihrer Gruppen teilnehmen
function groupParticipation(ev, groups, container, onToggle) {
  container.replaceChildren();
  for (const g of groups.filter((x) => canParticipate(ev, x))) {
    const on = ev.groups_in.includes(g.id);
    if (!g.is_owner && !on) continue;
    const item = el(g.is_owner ? "label" : "span", `gpart-item${on ? " on" : ""}`);
    item.style.setProperty("--c", catColor("group", g.color));
    if (g.is_owner) {
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = on;
      cb.addEventListener("change", () => onToggle(g.id, cb.checked));
      item.append(cb);
    } else item.append(el("i", "gp-dot"));
    item.append(el("span", null, `${g.name} nimmt teil`));
    container.append(item);
  }
  container.hidden = !container.childElementCount;
  return container;
}

/* ---------- Filter nach Veranstalter, Rennstrecke und Gruppe (Desktop + Handy) ----------
   Je eine Auswahlliste; mehrere gesetzt = Event muss alles erfüllen. Im Browser gemerkt. */
const refFilter = { organizer: "", track: "", group: "" };

function loadRefFilter() {
  try {
    const d = JSON.parse(localStorage.getItem("kal-refs") || "{}");
    refFilter.organizer = String(d.organizer || "");
    refFilter.track = String(d.track || "");
    refFilter.group = String(d.group || "");
  } catch { /* Speicher nicht verfügbar */ }
}

function saveRefFilter() {
  try { localStorage.setItem("kal-refs", JSON.stringify(refFilter)); } catch {}
}

const matchesRefs = (ev) =>
  (!refFilter.organizer || String(ev.organizer_id) === refFilter.organizer)
  && (!refFilter.track || String(ev.track_id) === refFilter.track)
  && (!refFilter.group || ev.groups_in.includes(Number(refFilter.group)));

// Auswahllisten neu aufbauen (nach dem Laden); gelöschte Einträge bzw. verlassene Gruppen fallen aus dem Filter
function buildRefFilter(container, groups, onChange) {
  container.replaceChildren();
  const lists = [
    ["organizer", "Alle Veranstalter", "Veranstalter", refs.organizers.map((r) => [r.id, r.name])],
    ["track", "Alle Rennstrecken", "Rennstrecke", refs.tracks.map((r) => [r.id, r.name])],
    ["group", "Alle Gruppen", "Gruppe nimmt teil", groups.map((g) => [g.id, `${g.name} nimmt teil`])],
  ];
  for (const [kind, all, title, options] of lists) {
    if (kind === "group" && !groups.length) { refFilter.group = ""; continue; }
    const sel = el("select", "rf-select");
    sel.setAttribute("aria-label", `Filter ${title}`);
    sel.append(new Option(all, ""));
    for (const [id, name] of options) sel.append(new Option(name, String(id)));
    if (!options.some(([id]) => String(id) === refFilter[kind])) refFilter[kind] = "";
    sel.value = refFilter[kind];
    sel.classList.toggle("on", !!refFilter[kind]);
    sel.addEventListener("change", () => {
      refFilter[kind] = sel.value;
      sel.classList.toggle("on", !!sel.value);
      saveRefFilter();
      onChange();
    });
    container.append(sel);
  }
}

/* ---------- Erklär-Video („So geht's“) ---------- */
// kind: "desktop" | "mobil"; n: { banner, thumb, play, close, buttons[], dialog, player }
async function setupIntro(kind, n) {
  let info;
  try { info = ((await api("GET", "/api/config")).videos || {})[kind]; } catch { return; }
  if (!info) return;
  const open = () => {
    if (n.player.dataset.src !== info.url) { n.player.src = info.url; n.player.dataset.src = info.url; }
    n.dialog.showModal();
    try { n.player.currentTime = 0; } catch {}
    n.player.play().catch(() => {});
    track("video_angesehen", kind === "mobil" ? "Handy" : "Desktop");
  };
  n.dialog.addEventListener("close", () => n.player.pause());
  n.dialog.addEventListener("click", (e) => { if (e.target === n.dialog) n.dialog.close(); });
  for (const b of n.dialog.querySelectorAll("[data-close]")) b.addEventListener("click", () => n.dialog.close());
  n.player.addEventListener("ended", () => setTimeout(() => n.dialog.open && n.dialog.close(), 600));
  for (const b of n.buttons) { b.hidden = false; b.addEventListener("click", open); }
  let closed = false;
  try { closed = localStorage.getItem("kal-intro-closed") === "1"; } catch {}
  if (closed) return;
  const thumb = el("video");                             // Standbild aus dem Video als Vorschau
  thumb.muted = true; thumb.playsInline = true; thumb.preload = "metadata";
  thumb.src = `${info.url}#t=1.6`;
  thumb.setAttribute("aria-hidden", "true");
  n.thumb.prepend(thumb);
  n.banner.hidden = false;
  n.thumb.addEventListener("click", open);
  n.play.addEventListener("click", open);
  n.close.addEventListener("click", () => {
    n.banner.hidden = true;
    try { localStorage.setItem("kal-intro-closed", "1"); } catch {}
  });
}
