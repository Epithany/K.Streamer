(() => {
  "use strict";
  const nav = document.getElementById("appNav");

  // Every glass surface on the site, in one place. Menus are created later by
  // other scripts: LiquidGlass watches the DOM and attaches to them as they appear.
  // The More pop-up is only a surface on phones (on the rail it is plain nav).
  window.glassSelector = (base) =>
    [
      base,
      ".nav-plate",
      ".acct-menu",
      ".pk",
      ".season-menu",
      ".modal",
      ".upload-dialog",
      ".search-dlg",
      ".ls-side",
      matchMedia("(max-width: 760px)").matches ? ".nav-extra" : "",
    ]
      .filter(Boolean)
      .join(", ");

  // Live updates and search are shared by every signed-in page (never login/watch).
  const loadScript = (src) =>
    new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = s.onerror = resolve;
      document.head.append(s);
    });
  const bare = /^\/(login|watch)\/?$/.test(location.pathname);
  if (!bare) {
    loadScript("/js/live.js");
    if (nav) loadScript("/js/search-core.js").then(() => loadScript("/js/search.js"));
  }

  if (!nav) return;

  // Remote and Chess are reachable from every screen that has this navigation.
  const extra = nav.querySelector(".nav-extra");
  if (extra && !extra.querySelector("[data-nav='/remote']")) {
    extra.insertAdjacentHTML(
      "afterbegin",
      '<a class="nav-item" href="/chess" data-nav="/chess"><i class="fa-solid fa-chess"></i><span class="nav-label">Chess</span></a>' +
        '<a class="nav-item" href="/remote" data-nav="/remote"><i class="fa-solid fa-sliders"></i><span class="nav-label">Remote</span></a>',
    );
  }

  // ----- Current page -----
  const path = location.pathname.replace(/\.html$/, "").replace(/\/+$/, "") || "/";
  for (const a of nav.querySelectorAll("a.nav-item[data-nav]")) {
    const to = a.dataset.nav;
    const on = to === "/" ? path === "/" : path === to || path.startsWith(to + "-");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }

  // ----- Rail: expand while focus is inside (remote / keyboard) -----
  nav.addEventListener("focusin", () => nav.classList.add("expanded"));
  nav.addEventListener("focusout", (e) => {
    if (!nav.contains(e.relatedTarget)) nav.classList.remove("expanded");
  });

  // ----- Phone: "More" pop-up -----
  const more = document.getElementById("navMore");
  const setMore = (open) => {
    nav.classList.toggle("more-open", open);
    more?.setAttribute("aria-expanded", String(open));
  };
  more?.addEventListener("click", (e) => {
    e.stopPropagation();
    setMore(!nav.classList.contains("more-open"));
  });
  nav.querySelector(".nav-extra")?.addEventListener("click", (e) => {
    if (e.target.closest(".nav-item")) setMore(false);
  });
  document.addEventListener("click", (e) => {
    if (!nav.contains(e.target)) setMore(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMore(false);
  });

  // ----- Remote: ArrowLeft reaches the rail, ArrowRight leaves it -----
  // Runs after the page's own arrow-key handling; only acts if focus didn't move.
  const CONTENT =
    ".grid .card, .tile, .track, .mg-tabs button, .ls-item.active, main a[href], main button";
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (matchMedia("(max-width: 760px)").matches) return;
    const from = document.activeElement;
    if (from?.closest("input, textarea, select, [role='slider'], dialog[open]")) return;
    setTimeout(() => {
      if (document.activeElement !== from) return;
      if (e.key === "ArrowLeft" && !nav.contains(from)) {
        (nav.querySelector("[aria-current='page']") || nav.querySelector(".nav-item"))?.focus();
      } else if (e.key === "ArrowRight" && nav.contains(from)) {
        document.querySelector(CONTENT)?.focus();
      }
    }, 0);
  });
})();
