(() => {
  "use strict";

  const ui = window.ui;
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const COLORS = ["#f0344a", "#ff9f1c", "#2ec4b6", "#3a86ff", "#8338ec", "#ff006e", "#80b918", "#fb5607"];
  const notify = (m) => window.deviceControl?.notify?.(m);

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
    return data;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const checkbox = (checked) => { const c = el("input"); c.type = "checkbox"; c.checked = Boolean(checked); return c; };
  const button = (label, cls = "hbtn small", icon) => {
    const b = el("button", cls);
    b.type = "button";
    if (icon) b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    b.append(el("span", null, label));
    return b;
  };

  let me = null;
  let people = []; // everyone but me, for the sharing pickers
  let items = [];
  const selected = new Set();
  const UPLOAD_PAGE_SIZE = 24;
  let visibleUploadCount = UPLOAD_PAGE_SIZE;
  let activeTab = "uploads";
  let lastScrollY = window.scrollY;

  document.addEventListener("DOMContentLoaded", async () => {
    me = await window.accountReady;
    if (!me) return;
    people = (await api("GET", "/api/accounts")).accounts.filter((a) => a.id !== me.id);
    $("adminTab").hidden = !me.isAdmin;

    for (const b of document.querySelectorAll(".mg-tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
    window.addEventListener("hashchange", () => showTab(location.hash.slice(1), false));
    showTab(location.hash.slice(1) || "uploads", false);
  });

  // ---------- Tabs ----------
  const loaders = { uploads: loadUploads, playlists: loadPlaylists, account: renderAccount, accounts: loadPeople };

  function showTab(name, setHash = true) {
    if (!loaders[name] || (name === "accounts" && !me.isAdmin)) name = "uploads";
    activeTab = name;
    lastScrollY = window.scrollY;
    for (const b of document.querySelectorAll(".mg-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const p of document.querySelectorAll(".mg-pane")) p.hidden = p.id !== `tab-${name}`;
    if (setHash && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    loaders[name]().catch((err) => notify(err.message));
  }

  // ---------- My uploads: who can see what ----------
  async function loadUploads() {
    items = (await api("GET", "/api/mine")).items;
    visibleUploadCount = UPLOAD_PAGE_SIZE;
    selected.clear();
    renderUploads();
  }

  const groupName = (i) => (i.type === "video" ? i.group || "Movies" : i.type === "short" ? "Shorts" : i.group || "Singles");

  function badge(i) {
    const names = i.shared.map((id) => people.find((p) => p.id === id)?.name).filter(Boolean);
    const b = el("span", `badge ${i.visibility}`,
      i.visibility === "public" ? "Everyone" : i.visibility === "shared" ? `Shared with ${names.length}` : "Only me");
    if (names.length) b.title = names.join(", ");
    return b;
  }

  function updateBar() {
    $("selEdit").disabled = selected.size === 0;
    $("selEdit").querySelector("span").textContent = selected.size ? `Change sharing (${selected.size})` : "Change sharing";
  }

  function renderUploads() {
    const root = $("uploadList");
    root.replaceChildren();
    if (!items.length) {
      root.append(el("p", "mg-empty", "You haven’t uploaded anything yet. Use Upload on the library page."));
      return updateBar();
    }

    const visibleItems = items.slice(0, visibleUploadCount);
    for (const [type, label] of [["video", "Videos"], ["short", "Shorts"], ["song", "Songs"]]) {
      const ofType = visibleItems.filter((i) => i.type === type);
      if (!ofType.length) continue;
      root.append(el("h2", "mg-h", label));

      const groups = new Map();
      for (const i of ofType) {
        const g = groupName(i);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(i);
      }
      const sorted = [...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
      for (const [name, list] of sorted) root.append(groupEl(type, name, list));
    }
    if (visibleItems.length < items.length) {
      const more = button(`Load more (${items.length - visibleItems.length} remaining)`, "hbtn mg-load-more", "fa-arrow-down");
      more.addEventListener("click", () => {
        visibleUploadCount += UPLOAD_PAGE_SIZE;
        renderUploads();
        $("uploadList").querySelector(".mg-load-more")?.focus();
      });
      root.append(more);
    }
    updateBar();
  }

  function groupEl(type, name, list) {
    const sec = el("section", "grp");
    const head = el("div", "grp-head");
    const all = checkbox(list.every((i) => selected.has(i.key)));
    all.setAttribute("aria-label", `Select all in ${name}`);
    all.addEventListener("change", () => {
      for (const i of list) (all.checked ? selected.add(i.key) : selected.delete(i.key));
      sec.querySelectorAll(".row input").forEach((c) => (c.checked = all.checked));
      updateBar();
    });
    const edit = button("Change all", "hbtn small", "fa-user-lock");
    edit.addEventListener("click", () => openShare(list.map((i) => i.key), list[0]));
    const title = type === "video" ? ui.prettyName(name) : name;
    head.append(all, el("span", "grp-title", title), el("span", "grp-count", `${list.length}`), edit);
    sec.append(head);

    for (const i of list) {
      const row = el("div", "row");
      const cb = checkbox(selected.has(i.key));
      cb.addEventListener("change", () => {
        (cb.checked ? selected.add(i.key) : selected.delete(i.key));
        all.checked = list.every((x) => selected.has(x.key));
        updateBar();
      });
      const one = button("Edit", "hbtn small");
      one.addEventListener("click", () => openShare([i.key], i));
      const title = i.type === "video"
        ? Object.assign(el("a", "row-name", ui.prettyName(i.name)), { href: `/watch?v=${enc(i.id)}` })
        : el("span", "row-name", i.type === "song" ? i.name : ui.prettyName(i.name));
      row.append(cb, title, badge(i));
      if (i.type === "video") {
        const media = el("span", "media-codecs");
        if (!i.media) {
          const detect = button("Detect", "hbtn small", "fa-wand-magic-sparkles");
          detect.title = "Detect codecs and convert this video if needed";
          detect.addEventListener("click", async () => {
            detect.disabled = true;
            detect.querySelector("span").textContent = "Detecting…";
            try {
              await api("POST", `/api/videos/${enc(i.id)}/detect`);
              await waitForMedia(i.id);
            } catch (err) {
              notify(err.message);
              detect.disabled = false;
              detect.querySelector("span").textContent = "Detect";
            }
          });
          media.append(detect);
        } else if (i.media.status === "processing") {
          media.textContent = "Detecting and converting…";
        } else if (i.media.status === "failed") {
          media.textContent = `Detection failed: ${i.media.error || "Unknown error"}`;
          media.classList.add("error");
          const retry = button("Retry", "hbtn small", "fa-rotate-right");
          retry.addEventListener("click", async () => {
            retry.disabled = true;
            try {
              await api("POST", `/api/videos/${enc(i.id)}/detect`);
              await waitForMedia(i.id);
            } catch (err) {
              notify(err.message);
              retry.disabled = false;
            }
          });
          media.append(" ", retry);
        } else {
          const videoCodec = i.media.videoCodec || "no video";
          const audioCodec = i.media.audioCodec || "no audio";
          media.textContent = `Video: ${videoCodec} · Audio: ${audioCodec}${i.media.normalized ? " · Converted" : ""}`;
          if (i.media.compatible) media.classList.add("safe");
        }
        row.append(media);

        const rename = button("Rename", "hbtn small");
        rename.addEventListener("click", async () => {
          const title = await window.askText({ title: "Rename video", label: "Title", value: i.name, okText: "Save title" });
          if (!title || title === i.name) return;
          try {
            await api("PATCH", `/api/videos/${enc(i.id)}`, { title });
            await loadUploads();
          } catch (err) { notify(err.message); }
        });
        row.append(rename);
      }
      row.append(one);
      sec.append(row);
    }
    return sec;
  }

  async function waitForMedia(videoId) {
    for (let attempts = 0; attempts < 240; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const refreshed = (await api("GET", "/api/mine")).items;
      const video = refreshed.find((item) => item.type === "video" && item.id === videoId);
      if (!video?.media || video.media.status === "processing") continue;
      await loadUploads();
      if (video.media.status === "failed") notify(`Conversion failed: ${video.media.error || "Unknown error"}`);
      else if (video.media.normalized) notify("Converted for browser playback. The original is in Old.");
      else notify("Codecs detected: this file already plays in browsers.");
      return;
    }
    notify("Conversion is still running. Refresh this page later to check it.");
  }

  $("selAll").addEventListener("click", () => { items.forEach((i) => selected.add(i.key)); renderUploads(); });
  $("selNone").addEventListener("click", () => { selected.clear(); renderUploads(); });
  $("selEdit").addEventListener("click", () => {
    const keys = [...selected];
    openShare(keys, items.find((i) => i.key === keys[0]));
  });

  // ---------- Sharing dialog ----------
  const dlg = $("shareDlg");
  let shareKeys = [];

  function syncPeople() {
    $("shPeople").hidden = dlg.querySelector('input[name="shWho"]:checked').value !== "shared";
  }

  function openShare(keys, first) {
    shareKeys = keys;
    $("shareTitle").textContent = keys.length > 1 ? `Who can see these ${keys.length} items?` : "Who can see this?";
    $("shError").textContent = "";
    dlg.querySelector(`input[name="shWho"][value="${first?.visibility || "private"}"]`).checked = true;

    const box = $("shPeople");
    box.replaceChildren();
    if (!people.length) box.append(el("span", "mg-hint", "There’s nobody else to share with yet."));
    for (const p of people) {
      const label = el("label");
      const cb = checkbox(first?.shared?.includes(p.id));
      cb.value = p.id;
      label.append(cb, window.accountUi.avatar(p), el("span", null, p.name));
      box.append(label);
    }
    syncPeople();
    dlg.showModal();
  }

  dlg.querySelectorAll('input[name="shWho"]').forEach((r) => r.addEventListener("change", syncPeople));
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  $("shCancel").addEventListener("click", () => dlg.close());
  $("shareForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const visibility = dlg.querySelector('input[name="shWho"]:checked').value;
    const shared = [...$("shPeople").querySelectorAll("input:checked")].map((c) => c.value);
    if (visibility === "shared" && !shared.length) {
      $("shError").textContent = "Pick at least one person, or choose Only me.";
      return;
    }
    try {
      const r = await api("POST", "/api/access", { keys: shareKeys, visibility, shared });
      dlg.close();
      notify(`Updated ${r.updated} item${r.updated === 1 ? "" : "s"}.`);
      await loadUploads();
    } catch (err) {
      $("shError").textContent = err.message;
    }
  });

  // ---------- Playlists ----------
  async function loadPlaylists() {
    const root = $("playlistList");
    const { playlists } = await api("GET", "/api/playlists");
    root.replaceChildren();
    if (!playlists.length) {
      root.append(el("p", "mg-empty", "No saved playlists yet. Use the bookmark button in the video player, or the + beside a song."));
      return;
    }
    const details = await Promise.all(playlists.map((p) => api("GET", `/api/playlists/${enc(p.id)}?detail=1`)));
    for (const d of details) root.append(playlistEl(d));
  }

  function playlistEl(d) {
    const card = el("section", "pl");
    const head = el("div", "pl-head");
    head.tabIndex = 0;
    head.setAttribute("role", "link");
    head.setAttribute("aria-label", `Manage playlist ${d.name}`);
    const openWorkspace = () => { location.href = `/manage/${enc(d.id)}`; };
    head.addEventListener("click", openWorkspace);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openWorkspace(); }
    });
    head.append(el("h3", null, d.name), el("span", "pl-kind", `${d.kind === "video" ? "Videos" : "Songs"} · ${d.items.length}`));

    if (d.items.length) {
      const first = d.items[0].id;
      const play = el("a", "hbtn small");
      play.href = d.kind === "video"
        ? `/watch?v=${enc(first)}&list=${enc(d.id)}`
        : `/listen?v=${enc(first)}&p=${enc(`up-${d.id}`)}`;
      play.innerHTML = '<i class="fa-solid fa-play"></i><span>Play</span>';
      play.addEventListener("click", event => event.stopPropagation());
      head.append(play);
    }
    const manage = button("Manage list", "hbtn small", "fa-sliders");
    manage.addEventListener("click", (event) => { event.stopPropagation(); openWorkspace(); });
    const collapse = button("", "hbtn small pl-collapse", "fa-chevron-down");
    collapse.setAttribute("aria-label", "Expand playlist preview");
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      setPlaylistCollapsed(card, collapse, !card.classList.contains("is-collapsed"));
    });
    const rename = button("Rename");
    rename.addEventListener("click", async () => {
      const name = await window.askText({ title: "Rename playlist", label: "Name", value: d.name, okText: "Rename" });
      if (!name) return;
      try { await api("PATCH", `/api/playlists/${enc(d.id)}`, { name }); await loadPlaylists(); } catch (err) { notify(err.message); }
    });
    const del = button("Delete", "hbtn small btn-danger");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete the playlist “${d.name}”? The videos or songs in it are not deleted.`)) return;
      try { await api("DELETE", `/api/playlists/${enc(d.id)}`); await loadPlaylists(); } catch (err) { notify(err.message); }
    });
    rename.addEventListener("click", event => event.stopPropagation());
    del.addEventListener("click", event => event.stopPropagation());
    head.append(manage, collapse, rename, del);
    card.append(head);

    if (d.items.length) {
      const ul = el("ul", "pl-items");
      for (const it of d.items) {
        const li = el("li");
        const label = d.kind === "video"
          ? [ui.prettyName(it.name), it.show ? ui.prettyName(it.show) : ""].filter(Boolean).join(" · ")
          : [it.name, it.artist].filter(Boolean).join(" · ");
        const rm = button("Remove");
        rm.addEventListener("click", async () => {
          try { await api("DELETE", `/api/playlists/${enc(d.id)}/items/${enc(it.id)}`); await loadPlaylists(); } catch (err) { notify(err.message); }
        });
        li.append(el("span", "row-name", label), rm);
        ul.append(li);
      }
      card.append(ul);
    }
    card.classList.add("is-collapsed");
    return card;
  }

  function setPlaylistCollapsed(card, control, collapsed) {
    card.classList.toggle("is-collapsed", collapsed);
    control.setAttribute("aria-label", collapsed ? "Expand playlist preview" : "Collapse playlist preview");
    control.querySelector("i").className = `fa-solid fa-chevron-${collapsed ? "down" : "up"}`;
  }

  function collapsePlaylists() {
    document.querySelectorAll(".pl").forEach((card) => {
      const control = card.querySelector(".pl-collapse");
      if (control) setPlaylistCollapsed(card, control, true);
    });
  }

  window.addEventListener("scroll", () => {
    const currentY = window.scrollY;
    if (activeTab === "playlists" && currentY < lastScrollY) collapsePlaylists();
    lastScrollY = currentY;
  }, { passive: true });

  // ---------- Account ----------
  function renderAccount() {
    const box = $("whoAmI");
    box.replaceChildren(window.accountUi.avatar(me));
    const info = el("div");
    info.append(el("strong", null, me.name), el("span", null, me.isAdmin ? "Admin" : "Member"));
    box.append(info);
    return Promise.resolve();
  }

  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("pwMsg");
    msg.style.color = "";
    if ($("pwNew").value !== $("pwNew2").value) { msg.textContent = "The new passwords don’t match."; return; }
    try {
      await api("POST", "/api/auth/password", { current: $("pwCur").value, next: $("pwNew").value });
      $("pwForm").reset();
      msg.style.color = "#6fdc8c";
      msg.textContent = "Password changed. Other devices were signed out.";
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // ---------- People (admin) ----------
  COLORS.forEach((c, i) => {
    const label = el("label");
    const r = el("input");
    r.type = "radio"; r.name = "addColor"; r.value = c; r.checked = i === 0;
    const a = window.accountUi?.avatar({ name: "A", color: c }) || el("span", "avatar");
    label.append(r, a);
    $("addColors").append(label);
  });

  async function loadPeople() {
    const { accounts } = await api("GET", "/api/admin/accounts");
    const root = $("peopleList");
    root.replaceChildren();
    for (const a of accounts) {
      const row = el("div", "person");
      row.append(window.accountUi.avatar(a), el("span", "person-name", a.name));
      if (a.isAdmin) row.append(el("span", "badge shared", a.primary ? "Main admin" : "Admin"));

      const reset = button("Reset password");
      reset.addEventListener("click", async () => {
        const password = await window.askText({ title: `New password for ${a.name}`, label: "Password", type: "password", okText: "Set password" });
        if (!password) return;
        try { await api("POST", `/api/admin/accounts/${enc(a.id)}/password`, { password }); notify(`Password changed for ${a.name}.`); }
        catch (err) { notify(err.message); }
      });
      row.append(reset);

      if (!a.primary && a.id !== me.id) {
        const del = button("Delete", "hbtn small btn-danger");
        del.addEventListener("click", async () => {
          if (!confirm(`Delete ${a.name}? Their uploads are kept and passed to you as private; their playlists are removed.`)) return;
          try { await api("DELETE", `/api/admin/accounts/${enc(a.id)}`); notify(`${a.name} was deleted.`); await loadPeople(); }
          catch (err) { notify(err.message); }
        });
        row.append(del);
      }
      root.append(row);
    }
    people = accounts.filter((a) => a.id !== me.id);
  }

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("addMsg");
    msg.style.color = "";
    try {
      await api("POST", "/api/admin/accounts", {
        name: $("addName").value,
        password: $("addPass").value,
        color: document.querySelector('input[name="addColor"]:checked')?.value,
        isAdmin: $("addAdmin").checked,
      });
      $("addForm").reset();
      msg.style.color = "#6fdc8c";
      msg.textContent = "Added.";
      await loadPeople();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  // Back key (remote / Esc) leaves the page.
  document.addEventListener("keydown", (e) => {
    if (dlg.open || e.target.matches?.("input")) return;
    if (ui.isBack(e) && !document.querySelector(".modal[open]")) { e.preventDefault(); location.href = "/"; }
  });
})();
