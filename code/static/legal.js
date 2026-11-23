// legal.js — Zentrale Angaben für Impressum & Datenschutzerklärung.
//
// HIER die Platzhalter füllen (gleiches Muster wie bei racedat / reifenbild).
// Die Seiten /impressum und /datenschutz lesen ausschließlich aus dieser Datei;
// an den HTML-Dateien selbst muss nichts geändert werden.
//
// Nach Änderungen: kein Server-Neustart nötig, nur Browser-Reload.
//
// Zweisprachig: Die Texte der Seiten stehen in texts.json (imprint.*, privacy.*). Felder mit
// Variante „_en“ werden auf Englisch verwendet. Nach jedem Sprachwechsel (Ereignis „i18n“)
// werden die Platzhalter neu gefüllt, weil i18n.js die Absätze dabei neu schreibt.

document.head.append(Object.assign(document.createElement("script"), { src: "/static/foot.js" }));

const LEGAL_DATA = {
  // --- Verantwortlicher (Impressum + Datenschutz) ---
  name: "Stefan Schuster",
  strasse: "Buchenweg 12",
  plzOrt: "73773 Aichwald",
  email: "generic@gmx.org",
  telefon: "",                           // optional, leer = Zeile wird ausgeblendet

  // --- Hosting ---
  // Name + Anschrift des Hosters, oder "Eigener Server" wenn die Maschine
  // bei dir selbst steht.
  hosterName: "Strato GmbH",             // TODO prüfen
  hosterAnschrift: "Otto-Ostrowski-Straße 7, 10249 Berlin",  // TODO prüfen

  // --- Betriebsart ---
  // Wird im Impressum als Zusatz angezeigt.
  betriebsart: "Privat betriebenes, nichtkommerzielles Projekt.",
  betriebsart_en: "Privately run, non-commercial project.",

  // --- Datum der letzten Aktualisierung der Datenschutzerklärung ---
  stand: "November 2026",
  stand_en: "November 2026",
};

// Füllt alle Elemente mit data-legal="<key>" mit dem jeweiligen Wert.
// Elemente mit data-legal-row werden komplett ausgeblendet, wenn der
// Wert leer ist (z. B. Telefon).
function fillLegal() {
  const en = window.i18n && i18n.lang === "en";
  document.querySelectorAll("[data-legal]").forEach((el) => {
    const key = el.getAttribute("data-legal");
    const val = en && LEGAL_DATA[key + "_en"] !== undefined ? LEGAL_DATA[key + "_en"] : LEGAL_DATA[key];
    if (val === undefined) return;
    if (!val && el.hasAttribute("data-legal-row")) {
      el.style.display = "none";
      return;
    }
    el.textContent = val;
  });
  // Zeilen, deren Wert in einem Kind-Element steht (z. B. „Telefon: …“)
  document.querySelectorAll("[data-legal-row-for]").forEach((el) => {
    if (!LEGAL_DATA[el.getAttribute("data-legal-row-for")]) el.style.display = "none";
  });
  // mailto-Links
  document.querySelectorAll("[data-legal-mailto]").forEach((el) => {
    el.setAttribute("href", "mailto:" + LEGAL_DATA.email);
    el.textContent = LEGAL_DATA.email;
  });
}
document.addEventListener("DOMContentLoaded", fillLegal);
document.addEventListener("i18n", fillLegal);
