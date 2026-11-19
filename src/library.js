const fs = require("fs/promises");
const path = require("path");
const { VIDEOS_DIR, LIBRARY_FILE, VIDEO_EXTENSIONS } = require("./config");
const { ensureDir, readJson, writeJsonAtomic, debouncedWriter } = require("./atomic");
const { createVideoId } = require("./ids");
const events = require("./events");
const previewStore = require("./previewStore");

let library = {
  version: 1,
  generatedAt: null,
  videos: [],
  shows: []
};

let scanPromise = null;
let lastSignature = null;

// Thumbnails land one by one; rewriting the whole library file for each is
// wasteful on a slow disk, so those writes are coalesced.
const saver = debouncedWriter(LIBRARY_FILE, () => library, { delay: 1500, pretty: false });

// Videos of one season, in episode order. One pass over `videos` instead of a
// linear search per episode.
function sortIds(ids, videos) {
  const wanted = new Set(ids);
  return videos.filter(v => wanted.has(v.id)).sort(sortEpisodes).map(v => v.id);
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function episodeNumber(name) {
  const m = name.match(/(?:^|[^a-z])e(\d+)(?:[^a-z]|$)/i);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function sortEpisodes(a, b) {
  const an = episodeNumber(a.name);
  const bn = episodeNumber(b.name);

  if (an !== bn) return an - bn;
  return naturalCompare(a.name, b.name);
}

async function listDirectory(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A folder mid-copy or locked by the OS/antivirus shouldn't take the
    // whole scan down - skip it, log it, and pick it up on the next scan.
    console.warn(`[library] could not read "${dir}": ${err.message}`);
    return [];
  }
  return entries.sort((a, b) => naturalCompare(a.name, b.name));
}

async function loadPrevious() {
  const saved = await readJson(LIBRARY_FILE, null);
  if (!saved || !Array.isArray(saved.videos)) return null;
  return saved;
}

function previousByRelativePath(previous) {
  const map = new Map();
  for (const video of previous?.videos || []) {
    if (video.relativePath) map.set(video.relativePath, video);
  }
  return map;
}

function createVideoObject(relativePath, absolutePath, previousMap) {
  const old = previousMap.get(relativePath);
  const ext = path.extname(relativePath).toLowerCase();

  return {
    id: old?.id || createVideoId(),
    // Preserve a title edited in the app when the library is rescanned.
    name: old?.name || path.basename(relativePath, ext),
    filename: path.basename(relativePath),
    extension: ext,
    relativePath,
    absolutePath,
    thumbnail: old?.thumbnail || "",
    showId: null,
    seasonId: null,
    seasonNumber: null,
    episodeNumber: null,
    addedAt: old?.addedAt || new Date().toISOString()
  };
}

async function collectVideos(dir, relativeDir, previousMap) {
  const entries = await listDirectory(dir);
  const result = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      result.push(...await collectVideos(absolute, relative, previousMap));
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      result.push(createVideoObject(relative, absolute, previousMap));
    }
  }

  return result;
}

function makeSeasonId(showId, seasonNumber) {
  return `${showId}:S${seasonNumber}`;
}

async function buildLibrary() {
  console.log("[library] scanning...");
  await ensureDir(VIDEOS_DIR);
  await ensureDir(path.dirname(LIBRARY_FILE));

  const previous = await loadPrevious();
  const previousMap = previousByRelativePath(previous);

  const rootEntries = await listDirectory(VIDEOS_DIR);

  const videos = [];
  const shows = [];

  // Top-level files are standalone videos.
  for (const entry of rootEntries) {
    if (!entry.isFile() || !isVideoFile(entry.name)) continue;

    const relative = entry.name;
    const absolute = path.join(VIDEOS_DIR, entry.name);
    const video = createVideoObject(relative, absolute, previousMap);

    videos.push(video);
  }

  // Each top-level directory becomes a show.
  for (const showEntry of rootEntries) {
    if (!showEntry.isDirectory()) continue;

    try {
      await scanShow(showEntry, previousMap, videos, shows);
    } catch (err) {
      console.error(`[library] failed to scan "${showEntry.name}", skipping this pass:`, err.message);
    }
  }

  // Make sure standalone files are also sorted chronologically by scan/name.
  videos.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));

  // A scan that found nothing new must not rewrite the file or make every
  // open page re-render.
  const signature = videos.map(v => `${v.id}|${v.relativePath}|${v.name}|${v.thumbnail}`).join("\n");
  const changed = signature !== lastSignature;
  lastSignature = signature;

  library = {
    version: 1,
    generatedAt: new Date().toISOString(),
    videos,
    shows
  };

  if (changed) {
    await writeJsonAtomic(LIBRARY_FILE, library, { pretty: false });
    events.emit("library:update", publicLibrary());
  }
  console.log(`[library] scan complete - ${videos.length} videos, ${shows.length} shows`);
  return library;
}

