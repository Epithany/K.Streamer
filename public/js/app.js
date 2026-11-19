(() => {
  "use strict";

  const ui = window.ui;
  const $ = (id) => document.getElementById(id);

  let library = null;
  let cardOrder = null; // keys in the order first shown, stable across live updates
  let playlists = []; // this account's saved video playlists
  const channelId = new URLSearchParams(location.search).get("c"); // ?c=<account id>: one person's channel
  const nodes = new Map(); // key -> { slot, a, art, title, owner, thumb }

  document.addEventListener("DOMContentLoaded", async () => {
    bind();
    showChannelBanner();
    await loadLibrary();
    connectLiveUpdates();
  });

  function bind() {
    // Coming back with the back button: refresh links to the latest episode.
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) loadPlaylists().then(render);
    });
    $("reloadBtn")?.addEventListener("click", () => location.reload());
    $("refreshBtn")?.addEventListener("click", rescan);

    // Remote / keyboard: arrows move focus between cards and header buttons.
    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const dir = ui.DIRS[e.key];
      if (!dir) return;
      if (ui.move(dir, document.body, () => document.querySelector(".card"))) {
        e.preventDefault();
      }
    });
  }

  async function loadLibrary() {
    try {
      const response = await fetch("/api/library");
      if (!response.ok) throw new Error("bad response");
      library = scoped(await response.json());
      await loadPlaylists();
      render();
    } catch {
      showEmpty("Can’t reach the server. Check that it is running, then reload.");
    }
  }

  function connectLiveUpdates() {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        library = scoped(JSON.parse(event.data));
      } catch {
        return;
      }
      render();
    };
  }

  async function rescan() {
    const icon = $("refreshBtn")?.querySelector("i");
    icon?.classList.add("fa-spin");
    try {
      const response = await fetch("/api/rescan", { method: "POST" });
      if (!response.ok) throw new Error("Rescan failed");
      // The refreshed library arrives through /api/events.
    } catch {
      window.deviceControl?.notify("Rescan failed. Is the server running?");
    } finally {
      icon?.classList.remove("fa-spin");
    }
  }

  // A channel is one person's uploads: the same page, narrowed to their files.
  function scoped(lib) {
    if (!channelId) return lib;
    const videos = lib.videos.filter((v) => v.ownerId === channelId);
    const ids = new Set(videos.map((v) => v.id));
    const shows = [];
    for (const s of lib.shows) {
      const videoIds = s.videoIds.filter((id) => ids.has(id));
      if (!videoIds.length) continue;
      const seasons = (s.seasons || [])
        .map((se) => ({ ...se, videoIds: se.videoIds.filter((id) => ids.has(id)) }))
        .filter((se) => se.videoIds.length);
      shows.push({ ...s, videoIds, seasons, thumbnail: videos.find((v) => v.id === videoIds[0])?.thumbnail || "" });
    }
    return { ...lib, videos, shows };
  }

  async function loadPlaylists() {
    if (channelId) { playlists = []; return; }
    try {
      const r = await fetch("/api/playlists?kind=video&full=1");
      if (r.ok) playlists = (await r.json()).playlists.filter((p) => p.items?.length);
    } catch {}
  }

  async function showChannelBanner() {
    if (!channelId) return;
    try {
      const { accounts } = await (await fetch("/api/accounts")).json();
      const owner = accounts.find((a) => a.id === channelId);
      if (!owner) return;
      const banner = $("channelBanner");
      const title = document.createElement("h2");
      title.textContent = `${owner.name}’s channel`;
      const back = document.createElement("a");
      back.href = "/";
      back.textContent = "← Everyone’s library";
      banner.replaceChildren(window.accountUi.avatar(owner), title, back);
      banner.hidden = false;
      document.title = `${owner.name}’s channel · K. Streamer`;
    } catch {}
  }

  // ---------- Rendering ----------

  function firstEpisode(show) {
    const id = show.seasons?.[0]?.videoIds?.[0] ?? show.videoIds[0];
    return library.videos.find((v) => v.id === id);
  }

  function buildItems() {
    const items = [];
    for (const v of library.videos) {
      if (!v.showId) items.push({ key: `v:${v.id}`, kind: "video", data: v });
    }
    for (const s of library.shows) {
      if (s.videoIds.length) items.push({ key: `s:${s.id}`, kind: "show", data: s });
    }
    const have = new Set(library.videos.map((v) => v.id));
    for (const p of playlists) {
      const ids = p.items.filter((id) => have.has(id));
      if (ids.length) items.push({ key: `p:${p.id}`, kind: "playlist", data: { ...p, items: ids } });
    }
    return items;
  }

  // Shuffle once, then keep that order so a live update never reshuffles
  // what the person is looking at. New items are appended.
  function stableOrder(items) {
    if (!cardOrder) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      cardOrder = shuffled.map((i) => i.key);
      return shuffled;
    }
    const byKey = new Map(items.map((i) => [i.key, i]));
    const ordered = [];
    for (const key of cardOrder) {
      if (byKey.has(key)) {
        ordered.push(byKey.get(key));
        byKey.delete(key);
      }
    }
    for (const [key, item] of byKey) {
      ordered.push(item);
      cardOrder.push(key);
    }
    return ordered;
  }

  function render() {
    if (!library) return;
    const grid = $("contentGrid");
    // Saved playlists lead; everything else keeps its (stable, shuffled) order.
    const ordered = stableOrder(buildItems()).sort((a, b) => (b.kind === "playlist") - (a.kind === "playlist"));

    if (!ordered.length) {
      for (const n of nodes.values()) n.slot.remove();
      nodes.clear();
      showEmpty(channelId ? "Nothing here is shared with you yet." : "No videos yet. Add files to the Videos folder, then press Rescan.");
      return;
    }
    $("emptyState").hidden = true;

    // Drop cards that no longer exist.
    const live = new Set(ordered.map((i) => i.key));
    for (const [key, n] of nodes) {
      if (!live.has(key)) {
        n.slot.remove();
        nodes.delete(key);
      }
    }

    // Create or update in place, and only move DOM nodes when order differs.
    let cursor = grid.firstElementChild;
    for (const item of ordered) {
      let node = nodes.get(item.key);
      if (!node) {
        node = createNode();
        nodes.set(item.key, node);
      }
      paint(node, item);
      if (node.slot === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(node.slot, cursor);
    }
  }

  function showEmpty(message) {
    const el = $("emptyState");
    el.textContent = message;
    el.hidden = false;
  }

  function createNode() {
    const slot = document.createElement("div");
    slot.className = "slot";
    const a = document.createElement("a");
    a.className = "card";
    a.innerHTML =
      '<span class="art"></span>' +
      '<span class="meta"><strong class="title"></strong></span>';
    const owner = document.createElement("a");
    owner.className = "card-owner";
    slot.append(a, owner);
    return {
      slot,
      a,
      art: a.querySelector(".art"),
      title: a.querySelector(".title"),
      owner,
      thumb: null,
    };
  }

  function paint(node, item) {
    const { kind, data } = item;
    let thumb;
    let href;
    let title;
    let ownerName = "";
    let ownerId = "";
    let stack = false;
    let coverId;

    if (kind === "playlist") {
      const first = library.videos.find((v) => v.id === data.items[0]);
      const selectedCover = library.videos.find((v) => v.id === data.thumbnailVideoId);
      const n = data.items.length;
      thumb = selectedCover?.thumbnail || first?.thumbnail || "";
      href = `/watch?v=${encodeURIComponent(data.items[0])}&list=${encodeURIComponent(data.id)}`;
      title = data.name;
      ownerName = "Your playlist";
      stack = true;
      coverId = selectedCover?.id || first?.id;
    } else if (kind === "show") {
      const first = firstEpisode(data);
      // First visit opens episode 1; after that, the episode watched last.
      const lastId = ui.progress.lastEpisode(data.id);
      const resume = lastId && data.videoIds.includes(lastId)
        ? library.videos.find((v) => v.id === lastId)
        : null;
      thumb = data.thumbnail || first?.thumbnail || "";
      href = (resume || first)?.url || `/watch?v=${encodeURIComponent(data.videoIds[0])}`;
      title = ui.prettyName(data.name);
      const seasons = data.seasons?.length || 1;
      const count = data.videoIds.length;
      const detail = seasons > 1 ? `${seasons} seasons` : `${count} episode${count === 1 ? "" : "s"}`;
      const owners = [...new Set(data.videoIds.map((id) => library.videos.find((v) => v.id === id)?.ownerId).filter(Boolean))];
      ownerId = owners.length === 1 ? owners[0] : "";
      ownerName = owners.length === 1
        ? library.videos.find((v) => v.ownerId === ownerId)?.ownerName || "Unknown uploader"
        : `Multiple uploaders · ${detail}`;
      stack = true;
      coverId = first?.id || data.videoIds[0];
    } else {
      thumb = data.thumbnail || "";
      href = data.url;
      title = ui.prettyName(data.name);
      ownerId = data.ownerId;
      ownerName = data.ownerName || "Unknown uploader";
      coverId = data.id;
    }

    if (node.a.getAttribute("href") !== href) node.a.setAttribute("href", href);
    node.a.classList.toggle("stack", stack);
    node.a.setAttribute("aria-label", ownerName ? `${title}, uploaded by ${ownerName}` : title);
    if (node.title.textContent !== title) node.title.textContent = title;
    node.owner.textContent = ownerName;
    node.owner.hidden = !ownerName;
    if (ownerId) node.owner.href = `/?c=${encodeURIComponent(ownerId)}`;
    else node.owner.removeAttribute("href");

    if (node.thumb !== thumb) {
      node.thumb = thumb;
      if (thumb) {
        node.art.innerHTML = `<img src="${ui.escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" draggable="false">`;
      } else {
        node.art.innerHTML =
          '<span class="ph"><i class="fa-solid fa-clapperboard"></i><span>Generating thumbnail…</span></span>';
        ui.watchCover(node.art, coverId);
      }
    }
  }
})();
