"use strict";

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
};
const PAGE = 200;
const LIVE_MS = 10000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  if (res.status === 403) { location.href = "/"; throw new Error("403"); }
  if (!res.ok) throw new Error(`Fehler ${res.status}`);
  return res.json();
}

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
async function loadUsers() {
  const users = await api("/api/admin/users");
  const tb = $("users").querySelector("tbody");
  tb.replaceChildren();
  const sel = $("f-user"), cur = sel.value;
  sel.replaceChildren(new Option("Alle Benutzer", ""));
  for (const u of users) {
    sel.append(new Option(u.username, u.id));
    const tr = el("tr", "clickable");
    tr.dataset.id = u.id;
    const cells = [
      [u.username, "strong"], [u.is_admin ? "Admin" : "Benutzer"], [u.logins, "num"],
      [fmtTs(u.last_login)], [fmtAgo(u.last_seen)], [u.sessions, "num"],
      [u.geplant, "num"], [u.gebucht, "num"], [u.events, "num"], [u.actions, "num"],
    ];
    for (const [text, cls] of cells) tr.append(el("td", cls, String(text)));
    tr.title = `angelegt ${fmtTs(u.created_at)}`;
    tb.append(tr);
  }
  sel.value = cur;
}

$("users").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  $("f-user").value = tr.dataset.id;
  reloadLog();
  $("log").scrollIntoView({ behavior: "smooth", block: "start" });
});

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
  const me = await api("/api/me");
  $("username").textContent = `${me.username} (Admin)`;
  await loadUsers();
  await reloadLog();
})();
