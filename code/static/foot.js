"use strict";
/* Fußzeile: Version und „hosted on instant-run“ – hängt sich an die vorhandene Fußzeile an */
(function () {
  function add() {
    if (document.getElementById("ir-ver")) return;
    let foot = document.querySelector(".app-foot");
    const ver = document.createElement("span");
    ver.id = "ir-ver";
    const host = document.createElement("span");
    host.textContent = "hosted on instant-run";
    if (foot) {
      foot.append(" · ", ver, " · ", host);
    } else {
      foot = document.createElement("footer");
      foot.className = "ir-foot";
      Object.assign(foot.style, { textAlign: "center", fontSize: ".7rem", opacity: ".45", margin: "2rem 0 1rem" });
      foot.append(ver, " · ", host);
      document.body.append(foot);
    }
    fetch("/version").then((r) => r.json()).then((v) => {
      ver.textContent = "v" + v.version;
      if (v.site) {
        const a = document.createElement("a");
        a.href = v.site; a.target = "_blank"; a.rel = "noopener";
        a.style.color = "inherit";
        a.textContent = "hosted on instant-run";
        host.replaceWith(a);
      }
    }).catch(() => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();
