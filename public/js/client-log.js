// Reports browser-side problems to the server (logs/client.log): script errors,
// unhandled promise rejections, failed script/stylesheet loads and video/audio
// playback errors. Tiny, dependency-free, and silent if the server is unreachable.
(() => {
  "use strict";
  if (window.__clientLog) return;
  window.__clientLog = true;

  const LIMIT = 20; // per page load, so a loop can't flood the log
  const seen = new Set();
  let sent = 0;

  const MEDIA_ERRORS = {
    1: "aborted",
    2: "network error",
    3: "decode error",
    4: "source not supported",
  };

  function identity() {
    try {
      return {
        deviceId: localStorage.getItem("media-server-device-id") || "",
        deviceName: localStorage.getItem("media-server-device-name") || "",
      };
    } catch {
      return {};
    }
  }

  function send(report) {
    if (sent >= LIMIT) return;
    const key = `${report.type}|${report.message}|${report.source || ""}|${report.line || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent += 1;
    const body = JSON.stringify({
      level: "error",
      ...identity(),
      page: location.pathname + location.search,
      userAgent: navigator.userAgent,
      ...report,
    });
    try {
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  const stripQuery = (url) => String(url || "").split("?")[0];

  function mediaError(el) {
    const err = el.error;
    const kind = err ? MEDIA_ERRORS[err.code] || `code ${err.code}` : "unknown";
    send({
      type: "media",
      message: `${el.tagName.toLowerCase()} playback failed (${kind}): ${stripQuery(el.currentSrc || el.src)}`,
      extra: [
        err?.message && `browser says: ${err.message}`,
        `time=${Math.round(el.currentTime || 0)}s readyState=${el.readyState} networkState=${el.networkState}`,
      ].filter(Boolean).join("\n"),
    });
  }

  // Capture phase: resource and media errors don't bubble.
  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window) {
      const tag = t.tagName;
      if (tag === "VIDEO" || tag === "AUDIO") mediaError(t);
      else if (tag === "SCRIPT" || tag === "LINK") {
        send({ type: "resource", message: `failed to load ${tag.toLowerCase()}: ${stripQuery(t.src || t.href)}` });
      }
      return; // images (e.g. covers without art) are expected to 404
    }
    send({
      type: "script",
      message: e.message || "script error",
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack,
    });
  }, true);

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send({
      type: "promise",
      message: (r && r.message) || String(r),
      stack: r && r.stack,
    });
  });
})();
