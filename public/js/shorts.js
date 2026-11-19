(() => {
  "use strict";

  const ui = window.ui;
  const $ = (id) => document.getElementById(id);
  const feed = $("feed");

  // device-control.js saves/restores playback of the page's first <video> across
  // a remote reload. Here the videos don't exist yet when it runs, so it would
  // leave that state behind for the next /watch page to misapply. Drop it.
  document.addEventListener("DOMContentLoaded", () => {
    sessionStorage.removeItem("media-server-reload-state");
    sessionStorage.removeItem("media-server-play-video-id");
  });

  const SOUND_KEY = "media-server-shorts-sound"; // "off" when the viewer muted on purpose
  const store = {
    get: () => { try { return localStorage.getItem(SOUND_KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(SOUND_KEY, v); } catch {} },
  };

  let reels = []; // { short, el, video, spin, bad, prog }
  let active = -1;
  let target = 0; // where a button/key/wheel navigation is heading
  let wantSound = store.get() !== "off";
  let forcedMute = false; // browser autoplay policy refused sound
  let userPaused = false;

  const isMuted = () => !wantSound || forcedMute;

  // ---------- Sound ----------
  function applyMute() {
    const muted = isMuted();
    for (const r of reels) r.video.muted = muted;
    $("muteBtn").classList.toggle("muted", muted);
    $("soundHint").hidden = !(forcedMute && wantSound);
  }

  $("muteBtn").addEventListener("click", () => {
    if (isMuted()) { wantSound = true; forcedMute = false; store.set("on"); }
    else { wantSound = false; store.set("off"); }
    applyMute();
  });
  $("soundHint").addEventListener("click", () => { forcedMute = false; applyMute(); });

  // Autoplay may have started muted; the first real gesture can restore sound.
  for (const type of ["click", "touchend", "keydown"]) {
    addEventListener(type, () => {
      if (forcedMute) { forcedMute = false; applyMute(); }
    }, { capture: true, passive: true });
  }

  // ---------- Playback ----------
  async function play(r) {
    const v = r.video;
    v.muted = isMuted();
    try {
      await v.play();
    } catch (err) {
      if (err.name === "NotAllowedError" && !v.muted) {
        forcedMute = true;
        applyMute();
        try { await v.play(); } catch {}
      }
      // AbortError = swiped away mid-load; nothing to do.
    }
  }

  function ensureSrc(r, preload) {
    r.video.preload = preload;
    if (!r.video.getAttribute("src")) r.video.src = r.short.streamUrl;
  }

  function unload(r) {
    if (!r.video.getAttribute("src")) return;
    r.video.pause();
    r.video.removeAttribute("src");
    r.video.load(); // releases the connection and decoder
    r.spin.hidden = true;
    r.bad.hidden = true;
    r.el.classList.remove("paused");
  }

  // Only the current short and its two neighbours hold a network connection:
  // the next one preloads for an instant swipe, the previous one stays warm.
  function refreshWindow(i) {
    reels.forEach((r, idx) => {
      if (idx === i) ensureSrc(r, "auto");
      else if (idx === i + 1) ensureSrc(r, "auto");
      else if (idx === i - 1) ensureSrc(r, "metadata");
      else unload(r);
    });
  }

  function activate(i) {
    if (i === active) return;
    const prev = reels[active];
    if (prev) {
      prev.video.pause();
      prev.el.classList.remove("paused");
    }
    active = i;
    target = i;
    userPaused = false;
    refreshWindow(i);

    const cur = reels[i];
    if (cur.video.readyState > 0) cur.video.currentTime = 0;
    play(cur);
    $("upBtn").disabled = i === 0;
  }

  function toggle() {
    const r = reels[active];
    if (!r) return;
    if (r.video.paused) {
      userPaused = false;
      r.el.classList.remove("paused");
      play(r);
    } else {
      userPaused = true;
      r.video.pause();
      r.el.classList.add("paused");
    }
  }

  document.addEventListener("visibilitychange", () => {
    const r = reels[active];
    if (!r) return;
    if (document.hidden) r.video.pause();
    else if (!userPaused) play(r);
  });

  // ---------- Navigation ----------
  function goTo(i, smooth = true) {
    i = Math.max(0, Math.min(reels.length - 1, i));
    target = i;
    feed.scrollTo({ top: i * feed.clientHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function step(dir) {
    if (!reels.length) return;
    const next = target + dir;
    if (next >= reels.length) return goTo(0, false); // end of the feed: loop round
    if (next < 0) return;
    goTo(next);
  }

  $("upBtn").addEventListener("click", () => step(-1));
  $("downBtn").addEventListener("click", () => step(1));

  // Tap / click the video to pause or resume. Swipes never fire a click.
  feed.addEventListener("click", (e) => {
    if (e.target.closest(".frame")) toggle();
  });

  // Mouse wheel / trackpad: one short per gesture. Without this, snap-scrolling
  // lets small wheel notches bounce back to where they started. The lock holds
  // until the gesture (and its trackpad inertia) goes quiet.
  let wheelLocked = false;
  let lastWheel = 0;
  let lastNav = 0;
  feed.addEventListener("wheel", (e) => {
    e.preventDefault();
    const now = performance.now();
    const gap = now - lastWheel;
    lastWheel = now;
    if (wheelLocked) {
      if (gap > 120 && now - lastNav > 450) wheelLocked = false;
      else return;
    }
    if (Math.abs(e.deltaY) < 8) return;
    wheelLocked = true;
    lastNav = now;
    step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const onControl = !!e.target.closest?.("button,a");

    if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); step(-1); }
    else if ((e.key === " " || e.key === "Enter") && !onControl) { e.preventDefault(); toggle(); }
    else if (e.key === "m" || e.key === "M") $("muteBtn").click();
    else if (ui?.isBack(e)) { e.preventDefault(); location.href = "/"; }
  });

  // ---------- Building the feed ----------
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let observer = null;

  function createReel(short) {
    const el = document.createElement("section");
    el.className = "reel";
    el.innerHTML =
      '<div class="frame">' +
      '<video loop playsinline preload="none"></video>' +
      '<div class="spin" hidden><i class="fa-solid fa-spinner fa-spin"></i></div>' +
      '<div class="flash"><i class="fa-solid fa-play"></i></div>' +
      '<div class="bad" hidden>Can’t play this file</div>' +
      '<div class="prog"><i></i></div>' +
      "</div>";

    const r = {
      short,
      el,
      video: el.querySelector("video"),
      spin: el.querySelector(".spin"),
      bad: el.querySelector(".bad"),
      prog: el.querySelector(".prog i"),
    };
    const isActive = () => reels[active] === r;

    r.video.addEventListener("loadedmetadata", () => {
      const { videoWidth: w, videoHeight: h } = r.video;
      if (w && h) el.classList.toggle("portrait", w / h < 0.62);
    });
    r.video.addEventListener("waiting", () => { if (isActive()) r.spin.hidden = false; });
    for (const ev of ["playing", "canplay", "pause", "emptied"]) {
      r.video.addEventListener(ev, () => { r.spin.hidden = true; });
    }
    r.video.addEventListener("error", () => {
      if (r.video.getAttribute("src")) r.bad.hidden = false;
    });
    r.video.muted = isMuted();
    return r;
  }

  function renumber() {
    reels.forEach((r, i) => {
      r.el.dataset.i = i;
      r.el.setAttribute("aria-label", `Short ${i + 1} of ${reels.length}`);
    });
  }

  // Inserts shorts at position `at` (never before the one being watched, so
  // the scroll position doesn't move).
  function insertReels(list, at) {
    const made = list.map(createReel);
    reels.splice(at, 0, ...made);
    const before = reels[at + made.length]?.el || null;
    const frag = document.createDocumentFragment();
    for (const r of made) frag.appendChild(r.el);
    feed.insertBefore(frag, before);
    renumber();
    for (const r of made) observer.observe(r.el);
    refreshWindow(Math.max(active, 0)); // the new neighbour starts preloading
  }

  function removeReels(ids) {
    for (const id of ids) {
      const i = reels.findIndex((r) => r.short.id === id);
      if (i < 0 || i === active) continue; // never pull the short out from under the viewer
      const [r] = reels.splice(i, 1);
      observer.unobserve(r.el);
      unload(r);
      r.el.remove();
      if (i < active) { active -= 1; target = active; }
    }
    renumber();
  }

  function build(shorts) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(Number(e.target.dataset.i));
      }
    }, { root: feed, threshold: [0.6] });

    insertReels(shorts, 0);

    // Progress bar for the active short.
    const tick = () => {
      const r = reels[active];
      const v = r?.video;
      if (v && v.duration > 0) r.prog.style.transform = `scaleX(${v.currentTime / v.duration})`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    window.deviceControl?.setStateProvider(() => ({
      title: "Shorts",
      short: reels[active]?.short.name || null,
    }));
  }

  // ---------- Live updates ----------
  // Uploads (and files added or removed on disk) show up without a reload: new
  // shorts slide in right after the one you're watching.
  let syncing = false;
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const response = await fetch("/api/shorts");
      const fresh = (await response.json()).shorts || [];
      const known = new Set(reels.map((r) => r.short.id));
      const incoming = fresh.filter((s) => !known.has(s.id));
      const freshIds = new Set(fresh.map((s) => s.id));
      const gone = reels.filter((r) => !freshIds.has(r.short.id)).map((r) => r.short.id);

      if (!observer) {
        if (!incoming.length) return;
        $("empty").hidden = true;
        $("muteBtn").hidden = false;
        $("nav").hidden = false;
        build(shuffle(incoming));
        return;
      }
      if (gone.length) removeReels(gone);
      if (incoming.length) {
        if (!reels.length) { $("empty").hidden = true; $("muteBtn").hidden = false; $("nav").hidden = false; }
        insertReels(incoming, Math.max(active, -1) + 1);
      }
      if (!reels.length) showEmpty("No shorts yet. Upload some from the home page.");
    } catch {
      // Transient (server restarting, offline): the next event retries.
    } finally {
      syncing = false;
    }
  }
  window.addEventListener("media:shorts", sync);
  window.addEventListener("media:resync", sync);

  function showEmpty(message) {
    const el = $("empty");
    el.textContent = message;
    el.hidden = false;
    $("muteBtn").hidden = true;
    $("nav").hidden = true;
  }

  async function init() {
    applyMute();
    let shorts;
    try {
      const response = await fetch("/api/shorts");
      shorts = (await response.json()).shorts || [];
    } catch {
      return showEmpty("Can’t reach the server. Check that it is running, then reload.");
    }
    if (!shorts.length) return showEmpty("No shorts yet. Upload some from the home page.");
    const order = shuffle(shorts);
    const want = new URLSearchParams(location.search).get("s");
    const at = want ? order.findIndex((x) => x.id === want) : -1;
    if (at > 0) order.unshift(...order.splice(at, 1));
    build(order);
  }

  init();
})();
