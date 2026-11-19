// Shared dialogs used by several pages:
//   askText({ title, label, value, type, okText })  -> Promise<string | null>
//   playlistPicker.open({ anchor, kind: "video" | "song", itemId, onChange })
(() => {
  "use strict";

  const enc = encodeURIComponent;
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const notify = (m) => window.deviceControl?.notify?.(m);
  const call = (method, url, body) =>
    fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  const errorOf = async (r) => { try { return (await r.json()).error; } catch { return null; } };
  const host = () => document.fullscreenElement || document.body; // visible even in fullscreen

  // ---------- Text prompt ----------
  function askText({ title, label = "", value = "", type = "text", okText = "OK", placeholder = "" }) {
    return new Promise((resolve) => {
      const dlg = el("dialog", "modal");
      dlg.innerHTML =
        '<form><h2></h2><label class="field"><span class="m-label"></span><input class="m-input" maxlength="120" autocomplete="off"></label>' +
        '<p class="m-error" role="alert"></p>' +
        '<div class="m-actions"><button type="button" class="hbtn m-cancel">Cancel</button><button type="submit" class="hbtn btn-primary m-ok"></button></div></form>';
      const q = (s) => dlg.querySelector(s);
      const input = q(".m-input");
      q("h2").textContent = title;
      q(".m-label").textContent = label;
      q(".m-ok").textContent = okText;
      input.type = type;
      input.value = value;
      input.placeholder = placeholder;

      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
      dlg.addEventListener("keydown", (e) => e.stopPropagation()); // page shortcuts must not fire while typing
      q(".m-cancel").addEventListener("click", () => finish(null));
      q("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const v = type === "password" ? input.value : input.value.trim();
        if (!v) { q(".m-error").textContent = "Please enter something."; return; }
        finish(v);
      });
      host().appendChild(dlg);
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  // ---------- "Save to playlist" popover ----------
  let current = null;

  function close() {
    if (!current) return;
    document.removeEventListener("pointerdown", current.outside, true);
    current.pop.remove();
    current.anchor?.focus?.({ preventScroll: true });
    current = null;
  }

  function place(pop, anchor) {
    const r = anchor?.getBoundingClientRect?.() || { right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2 };
    const w = pop.offsetWidth;
    pop.style.left = `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px`;
    if (r.top > innerHeight / 2) pop.style.bottom = `${innerHeight - r.top + 8}px`;
    else pop.style.top = `${r.bottom + 8}px`;
  }

  async function open({ anchor, kind, itemId, onChange }) {
    close();
    const pop = el("div", "pk",
      '<div class="pk-title">Save to playlist</div><div class="pk-list"></div>' +
      '<button type="button" class="pk-row pk-new"><i class="fa-solid fa-plus pk-check"></i><span class="pk-name">New playlist</span></button>');
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Save to playlist");
    host().appendChild(pop);
    place(pop, anchor);
    const list = pop.querySelector(".pk-list");

    const outside = (e) => {
      if (pop.contains(e.target) || anchor?.contains?.(e.target) || e.target.closest?.(".modal")) return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    current = { pop, anchor, outside };

    // The page underneath (video / music player) must not react to clicks or keys in here.
    for (const t of ["click", "pointerdown", "pointerup", "dblclick"]) pop.addEventListener(t, (e) => e.stopPropagation());
    pop.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (window.ui?.isBack(e) || e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = [...pop.querySelectorAll(".pk-row:not(:disabled)")];
        const i = rows.indexOf(document.activeElement);
        rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
    });

    const addRow = (p) => {
      const b = el("button", "pk-row", '<i class="fa-solid fa-check pk-check"></i><span class="pk-name"></span><span class="pk-count"></span>');
      b.type = "button";
      b.classList.toggle("on", Boolean(p.contains));
      b.querySelector(".pk-name").textContent = p.name;
      const count = b.querySelector(".pk-count");
      count.textContent = p.count;
      b.addEventListener("click", async () => {
        const on = b.classList.contains("on");
        b.disabled = true;
        const r = on
          ? await call("DELETE", `/api/playlists/${enc(p.id)}/items/${enc(itemId)}`)
          : await call("POST", `/api/playlists/${enc(p.id)}/items`, { item: itemId });
        b.disabled = false;
        if (!r.ok) { notify((await errorOf(r)) || "Couldn’t update the playlist"); return; }
        b.classList.toggle("on", !on);
        p.count += on ? -1 : 1;
        count.textContent = p.count;
        onChange?.();
        b.focus();
      });
      list.appendChild(b);
    };

    try {
      const r = await call("GET", `/api/playlists?kind=${enc(kind)}&item=${enc(itemId)}`);
      const { playlists } = await r.json();
      if (!playlists.length) list.appendChild(el("div", "pk-empty", "No playlists yet."));
      playlists.forEach(addRow);
    } catch {
      list.appendChild(el("div", "pk-empty", "Couldn’t load your playlists."));
    }

    pop.querySelector(".pk-new").addEventListener("click", async () => {
      const name = await askText({ title: "New playlist", label: "Name", okText: "Create and save" });
      if (!name) return;
      const r = await call("POST", "/api/playlists", { name, kind, item: itemId });
      if (!r.ok) { notify((await errorOf(r)) || "Couldn’t create the playlist"); return; }
      const { playlist } = await r.json();
      list.querySelector(".pk-empty")?.remove();
      addRow({ id: playlist.id, name: playlist.name, count: 1, contains: true });
      onChange?.();
    });

    (pop.querySelector(".pk-list .pk-row") || pop.querySelector(".pk-new")).focus({ preventScroll: true });
  }

  window.askText = askText;
  window.playlistPicker = { open, close };
})();
