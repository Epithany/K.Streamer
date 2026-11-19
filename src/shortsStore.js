const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { SHORTS_DIR, VIDEO_EXTENSIONS, FFMPEG_PATH, FFPROBE_PATH } = require("./config");

// Shorts is a flat folder, so there's no persisted library: a readdir is
// cheaper than keeping a JSON file in sync. IDs are derived from the file
// name, which keeps them stable across restarts without storing anything.
let byId = new Map();

function idFor(filename) {
  return `short-${crypto.createHash("sha256").update(filename).digest("base64url").slice(0, 11)}`;
}

async function scan() {
  let entries = [];
  try {
    entries = await fs.readdir(SHORTS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[shorts] could not read "${SHORTS_DIR}": ${err.message}`);
  }

  const next = new Map();
  for (const entry of entries) {
    // Dotfiles include in-flight uploads (.upload-*.part).
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;

    const id = idFor(entry.name);
    next.set(id, {
      id,
      name: path.basename(entry.name, ext),
      filename: entry.name,
      extension: ext,
      absolutePath: path.join(SHORTS_DIR, entry.name),
    });
  }
  byId = next;
  return next;
}

function publicShort(short) {
  const { absolutePath, ...safe } = short;
  safe.streamUrl = `/stream/shorts/${encodeURIComponent(short.id)}`;
  return safe;
}

async function list() {
  await scan();
  return [...byId.values()].map(publicShort);
}

async function find(id) {
  if (!byId.has(id)) await scan();
  return byId.get(id) || null;
}

// ---------- ffmpeg ----------
const FORMAT_BY_EXT = {
  ".mp4": "mp4",
  ".m4v": "mp4",
  ".mov": "mov",
  ".webm": "webm",
  ".mkv": "matroska",
  ".avi": "avi",
  ".wmv": "asf",
  ".flv": "flv",
  ".ts": "mpegts",
  ".m2ts": "mpegts",
};

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
      else reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.slice(-800).trim()}`));
    });
  });
}

async function duration(file) {
  const out = await run(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = Number.parseFloat(out);
  if (!Number.isFinite(d)) throw new Error("could not read the video's duration");
  return d;
}

// Cuts the last `seconds` off a video. Stream copy: no re-encode, so it's
// near-instant and lossless even on a weak CPU. Writes to `output` (any
// name - the container is forced from the extension of the original).
async function trimTail(input, output, ext, seconds) {
  const total = await duration(input);
  const keep = total - seconds;
  if (keep < 1) {
    return {
      trimmed: false,
      reason: `only ${total.toFixed(1)}s long, too short to trim - kept as-is`,
    };
  }

  const format = FORMAT_BY_EXT[ext] || "mp4";
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input,
    "-t", keep.toFixed(3),
    "-map", "0:v:0", "-map", "0:a?",
    "-c", "copy",
  ];
  if (format === "mp4" || format === "mov") args.push("-movflags", "+faststart");
  args.push("-f", format, output);

  await run(FFMPEG_PATH, args);
  return { trimmed: true, keptSeconds: keep };
}

module.exports = { list, find, trimTail };
