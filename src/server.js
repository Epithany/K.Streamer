const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const http = require("http");
const https = require("https");
const express = require("express");
let compression = null;
try { compression = require("compression"); } catch { /* npm i compression to enable */ }

// First thing: from here on console.* goes to logs/, and crashes are recorded.
const log = require("./logger");
log.captureConsole();
log.installProcessHandlers();

const {
  HOST,
  PORT,
  FFMPEG_PATH,
  FFPROBE_PATH,
  VIDEOS_DIR,
  VIDEO_EXTENSIONS,
  SHORTS_DIR,
  SONGS_DIR,
  AUDIO_EXTENSIONS,
  SHORTS_TRIM_SECONDS,
  THUMBNAILS_DIR,
  HTTPS_KEY,
  HTTPS_CERT,
} = require("./config");

const library = require("./library");
const thumbnailQueue = require("./thumbnailQueue");
const events = require("./events");
const devices = require("./devices");
const shortsStore = require("./shortsStore");
const mediaTranscoder = require("./mediaTranscoder");
const mediaNormalizationQueue = require("./mediaNormalizationQueue");
const songsStore = require("./songsStore");
const accounts = require("./accounts");
const access = require("./access");
const playlistStore = require("./playlistStore");
const accountRoutes = require("./accountRoutes");
const search = require("./search");
const chess = require("./chess");

const app = express();
app.disable("x-powered-by");

const httpLog = log.for("http");
const uploadLog = log.for("uploads");
const clientLog = log.for("client");
const serverLog = log.for("server");

let activeStreams = 0;
let activeUploads = 0;

const ipOf = (req) => String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");

function describeUpload(req) {
  const q = req.query || {};
  const parts = [`${q.kind || "movie"} "${q.filename || "?"}"`];
  if (q.show) parts.push(`show="${q.show}"`);
  if (q.playlist) parts.push(`playlist="${q.playlist}"`);
  if (q.source) parts.push(`source=${q.source}`);
  parts.push(`from ${ipOf(req)}`);
  return parts.join(" ");
}

// Failed requests -> http.log. Expected misses (cover art that doesn't exist,
// stale thumbnail URLs, upload pre-checks) are skipped; uploads log themselves.
const QUIET_4XX = ["/thumbnails", "/api/songs/cover/", "/api/upload"];
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const status = res.statusCode;
    if (status < 400 || status === 401 || res.locals.logged) return; // 401 = just not signed in yet
    const urlPath = req.originalUrl.split("?")[0];
    if (status < 500 && QUIET_4XX.some((p) => urlPath.startsWith(p))) return;
    (status >= 500 ? httpLog.error : httpLog.warn)(
      `${status} ${req.method} ${req.originalUrl} (${Date.now() - started}ms) from ${ipOf(req)}`,
    );
  });
  next();
});
// gzip/br for HTML, CSS, JS and the library JSON. Never for media, images or
// the event streams (compressing those buffers them).
if (compression) {
  const NO_COMPRESS = /^\/(stream|thumbnails|api\/(events|device\/events|server\/events|songs\/cover))/;
  app.use(compression({ filter: (req, res) => !NO_COMPRESS.test(req.path) && compression.filter(req, res) }));
}

app.use(express.json());
app.use(accounts.attach); // who is this? (req.account)
app.use(accountRoutes.gate); // nothing below is served to someone who isn't signed in
devices.attach(app);

app.post("/api/server/restart", (req, res) => {
  if (!req.account?.isAdmin) return res.status(403).json({ error: "Admins only" });
  res.json({ ok: true, restarting: true });
  setTimeout(() => process.exit(0), 150).unref();
});

app.use("/thumbnails", accountRoutes.thumbnailGuard(library));
app.use("/thumbnails", express.static(THUMBNAILS_DIR, {
  fallthrough: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "private, max-age=31536000, immutable")
}));

