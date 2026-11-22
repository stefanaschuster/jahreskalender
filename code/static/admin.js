"use strict";
document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));

const ACTIONS = {
  login: ["Login", "ok"],
  logout: ["Logout", ""],
  login_fehlgeschlagen: ["Login fehlgeschlagen", "bad"],
  login_gesperrt: ["Login gesperrt", "bad"],
  ansicht_jahr: ["Jahresansicht", "view"],
  ansicht_woche: ["Wochenansicht", "view"],
  ansicht_monat: ["Monatsansicht (Handy)", "view"],
  event_angesehen: ["Event angesehen", "view"],
  event_angelegt: ["Event angelegt", "edit"],
  event_geaendert: ["Event geändert", "edit"],
  event_geloescht: ["Event gelöscht", "bad"],
  status: ["Status gesetzt", "edit"],
  gruppe_angelegt: ["Gruppe gegründet", "edit"],
  gruppe_beigetreten: ["Gruppe beigetreten", "ok"],
  gruppe_beitritt_fehlgeschlagen: ["Beitritt fehlgeschlagen", "bad"],
  gruppe_verlassen: ["Gruppe verlassen", ""],
  gruppe_umbenannt: ["Gruppe umbenannt", "edit"],
  gruppe_neuer_code: ["Neuer Einladungslink", "edit"],
  gruppe_mitglied_entfernt: ["Mitglied entfernt", "bad"],
  gruppe_geloescht: ["Gruppe gelöscht", "bad"],
  gruppe_teilnahme: ["Gruppen-Teilnahme", "edit"],
  gruppe_owner: ["Gruppen-Owner geändert", "edit"],
  passwort_geaendert: ["Eigenes Passwort geändert", "edit"],
  passwort_fehlgeschlagen: ["Passwortänderung fehlgeschlagen", "bad"],
  benutzer_angelegt: ["Benutzer angelegt", "edit"],
  benutzer_passwort: ["Passwort gesetzt", "edit"],
  benutzer_rolle: ["Rolle geändert", "edit"],
  benutzer_eventmanager: ["Eventmanager-Rolle geändert", "edit"],
  benutzer_abgemeldet: ["Benutzer abgemeldet", ""],
  benutzer_geloescht: ["Benutzer gelöscht", "bad"],
  veranstalter_angelegt: ["Veranstalter angelegt", "edit"],
  veranstalter_geaendert: ["Veranstalter geändert", "edit"],
  veranstalter_geloescht: ["Veranstalter gelöscht", "bad"],
  strecke_angelegt: ["Rennstrecke angelegt", "edit"],
  strecke_geaendert: ["Rennstrecke geändert", "edit"],
  strecke_geloescht: ["Rennstrecke gelöscht", "bad"],
  daten_geloescht: ["Events & Stammdaten gelöscht (Skript)", "bad"],
  ics_export: ["ICS-Export", "view"],
  ics_import: ["ICS-Import", "edit"],
  registrierung_angefragt: ["Registrierung angefragt", "view"],
  registriert: ["Registriert (bestätigt)", "ok"],
  passwort_vergessen: ["Passwort vergessen", ""],
  passwort_zurueckgesetzt: ["Passwort zurückgesetzt", "edit"],
  benutzer_email: ["E-Mail gesetzt", "edit"],
  mail_fehler: ["Mailversand fehlgeschlagen", "bad"],
  abo_neu: ["Kalender-Abo: neuer Link", "edit"],
  video_hochgeladen: ["Erklär-Video hochgeladen", "edit"],
  video_entfernt: ["Erklär-Video entfernt", "bad"],
  video_angesehen: ["Erklär-Video angesehen", "view"],
};
const PAGE = 200;
const LIVE_MS = 10000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  if (res.status === 403) { location.href = "/"; throw new Error("403"); }
  if (!res.ok) {
    let msg = `Fehler ${res.status}`;
    try { const j = await res.json(); if (typeof j.detail === "string") msg = j.detail; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body || {}) });
