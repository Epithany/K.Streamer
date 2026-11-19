const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  SONGS_DIR,
  COVERS_DIR,
  SONGS_META_FILE,
  AUDIO_EXTENSIONS,
  FFMPEG_PATH,
  FFPROBE_PATH,
} = require("./config");
const { ensureDir, readJson, writeJsonAtomic } = require("./atomic");
const log = require("./logger").for("songs");

// Songs/ is scanned straight from disk (like Shorts) - there is no library
// file to keep in sync. IDs come from the relative path, so they are stable
// across restarts. The only thing persisted is tag metadata, because probing
// a few hundred files with ffprobe is worth doing once.
//
//   Songs/<file>             -> "Singles"
//   Songs/<folder>/**/<file> -> playlist named after <folder>
//   everything               -> "All songs"

const hash = (s) => crypto.createHash("sha256").update(s).digest("base64url").slice(0, 11);
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const exists = (f) => fs.access(f).then(() => true, () => false);

let songs = new Map(); // id -> internal song (has absolutePath)
let playlists = [];
let lastScan = 0;
let scanning = null;

// ---------- Scanning ----------
async function walk(dir, rel, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`could not read folder "${dir}"`, err);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(abs, r, out);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ abs, rel: r, name: entry.name });
    }
  }
}

async function doScan() {
  await loadMeta();

  const files = [];
  await walk(SONGS_DIR, "", files);
  files.sort((a, b) => naturalCompare(a.rel, b.rel));

  const next = new Map();
  const folders = new Map();
  const singles = [];

  for (const f of files) {
    let st;
    try {
      st = await fs.stat(f.abs);
    } catch {
      continue; // vanished mid-scan
    }
    const ext = path.extname(f.name).toLowerCase();
    const parts = f.rel.split("/");
    const folder = parts.length > 1 ? parts[0] : null;
    const id = `song-${hash(f.rel)}`;
    const playlistId = folder ? `pl-${hash(folder)}` : "singles";

    next.set(id, {
      id,
      name: path.basename(f.name, ext),
      filename: f.name,
      extension: ext,
      relativePath: f.rel,
      playlistId,
      absolutePath: f.abs,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    });

    if (folder) {
      if (!folders.has(folder)) folders.set(folder, { id: playlistId, name: folder, songIds: [] });
      folders.get(folder).songIds.push(id);
    } else {
      singles.push(id);
    }
  }

  songs = next;
  playlists = [
    { id: "all", name: "All songs", songIds: [...next.keys()] },
    ...[...folders.values()].sort((a, b) => naturalCompare(a.name, b.name)),
  ];
  if (singles.length) playlists.push({ id: "singles", name: "Singles", songIds: singles });

  for (const song of next.values()) if (!metaValid(song)) enqueueProbe(song);
  lastScan = Date.now();
}

function scan(force = false) {
  if (scanning) return scanning;
  if (!force && Date.now() - lastScan < 800) return Promise.resolve();
  scanning = doScan().finally(() => { scanning = null; });
  return scanning;
}

// ---------- Tag metadata (title / artist / album / duration) ----------
let meta = { version: 1, songs: {} };
let metaLoaded = false;

async function loadMeta() {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    const saved = await readJson(SONGS_META_FILE, null);
    if (saved && typeof saved.songs === "object") meta = { version: 1, songs: saved.songs };
  } catch (err) {
    log.warn(`ignoring unreadable ${SONGS_META_FILE} (tags will be re-read)`, err);
  }
}

const metaValid = (song) => {
  const m = meta.songs[song.id];
  return Boolean(m) && m.size === song.size && m.mtimeMs === song.mtimeMs;
};

// One ffprobe at a time: this machine is also the media host.
const probeQueue = [];
const probeQueued = new Set();
let probing = false;

function enqueueProbe(song) {
  if (probeQueued.has(song.id)) return;
  probeQueued.add(song.id);
  probeQueue.push(song);
  pumpProbes();
}