// Thumbnail work and library updates can briefly leave stale URLs in a page.
// Return a quiet 404 rather than routing the missing asset into app error logs.
app.use("/thumbnails", (req, res) => res.status(404).end());

app.use(express.static(path.join(__dirname, "..", "public"), {
  extensions: ["html"],
  setHeaders: (res, file) => {
    // Fonts and images rarely change; code is revalidated (cheap 304) so edits show up.
    const long = /\.(woff2?|ttf|otf|webp|png|jpe?g|svg|ico)$/i.test(file);
    res.setHeader("Cache-Control", long ? "public, max-age=86400" : "no-cache");
  }
}));

// Browsers report their own problems here (see client-log.js) -> client.log.
let clientBudget = { count: 0, since: Date.now() };
app.post("/api/log", (req, res) => {
  const now = Date.now();
  if (now - clientBudget.since > 60000) clientBudget = { count: 0, since: now };
  if (++clientBudget.count > 120) return res.status(429).end(); // runaway client

  const b = req.body || {};
  const clip = (v, n) => String(v ?? "").slice(0, n);
  const level = b.level === "warn" ? "warn" : "error";
  const device = clip(b.deviceName, 48) || "unnamed";
  const detail = [
    `device=${device} id=${clip(b.deviceId, 40) || "?"} ip=${ipOf(req)}`,
    `page=${clip(b.page, 200)}`,
    b.source ? `at ${clip(b.source, 200)}:${clip(b.line, 8)}:${clip(b.col, 8)}` : "",
    b.extra ? clip(b.extra, 600) : "",
    `ua=${clip(b.userAgent, 200)}`,
    b.stack ? clip(b.stack, 2000) : "",
  ].filter(Boolean).join("\n");

  clientLog[level](`${clip(b.type, 24) || "error"}: ${clip(b.message, 500)}`, detail);
  res.status(204).end();
});

const accountApi = accountRoutes.install(app, { library, shortsStore, songsStore, mediaNormalizationQueue });

const visibleLibrary = (req) => access.filterLibrary(library.publicLibrary(), req.account);
const canSeeVideo = (req, video) =>
  Boolean(video) && access.canView(req.account, access.keys.video(video.relativePath));

app.get("/api/library", async (req, res, next) => {
  try {
    res.json(visibleLibrary(req));
  } catch (err) {
    next(err);
  }
});

app.get("/api/videos", async (req, res, next) => {
  try {
    await library.getLibrary();
    res.json(visibleLibrary(req).videos);
  } catch (err) {
    next(err);
  }
});

