const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const http = require("http");
const https = require("https");
const express = require("express");

const {
  HOST,
  PORT,
  VIDEOS_DIR,
  VIDEO_EXTENSIONS,
  THUMBNAILS_DIR,
  HTTPS_KEY,
  HTTPS_CERT
} = require("./config");

const library = require("./library");
const thumbnailQueue = require("./thumbnailQueue");
const events = require("./events");
const devices = require("./devices");

const app = express();
app.disable("x-powered-by");

app.use(express.json());
devices.attach(app);

app.use("/thumbnails", express.static(THUMBNAILS_DIR, {
  fallthrough: true,
  maxAge: "365d",
  immutable: true
}));

// Thumbnail work and library updates can briefly leave stale URLs in a page.
// Return a quiet 404 rather than routing the missing asset into app error logs.
app.use("/thumbnails", (req, res) => res.status(404).end());

app.use(express.static(path.join(__dirname, "..", "public"), {
  extensions: ["html"]
}));

app.get("/api/library", async (req, res, next) => {
  try {
    res.json(library.publicLibrary());
  } catch (err) {
    next(err);
  }
});

app.get("/api/videos", async (req, res, next) => {
  try {
    const lib = await library.getLibrary();
    res.json(lib.videos.map(library.publicVideo));
  } catch (err) {
    next(err);
  }
});

app.get("/api/video/:id", async (req, res, next) => {
  try {
    const video = library.findVideo(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found" });

    res.json({
      video: library.publicVideo(video),
      playlist: library.getPlaylistForVideo(video.id)
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/playlist/:id", async (req, res, next) => {
  try {
    const playlist = library.findSeason(req.params.id);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });

    const videos = playlist.videoIds
      .map(id => library.findVideo(id))
      .filter(Boolean)
      .map(library.publicVideo);

    res.json({
      ...playlist,
      videos
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

  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send(library.publicLibrary());

  const onUpdate = payload => send(payload);
  events.on("library:update", onUpdate);
  const heartbeat = setInterval(() => res.write(":\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
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
    if (!video) return res.status(404).json({ error: "Video not found" });
    await thumbnailQueue.enqueue(video.id, { cover: true, priority: 0 });
    res.status(202).json({ ok: true, thumbnails: thumbnailQueue.status() });
  } catch (err) {
    next(err);
  }
});

app.post("/api/previews/:id", async (req, res, next) => {
  try {
    const video = library.findVideo(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found" });
    await thumbnailQueue.enqueue(video.id, { previews: true, priority: 10 });
    res.status(202).json({ ok: true, thumbnails: thumbnailQueue.status() });
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
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeSegment(raw, max = 150) {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") return "";
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
  const kind = query.kind === "show" ? "show" : "movie";
  const filename = safeSegment(query.filename, 240);
  if (!filename) throw new UploadError(400, "Missing file name");

  const ext = path.extname(filename).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw new UploadError(400, `Unsupported file type "${ext || "none"}"`);
  }

  let dir = VIDEOS_DIR;
  if (kind === "show") {
    const show = safeSegment(query.show, 120);
    if (!show) throw new UploadError(400, "Show name is required");
    dir = path.join(VIDEOS_DIR, show);
  }

  const root = path.resolve(VIDEOS_DIR);
  const finalPath = path.resolve(dir, filename);
  if (path.dirname(finalPath) !== path.resolve(dir) || !finalPath.startsWith(root + path.sep)) {
    throw new UploadError(400, "Invalid path");
  }

  try {
    await fsp.access(finalPath);
    throw new UploadError(409, "A file with that name already exists");
  } catch (err) {
    if (err instanceof UploadError) throw err;
  }

  return { dir: path.resolve(dir), finalPath, filename };
}

// Cheap pre-flight so name clashes / bad types are reported before the
// browser pushes gigabytes down the wire.
app.get("/api/upload/check", async (req, res) => {
  try {
    await resolveUploadTarget(req.query);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/upload", async (req, res, next) => {
  let tmp = null;
  try {
    const { dir, finalPath, filename } = await resolveUploadTarget(req.query);

    await fsp.mkdir(dir, { recursive: true });
    // ".part" is not a video extension, so a scan mid-upload ignores it.
    tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString("hex")}.part`);

    await pipeline(req, fs.createWriteStream(tmp, { flags: "wx" }));
    if (!req.complete) throw new UploadError(400, "Upload was interrupted");

    // Re-check right before the move in case the name appeared meanwhile.
    try {
      await fsp.access(finalPath);
      throw new UploadError(409, "A file with that name already exists");
    } catch (err) {
      if (err instanceof UploadError) throw err;
    }

    await fsp.rename(tmp, finalPath);
    tmp = null;

    const { size } = await fsp.stat(finalPath);
    res.status(201).json({ ok: true, file: path.relative(VIDEOS_DIR, finalPath), size });
  } catch (err) {
    if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
    if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
      console.warn("[upload] client disconnected mid-upload, partial file removed");
      return;
    }
    if (err instanceof UploadError) {
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.post("/api/rescan", async (req, res, next) => {
  try {
    await library.scan();
    res.json({
      ok: true,
      library: library.publicLibrary(),
      thumbnails: thumbnailQueue.status()
    });
  } catch (err) {
    next(err);
  }
});

function getVideoById(id) {
  return library.findVideo(id);
}

app.get("/stream/:id", async (req, res, next) => {
  try {
    const video = getVideoById(req.params.id);
    if (!video) return res.status(404).send("Video not found");

    const stat = await fsp.stat(video.absolutePath);
    const size = stat.size;
    const range = req.headers.range;

    const contentType = mimeForExtension(video.extension);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);

    if (!range) {
      res.setHeader("Content-Length", size);
      fs.createReadStream(video.absolutePath).pipe(res);
      return;
    }

    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
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

    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", chunkSize);

    fs.createReadStream(video.absolutePath, { start, end }).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.get("/watch", async (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "watch.html"));
});

app.get("/{*splat}", async (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
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
    ".m2ts": "video/mp2t"
  };

  return map[ext.toLowerCase()] || "application/octet-stream";
}

async function start() {
  await library.scan();
  await thumbnailQueue.init();
  await devices.init();

  const hasHttps = fs.existsSync(HTTPS_KEY) && fs.existsSync(HTTPS_CERT);

  let server;

  if (hasHttps) {
    server = https.createServer({
      key: fs.readFileSync(HTTPS_KEY),
      cert: fs.readFileSync(HTTPS_CERT)
    }, app);

    console.log(`HTTPS video server: https://<LAN-IP>:${PORT}`);
  } else {
    server = http.createServer(app);
    console.log(`HTTP video server: http://<LAN-IP>:${PORT}`);
    console.log("HTTPS is enabled automatically when certs/server.key and certs/server.crt exist.");
  }

  // Node's default requestTimeout (5 min) would kill any upload that takes
  // longer than that to arrive - fatal for big files over Wi-Fi.
  server.requestTimeout = 0;

  server.listen(PORT, HOST, () => {
    console.log(`Listening on ${HOST}:${PORT}`);
    devices.startConsole();
  });
}

start().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
