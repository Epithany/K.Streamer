(() => {
  "use strict";

  const ui = window.ui;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  document.addEventListener("DOMContentLoaded", async () => {
    const me = await window.accountReady;
    if (!me) return;

    const grid = document.getElementById("channels");
    try {
      const r = await fetch("/api/channels");
      if (!r.ok) throw new Error("bad response");
      const { accounts } = await r.json();
      accounts.sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));

      for (const a of accounts) {
        const tile = document.createElement("a");
        tile.className = "tile";
        tile.href = `/?c=${encodeURIComponent(a.id)}`;
        tile.append(window.accountUi.avatar(a));
        const name = document.createElement("span");
        name.className = "tile-name";
        name.textContent = a.id === me.id ? `${a.name} (you)` : a.name;
        const sub = document.createElement("span");
        sub.className = "tile-sub";
        sub.textContent = [plural(a.videos, "video"), plural(a.shorts, "short"), plural(a.songs, "song")].join(" · ");
        tile.append(name, sub);
        grid.appendChild(tile);
      }
      grid.querySelector(".tile")?.focus({ preventScroll: true });
    } catch {
      grid.textContent = "Couldn’t load channels.";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (ui.isBack(e)) { e.preventDefault(); location.href = "/"; return; }
    const dir = ui.DIRS[e.key];
    if (dir && ui.move(dir, document.body, () => document.querySelector(".tile"))) e.preventDefault();
  });
})();