app.get("/api/video/:id", async (req, res, next) => {
  try {
    const video = library.findVideo(req.params.id);
    if (!canSeeVideo(req, video)) return res.status(404).json({ error: "Video not found" });

    const playlist = library.getPlaylistForVideo(video.id);
    if (playlist) playlist.videoIds = playlist.videoIds.filter((id) => canSeeVideo(req, library.findVideo(id)));
    res.json({
      video: {
        ...library.publicVideo(video),
        ownerId: access.ownerOf(access.keys.video(video.relativePath)),
        ownerName: access.ownerName(access.keys.video(video.relativePath)),
      },
      playlist
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/playlist/:id", async (req, res, next) => {
  try {
    const playlist = library.findSeason(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });

    const visible = playlist.videoIds
      .map(id => library.findVideo(id))
      .filter(v => canSeeVideo(req, v));
    if (!visible.length) return res.status(404).json({ error: "Playlist not found" });

    res.json({
      ...playlist,
      videoIds: visible.map(v => v.id),
      videos: visible.map(library.publicVideo)
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/thumbnail-status", (req, res) => {
  res.json(thumbnailQueue.status());
});

// Covers and preview strips finish asynchronously. Push library updates so a
// placeholder turns into its cover without polling or a manual refresh.
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("\n");

  // Each connection only ever receives what its account may see.
  const send = payload => res.write(`data: ${JSON.stringify(access.filterLibrary(payload, req.account))}\n\n`);
  send(library.publicLibrary());

  // A burst (one update per finished thumbnail) becomes a single message.
  let latest = null;
  let flushTimer = null;
  const onUpdate = payload => {
    latest = payload;
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; send(latest); }, 400);
  };
  events.on("library:update", onUpdate);
  const heartbeat = setInterval(() => res.write(":\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(flushTimer);
    events.off("library:update", onUpdate);
  });
});

// Thumbnail work is initiated by an actual client need. The route returns
// immediately; the client receives the new library data over SSE when a cover
// is ready. Preview work is higher priority so opening a player stays useful
// even if several visible home cards are waiting for covers.
app.post("/api/thumbnails/:id", async (req, res, next) => {
  try {
    const video = library.findVideo(req.params.id);
    if (!canSeeVideo(req, video)) return res.status(404).json({ error: "Video not found" });
    await thumbnailQueue.enqueue(video.id, { cover: true, priority: 0 });
    res.status(202).json({ ok: true, thumbnails: thumbnailQueue.status() });
  } catch (err) {
    next(err);
  }
});

app.post("/api/previews/:id", async (req, res, next) => {
  try {
    const video = library.findVideo(req.params.id);
    if (!canSeeVideo(req, video)) return res.status(404).json({ error: "Video not found" });
    await thumbnailQueue.enqueue(video.id, { previews: true, priority: 10 });
    res.status(202).json({ ok: true, thumbnails: thumbnailQueue.status() });
  } catch (err) {
    next(err);
  }
});

// ---------- Live updates ----------
// Tiny "something changed" pings. Pages re-fetch what they show (songs, shorts,
// search index) instead of needing a manual refresh. Videos already have
// /api/events; this channel covers everything else and keeps search current.
const liveClients = new Set();
const searchCache = new Map();

function liveNotify(type) {
  searchCache.clear();
  const message = `data: ${JSON.stringify({ type, at: Date.now() })}\n\n`;
  for (const res of liveClients) {
    if (res.writableEnded) liveClients.delete(res);
    else res.write(message);
  }
}

app.get("/api/live", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("\n");
  liveClients.add(res);
  const heartbeat = setInterval(() => res.write(":\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    liveClients.delete(res);
  });
});

// Video changes are announced by library.js; thumbnails land in bursts, so coalesce.
let libraryPing = null;
events.on("library:update", () => {
  if (libraryPing) return;
  libraryPing = setTimeout(() => { libraryPing = null; liveNotify("library"); }, 800);
});

// Songs/ and Shorts/ are read straight from disk, so files copied in by hand (or
// removed) are noticed by a cheap check - only while a page is open.
function startLiveWatcher() {
  const last = { songs: null, shorts: null };
  let running = false;
  let tick = 0;
  const timer = setInterval(async () => {
    if (running || !liveClients.size) return;
    running = true;
    try {
      const shorts = (await shortsStore.list()).map((s) => s.id).sort().join(",");
      if (last.shorts !== null && shorts !== last.shorts) liveNotify("shorts");
      last.shorts = shorts;

      await songsStore.refresh();
      const snap = await songsStore.snapshot();
      const songs = snap.songs.map((s) => `${s.id}:${s.title || ""}`).sort().join("|");
      if (last.songs !== null && songs !== last.songs) liveNotify("songs");
      last.songs = songs;

      if (++tick % 2 === 0) await library.scan(); // announces itself if anything changed
    } catch (err) {
      serverLog.warn("live watcher check failed", err);
    } finally {
      running = false;
    }
  }, 10000);
  timer.unref();
}

// ---------- Search ----------
// GET /api/search/index  everything the account can see, compact: the page
//                        preloads it and searches locally with no round trip.
// GET /api/search?q=&limit=&kinds=song,short   same ranking, done server-side.
async function searchItems(account) {
  const hit = searchCache.get(account.id);
  if (hit && Date.now() - hit.at < 5000) return hit.items;
  await library.getLibrary();
  const items = search.buildItems({
    lib: access.filterLibrary(library.publicLibrary(), account),
    songs: access.filterSongs(await songsStore.snapshot(), account),
    shorts: access.filterShorts(await shortsStore.list(), account),
  });
  searchCache.set(account.id, { at: Date.now(), items });
  return items;
}

