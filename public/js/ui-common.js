(() => {
  "use strict";

  const DIRS = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };

  // Back keys: desktop Escape/Backspace, Android TV, Tizen (10009), webOS (461).
  const BACK_KEYS = new Set(["Escape", "Backspace", "BrowserBack", "GoBack", "XF86Back"]);
  const BACK_CODES = new Set([10009, 461]);
  const isBack = (e) => BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode);

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  // Focus rings only for keyboard / remote use, never after a click or tap.
  const root = document.documentElement;
  addEventListener(
    "keydown",
    (e) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      root.dataset.input = "key";
    },
    true,
  );
  for (const type of ["pointerdown", "touchstart"]) {
    addEventListener(type, () => (root.dataset.input = "pointer"), { capture: true, passive: true });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function prettyName(name) {
    return String(name ?? "")
      .replace(/\.(mp4|mkv|webm|mov|avi|m4v)$/i, "")
      .replace(/[._]+/g, " ")
      .replace(/\b(480|720|1080|2160)p\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Covers: ask the server for a thumbnail only when it is near view ----
  const requested = new Set();

  function requestCover(id) {
    if (!id || requested.has(id)) return;
    requested.add(id);
    fetch(`/api/thumbnails/${encodeURIComponent(id)}`, { method: "POST" }).catch(() =>
      requested.delete(id),
    );
  }

  const coverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        coverObserver.unobserve(entry.target);
        requestCover(entry.target.dataset.coverId);
      }
    },
    { rootMargin: "200px" },
  );

  function watchCover(el, id) {
    if (!el || !id) return;
    el.dataset.coverId = id;
    coverObserver.observe(el);
  }

  // ---- Spatial navigation (D-pad / arrow keys) ----
  function focusables(scope) {
    return [...scope.querySelectorAll("a[href],button,[tabindex]")].filter(
      (el) =>
        el.tabIndex >= 0 &&
        !el.disabled &&
        !el.closest("[inert],[hidden]") &&
        el.getClientRects().length > 0,
    );
  }

  function focusEl(el) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({
      block: "nearest",
      inline: el.hasAttribute("data-center") ? "center" : "nearest",
      behavior: reduceMotion.matches ? "auto" : "smooth",
    });
  }

  // Moves focus to the nearest focusable in `dir`. Returns true if focus moved.
  // `initial` (element or () => element) is used when nothing in scope has focus.
  function move(dir, scope = document.body, initial) {
    const list = focusables(scope);
    if (!list.length) return false;

    const active = document.activeElement;
    const cur = list.includes(active) ? active : null;

    if (!cur) {
      const start = (typeof initial === "function" ? initial() : initial) || list[0];
      focusEl(start);
      return true;
    }

    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestScore = Infinity;

    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2 - cx;
      const y = b.top + b.height / 2 - cy;
      let main;
      let cross;
      if (dir === "right") [main, cross] = [x, y];
      else if (dir === "left") [main, cross] = [-x, y];
      else if (dir === "down") [main, cross] = [y, x];
      else [main, cross] = [-y, x];
      if (main <= 2) continue;
      const score = main + Math.abs(cross) * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (!best) return false;
    focusEl(best);
    return true;
  }

  // ---- Watch history (per browser, in localStorage) ----
  // Resume points belong to the signed-in profile, not to the browser.
  const ACCT = (document.cookie.match(/(?:^|;\s*)ms_acct=([^;]+)/) || [])[1];
  const scope = (k) => (ACCT ? `${k}:${ACCT}` : k);
  const KEY_PROGRESS = scope("media-server-progress"); // videoId -> { t, d, at }
  const KEY_LAST = scope("media-server-last-episode"); // showId -> videoId
  const MAX_ENTRIES = 300;

  const read = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") || {};
    } catch {
      return {};
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };

  const progress = {
    get: (id) => read(KEY_PROGRESS)[id] || null,
    set(id, t, d) {
      const all = read(KEY_PROGRESS);
      all[id] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
      const ids = Object.keys(all);
      if (ids.length > MAX_ENTRIES) {
        ids
          .sort((a, b) => all[a].at - all[b].at)
          .slice(0, ids.length - MAX_ENTRIES)
          .forEach((k) => delete all[k]);
      }
      write(KEY_PROGRESS, all);
    },
    clear(id) {
      const all = read(KEY_PROGRESS);
      if (id in all) {
        delete all[id];
        write(KEY_PROGRESS, all);
      }
    },
    lastEpisode: (showId) => read(KEY_LAST)[showId] || null,
    setLastEpisode(showId, videoId) {
      const all = read(KEY_LAST);
      if (all[showId] === videoId) return;
      all[showId] = videoId;
      write(KEY_LAST, all);
    },
  };

  window.ui = { progress, DIRS, isBack, escapeHtml, prettyName, requestCover, watchCover, move, focusEl };
})();