async function pumpProbes() {
  if (probing) return;
  probing = true;
  let sinceSave = 0;
  try {
    while (probeQueue.length) {
      const song = probeQueue.shift();
      try {
        meta.songs[song.id] = { size: song.size, mtimeMs: song.mtimeMs, ...(await probe(song.absolutePath)) };
      } catch (err) {
        log.warn(`could not read tags from "${song.relativePath}"`, err);
        // Remember the failure so a broken file isn't re-probed forever.
        meta.songs[song.id] = { size: song.size, mtimeMs: song.mtimeMs, failed: true };
      }
      probeQueued.delete(song.id);
      if (++sinceSave >= 25) {
        sinceSave = 0;
        await writeJsonAtomic(SONGS_META_FILE, meta).catch(() => {});
      }
    }
  } finally {
    probing = false;
    await writeJsonAtomic(SONGS_META_FILE, meta).catch(() => {});
  }
}

async function probe(file) {
  const out = await run(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=duration:format_tags=title,artist,album,album_artist",
    "-of", "json",
    file,
  ]);
  const format = JSON.parse(out).format || {};
  const tags = {};
  for (const [k, v] of Object.entries(format.tags || {})) tags[k.toLowerCase()] = String(v).trim();
  const duration = Number.parseFloat(format.duration);
  return {
    duration: Number.isFinite(duration) ? duration : null,
    title: tags.title || null,
    artist: tags.artist || tags.album_artist || null,
    album: tags.album || null,
  };
}

// ---------- Public shape ----------
function publicSong(song) {
  const m = metaValid(song) && !meta.songs[song.id].failed ? meta.songs[song.id] : {};
  const id = encodeURIComponent(song.id);
  return {
    id: song.id,
    name: song.name,
    filename: song.filename,
    extension: song.extension,
    relativePath: song.relativePath,
    playlistId: song.playlistId,
    title: m.title || null,
    artist: m.artist || null,
    album: m.album || null,
    duration: m.duration || null,
    url: `/listen?v=${id}`,
    streamUrl: `/stream/songs/${id}`,
  };
}

async function snapshot() {
  await scan();
  return {
    generatedAt: new Date().toISOString(),
    metaPending: probeQueued.size, // the page re-fetches until this hits 0
    playlists,
    songs: [...songs.values()].map(publicSong),
  };
}

async function find(id) {
  if (!songs.has(id)) await scan(true);
  return songs.get(id) || null;
}

// ---------- Cover art ----------
// Pulled out of the file's embedded picture on demand, one ffmpeg at a time.
// "<id>.none" marks files with no art so they are never probed twice.
const coverJobs = new Map();
let coverChain = Promise.resolve();
let ffmpegMissingLogged = false;

async function coverFor(id) {
  const song = await find(id);
  if (!song) return null;

  const jpg = path.join(COVERS_DIR, `${id}.jpg`);
  const none = path.join(COVERS_DIR, `${id}.none`);
  if (await exists(jpg)) return jpg;
  if (await exists(none)) return null;

  if (!coverJobs.has(id)) {
    const job = coverChain
      .then(() => extractCover(song, jpg, none))
      .finally(() => coverJobs.delete(id));
    coverChain = job.catch(() => {});
    coverJobs.set(id, job);
  }
  return coverJobs.get(id);
}

async function extractCover(song, jpg, none) {
  await ensureDir(COVERS_DIR);
  const tmp = `${jpg}.${process.pid}.tmp.jpg`; // ffmpeg picks the encoder from the extension
  try {
    await run(FFMPEG_PATH, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", song.absolutePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", "scale='min(400,iw)':-2",
      "-q:v", "4",
      tmp,
    ]);
    await fs.rename(tmp, jpg);
    return jpg;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (err.code === "ENOENT") {
      // ffmpeg itself is missing: don't cache a "no art" verdict.
      if (!ffmpegMissingLogged) {
        ffmpegMissingLogged = true;
        log.error(`ffmpeg not found at ${FFMPEG_PATH} - cover art is disabled`, err);
      }
      return null;
    }
    await fs.writeFile(none, "").catch(() => {});
    return null;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.slice(-500).trim()}`));
    });
  });
}

// Forces a rescan of Songs/ now (used after an upload and by the live watcher).
const refresh = () => scan(true);

module.exports = { snapshot, find, coverFor, refresh };