app.get("/api/search/index", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-cache");
    res.json({ generatedAt: new Date().toISOString(), items: await searchItems(req.account) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").slice(0, 100);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 40));
    const kinds = String(req.query.kinds || "").split(",").filter(Boolean);
    res.set("Cache-Control", "private, no-cache");
    res.json({ q, results: search.query(await searchItems(req.account), q, { limit, kinds: kinds.length ? kinds : null }) });
  } catch (err) {
    next(err);
  }
});

// ---------- Uploads ----------
// Each file is sent as its own raw-body POST (no multipart, no extra
// dependency) so a multi-GB episode streams straight to disk instead of
// being buffered in memory, and the browser can report real progress.
//   kind=movie  -> Videos/<file>
//   kind=show   -> Videos/<show>/<file>
//   kind=song   -> Songs/<playlist>/<file>  (no playlist -> Songs/<file>, "Singles")
//   kind=short  -> Shorts/<file>   (source=tiktok|instagram also trims the
//                                   outro off the end; source=other doesn't)
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHORT_SOURCES = new Set(["tiktok", "instagram", "other"]);

function safeSegment(raw, max = 150) {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, ""); // leading dots would make a hidden (never-scanned) entry
  if (!s) return "";
  if (RESERVED_NAMES.test(s.split(".")[0])) s = `_${s}`;
  return s.slice(0, max);
}

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function resolveUploadTarget(query) {
  const kind = ["show", "short", "song"].includes(query.kind) ? query.kind : "movie";
  const filename = safeSegment(query.filename, 240);
  if (!filename) throw new UploadError(400, "Missing file name");

  const sourceExtension = path.extname(filename).toLowerCase();
  if (!(kind === "song" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS).has(sourceExtension)) {
    throw new UploadError(400, `Unsupported file type "${sourceExtension || "none"}"`);
  }
  const outputExtension = kind === "song" ? ".mp3" : ".mp4";
  const outputFilename = `${path.basename(filename, sourceExtension)}${outputExtension}`;

  let base = VIDEOS_DIR;
  let dir = VIDEOS_DIR;
  let trimSeconds = 0;
  const type = kind === "short" ? "short" : kind === "song" ? "song" : "video";

  if (kind === "show") {
    const show = safeSegment(query.show, 120);
    if (!show) throw new UploadError(400, "Show name is required");
    dir = path.join(VIDEOS_DIR, show);
  } else if (kind === "song") {
    base = SONGS_DIR;
    dir = SONGS_DIR;
    const playlist = safeSegment(query.playlist, 120); // optional
    if (playlist) dir = path.join(SONGS_DIR, playlist);
  } else if (kind === "short") {
    const source = String(query.source || "").toLowerCase();
    if (!SHORT_SOURCES.has(source)) {
      throw new UploadError(400, "Choose where the short is from");
    }
    base = SHORTS_DIR;
    dir = SHORTS_DIR;
    if (source !== "other") trimSeconds = SHORTS_TRIM_SECONDS;
  }

  const root = path.resolve(base);
  const finalPath = path.resolve(dir, outputFilename);
  if (path.dirname(finalPath) !== path.resolve(dir) || !finalPath.startsWith(root + path.sep)) {
    throw new UploadError(400, "Invalid path");
  }

  try {
    await fsp.access(finalPath);
    throw new UploadError(409, "A file with that name already exists");
  } catch (err) {
    if (err instanceof UploadError) throw err;
  }

  return { dir: path.resolve(dir), finalPath, sourceExtension, trimSeconds, base, type };
}

