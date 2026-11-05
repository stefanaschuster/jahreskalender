"use strict";
const form = document.getElementById("login-form");
const err = document.getElementById("login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    if (res.ok) { location.href = "/"; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.detail || "Anmeldung fehlgeschlagen";
    err.hidden = false;
  } catch {
    err.textContent = "Server nicht erreichbar";
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
