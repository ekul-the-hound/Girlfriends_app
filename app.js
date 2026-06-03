/* ============================================================
   app.js — boot, global wiring, PWA
   ============================================================ */

(function init() {
  seedOnce();

  // apply saved theme
  const s = Settings.get();
  if (s.night) {
    document.body.classList.add("night");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#17141f");
  }

  // photo of the day rolls over at midnight (keep but mark not-today handled in UI)
  // initial route from hash
  const startId = (location.hash || "").replace("#", "");
  UI.go(Routes[startId] ? startId : "home");

  // bottom nav
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => UI.go(tab.dataset.go));
  });

  // modal backdrop closes on tap outside
  document.getElementById("modalBg").addEventListener("click", (e) => {
    if (e.target.id === "modalBg") UI.closeModal();
  });

  // lightbox controls
  document.getElementById("lightbox").addEventListener("click", (e) => {
    const act = e.target.dataset.lb;
    if (!act) { if (e.target.id === "lightbox") Gallery.closeLb(); return; }
    if (act === "close") Gallery.closeLb();
    if (act === "prev") Gallery.lbNav(-1);
    if (act === "next") Gallery.lbNav(1);
    if (act === "fav") Gallery.lbFav();
    if (act === "del") Gallery.lbDel();
  });

  // keyboard for lightbox
  document.addEventListener("keydown", (e) => {
    const lb = document.getElementById("lightbox");
    if (lb.classList.contains("on")) {
      if (e.key === "ArrowLeft") Gallery.lbNav(-1);
      if (e.key === "ArrowRight") Gallery.lbNav(1);
      if (e.key === "Escape") Gallery.closeLb();
    } else if (document.getElementById("modalBg").classList.contains("on") && e.key === "Escape") {
      UI.closeModal();
    }
  });

  // hash navigation (back button friendly)
  window.addEventListener("hashchange", () => {
    const id = (location.hash || "").replace("#", "") || "home";
    if (Routes[id] && id !== App.current) UI.go(id);
  });

  // register service worker for PWA / offline
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