// Cheap pre-flight so name clashes / bad types are reported before the
// browser pushes gigabytes down the wire.
app.get("/api/upload/check", async (req, res) => {
  try {
    await resolveUploadTarget(req.query);
    res.json({ ok: true });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) uploadLog.error(`pre-check failed - ${describeUpload(req)}`, err);
    else uploadLog.warn(`pre-check rejected (${status}): ${err.message} - ${describeUpload(req)}`);
    res.status(status).json({ error: err.message });
  }
});

// ---- Upload processing queue ----
// The file is received first, then converted in a background queue (one job
// at a time: this machine is also the media host).
//   POST /api/upload                -> waits for the conversion, 201 (as before)
//   POST /api/upload?async=1        -> 202 { jobId } right after the bytes arrive
//   GET  /api/upload/jobs[/:id]     -> state: queued | processing | done | error
const uploadJobs = new Map();
const uploadQueue = [];
let uploadWorker = false;

const jobView = (j) => ({
  id: j.id, name: j.filename, state: j.state, progress: Number(j.progress.toFixed(3)),
  error: j.error || null, file: j.file || null, size: j.size ?? null, mode: j.mode || null,
  trimmed: Boolean(j.trimmed), trimmedSeconds: j.trimmed ? j.trimSeconds : 0, note: j.note || null,
});

function enqueueUpload(job) {
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => {}); // async clients poll instead of awaiting
  uploadJobs.set(job.id, job);
  uploadQueue.push(job);
  activeUploads += 1;
  pumpUploads();
}

async function pumpUploads() {
  if (uploadWorker) return;
  uploadWorker = true;
  try {
    while (uploadQueue.length) await runUploadJob(uploadQueue.shift());
  } finally {
    uploadWorker = false;
  }
}

// Moves into place without ever overwriting: hard-link fails with EEXIST if
// the name appeared meanwhile (closes the check-then-rename race).
async function moveNoClobber(from, to) {
  try {
    await fsp.link(from, to);
    await fsp.rm(from, { force: true });
  } catch (err) {
    if (err.code === "EEXIST") throw new UploadError(409, "A file with that name already exists");
    if (!["EPERM", "ENOTSUP", "EXDEV"].includes(err.code)) throw err;
    try { await fsp.access(to); throw new UploadError(409, "A file with that name already exists"); }
    catch (e) { if (e instanceof UploadError) throw e; }
    await fsp.rename(from, to);
  }
}

async function runUploadJob(job) {
  job.state = "processing";
  const started = Date.now();
  const ready = `${job.tmp}.browser${job.type === "song" ? ".mp3" : ".mp4"}`;
  try {
    let result;
    try {
      result = await mediaTranscoder.transcode(job.tmp, ready, job.type, {
        trimEnd: job.trimSeconds,
        onProgress: (p) => { job.progress = p; },
      });
    } catch (err) {
      const failure = new UploadError(500, `Conversion failed: ${err.message}`);
      failure.cause = err;
      throw failure;
    }
    job.mode = result.mode;
    job.trimmed = result.trimmed;
    if (job.trimSeconds && !result.trimmed) job.note = "too short to trim - kept as-is";

    // Ownership is written BEFORE the file appears, so a private upload can
    // never be visible (as a legacy file) even for a moment.
    const rel = path.relative(job.base, job.finalPath).split(path.sep).join("/");
    const key = access.keys[job.type](rel);
    await access.recordUpload(key, job.ownerId, job.visibility, job.shared);
    try {
      await moveNoClobber(ready, job.finalPath);
    } catch (err) {
      await access.forget(key);
      throw err;
    }

    job.size = (await fsp.stat(job.finalPath)).size;
    job.file = path.basename(job.finalPath);
    job.state = "done";
    job.progress = 1;
    uploadLog.info(
      `saved ${job.desc} -> ${job.finalPath} (${job.size} bytes, ${Date.now() - job.receivedAt}ms total, ` +
      `convert ${Date.now() - started}ms, mode=${job.mode}${job.trimmed ? `, last ${job.trimSeconds}s trimmed` : ""}` +
      `${job.note ? `, ${job.note}` : ""})`,
    );
    if (job.type === "video") library.scan().catch(() => {});
    else if (job.type === "song") songsStore.refresh().catch(() => {}).finally(() => liveNotify("songs"));
    else liveNotify("shorts");
    job.resolve(job);
  } catch (err) {
    job.state = "error";
    job.error = err.message;
    job.reject(err);
  } finally {
    await fsp.rm(job.tmp, { force: true }).catch(() => {});
    await fsp.rm(ready, { force: true }).catch(() => {});
    activeUploads -= 1;
    setTimeout(() => uploadJobs.delete(job.id), 30 * 60 * 1000).unref?.();
  }
}

