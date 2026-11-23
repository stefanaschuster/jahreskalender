// Zweisprachigkeit: Texte aus /static/texts.json, Sprache aus Cookie ir_lang oder Browser.
(function () {
  const LANGS = ["de", "en"], root = document.documentElement;
  root.classList.add("i18n-wait");
  setTimeout(() => root.classList.remove("i18n-wait"), 1500);
  const m = document.cookie.match(/(?:^|;\s*)ir_lang=(de|en)\b/);
  let lang = m ? m[1] : ((navigator.languages || [navigator.language || ""])
    .map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => LANGS.includes(l)) || "en");
  let texts = {};
  const src = (document.currentScript && document.currentScript.dataset.texts) || "/static/texts.json";
  const loaded = fetch(src).then((r) => r.json()).then((t) => { texts = t; }).catch(() => {});
  function t(key, vars) {
    let s = (texts[lang] || {})[key] ?? (texts.de || {})[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (a, k) => (k in vars ? vars[k] : a)) : s;
  }
  function apply() {
    root.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => el.dataset.i18nAttr.split(";").forEach((p) => {
      const [a, k] = p.split(":"); if (a && k) el.setAttribute(a.trim(), t(k.trim()));
    }));
    document.querySelectorAll("[data-lang-switch]").forEach((box) => {
      box.innerHTML = LANGS.map((l) => `<button type="button" lang="${l}" aria-pressed="${l === lang}">${l.toUpperCase()}</button>`).join(" | ");
    });
    document.dispatchEvent(new CustomEvent("i18n", { detail: { lang } }));
    root.classList.remove("i18n-wait");
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang-switch] button");
    if (!b) return;
    lang = b.lang;
    const domain = location.hostname.split(".").slice(-2).join(".");
    document.cookie = `ir_lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; Domain=${domain}`;
    apply();
  });
  window.i18n = { t, get lang() { return lang; } };
  const ready = new Promise((r) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
  Promise.all([loaded, ready]).then(apply);
})();
