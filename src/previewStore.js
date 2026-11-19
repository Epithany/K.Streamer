const fs = require("fs");
const path = require("path");
const { DATA_DIR, PREVIEW_RECORD_FILE } = require("./config");
const { ensureDir, writeJsonAtomic } = require("./atomic");

// Loaded synchronously once at require-time so library.js can read it
// without going async (it's a small file - one entry per video, not one
// row per frame). Writes still go through the atomic write-then-rename
// path used everywhere else in this app.
function loadSync() {
  try {
    return JSON.parse(fs.readFileSync(PREVIEW_RECORD_FILE, "utf8"));
  } catch {
    return { version: 1, videos: {} };
  }
}

let store = loadSync();

// Per video we only keep a compact summary. The full metadata map (tile grid,
// mip levels, frame timestamps) lives in a JSON file next to the sprite
// sheets and is fetched by the client from `mapUrl`.
//
// format 2 = sprite sheets + metadata map. Older records (one file per
// frame, no `format`) are still readable through get(), but has() reports
// them as missing so the queue regenerates them in the new format.
const PREVIEW_FORMAT = 2;

async function record(videoId, { count, width, height, mapUrl, levels }) {
  store.videos[videoId] = {
    format: PREVIEW_FORMAT,
    count,
    width,
    height,
    mapUrl,
    levels,
    generatedAt: new Date().toISOString()
  };

  await ensureDir(DATA_DIR);
  await writeJsonAtomic(PREVIEW_RECORD_FILE, store);
}

// Legacy (per-frame) records report as "no previews" so clients ask for the
// sprite format instead of requesting files that no longer exist.
function get(videoId) {
  return has(videoId) ? store.videos[videoId] : null;
}

function has(videoId) {
  return store.videos[videoId]?.format === PREVIEW_FORMAT;
}

module.exports = { record, get, has };
