// Account button + menu for pages that have an #accountSlot, and the redirect
// to the sign-in page when the session has ended. Exposes:
//   window.accountReady  Promise<account | null>
//   window.accountUi.avatar(account, size?)  -> element
(() => {
  "use strict";

  const enc = encodeURIComponent;

  function avatar(account, size) {
    const a = document.createElement("span");
    a.className = "avatar";
    a.style.setProperty("--c", account.color || "#f0344a");
    if (size) a.style.setProperty("--s", size);
    a.textContent = (String(account.name).trim()[0] || "?").toUpperCase();
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  window.accountUi = { avatar };

  function item(tag, icon, label, attrs = {}) {
    const el = document.createElement(tag);
    el.setAttribute("role", "menuitem");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    el.querySelector("span").textContent = label;
    return el;
  }

  function render(account) {
    const slot = document.getElementById("accountSlot");
    if (!slot) return;

    const here = location.pathname + location.search;
    const wrap = document.createElement("div");
    wrap.className = "acct";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "acct-btn";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.append(avatar(account));
    const name = document.createElement("span");
    name.className = "acct-name";
    name.textContent = account.name;
    btn.append(name);

    const menu = document.createElement("div");
    menu.className = "acct-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const who = document.createElement("div");
    who.className = "acct-who";
    who.textContent = `Signed in as ${account.name}${account.isAdmin ? " (admin)" : ""}`;
    const out = item("button", "fa-right-from-bracket", "Sign out", { type: "button" });
    menu.append(
      who,
      item("a", "fa-folder-open", "My space", { href: "/manage" }),
      item("a", "fa-bookmark", "My playlists", { href: "/manage#playlists" }),
      item("a", "fa-users", "Channels", { href: "/channels" }),
      document.createElement("hr"),
      item("a", "fa-repeat", "Switch account", { href: `/login?switch=1&next=${enc(here)}` }),
      out,
    );

    const close = (refocus) => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (refocus) btn.focus({ preventScroll: true });
    };
    btn.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("a,button")?.focus({ preventScroll: true });
    });
    out.addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
      location.href = "/login";
    });
    document.addEventListener("pointerdown", (e) => { if (!wrap.contains(e.target)) close(false); });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { e.stopPropagation(); close(true); }
    });

    wrap.append(btn, menu);
    slot.replaceChildren(wrap);
  }

  window.accountReady = (async () => {
    // The sign-in page itself is where signed-out people are sent: checking
    // the session here would redirect /login to /login forever.
    if (/^\/login(\.html)?$/.test(location.pathname)) return null;

    let r;
    try { r = await fetch("/api/auth/me"); } catch { return null; }
    if (r.status === 401) {
      location.href = `/login?next=${enc(location.pathname + location.search)}`;
      return null;
    }
    if (!r.ok) return null;
    const { account } = await r.json();
    window.currentAccount = account;
    render(account);
    return account;
  })();
})();