let me = null;

// DB speichert UTC "YYYY-MM-DD HH:MM:SS" → lokale Zeit
function fmtTs(ts) {
  if (!ts) return "–";
  const d = new Date(ts.replace(" ", "T") + "Z");
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtAgo(ts) {
  if (!ts) return "–";
  const s = (Date.now() - new Date(ts.replace(" ", "T") + "Z")) / 1000;
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.floor(s / 60)} min`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} h`;
  return `vor ${Math.floor(s / 86400)} Tagen`;
}

// User-Agent kurz: "Firefox 133 · Windows"
function shortUA(s) {
  if (!s) return "";
  const b = [[/Edg\/(\d+)/, "Edge"], [/Firefox\/(\d+)/, "Firefox"], [/(?:Headless)?Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+).*Safari/, "Safari"]].find(([re]) => re.test(s));
  const os = [[/Android/, "Android"], [/iPhone|iPad/, "iOS"], [/Windows/, "Windows"], [/Mac OS X/, "macOS"],
    [/Linux/, "Linux"]].find(([re]) => re.test(s));
  const browser = b ? `${b[1]} ${s.match(b[0])[1]}` : "";
  return [browser, os ? os[1] : ""].filter(Boolean).join(" · ") || s;
}

/* ---------- Benutzer ---------- */
const usersById = new Map();

function roleText(u) {
  if (u.is_admin) return "Admin";
  if (u.organizers.length) return `Eventmanager: ${u.organizers.map((o) => o.name).join(", ")}`;
  return "Benutzer";
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  const tb = $("users").querySelector("tbody");
  tb.replaceChildren();
  usersById.clear();
  const sel = $("f-user"), cur = sel.value;
  sel.replaceChildren(new Option("Alle Benutzer", ""));
  for (const u of users) {
    usersById.set(String(u.id), u);
    sel.append(new Option(u.username, u.id));
    const tr = el("tr", "clickable");
    tr.dataset.id = u.id;
    const cells = [
      [u.username, "strong"], [u.email || "–", u.email ? "detail" : "muted"], [roleText(u), u.organizers.length && !u.is_admin ? "detail" : ""], [u.logins, "num"],
      [fmtTs(u.last_login)], [fmtAgo(u.last_seen)], [u.sessions, "num"],
      [u.geplant, "num"], [u.gebucht, "num"], [u.events, "num"], [u.groups, "num"], [u.actions, "num"],
    ];
    for (const [text, cls] of cells) tr.append(el("td", cls, String(text)));
    tr.append(manageCell(u));
    tr.title = `angelegt ${fmtTs(u.created_at)}`;
    tb.append(tr);
  }
  sel.value = cur;
}

function manageCell(u) {
  const td = el("td", "nowrap manage");
  const self = me && u.id === me.id;
  const b = (label, action, cls) => { const x = el("button", `btn small ${cls || ""}`, label); x.type = "button"; x.dataset.action = action; td.append(x); return x; };
  b("Passwort", "pw");
  b("E-Mail", "email");
  b(u.is_admin ? "Admin entziehen" : "Zum Admin", "role").disabled = self && u.is_admin;
  const em = b("Eventmanager", "em");
  em.disabled = u.is_admin;
  em.title = u.is_admin ? "Admins dürfen ohnehin alle Events bearbeiten" : "Veranstalter festlegen, deren Events der Benutzer verwaltet";
  b("Abmelden", "logout").disabled = !u.sessions;
  b("Löschen", "del", "danger").disabled = self;
  td.dataset.name = u.username;
  td.dataset.admin = u.is_admin ? "1" : "";
  td.dataset.email = u.email || "";
  return td;
}