async function ensureFreeSpace(dir, incoming) {
  if (!incoming || typeof fsp.statfs !== "function") return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const s = await fsp.statfs(dir);
    // The upload, its converted copy and some slack.
    if (s.bavail * s.bsize < incoming * 2.2) throw new UploadError(507, "Not enough free disk space on the server");
  } catch (err) {
    if (err instanceof UploadError) throw err;
  }
}

app.get("/api/upload/jobs", (req, res) => {
  res.json({ jobs: [...uploadJobs.values()].filter((j) => j.ownerId === req.account.id).map(jobView) });
});

app.get("/api/upload/jobs/:id", (req, res) => {
  const job = uploadJobs.get(req.params.id);
  if (!job || job.ownerId !== req.account.id) return res.status(404).json({ error: "No such upload" });
  res.json(jobView(job));
});

app.post("/api/upload", async (req, res, next) => {
  const started = Date.now();
  let tmp = null;
  let queued = false;
  try {
    const target = await resolveUploadTarget(req.query);
    await ensureFreeSpace(target.dir, Number(req.headers["content-length"]) || 0);

    await fsp.mkdir(target.dir, { recursive: true });
    // ".part" is not a video extension, so a scan mid-upload ignores it.
    tmp = path.join(target.dir, `.upload-${crypto.randomBytes(6).toString("hex")}.part`);

    activeUploads += 1;
    try {
      await pipeline(req, fs.createWriteStream(tmp, { flags: "wx", highWaterMark: 1 << 20 }));
    } finally {
      activeUploads -= 1;
    }
    if (!req.complete) throw new UploadError(400, "Upload was interrupted");

    const job = {
      id: `up${crypto.randomBytes(6).toString("base64url")}`,
      state: "queued", progress: 0, receivedAt: started,
      ownerId: req.account.id,
      visibility: req.query.visibility,
      shared: String(req.query.shared || "").split(",").filter(Boolean),
      filename: path.basename(target.finalPath),
      desc: describeUpload(req),
      tmp, type: target.type, base: target.base, finalPath: target.finalPath,
      trimSeconds: target.trimSeconds,
    };
    queued = true;
    enqueueUpload(job);

    if (req.query.async === "1") return res.status(202).json({ ok: true, jobId: job.id, job: jobView(job) });

    await job.promise;
    res.status(201).json({
      ok: true, file: job.file, size: job.size, trimmed: Boolean(job.trimmed),
      trimmedSeconds: job.trimmed ? job.trimSeconds : 0, converted: true, mode: job.mode, note: job.note || null,
    });
  } catch (err) {
    if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
      uploadLog.warn(`client disconnected mid-upload, partial file removed - ${describeUpload(req)} after ${Date.now() - started}ms`);
      return;
    }
    res.locals.logged = true; // this handler logs the failure itself
    if (err instanceof UploadError) {
      if (err.status >= 500) uploadLog.error(`failed (${err.status}): ${err.message} - ${describeUpload(req)}`, err.cause || err);
      else uploadLog.warn(`rejected (${err.status}): ${err.message} - ${describeUpload(req)}`);
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    uploadLog.error(`unexpected failure - ${describeUpload(req)}`, err);
    err.logged = true;
    next(err);
  } finally {
    // A file that never reached the queue (partial upload, rejected) goes away.
    if (!queued && tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

app.post("/api/rescan", async (req, res, next) => {
  try {
    await library.scan();
    res.json({
      ok: true,
      library: visibleLibrary(req),
      thumbnails: thumbnailQueue.status()
    });
  } catch (err) {
    next(err);
  }
});

function getVideoById(id) {
  return library.findVideo(id);
}

// Shared range-aware file streamer for /stream/:id, /stream/shorts/:id and
// /stream/songs/:id. Strong ETag + Last-Modified let players revalidate and
// resume cheaply; If-Range makes a changed file restart instead of corrupting.
const STREAM_CHUNK = 1 << 20; // 1 MB reads: far fewer syscalls than the 64 KB default

async function streamFile(req, res, absolutePath, extension) {
  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).send("Video not found");
    throw err;
  }

  const size = stat.size;
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeForExtension(extension));
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", lastModified);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");

  let range = req.headers.range;
  const ifRange = req.headers["if-range"];
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = undefined;

  if (!range && req.headers["if-none-match"] === etag) return res.status(304).end();

  // pipeline(), not .pipe(): it releases the file handle when the client
  // hangs up mid-stream. Seeking and swiping through shorts abort a lot of
  // requests, and .pipe() would leak a descriptor for each one.
  const send = (options = {}) => {
    activeStreams += 1;
    pipeline(fs.createReadStream(absolutePath, { highWaterMark: STREAM_CHUNK, ...options }), res)
      .catch(() => {})
      .finally(() => {
        activeStreams -= 1;
      });
  };

  if (!range) {
    res.setHeader("Content-Length", size);
    return send();
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
  }

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= size) {
      return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
    }
    if (end === null || !Number.isFinite(end)) end = size - 1;
    end = Math.min(end, size - 1);
  }

  if (start > end) {
    return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  send({ start, end });
}

