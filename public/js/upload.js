(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const dlg = $("uploadDialog");
  if (!dlg || !$("uploadBtn")) return;

  const EXT_VIDEO = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".wmv", ".flv", ".ts", ".m2ts"]);
  const EXT_AUDIO = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".oga", ".opus", ".weba"]);
  const ACCEPT_VIDEO = "video/*,.mkv,.avi,.wmv,.flv,.ts,.m2ts";
  const ACCEPT_AUDIO = "audio/*,.flac,.opus,.oga,.weba,.m4a";
  const extOf = (n) => (n.lastIndexOf(".") < 0 ? "" : n.slice(n.lastIndexOf(".")).toLowerCase());

  let items = []; // { file, li, bar, state, status: pending|uploading|done|error }
  let busy = false;
  let cancelled = false;
  let xhr = null;

  const kind = () => document.querySelector('input[name="upKind"]:checked').value;
  const source = () => document.querySelector('input[name="upSource"]:checked')?.value || "";
  const exts = () => (kind() === "song" ? EXT_AUDIO : EXT_VIDEO);
  const who = () => document.querySelector('input[name="upWho"]:checked')?.value || "private";
  const sharedIds = () => [...document.querySelectorAll("#upPeople input:checked")].map((c) => c.value);
  const trims = () => kind() === "short" && source() !== "other";
  const setMsg = (t) => ($("upMsg").textContent = t);

  function fmtSize(b) {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function refreshControls() {
    const pending = items.some((i) => i.status === "pending" || i.status === "error");
    $("upStart").disabled = busy ? false : !pending;
    $("upStart").querySelector("span").textContent = busy ? "Cancel" : "Upload";
    $("upStart").querySelector("i").className = busy ? "fa-solid fa-ban" : "fa-solid fa-upload";
    $("upClear").disabled = busy;
    $("upClose").disabled = busy;
    $("upFiles").disabled = busy;
    $("upShow").disabled = busy;
    $("upPlaylist").disabled = busy;
    document.querySelectorAll('input[name="upKind"], input[name="upSource"], input[name="upWho"], #upPeople input').forEach((r) => (r.disabled = busy));
  }

  function syncKind() {
    $("upShowWrap").hidden = kind() !== "show";
    $("upPlaylistWrap").hidden = kind() !== "song";
    $("upSourceWrap").hidden = kind() !== "short";
    const song = kind() === "song";
    $("upFiles").accept = song ? ACCEPT_AUDIO : ACCEPT_VIDEO;
    $("upDropText").textContent = song ? "Drop audio files here" : "Drop video files here";
  }

  function setStatus(item, status, text, pct) {
    item.status = status;
    item.li.classList.toggle("done", status === "done");
    item.li.classList.toggle("err", status === "error");
    item.state.textContent = text;
    if (pct != null) item.bar.style.width = `${pct}%`;
  }

  function addFiles(fileList) {
    const rejected = [];
    for (const file of fileList) {
      if (!exts().has(extOf(file.name))) { rejected.push(file.name); continue; }
      if (items.some((i) => i.file.name === file.name && i.file.size === file.size)) continue;

      const li = document.createElement("li");
      li.className = "up-item";
      li.innerHTML = '<span class="up-name"></span><span class="up-state"></span><span class="up-bar"><i></i></span>';
      li.querySelector(".up-name").textContent = file.name;
      li.querySelector(".up-name").title = file.name;
      $("upList").appendChild(li);

      const item = { file, li, bar: li.querySelector(".up-bar i"), state: li.querySelector(".up-state"), status: "pending" };
      setStatus(item, "pending", fmtSize(file.size), 0);
      items.push(item);
    }
    setMsg(rejected.length ? `Skipped (not a supported ${kind() === "song" ? "audio" : "video"} type): ${rejected.join(", ")}` : "");
    refreshControls();
  }

  function params(file) {
    const p = new URLSearchParams({ kind: kind(), filename: file.name });
    if (kind() === "show") p.set("show", $("upShow").value.trim());
    p.set("visibility", who());
    if (who() === "shared") p.set("shared", sharedIds().join(","));
    if (kind() === "short") p.set("source", source());
    if (kind() === "song") p.set("playlist", $("upPlaylist").value.trim());
    return p.toString();
  }

  async function preflight(file) {
    const r = await fetch(`/api/upload/check?${params(file)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  }

  function send(item) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload?${params(item.file)}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        if (e.loaded >= e.total) {
          // Bytes are all sent; the server is now normalizing the media for browser playback.
          return setStatus(item, "uploading", trims() ? "Trimming and converting…" : "Converting for playback…", 100);
        }
        const pct = (e.loaded / e.total) * 100;
        setStatus(item, "uploading", `${Math.floor(pct)}% · ${fmtSize(e.loaded)} / ${fmtSize(e.total)}`, pct);
      };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        reject(new Error(body.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.onabort = () => reject(new Error("Cancelled"));
      xhr.send(item.file);
    });
  }

  async function start() {
    if (kind() === "show" && !$("upShow").value.trim()) {
      setMsg("Enter a show name first.");
      $("upShow").focus();
      return;
    }
    if (kind() === "short" && !source()) {
      setMsg("Choose where the short is from (TikTok, Instagram or Other).");
      return;
    }

    if (who() === "shared" && !sharedIds().length) {
      setMsg("Pick at least one person, or choose Only me.");
      return;
    }

    busy = true;
    cancelled = false;
    setMsg("");
    refreshControls();

    const uploadedKind = kind();
    let ok = 0;
    for (const item of items) {
      if (cancelled) break;
      if (item.status === "done") continue;
      try {
        setStatus(item, "uploading", "Checking…", 0);
        await preflight(item.file);
        const r = await send(item);
        const detail = `${r.converted ? " · converted for browser playback" : ""}${r.trimmed ? ` · last ${r.trimmedSeconds}s trimmed` : r.note ? ` · ${r.note}` : ""}`;
        setStatus(item, "done", `Done${detail}`, 100);
        ok++;
      } catch (err) {
        setStatus(item, "error", err.message, 0);
      }
    }

    busy = false;
    xhr = null;
    refreshControls();

    // Shorts and songs are read from disk on demand; only the video library needs a rescan.
    if (ok && (uploadedKind === "movie" || uploadedKind === "show")) {
      try { await fetch("/api/rescan", { method: "POST" }); } catch {}
    }
    const failed = items.filter((i) => i.status === "error").length;
    setMsg(
      cancelled ? "Upload cancelled." :
      failed ? `${ok} uploaded, ${failed} failed. Fix the issue and press Upload to retry the failed ones.` :
      uploadedKind === "short" ? `${ok} short${ok === 1 ? "" : "s"} uploaded. Open Shorts to watch.` :
      uploadedKind === "song" ? `${ok} song${ok === 1 ? "" : "s"} uploaded. Open Music to listen.` :
      `${ok} file${ok === 1 ? "" : "s"} uploaded. Thumbnails will generate in the background.`,
    );
  }

  function syncWho() {
    $("upPeople").hidden = who() !== "shared";
    try { localStorage.setItem("media-server-upload-who", who()); } catch {}
  }

  async function loadPeople() {
    const box = $("upPeople");
    try {
      const { me, accounts } = await (await fetch("/api/accounts")).json();
      const checked = new Set(sharedIds());
      box.replaceChildren();
      for (const a of accounts.filter((x) => x.id !== me)) {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = a.id;
        cb.checked = checked.has(a.id);
        const name = document.createElement("span");
        name.textContent = a.name;
        label.append(cb);
        if (window.accountUi) label.append(window.accountUi.avatar(a));
        label.append(name);
        box.appendChild(label);
      }
      if (!box.children.length) box.textContent = "There’s nobody else to share with yet.";
    } catch {}
  }

  async function openDialog() {
    try {
      const last = localStorage.getItem("media-server-upload-who");
      const radio = last && document.querySelector(`input[name="upWho"][value="${last}"]`);
      if (radio) radio.checked = true;
    } catch {}
    await loadPeople();
    syncWho();
    try {
      const { playlists = [] } = await (await fetch("/api/songs")).json();
      $("upPlaylistList").innerHTML = "";
      for (const p of playlists) {
        if (p.id === "all" || p.id === "singles") continue; // virtual: not folders
        const o = document.createElement("option");
        o.value = p.name;
        $("upPlaylistList").appendChild(o);
      }
    } catch {}
    try {
      const lib = await (await fetch("/api/library")).json();
      $("upShowList").innerHTML = "";
      for (const s of lib.shows || []) {
        const o = document.createElement("option");
        o.value = s.name;
        $("upShowList").appendChild(o);
      }
    } catch {}
    dlg.showModal();
  }

  function reset() {
    items = [];
    $("upList").innerHTML = "";
    setMsg("");
    refreshControls();
  }

  // Arrow keys inside the dialog must not drive the page's spatial navigation.
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });

  $("uploadBtn").addEventListener("click", openDialog);
  $("upClose").addEventListener("click", () => dlg.close());
  $("upClear").addEventListener("click", reset);
  $("upStart").addEventListener("click", () => {
    if (busy) { cancelled = true; xhr?.abort(); } else start();
  });
  $("upFiles").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  document.querySelectorAll('input[name="upKind"]').forEach((r) => r.addEventListener("change", syncKind));
  document.querySelectorAll('input[name="upWho"]').forEach((r) => r.addEventListener("change", syncWho));

  const drop = $("upDrop");
  for (const t of ["dragenter", "dragover"]) {
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const t of ["dragleave", "drop"]) {
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => { if (!busy) addFiles(e.dataTransfer.files); });

  syncKind();
  refreshControls();
})();