async function scanShow(showEntry, previousMap, videos, shows) {
  const showDir = path.join(VIDEOS_DIR, showEntry.name);
  const showId = cryptoHashId(`show:${showEntry.name}`);
  const show = {
    id: showId,
    name: showEntry.name,
    type: "show",
    seasons: [],
    thumbnail: "",
    videoIds: []
  };

  const children = await listDirectory(showDir);
  const directEpisodes = children.filter(e => e.isFile() && isVideoFile(e.name));
  const seasonDirs = children.filter(e => e.isDirectory());

  if (directEpisodes.length > 0) {
    // A show with files directly inside it is a one-season show.
    const seasonNumber = 1;
    const seasonId = makeSeasonId(showId, seasonNumber);
    const season = {
      id: seasonId,
      name: "Season 1",
      number: 1,
      showId,
      videoIds: []
    };

    for (const entry of directEpisodes.sort((a, b) => naturalCompare(a.name, b.name))) {
      const relative = path.join(showEntry.name, entry.name);
      const absolute = path.join(VIDEOS_DIR, relative);
      const video = createVideoObject(relative, absolute, previousMap);

      video.showId = showId;
      video.seasonId = seasonId;
      video.seasonNumber = 1;
      video.episodeNumber = episodeNumber(video.name);

      videos.push(video);
      season.videoIds.push(video.id);
      show.videoIds.push(video.id);
    }

    season.videoIds = sortIds(season.videoIds, videos);

    show.seasons.push(season);
  }

  // Subdirectories are seasons. Numeric S1/S2/etc. are sorted numerically.
  const parsedSeasons = [];
  for (const seasonEntry of seasonDirs) {
    const m = seasonEntry.name.match(/^s(\d+)$/i);
    const number = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    parsedSeasons.push({ entry: seasonEntry, number });
  }

  parsedSeasons.sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return naturalCompare(a.entry.name, b.entry.name);
  });

  for (const parsed of parsedSeasons) {
    const seasonEntry = parsed.entry;
    const seasonNumber = Number.isFinite(parsed.number)
      ? parsed.number
      : show.seasons.length + 1;

    const seasonId = makeSeasonId(showId, seasonNumber);
    const season = {
      id: seasonId,
      name: /^s\d+$/i.test(seasonEntry.name)
        ? `Season ${seasonNumber}`
        : seasonEntry.name,
      number: seasonNumber,
      folderName: seasonEntry.name,
      showId,
      videoIds: []
    };

    const episodeEntries = await listDirectory(path.join(showDir, seasonEntry.name));

    for (const entry of episodeEntries) {
      if (!entry.isFile() || !isVideoFile(entry.name)) continue;

      const relative = path.join(showEntry.name, seasonEntry.name, entry.name);
      const absolute = path.join(VIDEOS_DIR, relative);
      const video = createVideoObject(relative, absolute, previousMap);

      video.showId = showId;
      video.seasonId = seasonId;
      video.seasonNumber = seasonNumber;
      video.episodeNumber = episodeNumber(video.name);

      videos.push(video);
      season.videoIds.push(video.id);
      show.videoIds.push(video.id);
    }

    season.videoIds = sortIds(season.videoIds, videos);

    if (season.videoIds.length > 0) show.seasons.push(season);
  }

  show.thumbnail =
    show.videoIds.length > 0
      ? (videos.find(v => v.id === show.videoIds[0])?.thumbnail || "")
      : "";

  shows.push(show);
}

function cryptoHashId(input) {
  const crypto = require("crypto");
  return `show-${crypto.createHash("sha256").update(input).digest("base64url").slice(0, 11)}`;
}