async function manage(action, id, name, isAdmin, email) {
  try {
    if (action === "pw") return openUserDialog({ id, name, mode: "pw" });
    if (action === "email") return openUserDialog({ id, name, mode: "email", email });
    if (action === "em") return openManagerDialog(usersById.get(String(id)));
    if (action === "role") {
      await send(`/api/admin/users/${id}/admin`, "PUT", { is_admin: !isAdmin });
    } else if (action === "logout") {
      await send(`/api/admin/users/${id}/logout`, "POST");
    } else if (action === "del") {
      if (!confirm(`„${name}“ wirklich löschen? Private Events und Markierungen des Benutzers gehen verloren, er verlässt alle Gruppen.`)) return;
      await send(`/api/admin/users/${id}`, "DELETE");
    }
    await loadUsers();
    await pollNew();
  } catch (err) { alert(err.message); }
}

/* Dialog: neuer Benutzer, Passwort setzen oder E-Mail setzen */
let editing = null;
function openUserDialog(target) {
  editing = target || null;
  const mode = editing ? editing.mode : "new";
  const f = $("user-form");
  f.reset();
  $("user-error").hidden = true;
  $("user-heading").textContent = mode === "pw" ? `Passwort für ${editing.name}`
    : mode === "email" ? `E-Mail für ${editing.name}` : "Neuer Benutzer";
  $("user-name-label").hidden = mode !== "new";
  f.username.required = mode === "new";
  $("user-admin-label").hidden = mode !== "new";
  $("user-email-label").hidden = mode === "pw";
  $("user-pw-label").hidden = mode === "email";
  f.password.required = mode !== "email";
  $("user-gen").hidden = mode === "email";
  if (mode === "email") f.email.value = editing.email || "";
  $("user-dialog").showModal();
  (mode === "pw" ? f.password : mode === "email" ? f.email : f.username).focus();
}
function genPassword() {
  const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(r, (n) => a[n % a.length]).join("");
}
$("btn-add-user").addEventListener("click", () => openUserDialog());
$("user-close").addEventListener("click", () => $("user-dialog").close());
$("user-gen").addEventListener("click", () => { $("user-form").password.value = genPassword(); });
$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    if (editing?.mode === "pw") {
      await send(`/api/admin/users/${editing.id}/password`, "PUT", { password: f.password.value });
    } else if (editing?.mode === "email") {
      await send(`/api/admin/users/${editing.id}/email`, "PUT", { email: f.email.value.trim() });
    } else {
      await send("/api/admin/users", "POST", { username: f.username.value.trim(), email: f.email.value.trim(),
        password: f.password.value, is_admin: f.is_admin.checked });
    }
    $("user-dialog").close();
    await loadUsers();
    await pollNew();
  } catch (err) {
    $("user-error").textContent = err.message;
    $("user-error").hidden = false;
  }
});

/* Dialog: Rolle Eventmanager – Veranstalter auswählen */
let managerDialog = null;
function openManagerDialog(u) {
  if (!u) return;
  if (!managerDialog) {
    managerDialog = el("dialog");
    document.body.append(managerDialog);
  }
  const form = el("form", "dlg");
  const head = el("header");
  head.append(el("h2", null, `Eventmanager: ${u.username}`));
  const x = el("button", "btn icon", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Schließen");
  x.addEventListener("click", () => managerDialog.close());
  head.append(x);
  form.append(head, el("p", "muted small",
    "Für die gewählten Veranstalter darf der Benutzer öffentliche Events anlegen, ändern und löschen. Keine Auswahl = normaler Benutzer."));
  const have = new Set(u.organizers.map((o) => o.id));
  const list = el("div", "em-list");
  if (!refData.organizers.length) list.append(el("p", "muted", "Noch keine Veranstalter angelegt."));
  for (const o of refData.organizers) {
    const lab = el("label", "toggle");
    const cb = el("input");
    cb.type = "checkbox";
    cb.value = o.id;
    cb.checked = have.has(o.id);
    lab.append(cb, ` ${o.name}`);
    list.append(lab);
  }
  const err = el("p", "error");
  err.hidden = true;
  const foot = el("footer");
  const save = el("button", "btn primary", "Speichern");
  save.type = "submit";
  foot.append(save);
  form.append(list, err, foot);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ids = [...list.querySelectorAll("input:checked")].map((c) => Number(c.value));
    try {
      await send(`/api/admin/users/${u.id}/organizers`, "PUT", { organizer_ids: ids });
      managerDialog.close();
      await loadUsers();
      await pollNew();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  managerDialog.replaceChildren(form);
  managerDialog.showModal();
}

$("users").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) {
    const td = btn.closest("td"), tr = btn.closest("tr");
    manage(btn.dataset.action, tr.dataset.id, td.dataset.name, !!td.dataset.admin, td.dataset.email);
    return;
  }
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  $("f-user").value = tr.dataset.id;
  reloadLog();
  $("log").scrollIntoView({ behavior: "smooth", block: "start" });
});

