"use strict";
document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));

// Aktion → Art der Markierung; Bezeichnung aus texts.json (action.<name>)
const ACTIONS = {
  login: "ok",
  logout: "",
  login_fehlgeschlagen: "bad",
  login_gesperrt: "bad",
  ansicht_jahr: "view",
  ansicht_woche: "view",
  ansicht_monat: "view",
  event_angesehen: "view",
  event_angelegt: "edit",
  event_geaendert: "edit",
  event_geloescht: "bad",
  status: "edit",
  gruppe_angelegt: "edit",
  gruppe_beigetreten: "ok",
  gruppe_beitritt_fehlgeschlagen: "bad",
  gruppe_verlassen: "",
  gruppe_umbenannt: "edit",
  gruppe_neuer_code: "edit",
  gruppe_mitglied_entfernt: "bad",
  gruppe_geloescht: "bad",
  gruppe_teilnahme: "edit",
  gruppe_owner: "edit",
  passwort_geaendert: "edit",
  passwort_fehlgeschlagen: "bad",
  benutzer_angelegt: "edit",
  benutzer_passwort: "edit",
  benutzer_rolle: "edit",
  benutzer_eventmanager: "edit",
  benutzer_abgemeldet: "",
  benutzer_geloescht: "bad",
  veranstalter_angelegt: "edit",
  veranstalter_geaendert: "edit",
  veranstalter_geloescht: "bad",
  strecke_angelegt: "edit",
  strecke_geaendert: "edit",
  strecke_geloescht: "bad",
  daten_geloescht: "bad",
  ics_export: "view",
  ics_import: "edit",
  registrierung_angefragt: "view",
  registriert: "ok",
  passwort_vergessen: "",
  passwort_zurueckgesetzt: "edit",
  benutzer_email: "edit",
  mail_fehler: "bad",
  abo_neu: "edit",
  video_hochgeladen: "edit",
  video_entfernt: "bad",
  video_angesehen: "view",
};
const PAGE = 200;
const LIVE_MS = 10000;

const $ = (id) => document.getElementById(id);
const t = (key, vars) => i18n.t(key, vars);
const textsReady = new Promise((r) => document.addEventListener("i18n", r, { once: true }));
const actionLabel = (a) => (a in ACTIONS ? t(`action.${a}`) : a);
const locale = () => (i18n.lang === "de" ? "de-DE" : "en-GB");
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  if (res.status === 403) { location.href = "/"; throw new Error("403"); }
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.json()).detail; } catch {}
    throw new Error(errorText(detail, res.status));
  }
  return res.json();
}

// Fehlermeldung des Servers: Textschlüssel, Schlüssel mit Platzhaltern oder Liste von Prüffehlern
function errorText(detail, status) {
  if (typeof detail === "string") return t(detail);
  if (detail && typeof detail === "object" && !Array.isArray(detail) && detail.key) return t(detail.key, detail.values);
  if (Array.isArray(detail)) {
    return detail.map((x) => {
      const m = /^Value error, (err\.\w+)$/.exec(x.msg || "");
      return m ? t(m[1]) : t("err.invalid", { field: (x.loc || []).slice(-1)[0] ?? "" });
    }).join(", ");
  }
  return t("err.http", { status });
}
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body || {}) });
let me = null;

// DB speichert UTC "YYYY-MM-DD HH:MM:SS" → lokale Zeit
function fmtTs(ts) {
  if (!ts) return "–";
  const d = new Date(ts.replace(" ", "T") + "Z");
  return d.toLocaleString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtAgo(ts) {
  if (!ts) return "–";
  const s = (Date.now() - new Date(ts.replace(" ", "T") + "Z")) / 1000;
  if (s < 60) return t("admin.just_now");
  if (s < 3600) return t("admin.min_ago", { n: Math.floor(s / 60) });
  if (s < 86400) return t("admin.h_ago", { n: Math.floor(s / 3600) });
  return t("admin.days_ago", { n: Math.floor(s / 86400) });
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
  if (u.is_admin) return t("admin.role.admin");
  if (u.organizers.length) return t("admin.role.manager", { names: u.organizers.map((o) => o.name).join(", ") });
  return t("admin.role.user");
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  const tb = $("users").querySelector("tbody");
  tb.replaceChildren();
  usersById.clear();
  const sel = $("f-user"), cur = sel.value;
  sel.replaceChildren(new Option(t("admin.all_users"), ""));
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
    tr.title = t("admin.created", { ts: fmtTs(u.created_at) });
    tb.append(tr);
  }
  sel.value = cur;
}