async function scan() {
  if (scanPromise) return scanPromise;

  scanPromise = buildLibrary().finally(() => {
    scanPromise = null;
  });

  return scanPromise;
}

async function getLibrary() {
  if (!library.generatedAt) {
    const saved = await readJson(LIBRARY_FILE, null);
    if (saved) library = saved;
    else await scan();
  }

  return library;
}

async function updateThumbnail(videoId, thumbnail) {
  const current = await getLibrary();
  const video = current.videos.find(v => v.id === videoId);
  if (!video) return false;

  video.thumbnail = thumbnail;

  const show = current.shows.find(s => s.id === video.showId);
  if (show && !show.thumbnail) {
    const first = current.videos.find(v => v.id === show.videoIds[0]);
    if (first?.thumbnail) show.thumbnail = first.thumbnail;
  }

  saver.schedule();
  events.emit("library:update", publicLibrary());
  return true;
}

async function updateTitle(videoId, title) {
  const current = await getLibrary();
  const video = current.videos.find(v => v.id === videoId);
  if (!video) return null;

  video.name = title;
  await writeJsonAtomic(LIBRARY_FILE, current, { pretty: false });
  events.emit("library:update", publicLibrary());
  return video;
}

async function relocateVideo(videoId, relativePath) {
  const current = await getLibrary();
  const video = current.videos.find(v => v.id === videoId);
  if (!video) return null;

  video.relativePath = relativePath;
  video.absolutePath = path.join(VIDEOS_DIR, relativePath);
  video.filename = path.basename(relativePath);
  video.extension = path.extname(relativePath).toLowerCase();
  await writeJsonAtomic(LIBRARY_FILE, current, { pretty: false });
  return video;
}

function findVideo(id) {
  return library.videos.find(v => v.id === id) || null;
}

function announcePreviewsReady() {
  // Preview counts live in previewStore, not on the video objects
  // library.js persists - so there's nothing to write here, just a
  // fresh broadcast so connected clients see the new previewCount
  // without waiting for the next poll cycle.
  events.emit("library:update", publicLibrary());
}

function findShow(id) {
  return library.shows.find(s => s.id === id) || null;
}

function findSeason(id) {
  for (const show of library.shows) {
    const season = show.seasons.find(s => s.id === id);
    if (season) return season;
  }
  return null;
}

function publicVideo(video) {
  if (!video) return null;
  const { absolutePath, ...safe } = video;
  safe.url = `/watch?v=${encodeURIComponent(video.id)}`;
  safe.streamUrl = `/stream/${encodeURIComponent(video.id)}`;
  safe.previewCount = previewStore.get(video.id)?.count || 0;
  return safe;
}

function publicLibrary() {
  return {
    version: library.version,
    generatedAt: library.generatedAt,
    videos: library.videos.map(publicVideo),
    shows: library.shows
  };
}

function getPlaylistForVideo(videoId) {
  const video = findVideo(videoId);
  if (!video?.showId) return null;

  const show = findShow(video.showId);
  if (!show) return null;

  const season = show.seasons.find(s => s.id === video.seasonId);
  if (!season) return null;

  return {
    id: season.id,
    name: `${show.name} · ${season.name}`,
    showId: show.id,
    seasonId: season.id,
    videoIds: season.videoIds
  };
}

// A show folder was renamed on disk. Point the saved library at the new paths
// first, so the rescan matches every video to its old id (covers, previews and
// watch history are all keyed by that id) instead of treating them as new files.
async function renameShowFolder(oldName, newName) {
  if (scanPromise) await scanPromise.catch(() => {});
  const current = await getLibrary();
  const oldPrefix = oldName + path.sep;
  for (const v of current.videos) {
    if (!v.relativePath.startsWith(oldPrefix)) continue;
    v.relativePath = path.join(newName, v.relativePath.slice(oldPrefix.length));
    v.absolutePath = path.join(VIDEOS_DIR, v.relativePath);
  }
  await writeJsonAtomic(LIBRARY_FILE, current, { pretty: false });
  return scan();
}

module.exports = {
  scan,
  getLibrary,
  publicLibrary,
  findVideo,
  findShow,
  findSeason,
  getPlaylistForVideo,
  publicVideo,
  updateThumbnail,
  updateTitle,
  relocateVideo,
  announcePreviewsReady,
  renameShowFolder
};
