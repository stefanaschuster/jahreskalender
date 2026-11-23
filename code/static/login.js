"use strict";
/* Anmelden · Registrieren · Passwort vergessen · Links aus Mails (#confirm=…, #reset=…) */
document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));
const $ = (id) => document.getElementById(id);
const t = (key, vars) => i18n.t(key, vars);
const textsReady = new Promise((r) => document.addEventListener("i18n", r, { once: true }));
const info = $("login-info");
const forms = [...document.querySelectorAll("[data-mode]")];

// Einladungslink (#join=…) über die Anmeldung hinweg erhalten
const keepHash = /^#join=[A-Za-z0-9_-]{8,32}$/.test(location.hash) ? location.hash : "";
$("login-join").hidden = !keepHash;

// Hinweis oben als Textschlüssel merken, damit er beim Sprachwechsel mitwechselt
let infoMsg = null;
function showInfo() {
  info.textContent = infoMsg ? t(infoMsg.key, infoMsg.vars) : "";
  info.hidden = !infoMsg;
}
document.addEventListener("i18n", showInfo);

function show(mode, key, vars) {
  for (const f of forms) f.hidden = f.dataset.mode !== mode;
  infoMsg = key ? { key, vars } : null;
  showInfo();
  for (const e of document.querySelectorAll(".error")) e.hidden = true;
  const first = document.querySelector(`[data-mode="${mode}"] input`);
  if (first) first.focus();
}

function fail(container, text) {
  const e = container.querySelector(".error");
  e.textContent = text;
  e.hidden = false;
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

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data.detail, res.status));
  return data;
}

// Formular abschicken mit gesperrtem Knopf und Fehleranzeige
function handle(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector(".error").hidden = true;
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try { await fn(form); }
    catch (ex) { fail(form, ex instanceof TypeError ? t("err.offline") : ex.message); }
    finally { btn.disabled = false; }
  });
}

handle($("f-login"), async (f) => {
  await post("/api/login", { username: f.username.value, password: f.password.value });
  location.href = "/" + keepHash;
});

handle($("f-register"), async (f) => {
  if (f.password.value !== f.password2.value) throw new Error(t("err.pw_mismatch"));
  await post("/api/register", { username: f.username.value.trim(), email: f.email.value.trim(), password: f.password.value });
  const mail = f.email.value.trim();
  f.reset();
  show("login", "login.sent", { mail });
});

handle($("f-forgot"), async (f) => {
  await post("/api/password/forgot", { login: f.login.value.trim() });
  f.reset();
  show("login", "login.reset_sent");
});

let resetToken = "";
handle($("f-reset"), async (f) => {
  if (f.password.value !== f.password2.value) throw new Error(t("err.pw_mismatch"));
  await post("/api/password/reset", { token: resetToken, password: f.password.value });
  location.href = "/";
});

async function confirmRegistration(token) {
  show("confirm");
  $("confirm-text").textContent = t("login.wait");
  try {
    await post("/api/register/confirm", { token });
    $("confirm-text").textContent = t("login.active");
    setTimeout(() => { location.href = "/"; }, 900);
  } catch (ex) {
    $("confirm-text").hidden = true;
    fail($("f-confirm"), ex.message);
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go]");
  if (!a) return;
  e.preventDefault();
  show(a.dataset.go);
});

(async function init() {
  await textsReady;
  try {
    const cfg = await (await fetch("/api/config")).json();
    for (const a of document.querySelectorAll("[data-needs]")) a.hidden = !cfg[a.dataset.needs];
  } catch { /* ohne Konfiguration nur Anmelden */ }
  const h = location.hash;
  const m = h.match(/^#(confirm|reset)=([A-Za-z0-9_-]{20,100})$/);
  if (m) history.replaceState(null, "", location.pathname);       // Token nicht in der Adresszeile lassen
  if (m && m[1] === "confirm") confirmRegistration(m[2]);
  else if (m && m[1] === "reset") { resetToken = m[2]; show("reset"); }
  else if (h === "#forgot" || h === "#register") { history.replaceState(null, "", location.pathname); show(h.slice(1)); }
})();
