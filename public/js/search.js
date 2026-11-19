/* Search: a glass overlay (open with the Search button, "/" or Ctrl+K).
   The whole index is preloaded in the background and kept in memory, so
   results appear as you type. Empty search shows recent searches and recently
   added titles, whose thumbnails are warmed up ahead of time. */
(() => {
  "use strict";
  const Core = window.SearchCore;
  if (!Core) return;

  const acct = (document.cookie.match(/(?:^|;\s*)ms_acct=([^;]+)/) || [])[1] || "anon";
  const CACHE_KEY = `ms-search-index:${acct}`;
  const RECENT_KEY = `ms-search-recent:${acct}`;
  const KIND_ICON = { show: "fa-tv", episode: "fa-tv", movie: "fa-film", song: "fa-music", short: "fa-mobile-screen" };
  const KIND_LABEL = { show: "Show", episode: "Episode", movie: "Movie", song: "Song", short: "Short" };
  const FILTERS = [
    ["all", "All", null],
    ["watch", "Watch", ["show", "episode", "movie"]],
    ["music", "Music", ["song"]],
    ["shorts", "Shorts", ["short"]],
  ];

  let items = null; // prepared index
  let stale = false;
  let loading = null;
  let filter = "all";
  let dlg, input, list, status;

  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- Index: preload, cache, keep fresh ----------
  function setIndex(raw) {
    items = Core.prepare(raw.map((i) => ({ ...i })));
    warmSuggestions();
  }

  function loadIndex(force = false) {
    if (loading) return loading;
    if (items && !stale && !force) return Promise.resolve();
    loading = fetch("/api/search/index", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((data) => {
        stale = false;
        setIndex(data.items || []);
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data.items)); } catch {}
      })
      .catch(() => {})
      .finally(() => { loading = null; });
    return loading;
  }

  // Instant start: last session's index, then the real one.
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (Array.isArray(cached)) { setIndex(cached); stale = true; }
  } catch {}
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  idle(() => loadIndex(true));
  for (const type of ["library", "songs", "shorts", "resync"]) {
    window.addEventListener(`media:${type}`, () => {
      stale = true;
      if (dlg?.open) loadIndex().then(render); // someone is looking: refresh now
    });
  }

  // ---------- Thumbnail warm-up ----------
  const warmed = new Set();
  function warm(urls) {
    for (const u of urls) {
      if (!u || warmed.has(u)) continue;
      warmed.add(u);
      new Image().src = u;
    }
  }
  const recentlyAdded = () =>
    (items || [])
      .filter((i) => i.at && (i.k === "show" || i.k === "movie"))
      .sort((a, b) => b.at - a.at)
      .slice(0, 8);
  function warmSuggestions() {
    idle(() => warm(recentlyAdded().map((i) => i.thumb)));
  }

  // ---------- UI ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function mark(text, tokens) {
    const safe = esc(text);
    if (!tokens.length) return safe;
    const re = new RegExp(`(${tokens.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
    return safe.replace(re, "<mark>$1</mark>");
  }

  function build() {
    dlg = document.createElement("dialog");
    dlg.className = "search-dlg";
    dlg.setAttribute("aria-label", "Search");
    dlg.innerHTML = `
      <div class="sr-bar">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input id="srInput" type="search" placeholder="Search movies, shows, music and shorts" autocomplete="off" spellcheck="false" enterkeyhint="search" />
        <button id="srClose" class="hbtn sr-close" type="button" aria-label="Close search"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="sr-filters" role="group" aria-label="Filter results">
        ${FILTERS.map(([id, label]) => `<button type="button" class="sr-chip" data-filter="${id}" aria-pressed="${id === "all"}">${label}</button>`).join("")}
      </div>
      <div id="srList" class="sr-list" role="list"></div>
      <p id="srStatus" class="sr-status" role="status"></p>`;
    document.body.append(dlg);
    input = dlg.querySelector("#srInput");
    list = dlg.querySelector("#srList");
    status = dlg.querySelector("#srStatus");

    input.addEventListener("input", render);
    dlg.querySelector("#srClose").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
    dlg.querySelector(".sr-filters").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]");
      if (!b) return;
      filter = b.dataset.filter;
      dlg.querySelectorAll(".sr-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
      render();
    });
    list.addEventListener("click", (e) => {
      const row = e.target.closest("a.sr-row");
      if (row) remember(input.value);
      const recent = e.target.closest("[data-recent]");
      if (recent) { input.value = recent.dataset.recent; render(); input.focus(); }
    });
    dlg.addEventListener("keydown", onKey);
    dlg.addEventListener("close", () => { input.blur(); });
  }

  function onKey(e) {
    if (window.ui?.isBack?.(e) && e.key !== "Backspace") { e.preventDefault(); dlg.close(); return; }
    const rows = [...list.querySelectorAll("a.sr-row")];
    const at = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (rows[at + 1] || rows[0])?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at > 0) rows[at - 1].focus();
      else input.focus();
    } else if (e.key === "Enter" && document.activeElement === input && rows[0]) {
      e.preventDefault();
      remember(input.value);
      rows[0].click();
    }
  }

  function remember(q) {
    q = q.trim();
    if (q.length < 2) return;
    const recent = (store.get(RECENT_KEY) || []).filter((r) => r.toLowerCase() !== q.toLowerCase());
    recent.unshift(q);
    store.set(RECENT_KEY, recent.slice(0, 6));
  }

  function rowHtml(it, tokens) {
    const wide = it.k !== "song";
    const thumb = it.thumb
      ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />`
      : "";
    return `<a class="sr-row" role="listitem" href="${esc(it.url || "#")}">
      <span class="sr-thumb ${wide ? "wide" : ""}"><i class="fa-solid ${KIND_ICON[it.k]}"></i>${thumb}</span>
      <span class="sr-meta"><span class="sr-title">${mark(it.title, tokens)}</span><span class="sr-sub">${mark(it.sub, tokens)}</span></span>
      <span class="sr-kind">${KIND_LABEL[it.k]}</span>
    </a>`;
  }

  let seq = 0;
  async function render() {
    const q = input.value.trim();
    const kinds = FILTERS.find((f) => f[0] === filter)[2];
    const mine = ++seq;

    if (!q) {
      const recent = store.get(RECENT_KEY) || [];
      const added = recentlyAdded().filter((i) => !kinds || kinds.includes(i.k));
      list.innerHTML =
        (recent.length
          ? `<h3 class="sr-h">Recent searches</h3><div class="sr-recent">${recent.map((r) => `<button type="button" class="sr-chip" data-recent="${esc(r)}"><i class="fa-solid fa-clock-rotate-left"></i>${esc(r)}</button>`).join("")}</div>`
          : "") +
        (added.length ? `<h3 class="sr-h">Recently added</h3>${added.map((i) => rowHtml(i, [])).join("")}` : "");
      status.textContent = items ? "" : "Loading…";
      return;
    }

    let results;
    if (items) {
      results = Core.search(items, q, { limit: 40, kinds });
    } else {
      // Index not here yet (first moments after load): ask the server directly.
      status.textContent = "Searching…";
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}${kinds ? `&kinds=${kinds}` : ""}`, { credentials: "same-origin" });
        results = (await r.json()).results || [];
      } catch { results = []; }
      if (mine !== seq) return;
    }

    const tokens = Core.norm(q).split(/\s+/).filter(Boolean);
    list.innerHTML = results.map((i) => rowHtml(i, tokens)).join("");
    status.textContent = results.length ? "" : `No matches for “${q}”`;
    warm(results.slice(0, 6).map((i) => i.thumb));
  }

  function open() {
    if (!dlg) build();
    if (dlg.open) return;
    dlg.showModal();
    input.value = "";
    filter = "all";
    dlg.querySelectorAll(".sr-chip[data-filter]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === "all")));
    render();
    input.focus();
    if (!items || stale) loadIndex().then(() => dlg.open && render());
  }
  window.openSearch = open;

  document.getElementById("navSearch")?.addEventListener("click", open);
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if ((e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      open();
    }
  });
})();
