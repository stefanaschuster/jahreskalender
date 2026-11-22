"use strict";
/* Anmelden · Registrieren · Passwort vergessen · Links aus Mails (#confirm=…, #reset=…) */
document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));
const $ = (id) => document.getElementById(id);
const info = $("login-info");
const forms = [...document.querySelectorAll("[data-mode]")];

// Einladungslink (#join=…) über die Anmeldung hinweg erhalten
const keepHash = /^#join=[A-Za-z0-9_-]{8,32}$/.test(location.hash) ? location.hash : "";
$("login-join").hidden = !keepHash;

function show(mode, message) {
  for (const f of forms) f.hidden = f.dataset.mode !== mode;
  info.textContent = message || "";
  info.hidden = !message;
  for (const e of document.querySelectorAll(".error")) e.hidden = true;
  const first = document.querySelector(`[data-mode="${mode}"] input`);
  if (first) first.focus();
}

function fail(container, text) {
  const e = container.querySelector(".error");
  e.textContent = text;
  e.hidden = false;
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join(", ") : d || `Fehler ${res.status}`);
  }
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
    catch (ex) { fail(form, ex.message === "Failed to fetch" ? "Server nicht erreichbar" : ex.message); }
    finally { btn.disabled = false; }
  });
}

handle($("f-login"), async (f) => {
  await post("/api/login", { username: f.username.value, password: f.password.value });
  location.href = "/" + keepHash;
});

handle($("f-register"), async (f) => {
  if (f.password.value !== f.password2.value) throw new Error("Die Passwörter stimmen nicht überein");
  await post("/api/register", { username: f.username.value.trim(), email: f.email.value.trim(), password: f.password.value });
  const mail = f.email.value.trim();
  f.reset();
  show("login", `Fast geschafft: Wir haben eine Mail an ${mail} geschickt. Klick auf den Link darin, um dein Konto zu aktivieren.`);
});

handle($("f-forgot"), async (f) => {
  await post("/api/password/forgot", { login: f.login.value.trim() });
  f.reset();
  show("login", "Falls es dazu ein Konto mit E-Mail-Adresse gibt, ist ein Link unterwegs. Er gilt eine Stunde.");
});

let resetToken = "";
handle($("f-reset"), async (f) => {
  if (f.password.value !== f.password2.value) throw new Error("Die Passwörter stimmen nicht überein");
  await post("/api/password/reset", { token: resetToken, password: f.password.value });
  location.href = "/";
});

async function confirmRegistration(token) {
  show("confirm");
  try {
    await post("/api/register/confirm", { token });
    $("confirm-text").textContent = "Dein Konto ist aktiv. Du wirst angemeldet …";
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
