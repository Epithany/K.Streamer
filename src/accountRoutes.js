const fs = require("fs/promises");
const path = require("path");

const accounts = require("./accounts");
const access = require("./access");
const playlists = require("./playlistStore");
const log = require("./logger").for("auth");
const { SHORTS_DIR } = require("./config");

const { AuthError } = accounts;
const { keys } = access;

const enc = encodeURIComponent;
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Gate: nothing is served to someone who isn't signed in ----------
const PUBLIC_API = [/^\/api\/auth\//, /^\/api\/device\//, /^\/api\/log$/];

function gate(req, res, next) {
  if (req.account) return next();
  const p = req.path;
  if (PUBLIC_API.some((re) => re.test(p))) return next();
  if (p.startsWith("/api/") || p.startsWith("/stream/") || p.startsWith("/thumbnails/")) {
    return res.status(401).json({ error: "Sign in required" });
  }
  // Pages (not scripts/styles/fonts): send to the account picker, then back.
  const isPage = p === "/" || p.endsWith(".html") || !path.extname(p);
  if (isPage && p !== "/login" && p !== "/login.html") {
    return res.redirect(302, `/login?next=${enc(req.originalUrl)}`);
  }
  next();
}

// Cover + preview images are named after the video id; check the viewer may see it.
function thumbnailGuard(library) {
  return (req, res, next) => {
    const m = /^\/(?:previews\/([A-Za-z0-9_-]+)-\d{2}|([A-Za-z0-9_-]+))\.webp$/.exec(req.path);
    const video = m && library.findVideo(m[1] || m[2]);
    if (!video || !access.canView(req.account, keys.video(video.relativePath))) return res.status(404).end();
    next();
  };
}

function install(app, { library, shortsStore, songsStore, mediaNormalizationQueue }) {
  const requireLogin = (req, res, next) =>
    req.account ? next() : res.status(401).json({ error: "Sign in required" });
  const requireAdmin = (req, res, next) =>
    req.account?.isAdmin ? next() : res.status(403).json({ error: "Admins only" });

  app.use("/api/auth", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  // ---------- Sign in / out ----------
  // The picker is public on purpose (Netflix style): names and colours only.
  app.get("/api/auth/state", (req, res) => {
    res.json({ setup: accounts.needsSetup(), accounts: accounts.list(), me: accounts.publicAccount(req.account) });
  });

  app.post("/api/auth/setup", async (req, res) => {
    if (!accounts.needsSetup()) throw new AuthError(403, "Setup has already been done");
    const account = await accounts.create({ name: req.body?.name, password: req.body?.password, isAdmin: true });
    accounts.startSession(req, res, account);
    res.json({ ok: true, account: accounts.publicAccount(account) });
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const account = await accounts.login(req, String(req.body?.accountId || ""), req.body?.password);
      accounts.startSession(req, res, account); // replaces any session this browser already had
      res.json({ ok: true, account: accounts.publicAccount(account) });
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      res.locals.logged = true; // already in auth.log
      if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
      res.status(err.status).json({ error: err.message, retryAfter: err.retryAfter || 0 });
    }
  });

  // Anyone can create an account from the sign-in screen. Light spam guard
  // only: at most 10 per device per hour. They are signed in straight away.
  const signups = new Map(); // ip -> timestamps
  app.post("/api/auth/signup", async (req, res) => {
    const ip = String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
    const now = Date.now();
    const recent = (signups.get(ip) || []).filter((t) => now - t < 3600000);
    if (recent.length >= 10) throw new AuthError(429, "Too many accounts were created from this device. Try again later.");

    const b = req.body || {};
    const account = await accounts.create({ name: b.name, password: b.password, color: b.color, isAdmin: false });
    signups.set(ip, [...recent, now]);
    accounts.startSession(req, res, account);
    log.info(`new account "${account.name}" signed up from ${ip}`);
    res.status(201).json({ ok: true, account: accounts.publicAccount(account) });
  });

  app.post("/api/auth/logout", (req, res) => {
    accounts.endSession(req, res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireLogin, (req, res) => {
    res.json({ account: accounts.publicAccount(req.account) });
  });

  app.post("/api/auth/password", requireLogin, async (req, res) => {
    const me = accounts.get(req.account.id);
    const current = String(req.body?.current ?? "");
    if (!(await accounts.verifyPassword(current, me.passwordHash))) throw new AuthError(401, "Your current password is wrong");
    await accounts.setPassword(me.id, req.body?.next);
    accounts.destroyAllFor(me.id, req.sessionToken); // every other device must sign in again
    res.json({ ok: true });
  });

  // ---------- Admin: manage accounts ----------
  app.get("/api/admin/accounts", requireAdmin, (req, res) => {
    const primary = accounts.primaryAdminId();
    res.json({ accounts: accounts.list().map((a) => ({ ...a, primary: a.id === primary })) });
  });

  app.post("/api/admin/accounts", requireAdmin, async (req, res) => {
    const a = await accounts.create({
      name: req.body?.name, password: req.body?.password, color: req.body?.color, isAdmin: Boolean(req.body?.isAdmin),
    });
    log.info(`${req.account.name} created account "${a.name}"`);
    res.status(201).json({ account: accounts.publicAccount(a) });
  });

  app.post("/api/admin/accounts/:id/password", requireAdmin, async (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) throw httpError(404, "No such account");
    await accounts.setPassword(target.id, req.body?.password);
    accounts.destroyAllFor(target.id);
    log.info(`${req.account.name} reset the password of "${target.name}"`);
    res.json({ ok: true });
  });

  app.delete("/api/admin/accounts/:id", requireAdmin, async (req, res) => {
    const target = accounts.get(req.params.id);
    if (!target) throw httpError(404, "No such account");
    if (target.id === accounts.primaryAdminId()) throw httpError(400, "The main admin account can't be deleted");
    if (target.id === req.account.id) throw httpError(400, "You can't delete the account you're using");
    const moved = await access.releaseAccount(target.id);
    await playlists.removeOwner(target.id);
    await accounts.remove(target.id);
    log.info(`${req.account.name} deleted "${target.name}"; ${moved} item(s) passed to the main admin as private`);
    res.json({ ok: true, moved });
  });

  // ---------- Who exists, and what each channel holds (as seen by this viewer) ----------
  app.get("/api/accounts", requireLogin, (req, res) => {
    res.json({ me: req.account.id, accounts: accounts.list().map(({ id, name, color }) => ({ id, name, color })) });
  });

  app.get("/api/channels", requireLogin, async (req, res) => {
    const lib = access.filterLibrary(library.publicLibrary(), req.account);
    const shorts = access.filterShorts(await shortsStore.list(), req.account);
    const songs = access.filterSongs(await songsStore.snapshot(), req.account).songs;
    const count = (list, id) => list.filter((x) => x.ownerId === id).length;
    res.json({
      accounts: accounts.list().map(({ id, name, color }) => ({
        id, name, color,
        videos: count(lib.videos, id), shorts: count(shorts, id), songs: count(songs, id),
      })),
    });
  });

  // ---------- My uploads and who can see them ----------
  app.get("/api/mine", requireLogin, async (req, res) => {
    const me = req.account;
    const lib = library.publicLibrary();
    const shows = new Map(lib.shows.map((s) => [s.id, s.name]));
    const items = [];
    const push = (key, type, id, name, group) => {
      const r = access.record(key);
      if (r.owner === me.id) items.push({ key, type, id, name, group, visibility: r.visibility, shared: r.shared });
    };

    for (const v of lib.videos) {
      const key = keys.video(v.relativePath);
      const r = access.record(key);
      if (r.owner !== me.id) continue;
      items.push({
        key,
        type: "video",
        id: v.id,
        name: v.name,
        group: v.showId ? shows.get(v.showId) : null,
        visibility: r.visibility,
        shared: r.shared,
        media: mediaNormalizationQueue.get(v),
      });
    }
    for (const s of await shortsStore.list()) push(keys.short(s.filename), "short", s.id, s.name, null);
    const snap = await songsStore.snapshot();
    const folder = new Map(snap.playlists.map((p) => [p.id, p.name]));
    for (const s of snap.songs) push(keys.song(s.relativePath), "song", s.id, s.title || s.name, folder.get(s.playlistId) || "Singles");

    res.json({ items });
  });

  app.post("/api/access", requireLogin, async (req, res) => {
    const list = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 5000) : [];
    if (!list.length) throw httpError(400, "Nothing selected");
    res.json(await access.setSharing(req.account, list, req.body?.visibility, req.body?.shared));
  });

  app.post("/api/videos/:id/detect", requireLogin, async (req, res) => {
    const video = library.findVideo(req.params.id);
    if (!video) throw httpError(404, "Video not found");
    const key = keys.video(video.relativePath);
    if (!access.isOwner(req.account, key) && !req.account.isAdmin) {
      throw httpError(403, "Only the owner or an admin can detect this video");
    }

    const media = await mediaNormalizationQueue.enqueue(video);
    res.status(202).json({ ok: true, media });
  });

  // Titles are library metadata, separate from the on-disk filename. This
  // keeps sharing keys, watch IDs and generated thumbnails stable.
  app.patch("/api/videos/:id", requireLogin, async (req, res) => {
    const video = library.findVideo(req.params.id);
    if (!video) throw httpError(404, "Video not found");
    const key = keys.video(video.relativePath);
    if (!access.isOwner(req.account, key) && !req.account.isAdmin) {
      throw httpError(403, "Only the owner or an admin can edit this title");
    }

    const title = String(req.body?.title ?? "")
      .normalize("NFC")
      .replace(/[\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    if (!title) throw httpError(400, "A title is required");

    const updated = await library.updateTitle(video.id, title);
    log.info(`${req.account.name} renamed video "${video.relativePath}" to "${title}"`);
    res.json({ video: { ...library.publicVideo(updated), ownerId: access.ownerOf(key), ownerName: access.ownerName(key) } });
  });

  app.post("/api/videos/:id/move-to-shorts", requireLogin, async (req, res) => {
    const video = library.findVideo(req.params.id);
    if (!video) throw httpError(404, "Video not found");
    const oldKey = keys.video(video.relativePath);
    if (!access.isOwner(req.account, oldKey) && !req.account.isAdmin) {
      throw httpError(403, "Only the owner or an admin can move this video");
    }

    await fs.mkdir(SHORTS_DIR, { recursive: true });
    const target = path.join(SHORTS_DIR, video.filename);
    try {
      await fs.access(target);
      throw httpError(409, "A short with this filename already exists");
    } catch (err) {
      if (err.status || err.code !== "ENOENT") throw err;
    }

    await fs.rename(video.absolutePath, target);
    await access.renameKey(oldKey, keys.short(video.filename));
    await playlists.removeItemEverywhere(oldKey);
    await playlists.clearThumbnailForVideo(video.id);
    await library.scan();
    log.info(`${req.account.name} moved "${video.relativePath}" to Shorts`);
    res.json({ ok: true });
  });

  // ---------- Saved playlists (private to their owner) ----------
  async function index() {
    const lib = library.publicLibrary();
    const snap = await songsStore.snapshot();
    return {
      lib,
      video: new Map(lib.videos.map((v) => [keys.video(v.relativePath), v])),
      song: new Map(snap.songs.map((s) => [keys.song(s.relativePath), s])),
    };
  }

  // The playlist's items that still exist and that the owner may still see.
  function resolve(p, idx, account) {
    return p.items
      .map((key) => ({ key, obj: idx[p.kind].get(key) }))
      .filter((x) => x.obj && access.canView(account, x.key));
  }

  const ownPlaylist = (req) => {
    const p = playlists.get(req.params.id);
    if (!p || p.owner !== req.account.id) throw httpError(404, "Playlist not found");
    return p;
  };

  app.get("/api/playlists", requireLogin, async (req, res) => {
    const idx = await index();
    const item = req.query.item ? String(req.query.item) : null;
    res.json({
      playlists: playlists.list(req.account.id, req.query.kind).map((p) => {
        const ids = resolve(p, idx, req.account).map((x) => x.obj.id);
        return {
          id: p.id, name: p.name, kind: p.kind, count: ids.length,
          thumbnailVideoId: p.thumbnailVideoId || null,
          ...(req.query.full ? { items: ids } : {}),
          ...(item ? { contains: ids.includes(item) } : {}),
        };
      }),
    });
  });

  app.post("/api/playlists", requireLogin, async (req, res) => {
    const p = await playlists.create(req.account.id, req.body?.name, req.body?.kind);
    if (req.body?.item) {
      const idx = await index();
      const hit = [...idx[p.kind].entries()].find(([, o]) => o.id === String(req.body.item));
      if (hit && access.canView(req.account, hit[0])) await playlists.addItem(p.id, hit[0]);
    }
    res.status(201).json({ playlist: { id: p.id, name: p.name, kind: p.kind } });
  });

  app.get("/api/playlists/:id", requireLogin, async (req, res) => {
    const p = ownPlaylist(req);
    const idx = await index();
    const rows = resolve(p, idx, req.account);
    const shows = new Map(idx.lib.shows.map((s) => [s.id, s.name]));
    res.json({
      id: p.id, name: p.name, kind: p.kind, thumbnailVideoId: p.thumbnailVideoId || null,
      items: rows.map(({ key, obj }) => (req.query.detail
        ? { id: obj.id, key, name: obj.title || obj.name, show: obj.showId ? shows.get(obj.showId) : null, artist: obj.artist || null,
          visibility: access.record(key).visibility, shared: access.record(key).shared, canManage: access.isOwner(req.account, key) }
        : obj.id)),
    });
  });

  app.patch("/api/playlists/:id", requireLogin, async (req, res) => {
    const p = ownPlaylist(req);
    if (req.body?.name !== undefined) await playlists.rename(p.id, req.body.name);
    if (req.body?.thumbnailVideoId !== undefined) {
      const idx = await index();
      const allowed = resolve(p, idx, req.account).some(({ obj }) => obj.id === req.body.thumbnailVideoId);
      if (req.body.thumbnailVideoId && !allowed) throw httpError(400, "Choose a video in this playlist as its thumbnail");
      await playlists.setThumbnail(p.id, req.body.thumbnailVideoId);
    }
    res.json({ ok: true });
  });

  app.delete("/api/playlists/:id", requireLogin, async (req, res) => {
    await playlists.remove(ownPlaylist(req).id);
    res.json({ ok: true });
  });

  app.post("/api/playlists/:id/items", requireLogin, async (req, res) => {
    const p = ownPlaylist(req);
    const idx = await index();
    const hit = [...idx[p.kind].entries()].find(([, o]) => o.id === String(req.body?.item));
    if (!hit || !access.canView(req.account, hit[0])) throw httpError(404, "That item isn't available");
    await playlists.addItem(p.id, hit[0]);
    res.json({ ok: true });
  });

  app.delete("/api/playlists/:id/items/:item", requireLogin, async (req, res) => {
    const p = ownPlaylist(req);
    const idx = await index();
    const hit = [...idx[p.kind].entries()].find(([, o]) => o.id === req.params.item);
    if (!hit) throw httpError(404, "That item isn't available");
    await playlists.removeItem(p.id, hit[0]);
    await playlists.clearThumbnailForVideo(hit[1].id);
    res.json({ ok: true });
  });

  // The listen page shows an account's song playlists next to the folder ones.
  function songPlaylistsFor(account, visibleSongs) {
    const byKey = new Map(visibleSongs.map((s) => [keys.song(s.relativePath), s.id]));
    return playlists.list(account.id, "song").map((p) => ({
      id: `up-${p.id}`,
      name: p.name,
      mine: true,
      songIds: p.items.map((k) => byKey.get(k)).filter(Boolean),
    }));
  }

  return { songPlaylistsFor };
}

module.exports = { install, gate, thumbnailGuard };