/* ---------- Stammdaten: Veranstalter und Rennstrecken ---------- */
const REF = {
  organizers: { one: "Veranstalter", fields: [["name", "Name", "input"], ["website", "Website", "input"],
    ["email", "E-Mail", "input"], ["phone", "Telefon", "input"], ["note", "Notiz / Details", "textarea"]] },
  tracks: { one: "Rennstrecke", fields: [["name", "Name", "input"], ["location", "Ort / Land", "input"],
    ["length", "Länge", "input"], ["website", "Website", "input"], ["note", "Notiz / Details", "textarea"]] },
};
const refData = { organizers: [], tracks: [] };

async function loadRefs() {
  for (const key of Object.keys(REF)) {
    refData[key] = await api(`/api/${key}`);
    const table = $(`ref-${key}`);
    const cols = REF[key].fields.filter(([k]) => k !== "note");
    const head = el("tr");
    for (const [, label] of cols) head.append(el("th", null, label));
    head.append(el("th", "num", "Events"), el("th", null, "Verwalten"));
    table.tHead.replaceChildren(head);
    const tb = table.tBodies[0];
    tb.replaceChildren();
    for (const r of refData[key]) {
      const tr = el("tr");
      cols.forEach(([k], i) => tr.append(el("td", i === 0 ? "strong" : "detail", r[k] || "")));
      tr.append(el("td", "num", String(r.events)));
      const td = el("td", "nowrap manage");
      for (const [label, action, cls] of [["Bearbeiten", "edit", ""], ["Löschen", "del", "danger"]]) {
        const b = el("button", `btn small ${cls}`, label);
        b.type = "button";
        b.addEventListener("click", () => (action === "edit" ? openRef(key, r) : deleteRef(key, r)));
        td.append(b);
      }
      tr.append(td);
      tb.append(tr);
    }
    $(`ref-${key}-empty`).hidden = refData[key].length > 0;
  }
}

let refEdit = null;
function openRef(key, row) {
  refEdit = { key, id: row ? row.id : null };
  $("ref-heading").textContent = row ? `${REF[key].one} bearbeiten` : `Neu: ${REF[key].one}`;
  const box = $("ref-fields");
  box.replaceChildren();
  for (const [k, label, type] of REF[key].fields) {
    const lab = el("label", null, label + " ");
    const input = el(type);
    input.name = k;
    if (type === "textarea") input.rows = 4;
    input.maxLength = k === "note" ? 2000 : k === "name" ? 100 : 300;
    if (k === "name") input.required = true;
    input.value = row ? row[k] || "" : "";
    lab.append(input);
    box.append(lab);
  }
  $("ref-error").hidden = true;
  $("ref-dialog").showModal();
  box.querySelector("[name=name]").focus();
}

