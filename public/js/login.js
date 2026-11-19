(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ui = window.ui;
  const params = new URLSearchParams(location.search);
  const switching = params.has("switch");

  // Only ever go back to a page on this site.
  const rawNext = params.get("next") || "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") && !/^\/login(\b|\.)/.test(rawNext) ? rawNext : "/";

  const COLORS = ["#f0344a", "#ff9f1c", "#2ec4b6", "#3a86ff", "#8338ec", "#ff006e", "#80b918", "#fb5607"];
  let state = null;
  let picked = null;
  let lockTimer = null;
  let locked = false;

  const post = (url, body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    try {
      state = await (await fetch("/api/auth/state")).json();
    } catch {
      $("lgTitle").textContent = "Can’t reach the server";
      $("lgSub").textContent = "Check that it is running, then reload.";
      return;
    }
    if (state.setup) return showSetup();
    render();
  }

  // ---------- Profile picker ----------
  function render() {
    $("lgTitle").textContent = switching ? "Switch account" : "Who’s watching?";
    $("lgSub").textContent = switching ? "You’ll need the password of the account you switch to." : "";

    const grid = $("profiles");
    grid.replaceChildren();
    for (const a of state.accounts) {
      const isMe = state.me?.id === a.id;
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = `tile${isMe ? " current" : ""}`;
      tile.dataset.id = a.id;
      tile.append(window.accountUi.avatar(a));
      const name = document.createElement("span");
      name.className = "tile-name";
      name.textContent = a.name;
      tile.append(name);
      if (isMe) {
        const sub = document.createElement("span");
        sub.className = "tile-sub";
        sub.textContent = "Signed in";
        tile.append(sub);
      }
      tile.addEventListener("click", () => (isMe ? (location.href = next) : openPassword(a)));
      grid.appendChild(tile);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "tile add";
    const plus = document.createElement("span");
    plus.className = "avatar";
    plus.innerHTML = '<i class="fa-solid fa-plus"></i>';
    const addName = document.createElement("span");
    addName.className = "tile-name";
    addName.textContent = "Create account";
    add.append(plus, addName);
    add.addEventListener("click", openAdd);
    grid.appendChild(add);

    const footer = $("lgFooter");
    footer.replaceChildren();
    if (state.me) {
      const back = document.createElement("a");
      back.className = "hbtn";
      back.href = next;
      back.textContent = "Cancel";
      const out = document.createElement("button");
      out.type = "button";
      out.className = "hbtn";
      out.textContent = "Sign out";
      out.addEventListener("click", async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        location.href = "/login";
      });
      footer.append(back, out);
      footer.hidden = false;
    }

    (grid.querySelector(".tile.current") || grid.querySelector(".tile"))?.focus({ preventScroll: true });
  }

  // ---------- Password prompt (every switch needs it) ----------
  const dlg = $("pwDlg");

  function openPassword(account) {
    picked = account;
    $("pwAvatar").replaceChildren(window.accountUi.avatar(account));
    $("pwName").textContent = account.name;
    $("pwInput").value = "";
    $("pwError").textContent = "";
    $("pwOk").disabled = false;
    dlg.showModal();
    $("pwInput").focus();
  }

  function lockout(seconds) {
    clearInterval(lockTimer);
    let left = seconds;
    locked = true;
    $("pwOk").disabled = true;
    const tick = () => {
      if (left <= 0) {
        clearInterval(lockTimer);
        locked = false;
        $("pwOk").disabled = false;
        $("pwError").textContent = "";
        return;
      }
      $("pwError").textContent = `Too many attempts. Try again in ${left}s.`;
      left -= 1;
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!picked || $("pwOk").disabled) return;
    $("pwOk").disabled = true;
    $("pwError").textContent = "";
    try {
      const r = await post("/api/auth/login", { accountId: picked.id, password: $("pwInput").value });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        location.href = next;
        return;
      }
      if (r.status === 429) return lockout(body.retryAfter || 30);
      $("pwError").textContent = body.error || "Couldn’t sign in.";
      $("pwInput").select();
    } catch {
      $("pwError").textContent = "Can’t reach the server.";
    }
    if (!locked) $("pwOk").disabled = false;
  });

  $("pwCancel").addEventListener("click", () => dlg.close());
  dlg.addEventListener("keydown", (e) => e.stopPropagation()); // typing must not trigger page navigation
  dlg.addEventListener("close", () => { picked = null; locked = false; clearInterval(lockTimer); });

  // ---------- Create an account (open to everyone) ----------
  const addDlg = $("addDlg");

  COLORS.forEach((c, i) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "adColor";
    radio.value = c;
    radio.checked = i === 0;
    label.append(radio, window.accountUi.avatar({ name: "A", color: c }));
    $("adColors").appendChild(label);
  });

  function openAdd() {
    $("addForm").reset();
    $("adError").textContent = "";
    addDlg.showModal();
    $("adName").focus();
  }

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("adError").textContent = "";
    if ($("adNewPass").value !== $("adNewPass2").value) {
      $("adError").textContent = "The passwords don’t match.";
      return;
    }
    $("adOk").disabled = true;
    try {
      const r = await post("/api/auth/signup", {
        name: $("adName").value,
        password: $("adNewPass").value,
        color: document.querySelector('input[name="adColor"]:checked')?.value,
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        location.href = next; // already signed in as the new account
        return;
      }
      $("adError").textContent = body.error || "Couldn’t create the account.";
    } catch {
      $("adError").textContent = "Can’t reach the server.";
    }
    $("adOk").disabled = false;
  });
  $("adCancel").addEventListener("click", () => addDlg.close());
  addDlg.addEventListener("keydown", (e) => e.stopPropagation());

  // ---------- First run: create the main account ----------
  function showSetup() {
    $("lgTitle").textContent = "Welcome";
    $("lgSub").textContent = "Create the main account. Everything already on this server will belong to it.";
    $("setupForm").hidden = false;
    $("suPass").focus();

    $("setupForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("suError");
      err.textContent = "";
      if ($("suPass").value !== $("suPass2").value) { err.textContent = "The passwords don’t match."; return; }
      try {
        const r = await post("/api/auth/setup", { name: $("suName").value, password: $("suPass").value });
        const body = await r.json().catch(() => ({}));
        if (r.ok) { location.href = next; return; }
        err.textContent = body.error || "Couldn’t create the account.";
      } catch {
        err.textContent = "Can’t reach the server.";
      }
    });
  }

  // ---------- Remote / keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]") || e.altKey || e.ctrlKey || e.metaKey || e.target.matches?.("input")) return;
    const dir = ui?.DIRS[e.key];
    if (dir && ui.move(dir, document.body, () => document.querySelector(".tile"))) e.preventDefault();
  });
})();
