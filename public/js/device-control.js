(function () {
  const storageKey = "media-server-device-id";
  const nameKey = "media-server-device-name";
  const generatedId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deviceId = localStorage.getItem(storageKey) || generatedId;
  localStorage.setItem(storageKey, deviceId);

  let deviceName = localStorage.getItem(nameKey) || "";
  let stateProvider = () => ({});
  let started = false;
  const reloadStateKey = "media-server-reload-state";

  function installStyles() {
    if (document.querySelector("#device-control-styles")) return;
    const style = document.createElement("style");
    style.id = "device-control-styles";
    style.textContent =
      ".device-notification{position:fixed;z-index:10000;top:20px;left:50%;max-width:min(520px,calc(100vw - 32px));padding:12px 18px;border:1px solid rgba(255,255,255,.2);border-radius:12px;background:rgba(0,0,0,.94);color:#fff;box-shadow:0 14px 36px rgba(0,0,0,.45);opacity:0;pointer-events:none;transform:translate(-50%,-16px);transition:opacity .18s,transform .18s}.device-notification.visible{opacity:1;transform:translate(-50%,0)}.device-cursor{position:fixed;z-index:10001;width:18px;height:18px;border:3px solid #baff54;border-radius:50%;box-shadow:0 0 14px #baff54;pointer-events:none;opacity:0;transform:translate(-50%,-50%);transition:left .25s,top .25s,opacity .15s}.device-cursor.visible{opacity:1}";
    document.head.append(style);
  }

  // In fullscreen the browser paints only the fullscreen element and its
  // children, so anything appended to <body> is hidden behind it. Overlays
  // therefore live inside whatever is fullscreen right now, and move when
  // that changes.
  function overlayRoot() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.body
    );
  }

  function mountOverlays() {
    const root = overlayRoot();
    for (const selector of [".device-notification", ".device-cursor"]) {
      const element = document.querySelector(selector);
      if (element && element.parentElement !== root) root.append(element);
    }
  }

  function toast(message) {
    let element = document.querySelector(".device-notification");
    if (!element) {
      element = document.createElement("div");
      element.className = "device-notification";
      element.setAttribute("role", "status");
      overlayRoot().append(element);
    } else {
      mountOverlays();
    }
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("visible"), 5000);
  }

  function moveCursor(values) {
    const target = values.join(" ");
    let x;
    let y;
    const pair = target.match(/^(-?[\d.]+)[,\s]+(-?[\d.]+)$/);
    if (pair) {
      x = Number(pair[1]);
      y = Number(pair[2]);
    } else {
      const element = document.querySelector(target);
      if (!element) return toast(`No element matches: ${target}`);
      const rect = element.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
    let cursor = document.querySelector(".device-cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.className = "device-cursor";
      overlayRoot().append(cursor);
    }
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.classList.add("visible");
  }

  function restorePlayback() {
    const stored = sessionStorage.getItem(reloadStateKey);
    const playVideoId = sessionStorage.getItem("media-server-play-video-id");
    if (!stored && !playVideoId) return;
    let state;
    try {
      state = stored ? JSON.parse(stored) : {};
    } catch {
      sessionStorage.removeItem(reloadStateKey);
      return;
    }
    const video = document.querySelector("video");
    if (!video) return;
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (Number.isFinite(state.time))
          video.currentTime = Math.min(
            state.time,
            video.duration || state.time,
          );
        if (Number.isFinite(state.volume)) video.volume = state.volume;
        video.muted = Boolean(state.muted);
        if (Number.isFinite(state.rate)) video.playbackRate = state.rate;
        if (!state.paused) video.play().catch(() => {});
        sessionStorage.removeItem(reloadStateKey);
        if (
          playVideoId &&
          new URLSearchParams(location.search).get("v") === playVideoId
        ) {
          video.play().catch(() => {});
          sessionStorage.removeItem("media-server-play-video-id");
        }
      },
      { once: true },
    );
  }

  function reloadPage() {
    const video = document.querySelector("video");
    if (video) {
      sessionStorage.setItem(
        reloadStateKey,
        JSON.stringify({
          time: video.currentTime,
          paused: video.paused,
          volume: video.volume,
          muted: video.muted,
          rate: video.playbackRate,
        }),
      );
    }
    location.reload();
  }

  // Hot-swaps changed stylesheets: the new file is loaded next to the old one
  // and the old one is removed only once the new one has applied, so the page
  // never flashes unstyled and the video is never touched. `files` maps
  // stylesheet names to their modified time, as sent by the server.
  async function refreshStyles(files) {
    const video = document.querySelector("video");
    const wasPlaying = Boolean(video && !video.paused && !video.ended);
    // Safety net: if anything pauses the video while styles swap, resume it.
    const resume = () => {
      if (wasPlaying && video.paused) video.play().catch(() => {});
    };
    video?.addEventListener("pause", resume);

    const swaps = [];
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin) continue; // fonts etc. stay as they are
      const name = url.pathname.split("/").pop();
      if (files && !(name in files)) continue;
      url.searchParams.set("v", files?.[name] ?? Date.now());

      const next = link.cloneNode();
      next.href = url.href;
      swaps.push(
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            next.remove();
            resolve(false);
          }, 5000);
          next.onload = () => {
            clearTimeout(timer);
            link.remove();
            resolve(true);
          };
          next.onerror = () => {
            clearTimeout(timer);
            next.remove();
            resolve(false);
          };
          link.after(next);
        }),
      );
    }

    const results = await Promise.all(swaps);
    setTimeout(() => video?.removeEventListener("pause", resume), 500);
    const applied = results.filter(Boolean).length;
    toast(
      applied
        ? `Styles updated (${applied} file${applied === 1 ? "" : "s"})`
        : "No stylesheet needed updating",
    );
  }

  function run(command, args) {
    const values = args?.values || [];
    const videoMatch = command.match(/^video-play-(.+)$/i);
    const pageMatch = command.match(/^page-(.+)$/i);
    if (videoMatch) {
      sessionStorage.setItem("media-server-play-video-id", videoMatch[1]);
      location.href = `/watch?v=${encodeURIComponent(videoMatch[1])}`;
      return;
    }
    if (pageMatch) {
      const destination = new URL(pageMatch[1], location.origin);
      if (destination.origin === location.origin)
        location.href = destination.href;
      return;
    }
    if (command === "send-message") toast(args?.message || "");
    if (
      command === "sidebar-open" &&
      !document.querySelector("#sidebar")?.classList.contains("open")
    )
      document.querySelector("#menuBtn")?.click();
    if (command === "scroll-page")
      window.scrollBy({
        top: Number(values[0]) || window.innerHeight * 0.8,
        behavior: "smooth",
      });
    if (command === "playlist-button-click-up")
      document.querySelector("#playlistScrollUp")?.click();
    if (command === "playlist-button-click-down")
      document.querySelector("#playlistScrollDown")?.click();
    if (command === "playlist-button-click")
      document.querySelector("#playlistHeader")?.click();
    if (command === "page-button-click-up")
      document.querySelector(".page-scroll-up")?.click();
    if (command === "page-button-click-down")
      document.querySelector(".page-scroll-down")?.click();
    if (command === "move-cursor") moveCursor(values);
    if (command === "refresh-styles") refreshStyles(args?.files);
    if (command === "reload") reloadPage();
    window.dispatchEvent(
      new CustomEvent("device:command", { detail: { command, values } }),
    );
  }

  function heartbeat() {
    const details = stateProvider() || {};
    fetch("/api/device/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: deviceId,
        name: deviceName,
        page: location.pathname,
        watching: details,
      }),
    }).catch(() => {});
  }

  function connect() {
    const source = new EventSource(
      `/api/device/events?id=${encodeURIComponent(deviceId)}`,
    );
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "identity" && payload.name) {
          deviceName = payload.name;
          localStorage.setItem(nameKey, deviceName);
        }
        if (payload.type === "set-name") {
          deviceName = payload.name;
          localStorage.setItem(nameKey, deviceName);
          toast(`This device is now named ${deviceName}`);
          heartbeat();
        }
        if (payload.type === "command") run(payload.command, payload.args);
      } catch {}
    };
  }

  window.deviceControl = {
    setStateProvider(provider) {
      stateProvider = provider;
      heartbeat();
    },
    notify: toast,
  };

  function start() {
    if (started) return;
    started = true;
    installStyles();
    document.addEventListener("fullscreenchange", mountOverlays);
    document.addEventListener("webkitfullscreenchange", mountOverlays);
    restorePlayback();
    connect();
    heartbeat();
    setInterval(heartbeat, 10000);
    window.addEventListener("beforeunload", heartbeat);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