async function deleteRef(key, row) {
  const n = row.events;
  let msg = n ? `„${row.name}“ löschen? Bei ${n} ${n === 1 ? "Event" : "Events"} wird das Feld danach leer.` : `„${row.name}“ löschen?`;
  if (key === "organizers") msg += " Eventmanager dieses Veranstalters verlieren ihre Rechte dafür.";
  if (!confirm(msg)) return;
  try {
    await send(`/api/admin/${key}/${row.id}`, "DELETE");
    await loadRefs();
    await loadUsers();
    await pollNew();
  } catch (err) { alert(err.message); }
}

$("ref-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const [k] of REF[refEdit.key].fields) body[k] = e.target.elements[k].value;
  try {
    if (refEdit.id) await send(`/api/admin/${refEdit.key}/${refEdit.id}`, "PUT", body);
    else await send(`/api/admin/${refEdit.key}`, "POST", body);
    $("ref-dialog").close();
    await loadRefs();
    await loadUsers();
    await pollNew();
  } catch (err) {
    $("ref-error").textContent = err.message;
    $("ref-error").hidden = false;
  }
});
$("ref-close").addEventListener("click", () => $("ref-dialog").close());
for (const b of document.querySelectorAll("[data-ref-add]")) b.addEventListener("click", () => openRef(b.dataset.refAdd));

/* ---------- ICS Import ---------- */
$("ics-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("ics-file").files[0];
  const box = $("ics-result");
  if (!file) return;
  if (file.size > 5_000_000) { alert("Datei ist größer als 5 MB"); return; }
  const btn = e.target.querySelector("[type=submit]");
  btn.disabled = true;
  box.hidden = false;
  box.replaceChildren(el("p", "muted", "Importiere …"));
  try {
    const r = await send("/api/admin/import", "POST", { ics: await file.text(), create_refs: $("ics-create").checked });
    box.replaceChildren(el("p", "ok", `${r.neu} neu angelegt, ${r.aktualisiert} aktualisiert, ${r.uebersprungen.length} übersprungen.`));
    const list = (title, items) => {
      if (!items.length) return;
      const ul = el("ul");
      for (const t of items) ul.append(el("li", null, t));
      box.append(el("p", "small", title), ul);
    };
    list("Neu in den Stammdaten:", r.angelegt);
    list("Nicht in den Stammdaten (Feld bleibt leer):", r.unbekannt);
    list("Übersprungen:", r.uebersprungen);
    if (r.ohne_zuordnung) box.append(el("p", "small muted",
      `${r.ohne_zuordnung} Termin(e) ohne erkennbaren Veranstalter und Strecke – erwartet werden z. B. Zeilen wie „Veranstalter: …“ und „Strecke: …“ in der Beschreibung oder ein Ort (LOCATION).`));
    $("ics-file").value = "";
    await loadRefs();
    await pollNew();
  } catch (err) {
    box.replaceChildren(el("p", "error", err.message));
  } finally { btn.disabled = false; }
});

