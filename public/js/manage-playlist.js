(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const playlistId = location.pathname.split("/").filter(Boolean).at(-1);
  const enc = encodeURIComponent;
  const notify = message => window.deviceControl?.notify?.(message);
  let playlist;
  let mine = [];

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  const button = (label, icon, className = "hbtn small") => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    node.querySelector("span").textContent = label;
    return node;
  };

  const row = () => {
    const node = document.createElement("article");
    node.className = "studio-row";
    return node;
  };

  async function load() {
    [playlist, { items: mine }] = await Promise.all([
      api("GET", `/api/playlists/${enc(playlistId)}?detail=1`),
      api("GET", "/api/mine"),
    ]);
    mine = mine.filter(item => item.type === "video");
    render();
  }

  function render() {
    document.title = `${playlist.name} · Playlist Studio`;
    $("playlistName").textContent = playlist.name;
    $("playlistMeta").textContent = `${playlist.kind === "video" ? "Video" : "Song"} playlist · ${playlist.items.length} item${playlist.items.length === 1 ? "" : "s"}`;
    $("nameInput").value = playlist.name;
    $("saveName").disabled = false;

    const thumbnails = $("thumbnailSelect");
    thumbnails.replaceChildren(new Option("Use the first video", ""));
    for (const item of playlist.items) thumbnails.add(new Option(item.name, item.id, false, item.id === playlist.thumbnailVideoId));
    thumbnails.disabled = playlist.kind !== "video" || !playlist.items.length;

    const list = $("playlistItems");
    list.replaceChildren();
    if (!playlist.items.length) list.textContent = "This playlist is empty.";
    for (const item of playlist.items) list.append(itemRow(item));

    const addPanel = $("addPanel");
    addPanel.hidden = playlist.kind !== "video";
    const available = $("availableVideos");
    available.replaceChildren();
    const contained = new Set(playlist.items.map(item => item.id));
    const choices = mine.filter(item => !contained.has(item.id));
    if (!choices.length) available.textContent = "All of your videos are already in this list.";
    for (const item of choices) {
      const candidate = row();
      candidate.append(Object.assign(document.createElement("strong"), { textContent: item.name }));
      const add = button("Add", "fa-plus");
      add.addEventListener("click", async () => {
        add.disabled = true;
        try { await api("POST", `/api/playlists/${enc(playlistId)}/items`, { item: item.id }); await load(); }
        catch (error) { notify(error.message); add.disabled = false; }
      });
      candidate.append(add);
      available.append(candidate);
    }
  }

  function itemRow(item) {
    const node = row();
    const details = document.createElement("div");
    details.className = "studio-item-name";
    const name = document.createElement("strong");
    name.textContent = item.name;
    details.append(name);
    if (item.show) {
      const show = document.createElement("span");
      show.textContent = item.show;
      details.append(show);
    }
    node.append(details);

    if (playlist.kind === "video") {
      const visibility = document.createElement("select");
      visibility.setAttribute("aria-label", `Visibility for ${item.name}`);
      visibility.add(new Option("Only me", "private"), new Option("Everyone", "public"), new Option("Specific people", "shared"));
      visibility.value = item.visibility || "private";
      visibility.disabled = !item.canManage;
      if (!item.canManage) visibility.title = "Only the video owner can change visibility";
      visibility.addEventListener("change", async () => {
        visibility.disabled = true;
        try {
          await api("POST", "/api/access", { keys: [item.key], visibility: visibility.value, shared: item.shared || [] });
          await load();
        } catch (error) { notify(error.message); visibility.disabled = false; }
      });
      node.append(visibility);
    }

    const remove = button("Remove", "fa-xmark");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { await api("DELETE", `/api/playlists/${enc(playlistId)}/items/${enc(item.id)}`); await load(); }
      catch (error) { notify(error.message); remove.disabled = false; }
    });
    node.append(remove);

    if (playlist.kind === "video" && item.canManage) {
      const shorts = button("Move to Shorts", "fa-mobile-screen", "hbtn small btn-danger");
      shorts.addEventListener("click", async () => {
        if (!confirm(`Move “${item.name}” to Shorts? It will be removed from this and other video playlists.`)) return;
        shorts.disabled = true;
        try { await api("POST", `/api/videos/${enc(item.id)}/move-to-shorts`); await load(); notify("Moved to Shorts."); }
        catch (error) { notify(error.message); shorts.disabled = false; }
      });
      node.append(shorts);
    }
    return node;
  }

  $("saveName").addEventListener("click", async () => {
    const name = $("nameInput").value.trim();
    const thumbnailVideoId = $("thumbnailSelect").value || null;
    $("saveName").disabled = true;
    try {
      await api("PATCH", `/api/playlists/${enc(playlistId)}`, { name, thumbnailVideoId });
      await load();
      notify("Playlist saved.");
    } catch (error) { notify(error.message); $("saveName").disabled = false; }
  });

  document.addEventListener("DOMContentLoaded", async () => {
    const account = await window.accountReady;
    if (!account) return;
    try { await load(); } catch (error) {
      $("playlistName").textContent = "Playlist not found";
      $("playlistMeta").textContent = error.message;
      $("saveName").hidden = true;
    }
  });
})();
