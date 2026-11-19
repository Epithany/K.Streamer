/* Live updates: listens to /api/live and fires window events
     media:library  media:songs  media:shorts  media:resync (after a reconnect)
   Pages react by re-fetching what they show. */
(() => {
  "use strict";
  if (!window.EventSource) return;

  const emit = (type) => window.dispatchEvent(new CustomEvent(`media:${type}`));
  let opened = false;

  const source = new EventSource("/api/live");
  source.onopen = () => {
    if (opened) emit("resync"); // the connection dropped and came back: assume anything changed
    opened = true;
  };
  source.onmessage = (event) => {
    try {
      const { type } = JSON.parse(event.data);
      if (type) emit(type);
    } catch {}
  };

  // ----- Music page: refresh itself when songs are added -----
  // If listen.js defines window.listenRefresh() it is used. Otherwise: reload
  // when nothing is loaded in the player, or offer a refresh button.
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/listen") {
    let toast;
    window.addEventListener("media:songs", () => {
      if (typeof window.listenRefresh === "function") return window.listenRefresh();
      const audio = document.getElementById("audio");
      if (audio && !audio.currentSrc) return setTimeout(() => location.reload(), 300);
      if (toast?.isConnected) return;
      toast = document.createElement("div");
      toast.className = "live-toast";
      toast.setAttribute("role", "status");
      toast.innerHTML = '<span>New music was added</span><button type="button" class="hbtn">Refresh</button>';
      toast.querySelector("button").addEventListener("click", () => location.reload());
      document.body.append(toast);
    });
  }
})();
