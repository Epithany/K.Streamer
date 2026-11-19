// Registers the service worker and exposes install support:
//   window.pwa.canInstall()   true when the browser offers to install the app
//   window.pwa.install()      shows the install prompt
//   window.pwa.onChange(fn)   called when that availability changes
// Service workers (and installing) need a secure origin: https://, or localhost.
(() => {
  "use strict";

  const secure = location.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  let deferred = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch {} });

  window.pwa = {
    secure,
    standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    canInstall: () => Boolean(deferred),
    onChange: (fn) => listeners.add(fn),
    async install() {
      if (!deferred) return false;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      notify();
      return outcome === "accepted";
    },
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we offer "Install app" in the account menu instead of the browser's banner
    deferred = e;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });

  if (secure && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("service worker:", err.message));
    });
  }
})();