function manageCell(u) {
  const td = el("td", "nowrap manage");
  const self = me && u.id === me.id;
  const b = (label, action, cls) => { const x = el("button", `btn small ${cls || ""}`, label); x.type = "button"; x.dataset.action = action; td.append(x); return x; };
  b(t("admin.btn.pw"), "pw");
  b(t("admin.btn.email"), "email");
  b(t(u.is_admin ? "admin.btn.revoke" : "admin.btn.make"), "role").disabled = self && u.is_admin;
  const em = b(t("admin.btn.manager"), "em");
  em.disabled = u.is_admin;
  em.title = t(u.is_admin ? "admin.manager_admin" : "admin.manager_title");
  b(t("admin.btn.logout"), "logout").disabled = !u.sessions;
  b(t("btn.delete"), "del", "danger").disabled = self;
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
      if (!confirm(t("admin.delete_user", { name }))) return;
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
  userHeading();
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
function userHeading() {
  const mode = editing ? editing.mode : "new";
  $("user-heading").textContent = mode === "pw" ? t("admin.pw_for", { name: editing.name })
    : mode === "email" ? t("admin.email_for", { name: editing.name }) : t("admin.new_user");
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
  head.append(el("h2", null, t("admin.manager_head", { name: u.username })));
  const x = el("button", "btn icon", "✕");
  x.type = "button";
  x.setAttribute("aria-label", t("btn.close"));
  x.addEventListener("click", () => managerDialog.close());
  head.append(x);
  form.append(head, el("p", "muted small", t("admin.manager_hint")));
  const have = new Set(u.organizers.map((o) => o.id));
  const list = el("div", "em-list");
  if (!refData.organizers.length) list.append(el("p", "muted", t("admin.no_organizers")));
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
  const save = el("button", "btn primary", t("btn.save"));
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
// one und Feldbezeichnungen sind Textschlüssel
const REF = {
  organizers: { one: "ref.organizer", fields: [["name", "admin.ref.name", "input"], ["website", "ref.website", "input"],
    ["email", "ref.email", "input"], ["phone", "ref.phone", "input"], ["note", "admin.ref.note", "textarea"]] },
  tracks: { one: "ref.track", fields: [["name", "admin.ref.name", "input"], ["location", "admin.ref.location", "input"],
    ["length", "ref.length", "input"], ["website", "ref.website", "input"], ["note", "admin.ref.note", "textarea"]] },
};
const refData = { organizers: [], tracks: [] };

async function loadRefs() {
  for (const key of Object.keys(REF)) {
    refData[key] = await api(`/api/${key}`);
    const table = $(`ref-${key}`);
    const cols = REF[key].fields.filter(([k]) => k !== "note");
    const head = el("tr");
    for (const [, label] of cols) head.append(el("th", null, t(label)));
    head.append(el("th", "num", t("admin.ref.events")), el("th", null, t("admin.col.manage")));
    table.tHead.replaceChildren(head);
    const tb = table.tBodies[0];
    tb.replaceChildren();
    for (const r of refData[key]) {
      const tr = el("tr");
      cols.forEach(([k], i) => tr.append(el("td", i === 0 ? "strong" : "detail", r[k] || "")));
      tr.append(el("td", "num", String(r.events)));
      const td = el("td", "nowrap manage");
      for (const [label, action, cls] of [["btn.edit", "edit", ""], ["btn.delete", "del", "danger"]]) {
        const b = el("button", `btn small ${cls}`, t(label));
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
  $("ref-heading").textContent = t(row ? "admin.ref.edit" : "admin.ref.new", { kind: t(REF[key].one) });
  const box = $("ref-fields");
  box.replaceChildren();
  for (const [k, label, type] of REF[key].fields) {
    const lab = el("label", null, t(label) + " ");
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
  let msg = t(!n ? "admin.ref.delete" : n === 1 ? "admin.ref.delete_used_one" : "admin.ref.delete_used", { name: row.name, n });
  if (key === "organizers") msg += t("admin.ref.delete_manager");
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
  if (file.size > 5_000_000) { alert(t("admin.ics_too_big")); return; }
  const btn = e.target.querySelector("[type=submit]");
  btn.disabled = true;
  box.hidden = false;
  box.replaceChildren(el("p", "muted", t("admin.importing")));
  try {
    const r = await send("/api/admin/import", "POST", { ics: await file.text(), create_refs: $("ics-create").checked });
    box.replaceChildren(el("p", "ok", t("admin.import_result", { new: r.neu, updated: r.aktualisiert, skipped: r.uebersprungen.length })));
    const list = (title, items) => {
      if (!items.length) return;
      const ul = el("ul");
      for (const item of items) ul.append(el("li", null, item));
      box.append(el("p", "small", title), ul);
    };
    list(t("admin.import_created"), r.angelegt);
    list(t("admin.import_unknown"), r.unbekannt);
    list(t("admin.import_skipped"), r.uebersprungen);
    if (r.ohne_zuordnung) box.append(el("p", "small muted", t("admin.import_unassigned", { n: r.ohne_zuordnung })));
    $("ics-file").value = "";
    await loadRefs();
    await pollNew();
  } catch (err) {
    box.replaceChildren(el("p", "error", err.message));
  } finally { btn.disabled = false; }
});

/* ---------- Erklär-Videos ---------- */
const VIDEO_KINDS = ["desktop", "mobil"];
let videoInfo = {};
function renderVideos(info) {
  videoInfo = info;
  const box = $("video-rows");
  box.replaceChildren();
  for (const kind of VIDEO_KINDS) {
    const label = t(`admin.video.${kind}`);
    const v = info[kind];
    const row = el("div", "video-row");
    const text = el("div", "video-text");
    text.append(el("strong", null, label),
      el("span", "muted small", v ? t("admin.video.present", { size: (v.size / 1048576).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t("admin.video.none")));
    if (v) {
      const a = el("a", "small", t("admin.video.view")); a.href = v.url; a.target = "_blank"; a.rel = "noopener";
      text.append(a);
    }
    const file = el("input"); file.type = "file"; file.accept = "video/mp4,.mp4"; file.hidden = true;
    const up = el("button", "btn primary", t(v ? "admin.video.replace" : "admin.video.upload"));
    const msg = el("span", "small");
    up.addEventListener("click", async () => {
      const f = file.files[0];
      if (!f) { file.click(); return; }
      if (f.size > 9 * 1048576) { msg.className = "small error"; msg.textContent = t("admin.video.too_big"); return; }
      up.disabled = true; msg.className = "small muted"; msg.textContent = t("admin.video.uploading");
      try {
        const res = await fetch(`/api/admin/videos/${kind}`, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: f });
        if (!res.ok) {
          let detail = null;
          try { detail = (await res.json()).detail; } catch {}
          throw new Error(errorText(detail, res.status));
        }
        renderVideos(await res.json());
      } catch (err) { msg.className = "small error"; msg.textContent = err.message; up.disabled = false; }
    });
    file.addEventListener("change", () => { if (file.files[0]) up.click(); });
    const actions = el("div", "video-actions");
    actions.append(file, up);
    if (v) {
      const del = el("button", "btn danger", t("admin.video.remove"));
      del.addEventListener("click", async () => {
        if (!confirm(t("admin.video.remove_confirm", { label }))) return;
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
  const label = actionLabel(r.action), kind = ACTIONS[r.action] || "";
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

function fillActions() {
  const sel = $("f-action"), cur = sel.value;
  sel.replaceChildren(new Option(t("admin.all_actions"), ""));
  for (const key of Object.keys(ACTIONS)) sel.append(new Option(actionLabel(key), key));
  sel.value = cur;
}
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

// Sprachwechsel: alles, was das Skript gezeichnet hat, neu aufbauen
document.addEventListener("i18n", () => {
  if (!me) return;
  $("username").textContent = t("admin.me", { name: me.username });
  fillActions();
  loadUsers().catch(() => {});
  loadRefs().catch(() => {});
  renderVideos(videoInfo);
  renderLog();
  if ($("user-dialog").open) userHeading();
});

(async function init() {
  [me] = await Promise.all([api("/api/me"), textsReady]);
  $("username").textContent = t("admin.me", { name: me.username });
  fillActions();
  await loadUsers();
  await loadRefs();
  await loadVideos();
  await reloadLog();
})();
