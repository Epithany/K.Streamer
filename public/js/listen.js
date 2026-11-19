(() => {
  "use strict";

  const ui = window.ui;
  const $ = (id) => document.getElementById(id);

  const app = $("app");
  const audio = $("audio");
  const dock = $("dock");
  const list = $("songList");
  const timeline = $("timeline");
  const tCur = $("tCur");
  const tLeft = $("tLeft");
  const pvTime = $("pvTime");
  const volSlider = $("volSlider");
  const volFill = $("volFill");
  const playBtn = $("playBtn");
  const nextBtn = $("nextBtn");
  const shuffleBtn = $("shuffleBtn");
  const repeatBtn = $("repeatBtn");
  const autoBtn = $("autoBtn");
  const playAllBtn = $("playAllBtn");

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const KEY = {
    vol: "media-server-listen-volume",
    shuffle: "media-server-listen-shuffle",
    repeat: "media-server-listen-repeat",
    auto: "media-server-listen-autoplay",
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} },
  };

  // ---------- State ----------
  let data = { songs: [], playlists: [], metaPending: 0 };
  let songsById = new Map();
  let playlistsById = new Map();

  let current = null; // the song loaded into <audio>
  let queuePlaylistId = "all"; // playlist the queue came from
  let queue = []; // song ids, in play order
  let viewId = "all"; // "queue" or a playlist id: what the main area shows

  let shuffle = store.get(KEY.shuffle) === "true";
  let repeat = store.get(KEY.repeat) === "true";
  let autoplay = store.get(KEY.auto) !== "false";

  let scrubPct = null;
  let reconnectAttempts = 0;
  let pollTimer;
  let drawerOpen = false;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const enc = encodeURIComponent;
  const cleanName = (n) => String(n ?? "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  const titleOf = (s) => s.title || cleanName(s.name);
  const playlistName = (id) => playlistsById.get(id)?.name || "";
  const subOf = (s) => {
    const parts = [s.artist, s.album].filter(Boolean);
    return parts.length ? parts.join(" · ") : playlistName(s.playlistId);
  };

  const fmt = (time) => {
    if (!Number.isFinite(time) || time < 0) return "0:00";
    const s = Math.floor(time % 60);
    const m = Math.floor(time / 60) % 60;
    const h = Math.floor(time / 3600);
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };
  const fmtTotal = (secs) => {
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${Math.max(1, m)} min`;
  };

  document.addEventListener("DOMContentLoaded", init);

  // ---------- Init ----------
  async function init() {
    bind();
    bindMediaSession();
    try {
      applyData(await fetchData());
    } catch {
      $("viewTitle").textContent = "Music";
      return showEmpty("Can’t reach the server. Check that it is running, then reload.");
    }

    const params = new URLSearchParams(location.search);
    const id = params.get("v");
    const song = id && songsById.get(id);
    if (song) {
      // Only trust ?p= if that playlist really contains the song.
      const p = params.get("p");
      queuePlaylistId = playlistsById.get(p)?.songIds.includes(song.id) ? p : song.playlistId;
      queue = makeQueue(playlistsById.get(queuePlaylistId).songIds, song.id);
      load(song);
      setView("queue");
    } else {
      if (id) window.deviceControl?.notify("That song isn’t in the library.");
      setView("all");
    }
  }

  async function fetchData() {
    const r = await fetch("/api/songs");
    if (!r.ok) throw new Error("bad response");
    return r.json();
  }

  // Tags are probed in the background on the server, so keep refreshing until
  // that is done. Refreshing never touches <audio>: playback isn't interrupted.
  async function refresh() {
    try { applyData(await fetchData()); } catch {}
  }

  function applyData(d) {
    data = d;
    songsById = new Map(d.songs.map((s) => [s.id, s]));
    playlistsById = new Map(d.playlists.map((p) => [p.id, p]));
    if (current) current = songsById.get(current.id) || current;
    if (!playlistsById.has(viewId) && viewId !== "queue") viewId = "all";
    syncQueue();
    renderSidebar();
    renderMain();
    if (current) renderNow(false);
    clearTimeout(pollTimer);
    if (d.metaPending > 0) pollTimer = setTimeout(refresh, 3000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh(); // pick up newly added files
  });

  // ---------- Queue ----------
  function shuffled(ids) {
    const a = [...ids];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function makeQueue(ids, firstId) {
    if (!shuffle) return [...ids];
    if (!ids.includes(firstId)) return shuffled(ids);
    return [firstId, ...shuffled(ids.filter((id) => id !== firstId))];
  }

  function syncQueue() {
    queue = queue.filter((id) => songsById.has(id));
    const pl = playlistsById.get(queuePlaylistId);
    if (!pl) return;
    if (!shuffle) {
      queue = [...pl.songIds];
      return;
    }
    const known = new Set(queue);
    for (const id of pl.songIds) if (!known.has(id)) queue.push(id);
  }

  function neighbor(dir) {
    if (!current || !queue.length) return null;
    const i = queue.indexOf(current.id);
    let n = i < 0 ? (dir > 0 ? 0 : -1) : i + dir;
    if (n < 0 || n >= queue.length) {
      if (!repeat || n < -1) return null;
      n = (n + queue.length) % queue.length;
    }
    return songsById.get(queue[n]) || null;
  }

  function go(dir) {
    const next = neighbor(dir);
    if (next) load(next);
  }

  function previous() {
    if (audio.currentTime > 3) audio.currentTime = 0;
    else go(-1);
  }

  function startPlaylist(playlistId, startId) {
    const pl = playlistsById.get(playlistId);
    if (!pl || !pl.songIds.length) return;
    queuePlaylistId = playlistId;
    const first = startId || (shuffle ? pl.songIds[Math.floor(Math.random() * pl.songIds.length)] : pl.songIds[0]);
    queue = makeQueue(pl.songIds, first);
    load(songsById.get(first));
    setView("queue");
  }

  function setShuffle(on) {
    shuffle = Boolean(on);
    store.set(KEY.shuffle, shuffle);
    shuffleBtn.setAttribute("aria-pressed", String(shuffle));
    const pl = playlistsById.get(queuePlaylistId);
    if (pl && current) queue = makeQueue(pl.songIds, current.id);
    updateNav();
    if (viewId === "queue") renderMain();
  }

  function setRepeat(on) {
    repeat = Boolean(on);
    store.set(KEY.repeat, repeat);
    repeatBtn.setAttribute("aria-pressed", String(repeat));
    updateNav();
  }

  function setAutoplay(on) {
    autoplay = Boolean(on);
    store.set(KEY.auto, autoplay);
    autoBtn.setAttribute("aria-pressed", String(autoplay));
  }

  // ---------- Loading a song (in place: playback survives view changes) ----------
  function load(song) {
    current = song;
    reconnectAttempts = 0;
    scrubPct = null;
    dock.hidden = false;
    $("navQueue").hidden = false;

    history.replaceState(null, "", `/listen?v=${enc(song.id)}&p=${enc(queuePlaylistId)}`);
    audio.src = song.streamUrl;
    audio.load(); // resets playbackRate to defaultPlaybackRate, which we keep in sync
    audio.play().catch(() => {}); // blocked autoplay just leaves the play button

    renderNow(true);
    updateTime();
    updateNav();
    paintSidebarState();
    markCurrent();
    paintPlayAll();
    updateMediaSession();
  }

  function renderNow(withCover) {
    if (!current) return;
    $("npTitle").textContent = titleOf(current);
    $("npSub").textContent = subOf(current);
    document.title = `${titleOf(current)} · K. Streamer`;
    if (withCover) {
      const art = $("npArt");
      art.querySelector("img")?.remove();
      art.classList.remove("has-img");
      loadCover(current.id, art, true);
    }
    updateMediaSession();
  }

  function updateNav() {
    nextBtn.disabled = !neighbor(1);
  }

  // ---------- Sidebar ----------
  let sideSig = "";

  function renderSidebar() {
    const sig = data.playlists.map((p) => `${p.id}:${p.name}:${p.songIds.length}:${p.mine ? 1 : 0}`).join("|");
    if (sig !== sideSig) {
      sideSig = sig;
      const nav = $("playlistNav");
      nav.replaceChildren();

      const make = (p) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ls-item";
        b.dataset.id = p.id;
        const icon = p.mine ? "fa-bookmark" : p.id === "all" ? "fa-music" : p.id === "singles" ? "fa-compact-disc" : "fa-folder";
        b.innerHTML =
          `<span class="ls-ico"><i class="fa-solid ${icon}"></i></span>` +
          '<span class="ls-name"></span><span class="ls-count"></span>';
        b.querySelector(".ls-name").textContent = p.name;
        b.querySelector(".ls-count").textContent = p.songIds.length;
        b.addEventListener("click", () => {
          setView(p.id);
          setDrawer(false);
        });
        return b;
      };

      for (const p of data.playlists.filter((x) => !x.mine)) nav.appendChild(make(p));

      const label = document.createElement("h2");
      label.className = "ls-label";
      label.textContent = "My playlists";
      nav.appendChild(label);
      for (const p of data.playlists.filter((x) => x.mine)) nav.appendChild(make(p));

      const add = document.createElement("button");
      add.type = "button";
      add.className = "ls-item ls-new";
      add.innerHTML = '<span class="ls-ico"><i class="fa-solid fa-plus"></i></span><span class="ls-name">New playlist</span>';
      add.addEventListener("click", createPlaylist);
      nav.appendChild(add);
    }
    paintSidebarState();
  }

  async function createPlaylist() {
    const name = await window.askText({ title: "New playlist", label: "Name", okText: "Create" });
    if (!name) return;
    try {
      const r = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind: "song" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn’t create the playlist");
      await refresh();
    } catch (err) {
      window.deviceControl?.notify(err.message);
    }
  }

  function paintSidebarState() {
    for (const b of $("playlistNav").children) {
      b.classList.toggle("active", viewId === b.dataset.id);
      b.classList.toggle("playing", Boolean(current) && queuePlaylistId === b.dataset.id);
    }
    $("navQueue").hidden = !current;
    $("navQueue").classList.toggle("active", viewId === "queue");
  }

  function setView(id) {
    viewId = id === "queue" && !current ? "all" : id;
    paintSidebarState();
    renderMain();
    if (viewId === "queue") markCurrent(true);
    else list.scrollTop = 0;
  }

  // ---------- Main area: queue, or the playlist being browsed ----------
  const rows = new Map(); // song id -> row element
  let listSig = "";

  function showEmpty(message) {
    $("empty").textContent = message;
    $("empty").hidden = false;
  }

  function renderMain() {
    let ids;
    let title;
    let kicker;
    let ctx;

    if (viewId === "queue" && current) {
      const pl = playlistsById.get(queuePlaylistId);
      ids = queue;
      title = pl?.name || "Queue";
      kicker = shuffle ? "Now playing · Shuffled queue" : "Now playing · Queue";
      ctx = queuePlaylistId;
    } else {
      const pl = playlistsById.get(viewId) || playlistsById.get("all");
      ids = pl ? pl.songIds : [];
      title = pl?.name || "Music";
      kicker = pl?.id === "all" ? "Library" : "Playlist";
      ctx = pl?.id || "all";
    }

    const known = ids.map((id) => songsById.get(id)?.duration);
    let meta = `${ids.length} song${ids.length === 1 ? "" : "s"}`;
    if (ids.length && known.every(Boolean)) meta += ` · ${fmtTotal(known.reduce((a, b) => a + b, 0))}`;

    $("viewKicker").textContent = kicker;
    $("viewTitle").textContent = title;
    $("viewMeta").textContent = meta;
    playAllBtn.hidden = !ids.length;
    paintPlayAll();

    if (!data.songs.length) {
      showEmpty("No music yet. Add audio files to the Songs folder, then reload.");
    } else {
      $("empty").hidden = true;
    }

    renderList(ids, ctx);
  }

  function paintPlayAll() {
    const inQueue = viewId === "queue" && current;
    const playing = inQueue && !audio.paused;
    playAllBtn.querySelector("i").className = `fa-solid ${playing ? "fa-pause" : "fa-play"}`;
    playAllBtn.querySelector("span").textContent = playing ? "Pause" : "Play";
  }

  function renderList(ids, ctx) {
    const sig = `${viewId}|${ctx}|${ids.join(",")}`;
    if (sig === listSig) {
      ids.forEach((id) => paintRow(rows.get(id), songsById.get(id)));
      return;
    }
    listSig = sig;
    rows.clear();
    const frag = document.createDocumentFragment();
    ids.forEach((id, i) => {
      const song = songsById.get(id);
      if (!song) return;
      const row = createRow(song, i, ctx);
      rows.set(id, row);
      paintRow(row, song);
      frag.appendChild(row);
    });
    list.replaceChildren(frag);
    markCurrent();
  }

  function createRow(song, index, ctx) {
    const a = document.createElement("a");
    a.className = "track";
    a.dataset.id = song.id;
    a.setAttribute("role", "listitem");
    a.href = `/listen?v=${enc(song.id)}&p=${enc(ctx)}`;
    a.innerHTML =
      '<span class="t-num"><span class="n"></span><span class="eq"><i></i><i></i><i></i></span></span>' +
      '<span class="t-art"><i class="fa-solid fa-music"></i></span>' +
      '<span class="t-meta"><strong class="t-title"></strong><span class="t-sub"></span></span>' +
      '<span class="t-dur"></span>' +
      '<button class="t-add" type="button" aria-label="Save to playlist" title="Save to playlist"><i class="fa-solid fa-plus"></i></button>';
    a.querySelector(".n").textContent = index + 1;
    a.querySelector(".t-add").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't start the song
      window.playlistPicker?.open({ anchor: e.currentTarget, kind: "song", itemId: song.id, onChange: refresh });
    });
    const art = a.querySelector(".t-art");
    art.dataset.id = song.id;
    coverObserver.observe(art);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onRowClick(song.id);
    });
    return a;
  }

  function paintRow(row, song) {
    if (!row || !song) return;
    const set = (sel, text) => {
      const el = row.querySelector(sel);
      if (el.textContent !== text) el.textContent = text;
    };
    set(".t-title", titleOf(song));
    set(".t-sub", subOf(song));
    set(".t-dur", song.duration ? fmt(song.duration) : "");
  }

  function onRowClick(id) {
    const song = songsById.get(id);
    if (!song) return;
    if (current && current.id === id) return togglePlay();
    if (viewId === "queue") load(song); // keep the queue (and its shuffle) as is
    else startPlaylist(viewId, id);
  }

  function markCurrent(scrollTo = false) {
    for (const el of list.querySelectorAll(".track.current")) {
      el.classList.remove("current");
      el.removeAttribute("aria-current");
    }
    const row = current && rows.get(current.id);
    if (!row) return;
    row.classList.add("current");
    row.setAttribute("aria-current", "true");
    if (viewId === "queue") {
      row.scrollIntoView({ block: scrollTo ? "center" : "nearest" });
    }
  }

  // ---------- Cover art (two at a time, so streaming never starves) ----------
  const coverState = new Map(); // id -> "ok" | "none"
  const coverWaiting = [];
  let coverActive = 0;
  const coverUrl = (id) => `/api/songs/cover/${enc(id)}`;

  function attachCover(target, id) {
    if (!target.isConnected || target.dataset.id !== id && target.id !== "npArt") return;
    if (target.querySelector("img")) return;
    if (target.id === "npArt" && current?.id !== id) return;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = coverUrl(id);
    target.appendChild(img);
    target.classList.add("has-img");
  }

  function loadCover(id, target, priority = false) {
    const state = coverState.get(id);
    if (state === "none") return;
    if (state === "ok") return attachCover(target, id);
    const job = { id, target };
    if (priority) coverWaiting.unshift(job);
    else coverWaiting.push(job);
    pumpCovers();
  }

  function pumpCovers() {
    while (coverActive < 2 && coverWaiting.length) {
      const { id, target } = coverWaiting.shift();
      if (coverState.has(id)) {
        if (coverState.get(id) === "ok") attachCover(target, id);
        continue;
      }
      coverActive += 1;
      const probe = new Image();
      const done = (ok) => {
        coverState.set(id, ok ? "ok" : "none");
        coverActive -= 1;
        if (ok) attachCover(target, id);
        pumpCovers();
      };
      probe.onload = () => done(true);
      probe.onerror = () => done(false);
      probe.src = coverUrl(id);
    }
  }

  const coverObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        coverObserver.unobserve(e.target);
        loadCover(e.target.dataset.id, e.target);
      }
    },
    { root: list, rootMargin: "200px" },
  );

  // ---------- Drawer (phones) ----------
  const narrow = matchMedia("(max-width: 819px)");

  function syncInert() {
    $("sidebar").inert = narrow.matches && !drawerOpen;
  }

  function setDrawer(open) {
    drawerOpen = open;
    $("sidebar").classList.toggle("open", open);
    $("sbBackdrop").classList.toggle("visible", open);
    syncInert();
    if (open) ($("sidebar").querySelector(".ls-item.active") || $("sidebar").querySelector(".ls-item"))?.focus();
  }

  // ---------- Time, buffering ----------
  function updateTime() {
    const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const t = scrubPct != null ? scrubPct * d : audio.currentTime || 0;
    const p = d ? clamp(t / d, 0, 1) : 0;
    timeline.style.setProperty("--p", p.toFixed(4));
    timeline.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    timeline.setAttribute("aria-valuetext", fmt(t));
    tCur.textContent = fmt(t);
    tLeft.textContent = d ? `-${fmt(Math.max(0, d - t))}` : "";
  }

  function updateBuffered() {
    const d = audio.duration;
    if (!d) return;
    const b = audio.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= audio.currentTime + 0.5 && b.end(i) > end) end = b.end(i);
    }
    timeline.style.setProperty("--b", (end / d).toFixed(4));
  }

  function skip(delta) {
    const d = audio.duration || Infinity;
    audio.currentTime = clamp(audio.currentTime + delta, 0, d);
  }

  const togglePlay = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());

  function setVolume(v) {
    audio.volume = clamp(v, 0, 1);
    audio.muted = audio.volume === 0;
  }

  function toggleMute() {
    if (audio.muted && audio.volume === 0) audio.volume = 0.5;
    audio.muted = !audio.muted;
  }

  // ---------- Lock-screen / headset / keyboard media controls ----------
  function bindMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    on("play", () => audio.play().catch(() => {}));
    on("pause", () => audio.pause());
    on("previoustrack", previous);
    on("nexttrack", () => go(1));
    on("seekbackward", () => skip(-10));
    on("seekforward", () => skip(10));
    on("seekto", (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  }

  function updateMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms || !current || typeof MediaMetadata === "undefined") return;
    ms.metadata = new MediaMetadata({
      title: titleOf(current),
      artist: current.artist || "",
      album: current.album || playlistName(current.playlistId),
      artwork: [{ src: coverUrl(current.id), sizes: "400x400", type: "image/jpeg" }],
    });
  }

  function updatePosition() {
    const ms = navigator.mediaSession;
    if (!ms?.setPositionState || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      ms.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: clamp(audio.currentTime, 0, audio.duration),
      });
    } catch {}
  }

  // ---------- Wiring ----------
  function bind() {
    // Sidebar / header
    $("menuBtn").addEventListener("click", () => setDrawer(!drawerOpen));
    $("sbBackdrop").addEventListener("click", () => setDrawer(false));
    $("navQueue").addEventListener("click", () => {
      setView("queue");
      setDrawer(false);
    });
    $("queueBtn").addEventListener("click", () => setView("queue"));
    playAllBtn.addEventListener("click", () => {
      if (viewId === "queue" && current) togglePlay();
      else if (playlistsById.has(viewId)) startPlaylist(viewId);
    });
    narrow.addEventListener?.("change", syncInert);
    syncInert();

    // Buttons
    playBtn.addEventListener("click", togglePlay);
    $("prevBtn").addEventListener("click", previous);
    nextBtn.addEventListener("click", () => go(1));
    $("backBtn").addEventListener("click", () => skip(-10));
    $("fwdBtn").addEventListener("click", () => skip(10));
    $("muteBtn").addEventListener("click", toggleMute);
    shuffleBtn.addEventListener("click", () => setShuffle(!shuffle));
    repeatBtn.addEventListener("click", () => setRepeat(!repeat));
    autoBtn.addEventListener("click", () => setAutoplay(!autoplay));
    $("speedBtn").addEventListener("click", () => {
      const i = RATES.indexOf(audio.playbackRate);
      audio.defaultPlaybackRate = audio.playbackRate = RATES[(i + 1) % RATES.length];
    });
    shuffleBtn.setAttribute("aria-pressed", String(shuffle));
    repeatBtn.setAttribute("aria-pressed", String(repeat));
    autoBtn.setAttribute("aria-pressed", String(autoplay));

    // After a mouse click, drop focus so the arrow keys seek instead of
    // walking the focus ring (keyboard / remote users keep their focus).
    document.addEventListener("click", (e) => {
      if (e.detail > 0) requestAnimationFrame(() => document.activeElement?.blur?.());
    });

    // Timeline: pointer scrubbing
    const pctFrom = (e) => {
      const r = timeline.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    const hover = (e) => {
      const pct = pctFrom(e);
      timeline.style.setProperty("--pv", pct.toFixed(4));
      pvTime.textContent = fmt(pct * (audio.duration || 0));
    };
    timeline.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      timeline.setPointerCapture?.(e.pointerId);
      app.classList.add("scrubbing");
      scrubPct = pctFrom(e);
      hover(e);
      updateTime();
    });
    timeline.addEventListener("pointermove", (e) => {
      hover(e);
      if (scrubPct != null) {
        scrubPct = pctFrom(e);
        updateTime();
      }
    });
    const endScrub = () => {
      if (scrubPct == null) return;
      if (audio.duration > 0) audio.currentTime = scrubPct * audio.duration;
      scrubPct = null;
      app.classList.remove("scrubbing");
      updateTime();
    };
    timeline.addEventListener("pointerup", endScrub);
    timeline.addEventListener("pointercancel", endScrub);

    // Volume slider
    const volFrom = (e) => {
      const r = volSlider.getBoundingClientRect();
      setVolume((e.clientX - r.left) / r.width);
    };
    volSlider.addEventListener("pointerdown", (e) => {
      volSlider.setPointerCapture?.(e.pointerId);
      volFrom(e);
    });
    volSlider.addEventListener("pointermove", (e) => {
      if (e.buttons) volFrom(e);
    });

    // Audio events
    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("progress", updateBuffered);
    audio.addEventListener("seeked", () => { updateBuffered(); updatePosition(); });
    audio.addEventListener("loadedmetadata", () => {
      if (current && !current.duration && Number.isFinite(audio.duration)) {
        current.duration = audio.duration;
        paintRow(rows.get(current.id), current);
      }
      updateTime();
      updatePosition();
    });
    audio.addEventListener("play", () => { app.classList.remove("paused"); paintPlayAll(); updatePosition(); });
    audio.addEventListener("pause", () => { app.classList.add("paused"); paintPlayAll(); updatePosition(); });
    audio.addEventListener("playing", () => { $("buffering").hidden = true; reconnectAttempts = 0; });
    audio.addEventListener("waiting", () => { $("buffering").hidden = false; });
    audio.addEventListener("canplay", () => { $("buffering").hidden = true; });
    audio.addEventListener("ratechange", () => {
      $("speedLbl").textContent = `${audio.playbackRate}x`;
      updatePosition();
    });
    audio.addEventListener("volumechange", () => {
      const v = audio.muted ? 0 : audio.volume;
      volFill.style.transform = `scaleX(${v})`;
      volSlider.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      app.dataset.volume = v === 0 ? "mute" : v >= 0.5 ? "high" : "low";
      if (audio.volume > 0) store.set(KEY.vol, audio.volume);
    });
    audio.addEventListener("ended", () => {
      if (!autoplay) return;
      const next = neighbor(1);
      if (next) load(next);
    });

    // LAN hiccup: retry the same stream from where it stopped.
    audio.addEventListener("error", () => {
      if (reconnectAttempts >= 4 || !current) return;
      const time = audio.currentTime;
      const resume = !audio.paused;
      reconnectAttempts += 1;
      setTimeout(() => {
        audio.src = `${current.streamUrl}?retry=${Date.now()}`;
        audio.load();
        audio.addEventListener("loadedmetadata", () => {
          audio.currentTime = time;
          if (resume) audio.play().catch(() => {});
        }, { once: true });
      }, reconnectAttempts * 1500);
    });

    const savedVol = Number(store.get(KEY.vol));
    audio.volume = Number.isFinite(savedVol) && savedVol > 0 ? clamp(savedVol, 0, 1) : 1;
    audio.dispatchEvent(new Event("volumechange"));

    document.addEventListener("keydown", onKey);

    // Remote commands from the server console. Both `video-*` and `audio-*` work.
    window.addEventListener("device:command", (event) => {
      const { command, values } = event.detail;
      const cmd = String(command).replace(/^(video|audio)-/, "");
      if (cmd === "play") audio.play().catch(() => {});
      else if (cmd === "pause") audio.pause();
      else if (cmd === "toggle-play") togglePlay();
      else if (cmd === "skip-forward-10") skip(10);
      else if (cmd === "skip-back-10") skip(-10);
      else if (cmd === "next") go(1);
      else if (cmd === "previous") previous();
      else if (cmd === "shuffle") setShuffle(values[0] !== "off");
      else if (cmd === "autoplay") setAutoplay(values[0] !== "off");
      else if (cmd === "volume-value") {
        const raw = Number(values[0]);
        if (Number.isFinite(raw)) setVolume(raw > 1 ? raw / 100 : raw);
      }
    });

    window.deviceControl?.setStateProvider(() => ({
      videoId: current?.id || null,
      title: current ? titleOf(current) : null,
      paused: audio.paused,
      time: Math.round(audio.currentTime || 0),
      duration: Math.round(audio.duration || 0),
      volume: audio.muted ? 0 : audio.volume,
    }));
  }

  // ---------- Keyboard / remote ----------
  const MEDIA_CODES = { 415: "play", 19: "pause", 179: "toggle", 10252: "toggle", 417: "ff", 412: "rw" };
  const MEDIA_KEYS = {
    MediaPlayPause: "toggle",
    MediaPlay: "play",
    MediaPause: "pause",
    MediaFastForward: "ff",
    MediaRewind: "rw",
    MediaTrackNext: "next",
    MediaTrackPrevious: "prev",
  };

  function adjust(el, dir) {
    const sign = dir === "right" ? 1 : -1;
    if (el === timeline) skip(10 * sign);
    else if (el === volSlider) setVolume((audio.muted ? 0 : audio.volume) + 0.05 * sign);
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;

    if (ui.isBack(e)) {
      e.preventDefault();
      if (drawerOpen) setDrawer(false);
      else if (viewId !== "queue" && current) setView("queue");
      else location.href = "/";
      return;
    }

    const media = MEDIA_KEYS[k] || MEDIA_CODES[e.keyCode];
    if (media) {
      e.preventDefault();
      if (media === "toggle") togglePlay();
      else if (media === "play") audio.play().catch(() => {});
      else if (media === "pause") audio.pause();
      else if (media === "ff") skip(10);
      else if (media === "rw") skip(-10);
      else if (media === "next") go(1);
      else if (media === "prev") previous();
      return;
    }

    const dir = ui.DIRS[k];
    const active = document.activeElement;
    const focused = active && active !== document.body;

    if (dir) {
      e.preventDefault();
      if (focused) {
        if ((dir === "left" || dir === "right") && active.hasAttribute("data-adjust")) adjust(active, dir);
        else ui.move(dir, document.body);
      } else if (dir === "left" || dir === "right") {
        skip(dir === "left" ? -10 : 10);
      } else {
        const row = list.querySelector(".track.current") || list.querySelector(".track");
        if (row) ui.focusEl(row);
        else playBtn.focus({ preventScroll: true });
      }
      return;
    }

    if (k === "Enter") {
      if (!focused || active.hasAttribute("data-adjust")) {
        e.preventDefault();
        togglePlay();
      }
      return;
    }
    if (k === " ") {
      if (focused && active.matches("button,a")) return;
      e.preventDefault();
      togglePlay();
      return;
    }

    if (k === "k") togglePlay();
    else if (k === "m") toggleMute();
    else if (k === "j") skip(-10);
    else if (k === "l") skip(10);
    else if (k === "n") go(1);
    else if (k === "p") previous();
    else if (k === "s") setShuffle(!shuffle);
    else if (k === "r") setRepeat(!repeat);
    else if (k === "q" && current) setView("queue");
  }
})();
