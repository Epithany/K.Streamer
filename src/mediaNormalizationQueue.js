const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  FFMPEG_PATH,
  FFPROBE_PATH,
  VIDEOS_DIR,
  OLD_DIR,
  MEDIA_INFO_FILE,
} = require("./config");
const { ensureDir, readJson, writeJsonAtomic } = require("./atomic");
const { transcode } = require("./mediaTranscoder");
const log = require("./logger").for("media");

let library;
let access;
let store = { version: 1, videos: {} };
const queued = new Set();
const pending = [];
let processing = false;
let initialized = false;

async function init(dependencies) {
  if (initialized) return;
  ({ library, access } = dependencies);
  const saved = await readJson(MEDIA_INFO_FILE, null);
  if (saved?.videos && typeof saved.videos === "object") store = { version: 1, videos: saved.videos };
  for (const [videoId, entry] of Object.entries(store.videos)) {
    if (entry?.status === "processing") delete store.videos[videoId];
  }
  await save();
  initialized = true;
}

const save = () => writeJsonAtomic(MEDIA_INFO_FILE, store);

async function signature(file) {
  const stat = await fs.stat(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function get(video) {
  const entry = store.videos[video.id];
  if (!entry) return null;
  return entry;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} failed (${code}): ${stderr.slice(-2000).trim()}`));
    });
  });
}

async function inspect(file) {
  const output = await run(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=format_name:stream=codec_type,codec_name,pix_fmt,channels",
    "-of", "json",
    file,
  ]);
  const data = JSON.parse(output);
  const video = data.streams?.find(stream => stream.codec_type === "video") || {};
  const audio = data.streams?.find(stream => stream.codec_type === "audio") || {};
  const format = String(data.format?.format_name || "");
  return {
    videoCodec: video.codec_name || null,
    audioCodec: audio.codec_name || null,
    pixelFormat: video.pix_fmt || null,
    audioChannels: Number(audio.channels || 0),
    format,
  };
}

function isBrowserSafe(info, extension) {
  return extension === ".mp4" &&
    info.format.split(",").includes("mp4") &&
    info.videoCodec === "h264" &&
    info.pixelFormat === "yuv420p" &&
    (!info.audioCodec || (info.audioCodec === "aac" && info.audioChannels <= 2));
}

async function set(videoId, value) {
  store.videos[videoId] = value;
  await save();
}

async function process(videoId) {
  const video = library.findVideo(videoId);
  if (!video) return;
  const sourceSignature = await signature(video.absolutePath);
  const info = await inspect(video.absolutePath);
  const compatible = isBrowserSafe(info, video.extension);

  if (compatible) {
    await set(video.id, { status: "ready", ...info, compatible: true, normalized: false, signature: sourceSignature, checkedAt: new Date().toISOString() });
    return;
  }

  const outputRelative = path.join(path.dirname(video.relativePath), `${path.basename(video.relativePath, video.extension)}.mp4`);
  const outputPath = path.join(VIDEOS_DIR, outputRelative);
  if (outputPath !== video.absolutePath) {
    try {
      await fs.access(outputPath);
      throw new Error("A .mp4 file with this name already exists");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  const archivePath = path.join(OLD_DIR, video.relativePath);
  try {
    await fs.access(archivePath);
    throw new Error("An archived copy already exists in Old");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  await ensureDir(path.dirname(archivePath));
  await ensureDir(path.dirname(outputPath));
  const temporaryOutput = path.join(path.dirname(outputPath), `.normalize-${crypto.randomBytes(6).toString("hex")}.mp4`);
  let archived = false;
  try {
    await fs.rename(video.absolutePath, archivePath);
    archived = true;
    await transcode(archivePath, temporaryOutput, "video");
    await fs.rename(temporaryOutput, outputPath);
  } catch (err) {
    await fs.rm(temporaryOutput, { force: true }).catch(() => {});
    if (archived) await fs.rename(archivePath, video.absolutePath).catch(() => {});
    throw err;
  }

  const oldKey = access.keys.video(video.relativePath);
  const updated = await library.relocateVideo(video.id, outputRelative);
  await access.renameKey(oldKey, access.keys.video(outputRelative));
  await library.scan();
  const outputInfo = await inspect(updated.absolutePath);
  await set(video.id, {
    status: "ready",
    ...outputInfo,
    compatible: true,
    normalized: true,
    signature: await signature(updated.absolutePath),
    checkedAt: new Date().toISOString(),
  });
}

async function enqueue(video) {
  if (!initialized) throw new Error("Media normalization queue has not been initialized");
  if (queued.has(video.id) || store.videos[video.id]?.status === "processing") return get(video);
  queued.add(video.id);
  await set(video.id, { status: "processing", checkedAt: new Date().toISOString() });
  pending.push({ id: video.id, relativePath: video.relativePath });
  schedule();
  return get(video);
}

function schedule() {
  setImmediate(() => drain().catch(err => log.error("normalization queue failed", err)));
}

async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (pending.length) {
      const job = pending.shift();
      try {
        await process(job.id);
      } catch (err) {
        log.error(`normalization failed for "${job.relativePath}"`, err);
        await set(job.id, { status: "failed", error: err.message, checkedAt: new Date().toISOString() });
      } finally {
        queued.delete(job.id);
      }
    }
  } finally {
    processing = false;
  }
}

module.exports = { init, get, enqueue };