app.get("/stream/:id", async (req, res, next) => {
  try {
    const video = getVideoById(req.params.id);
    if (!canSeeVideo(req, video)) return res.status(404).send("Video not found");
    await streamFile(req, res, video.absolutePath, video.extension);
  } catch (err) {
    next(err);
  }
});

// ---------- Shorts ----------
app.get("/api/shorts", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ shorts: access.filterShorts(await shortsStore.list(), req.account) });
  } catch (err) {
    next(err);
  }
});

app.get("/stream/shorts/:id", async (req, res, next) => {
  try {
    const short = await shortsStore.find(req.params.id);
    if (!short || !access.canView(req.account, access.keys.short(short.filename))) {
      return res.status(404).send("Short not found");
    }
    await streamFile(req, res, short.absolutePath, short.extension);
  } catch (err) {
    next(err);
  }
});

app.get("/shorts", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "shorts.html"));
});

// ---------- Songs ----------
app.get("/api/songs", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const snap = access.filterSongs(await songsStore.snapshot(), req.account);
    // The account's own song playlists appear next to the folder ones.
    res.json({ ...snap, playlists: [...snap.playlists, ...accountApi.songPlaylistsFor(req.account, snap.songs)] });
  } catch (err) {
    next(err);
  }
});

// Embedded cover art, extracted on first request and cached on disk.
// 404 means the file has no art; the page falls back to an icon.
app.get("/api/songs/cover/:id", async (req, res, next) => {
  try {
    const song = await songsStore.find(req.params.id);
    if (!song || !access.canView(req.account, access.keys.song(song.relativePath))) return res.status(404).end();
    const file = await songsStore.coverFor(req.params.id);
    if (!file) return res.status(404).end();
    res.set("Cache-Control", "private, max-age=86400");
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

app.get("/stream/songs/:id", async (req, res, next) => {
  try {
    const song = await songsStore.find(req.params.id);
    if (!song || !access.canView(req.account, access.keys.song(song.relativePath))) {
      return res.status(404).send("Song not found");
    }
    await streamFile(req, res, song.absolutePath, song.extension);
  } catch (err) {
    next(err);
  }
});

app.get("/listen", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "listen.html"));
});

