(() => {
  "use strict";

  const ui = window.ui;
  const $ = (id) => document.getElementById(id);

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const HUD_IDLE_MS = 3000;
  const INTRO_WINDOW = 240; // seconds from the start where "Skip intro" shows

  const player = $("player");
  const video = $("video");
  const hud = $("hud");
  const pills = $("pills");
  const poster = $("poster");
  const buffering = $("buffering");
  const seekToast = $("seekToast");
  const timeline = $("timeline");
  const tCur = $("tCur");
  const tLeft = $("tLeft");
  const pvImg = $("pvImg");
  const pvTime = $("pvTime");
  const volSlider = $("volSlider");
  const volFill = $("volFill");
  const playBtn = $("playBtn");
  const captionsBtn = $("captionsBtn");
  const autoBtn = $("autoBtn");
  const episodesBtn = $("episodesBtn");
  const skipIntroBtn = $("skipIntro");
  const nextPill = $("nextPill");
  const episodes = $("episodes");
  const track = $("epTrack");
  const seasonBtn = $("seasonBtn");
  const seasonMenu = $("seasonMenu");

  let library = null;
  let currentVideo = null;
  let previewRequested = false;
  let introDismissed = false;
  let episodesOpen = false;
  let scrubPct = null;
  let hudTimer;
  let lastPointerShow = 0;
  let toastTimer;
  let reconnectAttempts = 0;
  let autoplay = localStorage.getItem("media-server-autoplay") !== "false";

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  document.addEventListener("DOMContentLoaded", init);

  // ---------- Init ----------

  async function init() {
    const id = new URLSearchParams(location.search).get("v");
    if (!id) {
      location.href = "/";
      return;
    }

    const listId = new URLSearchParams(location.search).get("list");
    const [libResponse, videoResponse, listResponse] = await Promise.all([
      fetch("/api/library"),
      fetch(`/api/video/${encodeURIComponent(id)}`),
      listId ? fetch(`/api/playlists/${encodeURIComponent(listId)}`) : null,
    ]);
    library = await libResponse.json();

    // Playing a saved playlist: it takes the place of the show for next/previous and the episode list.
    if (listResponse?.ok) {
      const l = await listResponse.json();
      if (l.kind === "video" && l.items.includes(id)) activeList = { id: l.id, name: l.name, videoIds: l.items };
    }

    if (!videoResponse.ok) {
      $("nowTitle").textContent = "Video not found";
      return;
    }
    const payload = await videoResponse.json();

    bindPlayer();
    bindEpisodes();
    loadVideo(payload.video);
    armFullscreen();
    connectLiveUpdates();
  }

  function connectLiveUpdates() {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        library = JSON.parse(event.data);
      } catch {
        return;
      }
      // Never touch video.src here: a library update must not interrupt playback.
      currentVideo = library.videos.find((v) => v.id === currentVideo?.id) || currentVideo;
      renderPoster();
      updateNav();
    };
  }

  // ---------- Library helpers ----------

  let activeList = null; // saved playlist being played: { id, name, videoIds }

  const getShow = (v) => {
    if (activeList && v && activeList.videoIds.includes(v.id)) {
      return {
        id: `list:${activeList.id}`,
        name: activeList.name,
        videoIds: activeList.videoIds,
        seasons: [{ id: "_list", name: "Playlist", videoIds: activeList.videoIds }],
      };
    }
    return v?.showId ? library.shows.find((s) => s.id === v.showId) : null;
  };

  function seasonsOf(show) {
    return show.seasons?.length
      ? show.seasons
      : [{ id: "_all", name: "Episodes", videoIds: show.videoIds }];
  }

  const episodeIds = (show) => seasonsOf(show).flatMap((s) => s.videoIds);

  function neighbor(dir) {
    const show = getShow(currentVideo);
    if (!show) return null;
    const ids = episodeIds(show);
    const id = ids[ids.indexOf(currentVideo.id) + dir];
    return id ? library.videos.find((v) => v.id === id) : null;
  }

  function seasonName(name) {
    const m = /^s(?:eason)?\s*0*(\d+)$/i.exec(String(name).trim());
    return m ? `Season ${m[1]}` : ui.prettyName(name);
  }

  function episodeTitle(v, index) {
    const raw = ui.prettyName(v.name);
    const n = Number.isFinite(v.episodeNumber) ? v.episodeNumber : index + 1;
    return /^(s\d+\s*)?e\d+$/i.test(raw) ? `Episode ${n}` : raw;
  }

  // ---------- Loading a video (in place, so fullscreen survives) ----------

  function loadVideo(v) {
    saveProgress(); // keep the spot in the video we are leaving
    currentVideo = v;
    if (v.showId) ui.progress.setLastEpisode(v.showId, v.id);

    // Resume where this browser left off (unless the server just reloaded us,
    // in which case device-control restores the exact state itself).
    const saved = ui.progress.get(v.id);
    if (saved && !sessionStorage.getItem("media-server-reload-state")) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          const d = video.duration;
          if (saved.t > 5 && (!d || saved.t < d - 30)) video.currentTime = saved.t;
        },
        { once: true },
      );
    }

    previewRequested = false;
    resetPreviews();
    introDismissed = false;
    scrubPct = null;
    reconnectAttempts = 0;
    player.classList.remove("started");

    renderNow();
    renderPoster();
    updateNav();
    updateTime();

    history.replaceState(null, "", `/watch?v=${encodeURIComponent(v.id)}${activeList ? `&list=${encodeURIComponent(activeList.id)}` : ""}`);
    video.src = v.streamUrl;
    video.load();
    video.play().catch(() => {}); // blocked autoplay leaves the big play button
    showHud();
  }

  function go(dir) {
    const next = neighbor(dir);
    if (!next) return;
    if (episodesOpen) closeEpisodes(false);
    loadVideo(next);
  }

  function renderNow() {
    const show = getShow(currentVideo);
    const title = ui.prettyName(currentVideo.name);
    const showEl = $("nowShow");

    if (show) {
      const ids = episodeIds(show);
      const index = Math.max(0, ids.indexOf(currentVideo.id));
      const parts = [ui.prettyName(show.name)];
      const multi = (show.seasons?.length || 1) > 1;
      const n = Number.isFinite(currentVideo.episodeNumber) ? currentVideo.episodeNumber : index + 1;
      parts.push(
        activeList
          ? `${index + 1} of ${ids.length}`
          : multi && currentVideo.seasonNumber ? `S${currentVideo.seasonNumber}:E${n}` : `Episode ${n}`,
      );
      showEl.textContent = parts.join("  ");
      showEl.hidden = false;
      $("nowTitle").textContent = activeList ? title : episodeTitle(currentVideo, index);
    } else {
      showEl.hidden = true;
      $("nowTitle").textContent = title;
    }
    document.title = `${title} · K. Streamer`;
  }

  function renderPoster() {
    const thumb = currentVideo?.thumbnail;
    if (thumb) {
      if (poster.getAttribute("src") !== thumb) poster.src = thumb;
      poster.hidden = false;
    } else {
      poster.hidden = true;
      ui.requestCover(currentVideo?.id);
    }
  }

  function updateNav() {
    const show = getShow(currentVideo);
    $("prevEpBtn").hidden = !neighbor(-1);
    $("nextEpBtn").hidden = !neighbor(1);
    episodesBtn.hidden = !show;
    updatePills();
  }

  // ---------- Fullscreen (always) ----------

  async function enterFullscreen() {
    try {
      const el = player;
      await (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: "hide" });
    } catch {}
    if (matchMedia("(pointer: coarse)").matches) {
      screen.orientation?.lock?.("landscape").catch(() => {});
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      screen.orientation?.unlock?.();
    } else {
      await enterFullscreen();
    }
  }

  // Browsers only allow fullscreen from a user gesture, so try now and
  // again on the first key press or tap.
  function armFullscreen() {
    enterFullscreen();
    const go = (e) => {
      if (e.type === "keydown" && ui.isBack(e)) return;
      off();
      if (!document.fullscreenElement) enterFullscreen();
    };
    const off = () => {
      document.removeEventListener("pointerdown", go, true);
      document.removeEventListener("keydown", go, true);
    };
    document.addEventListener("pointerdown", go, true);
    document.addEventListener("keydown", go, true);
  }

  document.addEventListener("fullscreenchange", () => {
    player.classList.toggle("is-fs", document.fullscreenElement === player);
    if (!document.fullscreenElement) screen.orientation?.unlock?.();
  });

  // ---------- Controls panel visibility ----------

  function showHud() {
    player.classList.add("hud-on");
    hud.inert = false;
    scheduleHide();
  }

  // True while a mouse is directly over a control (never true on touch,
  // where :hover sticks after a tap).
  function controlsHovered() {
    return (
      matchMedia("(hover: hover)").matches &&
      Boolean(document.querySelector(".hud .ctl:hover, .hud .timeline:hover, .hud .vol-slider:hover, .pill:hover"))
    );
  }

  function scheduleHide() {
    clearTimeout(hudTimer);
    if (video.paused || episodesOpen) return;
    hudTimer = setTimeout(() => {
      if (controlsHovered()) scheduleHide();
      else hideHud();
    }, HUD_IDLE_MS);
  }

  function hideHud(force = false) {
    if (episodesOpen) return;
    if (video.paused && !force) return;
    player.classList.remove("hud-on");
    hud.inert = true; // also drops focus, so the next arrow press seeks
  }

  // ---------- Time, progress, pills ----------

  const fmt = (time) => {
    if (!Number.isFinite(time) || time < 0) return "0:00";
    const s = Math.floor(time % 60);
    const m = Math.floor(time / 60) % 60;
    const h = Math.floor(time / 3600);
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };

  const fmtShort = (secs) => {
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.max(1, m)}m`;
  };

  function updateTime() {
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const t = scrubPct != null ? scrubPct * d : video.currentTime || 0;
    const p = d ? clamp(t / d, 0, 1) : 0;
    timeline.style.setProperty("--p", p.toFixed(4));
    timeline.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    timeline.setAttribute("aria-valuetext", fmt(t));
    tCur.textContent = fmt(t);
    tLeft.textContent = d ? `-${fmt(Math.max(0, d - t))}` : "";
    updatePills();
  }

  function updatePills() {
    const t = video.currentTime || 0;
    const d = video.duration || 0;
    const isEpisode = Boolean(currentVideo?.showId);
    skipIntroBtn.hidden = episodesOpen || introDismissed || !(isEpisode && t > 1 && t < INTRO_WINDOW);
    nextPill.hidden = episodesOpen || !(d > 0 && d - t < 45 && neighbor(1));
  }

  function updateBuffered() {
    const d = video.duration;
    if (!d) return;
    const b = video.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > end) end = b.end(i);
    }
    timeline.style.setProperty("--b", (end / d).toFixed(4));
  }

  let seekAcc = 0; // running total while skips chain together
  function showSeekToast(text) {
    seekToast.textContent = text;
    seekToast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      seekToast.classList.remove("visible");
      seekAcc = 0;
    }, 700);
  }

  function skip(delta) {
    const d = video.duration || Infinity;
    video.currentTime = clamp(video.currentTime + delta, 0, d);
    seekAcc += delta;
    showSeekToast(`${seekAcc > 0 ? "+" : ""}${Math.round(seekAcc)}s`);
  }

  const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());

  function setVolume(v) {
    video.volume = clamp(v, 0, 1);
    video.muted = video.volume === 0;
  }

  function toggleMute() {
    if (video.muted && video.volume === 0) video.volume = 0.5;
    video.muted = !video.muted;
  }

  function requestPreviews() {
    if (!currentVideo || currentVideo.previewCount || previewRequested) return;
    previewRequested = true;
    fetch(`/api/previews/${encodeURIComponent(currentVideo.id)}`, { method: "POST" }).catch(() => {
      previewRequested = false;
    });
  }

  // ---------- Timeline previews: sprite sheets + mip levels ----------
  //
  // The server writes one metadata map per video (<id>-map.json) plus one
  // sprite sheet per mip level (<id>-sprite-L0.webp, L1, ...), largest first.
  // Frame i of a level sits at x = (i % cols) * tileWidth,
  // y = floor(i / cols) * tileHeight.
  //
  // Decoding: a sheet is fetched once, decoded once, and cut into per-frame
  // tiles, so hovering only swaps an <img> src (no network, no decode).
  // Level choice: the smallest level that still covers the preview's
  // on-screen size at the device pixel ratio. The coarsest level loads first
  // so something shows almost immediately; the wanted level swaps in when its
  // tiles are ready.
  const MAP_RETRY_MS = 5000;
  const preview = { gen: 0, map: null, mapPromise: null, retryAt: 0, levels: new Map(), t: 0, shown: "" };

  function resetPreviews() {
    preview.gen += 1;
    for (const lvl of preview.levels.values()) lvl.tiles?.forEach((u) => URL.revokeObjectURL(u));
    preview.levels.clear();
    preview.map = null;
    preview.mapPromise = null;
    preview.retryAt = 0;
    preview.shown = "";
    pvImg.hidden = true;
    pvImg.removeAttribute("src");
  }

  function loadPreviewMap() {
    if (preview.map) return Promise.resolve(preview.map);
    if (preview.mapPromise) return preview.mapPromise;
    if (Date.now() < preview.retryAt || !currentVideo) return Promise.resolve(null);

    const gen = preview.gen;
    const url = `/thumbnails/previews/${encodeURIComponent(currentVideo.id)}-map.json`;
    // The map is rewritten in place when previews are regenerated, so always revalidate it.
    preview.mapPromise = fetch(url, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((map) => {
        if (gen !== preview.gen) return null;
        if (!map?.levels?.length || !map.count || !(map.interval > 0)) throw new Error("bad preview map");
        preview.map = map;
        return map;
      })
      .catch(() => {
        if (gen === preview.gen) preview.retryAt = Date.now() + MAP_RETRY_MS;
        return null;
      })
      .finally(() => {
        if (gen === preview.gen) preview.mapPromise = null;
      });
    return preview.mapPromise;
  }

  // CSS size of the preview box. If the stylesheet leaves it to the image's
  // natural size, pin it to the largest level's size so swapping to a smaller
  // level never changes the layout.
  function previewCssWidth(map) {
    const w = getComputedStyle(pvImg).width;
    if (w.endsWith("px") && parseFloat(w) > 0) return parseFloat(w);
    const natural = map.levels[0].tileWidth;
    pvImg.style.width = `${natural}px`;
    return natural;
  }

  // Levels are ordered largest -> smallest.
  function wantedLevel(map) {
    const need = previewCssWidth(map) * (window.devicePixelRatio || 1);
    for (let i = map.levels.length - 1; i >= 0; i--) {
      if (map.levels[i].tileWidth >= need) return i;
    }
    return 0;
  }

  async function decodeSheet(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    // Older TV browsers: no createImageBitmap.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error("sprite decode failed"));
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toBlob(canvas) {
    return new Promise((ok) => canvas.toBlob(ok, "image/webp", 0.92));
  }

  function ensureLevel(map, index) {
    let lvl = preview.levels.get(index);
    if (lvl) return lvl;
    lvl = { state: "loading", tiles: null };
    preview.levels.set(index, lvl);

    const gen = preview.gen;
    const info = map.levels[index];
    (async () => {
      const r = await fetch(info.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const sheet = await decodeSheet(await r.blob());
      const canvas = document.createElement("canvas");
      canvas.width = info.tileWidth;
      canvas.height = info.tileHeight;
      const ctx = canvas.getContext("2d");
      const tiles = [];
      for (let i = 0; i < map.count; i++) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          sheet,
          (i % info.cols) * info.tileWidth, Math.floor(i / info.cols) * info.tileHeight,
          info.tileWidth, info.tileHeight,
          0, 0, info.tileWidth, info.tileHeight,
        );
        const blob = await toBlob(canvas);
        if (!blob) throw new Error("tile encode failed");
        tiles.push(URL.createObjectURL(blob));
      }
      sheet.close?.();
      if (gen !== preview.gen) return tiles.forEach((u) => URL.revokeObjectURL(u));
      lvl.tiles = tiles;
      lvl.state = "ready";
      renderPreview(); // the hover may be waiting on exactly this level
    })().catch(() => {
      if (gen === preview.gen) lvl.state = "failed";
    });
    return lvl;
  }

  // Best level that is ready right now: the wanted one, else the nearest.
  function readyLevel(map, wanted) {
    let best = -1;
    for (const [index, lvl] of preview.levels) {
      if (lvl.state !== "ready") continue;
      if (best < 0 || Math.abs(index - wanted) < Math.abs(best - wanted)) best = index;
    }
    return best;
  }

  function renderPreview() {
    const map = preview.map;
    if (!map) return;
    const wanted = wantedLevel(map);
    ensureLevel(map, map.levels.length - 1); // coarsest first, for a fast first frame
    ensureLevel(map, wanted);

    const index = readyLevel(map, wanted);
    if (index < 0) return;

    const frame = clamp(Math.round(preview.t / map.interval) - 1, 0, map.count - 1);
    const key = `${index}:${frame}`;
    if (preview.shown !== key) {
      preview.shown = key;
      pvImg.src = preview.levels.get(index).tiles[frame];
    }
    pvImg.hidden = false;
  }

  function showPreviewAt(seconds) {
    preview.t = seconds;
    if (preview.map) return renderPreview();
    loadPreviewMap().then((map) => {
      if (map) renderPreview();
    });
  }

  // ---------- Remember where this browser stopped ----------

  let lastSave = 0;

  function saveProgress() {
    const d = video.duration;
    if (!currentVideo || !Number.isFinite(d) || d <= 0) return;
    const t = video.currentTime;
    if (d - t < 30) ui.progress.clear(currentVideo.id); // finished
    else if (t >= 5) ui.progress.set(currentVideo.id, t, d);
  }

  function maybeSave() {
    const now = Date.now();
    if (now - lastSave < 5000) return;
    lastSave = now;
    saveProgress();
  }

  // ---------- Player wiring ----------

  function bindPlayer() {
    // Buttons
    playBtn.addEventListener("click", togglePlay);
    $("bigPlay").addEventListener("click", () => {
      togglePlay();
      if (!document.fullscreenElement) enterFullscreen();
    });
    $("backBtn").addEventListener("click", () => skip(-10));
    $("fwdBtn").addEventListener("click", () => skip(10));
    $("muteBtn").addEventListener("click", toggleMute);
    $("prevEpBtn").addEventListener("click", () => go(-1));
    $("nextEpBtn").addEventListener("click", () => go(1));
    nextPill.addEventListener("click", () => go(1));
    skipIntroBtn.addEventListener("click", () => {
      introDismissed = true;
      skip(90);
      updatePills();
      playBtn.focus({ preventScroll: true });
    });
    $("fsBtn").addEventListener("click", toggleFullscreen);
    episodesBtn.addEventListener("click", () => (episodesOpen ? closeEpisodes() : openEpisodes()));
    $("saveBtn").addEventListener("click", () => {
      window.playlistPicker?.open({ anchor: $("saveBtn"), kind: "video", itemId: currentVideo.id });
    });

    $("speedBtn").addEventListener("click", () => {
      const i = RATES.indexOf(video.playbackRate);
      video.playbackRate = RATES[(i + 1) % RATES.length];
    });

    captionsBtn.addEventListener("click", () => {
      const t = video.textTracks[0];
      if (!t) return;
      t.mode = t.mode === "showing" ? "hidden" : "showing";
      captionsBtn.setAttribute("aria-pressed", String(t.mode === "showing"));
    });

    function setAutoplay(on) {
      autoplay = Boolean(on);
      localStorage.setItem("media-server-autoplay", String(autoplay));
      autoBtn.setAttribute("aria-pressed", String(autoplay));
    }
    autoBtn.addEventListener("click", () => setAutoplay(!autoplay));
    setAutoplay(autoplay);

    // Timeline: pointer scrubbing with preview frames
    const pctFrom = (e) => {
      const r = timeline.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };

    function hoverPreview(e) {
      const pct = pctFrom(e);
      timeline.style.setProperty("--pv", pct.toFixed(4));
      pvTime.textContent = fmt(pct * (video.duration || 0));
      if (!currentVideo?.previewCount) {
        requestPreviews();
        pvImg.hidden = true;
        return;
      }
      showPreviewAt(pct * (video.duration || 0));
    }
    pvImg.addEventListener("error", () => { pvImg.hidden = true; preview.shown = ""; });

    timeline.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      timeline.setPointerCapture?.(e.pointerId);
      player.classList.add("scrubbing");
      scrubPct = pctFrom(e);
      hoverPreview(e);
      updateTime();
    });
    timeline.addEventListener("pointermove", (e) => {
      hoverPreview(e);
      if (scrubPct != null) {
        scrubPct = pctFrom(e);
        updateTime();
      }
    });
    const endScrub = () => {
      if (scrubPct == null) return;
      const d = video.duration;
      if (d > 0) video.currentTime = scrubPct * d;
      scrubPct = null;
      player.classList.remove("scrubbing");
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

    // Video events
    video.addEventListener("timeupdate", () => {
      updateTime();
      maybeSave();
    });
    window.addEventListener("pagehide", saveProgress);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveProgress();
    });
    video.addEventListener("progress", updateBuffered);
    video.addEventListener("seeked", updateBuffered);
    video.addEventListener("loadedmetadata", () => {
      durCache.set(currentVideo.id, video.duration);
      captionsBtn.hidden = video.textTracks.length === 0;
      captionsBtn.setAttribute("aria-pressed", "false");
      updateTime();
    });
    video.addEventListener("play", () => {
      player.classList.remove("paused");
      showHud();
    });
    video.addEventListener("pause", () => {
      saveProgress();
      player.classList.add("paused");
      showHud();
    });
    video.addEventListener("playing", () => {
      player.classList.add("started");
      buffering.hidden = true;
      reconnectAttempts = 0;
    });
    video.addEventListener("waiting", () => (buffering.hidden = false));
    video.addEventListener("canplay", () => (buffering.hidden = true));
    video.addEventListener("volumechange", () => {
      const v = video.muted ? 0 : video.volume;
      volFill.style.transform = `scaleX(${v})`;
      volSlider.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      player.dataset.volume = v === 0 ? "mute" : v >= 0.5 ? "high" : "low";
    });
    video.addEventListener("ratechange", () => {
      $("speedLbl").textContent = `${video.playbackRate}x`;
    });
    video.addEventListener("ended", () => {
      ui.progress.clear(currentVideo.id);
      const next = neighbor(1);
      if (next && currentVideo.showId) ui.progress.setLastEpisode(currentVideo.showId, next.id);
      if (autoplay) go(1);
    });
    video.dispatchEvent(new Event("volumechange"));

    // LAN hiccup: retry the same stream from the current position.
    video.addEventListener("error", () => {
      if (reconnectAttempts >= 4 || !currentVideo) return;
      const time = video.currentTime;
      const resume = !video.paused;
      reconnectAttempts += 1;
      setTimeout(() => {
        video.src = `${currentVideo.streamUrl}?retry=${Date.now()}`;
        video.load();
        video.addEventListener(
          "loadedmetadata",
          () => {
            video.currentTime = time;
            if (resume) video.play().catch(() => {});
          },
          { once: true },
        );
      }, reconnectAttempts * 1500);
    });

    // Pointer: reveal controls; click toggles play; double-tap seeks (touch)
    player.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const now = performance.now();
      if (!player.classList.contains("hud-on") || now - lastPointerShow > 400) {
        lastPointerShow = now;
        showHud();
      }
    });

    let lastTap = 0;
    player.addEventListener("pointerup", (e) => {
      if (e.target.closest("button,a,[role='slider'],.episodes")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (episodesOpen) {
        closeEpisodes();
        return;
      }
      if (e.pointerType === "mouse") {
        const double = e.timeStamp - lastTap < 300;
        lastTap = double ? 0 : e.timeStamp;
        togglePlay();
        if (double) toggleFullscreen();
        return;
      }

      // Touch: middle third plays/pauses. On the side thirds a single tap
      // toggles the controls; a double tap, and every quick tap after it,
      // skips back (left third) or forward (right third).
      const x = e.clientX / window.innerWidth;
      if (x >= 1 / 3 && x <= 2 / 3) {
        lastTap = 0;
        togglePlay();
        return;
      }
      const chained = e.timeStamp - lastTap < 350;
      lastTap = e.timeStamp;
      if (chained) {
        skip(x < 0.5 ? -10 : 10);
        return;
      }
      if (player.classList.contains("hud-on")) hideHud(true);
      else showHud();
    });

    document.addEventListener("keydown", onKey);

    // Remote commands from the server console
    window.addEventListener("device:command", (event) => {
      const { command, values } = event.detail;
      if (command === "video-play") video.play().catch(() => {});
      if (command === "video-toggle-play") togglePlay();
      if (command === "video-pause") video.pause();
      if (command === "video-skip-forward-10") skip(10);
      if (command === "video-skip-back-10") skip(-10);
      if (command === "video-skip-intro") skip(90);
      if (command === "video-skip-outro") video.currentTime = Math.max(0, (video.duration || 0) - 0.25);
      if (command === "video-autoplay") setAutoplay(values[0] !== "off");
      if (command === "video-volume-value") {
        const raw = Number(values[0]);
        if (Number.isFinite(raw)) setVolume(raw > 1 ? raw / 100 : raw);
      }
      if (command === "video-f-screen") toggleFullscreen();
      if (command === "video-next") go(1);
      if (command === "video-previous") go(-1);
      if (command === "video-episodes") (episodesOpen ? closeEpisodes() : openEpisodes());
      if (command === "video-mini-player") {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else video.requestPictureInPicture?.().catch(() => {});
      }
    });

    window.deviceControl?.setStateProvider(() => ({
      videoId: currentVideo?.id || null,
      title: currentVideo?.name || null,
      paused: video.paused,
      time: Math.round(video.currentTime || 0),
      duration: Math.round(video.duration || 0),
      volume: video.muted ? 0 : video.volume,
    }));
  }

  // ---------- Keyboard / remote ----------

  const MEDIA_CODES = {
    415: "play",
    19: "pause",
    179: "toggle",
    10252: "toggle",
    417: "ff",
    412: "rw",
  };
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
    else if (el === volSlider) setVolume((video.muted ? 0 : video.volume) + 0.05 * sign);
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;

    if (ui.isBack(e)) {
      e.preventDefault();
      handleBack();
      return;
    }

    const media = MEDIA_KEYS[k] || MEDIA_CODES[e.keyCode];
    if (media) {
      e.preventDefault();
      if (media === "toggle") togglePlay();
      else if (media === "play") video.play().catch(() => {});
      else if (media === "pause") video.pause();
      else if (media === "ff") skip(10);
      else if (media === "rw") skip(-10);
      else if (media === "next") go(1);
      else if (media === "prev") go(-1);
      showHud();
      return;
    }

    if (k === "e" || k === "E") {
      episodesOpen ? closeEpisodes() : openEpisodes();
      return;
    }

    const dir = ui.DIRS[k];

    // Episodes panel: arrows move focus, Enter picks (links activate natively)
    if (episodesOpen) {
      if (!seasonMenu.hidden) {
        if (k === "ArrowDown" || k === "ArrowUp") {
          const items = [...seasonMenu.querySelectorAll("button")];
          const next = items[items.indexOf(document.activeElement) + (k === "ArrowDown" ? 1 : -1)];
          if (next) next.focus();
          else if (k === "ArrowUp") closeMenu(true);
          e.preventDefault();
        }
        return;
      }
      if (dir) {
        ui.move(dir, episodes, () => track.querySelector(".ep-card.current") || track.querySelector(".ep-card"));
        e.preventDefault();
      }
      return;
    }

    const active = document.activeElement;
    const hudVisible = player.classList.contains("hud-on");
    const inUi =
      active && active !== document.body && (hud.contains(active) || pills.contains(active));

    if (dir) {
      if (inUi && hudVisible) {
        if ((dir === "left" || dir === "right") && active.hasAttribute("data-adjust")) {
          adjust(active, dir);
        } else {
          ui.move(dir, player);
        }
        e.preventDefault();
        showHud();
        return;
      }
      e.preventDefault();
      if (dir === "left" || dir === "right") {
        skip(dir === "left" ? -10 : 10);
        showHud();
      } else {
        showHud();
        const target = [skipIntroBtn, nextPill].find((b) => !b.hidden) || playBtn;
        target.focus({ preventScroll: true });
      }
      return;
    }

    if (k === "Enter") {
      if (!inUi || active.hasAttribute("data-adjust")) {
        e.preventDefault();
        togglePlay();
        showHud();
      }
      return;
    }

    if (k === " ") {
      if (inUi && active.matches("button,a")) return;
      e.preventDefault();
      togglePlay();
      return;
    }

    if (k === "k") togglePlay();
    else if (k === "f") toggleFullscreen();
    else if (k === "m") toggleMute();
    else if (k === "j") skip(-10);
    else if (k === "l") skip(10);
    else if (k === "n") go(1);
    else if (k === "c" && !captionsBtn.hidden) captionsBtn.click();
    else if (k === "i") window.dispatchEvent(new CustomEvent("device:command", { detail: { command: "video-mini-player", values: [] } }));
  }

  function handleBack() {
    if (episodesOpen) {
      if (!seasonMenu.hidden) closeMenu(true);
      else closeEpisodes();
      return;
    }
    if (player.classList.contains("hud-on") && !video.paused) {
      hideHud();
      return;
    }
    location.href = "/";
  }

  // ---------- Episodes carousel ----------

  const durCache = new Map();
  const probeQueue = [];
  let probing = 0;
  let activeSeasonId = null;

  const durationOf = (v) => {
    const d = Number(v.duration ?? v.durationSeconds);
    return Number.isFinite(d) && d > 0 ? d : durCache.get(v.id);
  };

  // If the library has no durations, read them from each file's metadata,
  // two at a time, and only for cards that scroll into view.
  function probe(v, done) {
    probeQueue.push({ v, done });
    pump();
  }

  function pump() {
    while (probing < 2 && probeQueue.length) {
      const { v, done } = probeQueue.shift();
      probing += 1;
      const el = document.createElement("video");
      el.preload = "metadata";
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const d = el.duration;
        el.removeAttribute("src");
        el.load();
        probing -= 1;
        if (Number.isFinite(d) && d > 0) {
          durCache.set(v.id, d);
          done(d);
        }
        pump();
      };
      const timer = setTimeout(finish, 8000);
      el.onloadedmetadata = finish;
      el.onerror = finish;
      el.src = v.streamUrl;
    }
  }

  const durObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        durObserver.unobserve(entry.target);
        const card = entry.target;
        const v = library.videos.find((x) => x.id === card.dataset.id);
        if (!v || durationOf(v)) continue;
        probe(v, (d) => {
          const el = card.querySelector(".ep-dur");
          if (el) el.textContent = fmtShort(d);
        });
      }
    },
    { rootMargin: "0px 300px" },
  );

  function bindEpisodes() {
    $("epClose").addEventListener("click", () => closeEpisodes());
    seasonBtn.addEventListener("click", () => (seasonMenu.hidden ? openMenu() : closeMenu(true)));

    const scrollBy = (dir) =>
      track.scrollBy({ left: dir * track.clientWidth * 0.8, behavior: "smooth" });
    $("epPrev").addEventListener("click", () => scrollBy(-1));
    $("epNext").addEventListener("click", () => scrollBy(1));

    let ticking = false;
    track.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          updateArrows();
        });
      },
      { passive: true },
    );

    // Mouse wheel scrolls the carousel sideways.
    track.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
        track.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
  }

  function updateArrows() {
    $("epPrev").disabled = track.scrollLeft <= 2;
    $("epNext").disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
  }

  function openEpisodes() {
    const show = getShow(currentVideo);
    if (!show || episodesOpen) return;
    episodesOpen = true;
    clearTimeout(hudTimer);
    hud.inert = true;
    episodes.inert = false;
    player.classList.add("episodes-open");
    updatePills();

    const seasons = seasonsOf(show);
    const current = seasons.find((s) => s.id === currentVideo.seasonId) || seasons[0];
    setSeason(seasons, current, true);
  }

  function closeEpisodes(refocus = true) {
    if (!episodesOpen) return;
    episodesOpen = false;
    closeMenu(false);
    durObserver.disconnect();
    episodes.inert = true;
    player.classList.remove("episodes-open");
    hud.inert = false;
    showHud();
    updatePills();
    if (refocus) episodesBtn.focus({ preventScroll: true });
  }

  function openMenu() {
    if (seasonBtn.dataset.single === "true") return;
    seasonMenu.hidden = false;
    seasonBtn.setAttribute("aria-expanded", "true");
    (seasonMenu.querySelector('[aria-selected="true"]') || seasonMenu.querySelector("button"))?.focus();
  }

  function closeMenu(refocus) {
    seasonMenu.hidden = true;
    seasonBtn.setAttribute("aria-expanded", "false");
    if (refocus && episodesOpen) seasonBtn.focus({ preventScroll: true });
  }

  function setSeason(seasons, season, focusCurrent) {
    activeSeasonId = season.id;
    const single = seasons.length === 1;
    $("seasonLabel").textContent = seasonName(season.name);
    seasonBtn.dataset.single = String(single);
    seasonBtn.tabIndex = single ? -1 : 0;

    // Custom dropdown (hidden when there is only one season)
    seasonMenu.replaceChildren();
    for (const s of seasons) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctl";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(s.id === season.id));
      b.innerHTML = `<span>${ui.escapeHtml(seasonName(s.name))}</span><i class="fa-solid fa-check"></i>`;
      b.addEventListener("click", () => {
        closeMenu(false);
        setSeason(seasons, s, false);
        track.querySelector(s.id === currentVideo.seasonId ? ".ep-card.current" : ".ep-card")?.focus({ preventScroll: true });
      });
      li.appendChild(b);
      seasonMenu.appendChild(li);
    }

    // Cards
    durObserver.disconnect();
    track.replaceChildren();
    const frag = document.createDocumentFragment();
    season.videoIds.forEach((id, index) => {
      const v = library.videos.find((x) => x.id === id);
      if (v) frag.appendChild(createEpisodeCard(v, index));
    });
    track.appendChild(frag);
    track.scrollLeft = 0;

    const current = track.querySelector(".ep-card.current");
    if (current) {
      track.scrollLeft = current.offsetLeft - (track.clientWidth - current.offsetWidth) / 2;
    }
    updateArrows();

    if (focusCurrent) {
      const target = current || track.querySelector(".ep-card");
      target?.focus({ preventScroll: true });
    }
  }

  function createEpisodeCard(v, index) {
    const a = document.createElement("a");
    a.className = "ep-card";
    a.href = v.url;
    a.dataset.id = v.id;
    a.setAttribute("data-center", "");
    a.setAttribute("role", "listitem");
    if (v.id === currentVideo.id) a.classList.add("current");

    const n = Number.isFinite(v.episodeNumber) ? v.episodeNumber : index + 1;
    const title = episodeTitle(v, index);
    const d = v.id === currentVideo.id && video.duration ? video.duration : durationOf(v);

    a.innerHTML =
      `<span class="ep-art">${
        v.thumbnail
          ? `<img src="${ui.escapeHtml(v.thumbnail)}" alt="" loading="lazy" decoding="async" draggable="false">`
          : '<span class="ph"><i class="fa-solid fa-clapperboard"></i></span>'
      }<span class="ep-now">Playing</span></span>` +
      `<span class="ep-meta"><span class="ep-num">${n}</span><span class="ep-name">${ui.escapeHtml(title)}</span>` +
      `<span class="ep-dur">${d ? fmtShort(d) : ""}</span></span>`;

    if (!v.thumbnail) ui.watchCover(a.querySelector(".ep-art"), v.id);
    if (!d) durObserver.observe(a);

    a.addEventListener("click", (e) => {
      e.preventDefault();
      closeEpisodes(false);
      if (v.id !== currentVideo.id) loadVideo(v);
      else showHud();
    });
    return a;
  }
})();