/* ---------- Erklär-Videos ---------- */
const VIDEO_KINDS = [["desktop", "Desktop (Querformat 16:9)"], ["mobil", "Handy (Hochformat 9:16)"]];
function renderVideos(info) {
  const box = $("video-rows");
  box.replaceChildren();
  for (const [kind, label] of VIDEO_KINDS) {
    const v = info[kind];
    const row = el("div", "video-row");
    const text = el("div", "video-text");
    text.append(el("strong", null, label),
      el("span", "muted small", v ? `vorhanden · ${(v.size / 1048576).toFixed(1)} MB` : "noch kein Video"));
    if (v) {
      const a = el("a", "small", "ansehen"); a.href = v.url; a.target = "_blank"; a.rel = "noopener";
      text.append(a);
    }
    const file = el("input"); file.type = "file"; file.accept = "video/mp4,.mp4"; file.hidden = true;
    const up = el("button", "btn primary", v ? "Ersetzen" : "Hochladen");
    const msg = el("span", "small");
    up.addEventListener("click", async () => {
      const f = file.files[0];
      if (!f) { file.click(); return; }
      if (f.size > 9 * 1048576) { msg.className = "small error"; msg.textContent = "Datei ist größer als 9 MB"; return; }
      up.disabled = true; msg.className = "small muted"; msg.textContent = "Lade hoch …";
      try {
        const res = await fetch(`/api/admin/videos/${kind}`, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: f });
        if (!res.ok) {
          let m = `Fehler ${res.status}`;
          try { const j = await res.json(); if (typeof j.detail === "string") m = j.detail; } catch {}
          throw new Error(m);
        }
        renderVideos(await res.json());
      } catch (err) { msg.className = "small error"; msg.textContent = err.message; up.disabled = false; }
    });
    file.addEventListener("change", () => { if (file.files[0]) up.click(); });
    const actions = el("div", "video-actions");
    actions.append(file, up);
    if (v) {
      const del = el("button", "btn danger", "Entfernen");
      del.addEventListener("click", async () => {
        if (!confirm(`${label}: Video wirklich entfernen?`)) return;
        renderVideos(await send(`/api/admin/videos/${kind}`, "DELETE"));
      });
      actions.append(del);
    }
    row.append(text, actions, msg);
    box.append(row);
  }
}
async function loadVideos() { renderVideos(await api("/api/admin/videos")); }

/* ---------- Protokoll ---------- */
let rows = [];
let exhausted = false;

function query(before) {
  const p = new URLSearchParams({ limit: PAGE });
  if ($("f-user").value) p.set("user_id", $("f-user").value);
  if ($("f-action").value) p.set("action", $("f-action").value);
  if (before) p.set("before", before);
  return `/api/admin/activity?${p}`;
}

function rowEl(r) {
  const tr = el("tr");
  const [label, kind] = ACTIONS[r.action] || [r.action, ""];
  tr.append(el("td", "nowrap", fmtTs(r.ts)));
  const who = el("td", "nowrap", r.username || "–");
  if (!r.user_id) who.classList.add("muted");
  tr.append(who);
  const act = el("td", "nowrap");
  act.append(el("span", `tag ${kind}`, label));
  tr.append(act);
  const det = el("td", "detail", r.action === "login" ? shortUA(r.detail) : r.detail);
  det.title = r.detail;
  tr.append(det);
  tr.append(el("td", "nowrap muted", r.ip));
  return tr;
}

function renderLog() {
  const tb = $("log").querySelector("tbody");
  tb.replaceChildren(...rows.map(rowEl));
  $("log-empty").hidden = rows.length > 0;
  $("btn-more").hidden = exhausted || rows.length === 0;
}

async function reloadLog() {
  rows = await api(query());
  exhausted = rows.length < PAGE;
  renderLog();
}

async function loadMore() {
  const older = await api(query(rows[rows.length - 1].id));
  exhausted = older.length < PAGE;
  rows = rows.concat(older);
  renderLog();
}

async function pollNew() {
  const latest = await api(query());
  const top = rows.length ? rows[0].id : 0;
  const fresh = latest.filter((r) => r.id > top);
  if (fresh.length) { rows = fresh.concat(rows); renderLog(); }
}

for (const [key, [label]] of Object.entries(ACTIONS)) $("f-action").append(new Option(label, key));
$("f-user").addEventListener("change", reloadLog);
$("f-action").addEventListener("change", reloadLog);
$("btn-more").addEventListener("click", loadMore);
$("btn-refresh").addEventListener("click", () => { loadUsers(); reloadLog(); });

setInterval(() => {
  if (!$("f-live").checked || document.hidden) return;
  pollNew().catch(() => {});
  loadUsers().catch(() => {});
}, LIVE_MS);

$("btn-logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } finally { location.href = "/login"; }
});

(async function init() {
  me = await api("/api/me");
  $("username").textContent = `${me.username} (Admin)`;
  await loadUsers();
  await loadRefs();
  await loadVideos();
  await reloadLog();
})();