app.get("/watch", async (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "watch.html"));
});

app.get("/remote", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "remote.html"));
});

app.get("/chess", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "chess.html"));
});

app.get("/manage/:playlistId", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "manage-playlist.html"));
});

app.get("/{*splat}", async (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // Pages send a heartbeat while unloading; the aborted body isn't a problem.
  const aborted = err.type === "request.aborted" || err.code === "ECONNRESET";
  if (!err.logged && !aborted) {
    if (status >= 500) httpLog.error(`${req.method} ${req.originalUrl} -> ${status}`, err);
    else httpLog.warn(`${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  }
  res.locals.logged = true;
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

function mimeForExtension(ext) {
  const map = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",

    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".weba": "audio/webm"
  };

  return map[ext.toLowerCase()] || "application/octet-stream";
}

async function checkEnvironment() {
  for (const [label, file] of [["ffmpeg", FFMPEG_PATH], ["ffprobe", FFPROBE_PATH]]) {
    try {
      await fsp.access(file);
    } catch {
      serverLog.error(`${label} not found at ${file} - covers, previews, short trimming and cover art will fail`);
    }
  }
  for (const [label, dir] of [["Videos", VIDEOS_DIR], ["Songs", SONGS_DIR], ["Shorts", SHORTS_DIR]]) {
    try {
      await fsp.access(dir);
    } catch {
      serverLog.info(`${label} folder does not exist yet: ${dir}`);
    }
  }
}

async function start() {
  serverLog.info(`=== starting (pid ${process.pid}, node ${process.version}, ${process.platform}) ===`);
  await checkEnvironment();
  await accounts.init();
  await access.init();
  await playlistStore.init();
  if (accounts.needsSetup()) {
    serverLog.info("no accounts yet: the first visit to the site asks you to create the main (admin) account");
  }
  await library.scan();
  await mediaNormalizationQueue.init({ library, access });
  await thumbnailQueue.init();
  await devices.init();
  await chess.init();

  const hasHttps = fs.existsSync(HTTPS_KEY) && fs.existsSync(HTTPS_CERT);

  let server;

  if (hasHttps) {
    server = https.createServer({
      key: fs.readFileSync(HTTPS_KEY),
      cert: fs.readFileSync(HTTPS_CERT)
    }, app);
  } else {
    server = http.createServer(app);
    serverLog.info("HTTP only: HTTPS turns on automatically when certs/server.key and certs/server.crt exist");
  }

  // Chess needs a live socket (/chess/ws) on the same HTTP(S) server.
  chess.attach(server);

  // Node's default requestTimeout (5 min) would kill any upload that takes
  // longer than that to arrive - fatal for big files over Wi-Fi.
  server.requestTimeout = 0;

  server.on("error", (err) => {
    const hints = {
      EADDRINUSE: `port ${PORT} is already in use (another copy of the server, or another program)`,
      EACCES: `no permission to listen on port ${PORT} - run as administrator, or set the PORT environment variable`,
    };
    log.fatal("server", hints[err.code] || `server error: ${err.message}`, err);
  });

  // A browser rejecting a self-signed certificate shows up here, nowhere else.
  const tlsSeen = new Map();
  server.on("tlsClientError", (err, socket) => {
    const ip = String(socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
    const key = `${ip}|${err.code}`;
    if (Date.now() - (tlsSeen.get(key) || 0) > 60000) {
      tlsSeen.set(key, Date.now());
      serverLog.warn(`TLS handshake failed from ${ip}: ${err.code || err.message} (often an untrusted self-signed certificate)`);
    }
    socket.destroy();
  });

  server.listen(PORT, HOST, () => {
    serverLog.info(`listening on ${hasHttps ? "https" : "http"}://${HOST}:${PORT}`);
    startLiveWatcher();
    devices.startConsole();
  });
}

start().catch((err) => log.fatal("server", "startup failed", err));
