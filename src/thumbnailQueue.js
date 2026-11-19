const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const {
  FFMPEG_PATH,
  FFPROBE_PATH,
  THUMBNAILS_DIR,
  PREVIEWS_DIR,
  THUMBNAIL_PROCESS_FILE,
  THUMBNAIL_CONCURRENCY,
  PREVIEW_COUNT,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_MAX_HEIGHT,
} = require("./config");

const { ensureDir, readJson, writeJsonAtomic } = require("./atomic");
const libraryModule = require("./library");
const previewStore = require("./previewStore");
const log = require("./logger").for("thumbnails");

let state = {
  version: 1,
  processing: {},
  finished: {},
  failed: {},
};

// A queued entry records exactly what a client asked for. Covers and timeline
// previews are deliberately separate: generating a cover must never decode a
// full preview strip in the background.
const queued = new Map();
const running = new Set();
let pumpScheduled = false;
let initialized = false;
let paused = false;

function normalizeState(raw) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  return {
    version: 1,
    processing: isObj(raw?.processing) ? raw.processing : {},
    finished: isObj(raw?.finished) ? raw.finished : {},
    failed: isObj(raw?.failed) ? raw.failed : {},
  };
}

async function init() {
  if (initialized) return;
  initialized = true;

  await ensureDir(THUMBNAILS_DIR);
  await ensureDir(PREVIEWS_DIR);

  let loaded = null;
  try {
    loaded = await readJson(THUMBNAIL_PROCESS_FILE, null);
  } catch (err) {
    console.warn(
      `[thumbnail] ignoring unreadable ${THUMBNAIL_PROCESS_FILE}: ${err.message}`,
    );
  }
  state = normalizeState(loaded);

  // A client may no longer need work that was in progress when the process
  // stopped. Drop stale jobs; a visible card or player will request them
  // again if needed.
  for (const [id, job] of Object.entries(state.processing || {})) {
    if (job?.status === "processing") {
      delete state.processing[id];
    }
  }

  await persist();
  schedulePump();
}

async function persist() {
  // This file is private to this module. No other module imports or writes it.
  await writeJsonAtomic(THUMBNAIL_PROCESS_FILE, state);
}

function thumbnailFilename(videoId) {
  return `${videoId}.webp`;
}

function thumbnailRelativePath(videoId) {
  return `/thumbnails/${thumbnailFilename(videoId)}`;
}

async function thumbnailExists(videoId) {
  try {
    await fs.access(path.join(THUMBNAILS_DIR, thumbnailFilename(videoId)));
    return true;
  } catch {
    return false;
  }
}

async function enqueue(
  videoId,
  { cover = true, previews = false, priority = 0 } = {},
) {
  await init();

  const video = libraryModule.findVideo(videoId);
  if (!video) return;

  const needsCover =
    cover && !(video.thumbnail && (await thumbnailExists(videoId)));
  const needsPreviews = previews && !previewStore.has(videoId);
  if (!needsCover && !needsPreviews) {
    return;
  }

  // Merge requests for the same video. A preview request gets priority over
  // cards that merely entered the viewport.
  const existing = queued.get(videoId) || {
    cover: false,
    previews: false,
    priority: 0,
  };
  queued.set(videoId, {
    cover: existing.cover || needsCover,
    previews: existing.previews || needsPreviews,
    priority: Math.max(existing.priority, priority),
  });
  schedulePump();
}

function schedulePump() {
  if (paused || pumpScheduled) return;
  pumpScheduled = true;

  setImmediate(() => {
    pumpScheduled = false;
    pump().catch((err) => console.error("[thumbnail worker]", err));
  });
}

async function pump() {
  await init();
  if (paused) return;

  while (running.size < THUMBNAIL_CONCURRENCY) {
    const next = [...queued.entries()].sort(
      ([, a], [, b]) => b.priority - a.priority,
    )[0];
    if (!next) break;

    const [videoId, request] = next;
    queued.delete(videoId);
    running.add(videoId);

    runJob(videoId, request)
      .catch((err) => console.error(`[thumbnail ${videoId}]`, err))
      .finally(() => {
        running.delete(videoId);
        schedulePump();
      });
  }
}

function setPaused(value) {
  paused = Boolean(value);
  if (!paused) schedulePump();
}

function isBusy() {
  return queued.size > 0 || running.size > 0;
}

// Fit srcW x srcH inside a maxW x maxH box, preserving aspect ratio, and
// NEVER upscaling - if the source is already smaller than the box, the
// source's own resolution wins. Dimensions are rounded down to even
// numbers, which most video/image encoders require or strongly prefer.
function fitWithinBox(srcW, srcH, maxW, maxH) {
  if (!srcW || !srcH) {
    // Couldn't read the source's real resolution - fall back to the box
    // itself rather than guessing an aspect ratio.
    return { width: maxW - (maxW % 2), height: maxH - (maxH % 2) };
  }

  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  const width = Math.max(2, Math.floor((srcW * scale) / 2) * 2);
  const height = Math.max(2, Math.floor((srcH * scale) / 2) * 2);
  return { width, height };
}

async function runJob(videoId, request) {
  const video = libraryModule.findVideo(videoId);
  if (!video) return;

  const output = path.join(THUMBNAILS_DIR, thumbnailFilename(videoId));
  const needsCover = request.cover && !(await thumbnailExists(videoId));
  const needsPreviews = request.previews && !previewStore.has(videoId);

  if (request.cover && !needsCover) {
    // Cover already on disk - make sure the library record points at it,
    // then still fall through to check the preview strip below.
    await libraryModule.updateThumbnail(
      videoId,
      thumbnailRelativePath(videoId),
    );
  }

  if (!needsCover && !needsPreviews) return;

  let info;
  try {
    info = await getVideoInfo(video.absolutePath);
  } catch (err) {
    log.error(`ffprobe failed for "${video.relativePath}"`, err);
    state.failed[videoId] = {
      videoId,
      error: err.message,
      failedAt: new Date().toISOString(),
    };
    await persist();
    return;
  }

  const { duration, width: srcW, height: srcH } = info;

  if (needsCover) {
    const middleTimestamp = Math.max(0, (duration * 2) / 6);
    const dims = fitWithinBox(
      srcW,
      srcH,
      THUMBNAIL_MAX_WIDTH,
      THUMBNAIL_MAX_HEIGHT,
    );

    state.processing[videoId] = {
      videoId,
      input: video.relativePath,
      output: thumbnailRelativePath(videoId),
      status: "processing",
      startedAt: new Date().toISOString(),
    };
    delete state.failed[videoId];
    await persist();

    try {
      await ffmpegThumbnail(video.absolutePath, middleTimestamp, dims, output);

      state.finished[videoId] = {
        videoId,
        output: thumbnailRelativePath(videoId),
        finishedAt: new Date().toISOString(),
      };

      delete state.processing[videoId];
      delete state.failed[videoId];

      await persist();
      await libraryModule.updateThumbnail(
        videoId,
        thumbnailRelativePath(videoId),
      );

      // Finished jobs are removed from the process list after being persisted
      // as finished, keeping the file useful for inspection without allowing it
      // to become an ever-growing queue.
      delete state.finished[videoId];
      await persist();
    } catch (err) {
      log.error(`cover generation failed for "${video.relativePath}"`, err);
      delete state.processing[videoId];

      state.failed[videoId] = {
        videoId,
        error: err.message,
        failedAt: new Date().toISOString(),
      };

      await persist();
    }
  }

  if (needsPreviews) {
    try {
      await generatePreviewSprites(video, duration, srcW, srcH);
    } catch (err) {
      // Preview sprites failing shouldn't be treated as the whole job failing -
      // the cover thumbnail (the important part) may have worked fine.
      log.error(`preview sprites failed for "${video.relativePath}"`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Preview sprites + metadata map
//
// Instead of PREVIEW_COUNT separate .webp files, each video gets:
//   - one sprite sheet per mip level (a grid of evenly spaced frames), and
//   - one JSON metadata map describing the grid, the levels and each
//     frame's timestamp.
// All levels come out of a single ffmpeg decode (split filter), so adding
// mip levels costs scaling time, not extra decoding.
//
// Level 0 is the largest. Each following level is half the size of the
// previous one (PREVIEW_MIP_SCALES), so a client can pick the smallest
// level that still covers the size it is drawing at.
// ---------------------------------------------------------------------------
const PREVIEW_MIP_SCALES = [1, 0.5, 0.25];
const MAX_WEBP_DIMENSION = 16383;
const MIN_MIP_TILE_WIDTH = 32;

function spriteFilename(videoId, level) {
  return `${videoId}-sprite-L${level}.webp`;
}

function mapFilename(videoId) {
  return `${videoId}-map.json`;
}

function previewUrlFor(file) {
  // PREVIEWS_DIR is thumbnails/previews on disk, and only /thumbnails
  // is mounted as a static route - so the URL needs that prefix too.
  return `/thumbnails/previews/${file}`;
}

// Builds the mip chain: level 0 fits the preview box, every other level is a
// scaled-down copy. Levels that would end up the same size (tiny sources never
// upscale) or too small to be useful are dropped.
function planMipLevels(srcW, srcH, count) {
  const levels = [];
  const seen = new Set();

  for (const scale of PREVIEW_MIP_SCALES) {
    const dims = fitWithinBox(
      srcW,
      srcH,
      PREVIEW_MAX_WIDTH * scale,
      PREVIEW_MAX_HEIGHT * scale,
    );
    if (levels.length > 0 && dims.width < MIN_MIP_TILE_WIDTH) continue;
    if (seen.has(dims.width)) continue;
    seen.add(dims.width);

    // Near-square grid, shrunk if the sheet would exceed the WebP size limit.
    let cols = Math.ceil(Math.sqrt(count));
    cols = Math.max(
      1,
      Math.min(cols, Math.floor(MAX_WEBP_DIMENSION / dims.width)),
    );
    const rows = Math.ceil(count / cols);

    if (rows * dims.height > MAX_WEBP_DIMENSION) {
      throw new Error(
        `sprite sheet for ${count} frames at ${dims.width}x${dims.height} exceeds WebP limits`,
      );
    }

    levels.push({
      level: levels.length,
      tileWidth: dims.width,
      tileHeight: dims.height,
      cols,
      rows,
      sheetWidth: cols * dims.width,
      sheetHeight: rows * dims.height,
    });
  }

  return levels;
}

async function generatePreviewSprites(video, duration, srcW, srcH) {
  // Frames sit at step, 2*step, ... N*step - the very first/last instants
  // (often black frames or logos) are skipped on purpose.
  let step = Math.max(0.5, duration / (PREVIEW_COUNT + 1));
  if (step >= duration) step = duration / 2; // very short clips
  const count = Math.max(
    1,
    Math.min(PREVIEW_COUNT, Math.floor(duration / step - 1e-6)),
  );
  const times = Array.from({ length: count }, (_, i) =>
    Number(((i + 1) * step).toFixed(3)),
  );

  const levels = planMipLevels(srcW, srcH, count);
  for (const lvl of levels) {
    lvl.file = path.join(PREVIEWS_DIR, spriteFilename(video.id, lvl.level));
  }

  await ffmpegPreviewSprites(video.absolutePath, step, levels);

  const version = Date.now();
  const map = {
    version: 2,
    videoId: video.id,
    generatedAt: new Date(version).toISOString(),
    duration,
    interval: step,
    count,
    times,
    source: { width: srcW, height: srcH },
    // Ordered largest -> smallest. Frame i lives at
    //   x = (i % cols) * tileWidth,  y = floor(i / cols) * tileHeight
    levels: levels.map((l) => ({
      level: l.level,
      url: `${previewUrlFor(spriteFilename(video.id, l.level))}?v=${version}`,
      tileWidth: l.tileWidth,
      tileHeight: l.tileHeight,
      cols: l.cols,
      rows: l.rows,
      sheetWidth: l.sheetWidth,
      sheetHeight: l.sheetHeight,
    })),
  };

  await writeJsonAtomic(path.join(PREVIEWS_DIR, mapFilename(video.id)), map);

  await previewStore.record(video.id, {
    count,
    width: levels[0].tileWidth,
    height: levels[0].tileHeight,
    mapUrl: `${previewUrlFor(mapFilename(video.id))}?v=${version}`,
    levels: levels.length,
  });

  await removeLegacyPreviewFrames(video.id);
  libraryModule.announcePreviewsReady();
}

// Old format: one <id>-NN.webp per frame. Best-effort cleanup once the
// sprite sheets exist.
async function removeLegacyPreviewFrames(videoId) {
  try {
    const prefix = `${videoId}-`;
    for (const name of await fs.readdir(PREVIEWS_DIR)) {
      if (name.startsWith(prefix) && /^\d\d\.webp$/.test(name.slice(prefix.length))) {
        await fs.rm(path.join(PREVIEWS_DIR, name), { force: true });
      }
    }
  } catch {
    // Leftover files are harmless.
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// One ffprobe call gets both duration and the source's real resolution -
// dimensions are what drive fitWithinBox(), so we can't skip reading them.
function getVideoInfo(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFPROBE_PATH,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        file,
      ],
      {
        windowsHide: true,
      },
    );

    let output = "";
    let error = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (${code}): ${error.trim()}`));
        return;
      }

      try {
        const data = JSON.parse(output);
        const stream = data.streams?.[0] || {};
        const duration = Number.parseFloat(data.format?.duration);

        if (!Number.isFinite(duration)) {
          throw new Error("no valid duration in ffprobe output");
        }

        resolve({
          duration,
          width: stream.width || 0,
          height: stream.height || 0,
        });
      } catch (err) {
        reject(new Error(`ffprobe returned unexpected output: ${err.message}`));
      }
    });
  });
}

function ffmpegThumbnail(input, timestamp, dims, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG_PATH,
      [
        "-y",
        "-ss",
        String(timestamp),
        "-i",
        input,
        "-vframes",
        "1",
        "-vf",
        `scale=${dims.width}:${dims.height}`,
        "-c:v",
        "libwebp",
        "-quality",
        "80",
        output,
      ],
      {
        windowsHide: true,
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-3000)}`));
    });
  });
}

function ffmpegPreviewSprites(input, step, levels) {
  return new Promise((resolve, reject) => {
    // One decode, one filter graph, one output per mip level. Seeking to
    // `step` first makes the fps filter land on step, 2*step, ... Each
    // `tile` emits a single sheet once all frames have arrived.
    const n = levels.length;
    const branches = levels.map(
      (l, i) =>
        `[s${i}]scale=${l.tileWidth}:${l.tileHeight},tile=${l.cols}x${l.rows}:padding=0:margin=0:color=black[t${i}]`,
    );
    const head =
      n === 1
        ? `[0:v]fps=1/${step.toFixed(4)}[s0]`
        : `[0:v]fps=1/${step.toFixed(4)},split=${n}${levels.map((_, i) => `[s${i}]`).join("")}`;
    const filter = [head, ...branches].join(";");

    // -skip_frame nokey: decode keyframes only. The fps filter would otherwise
    // decode every frame of the whole film just to keep one per `step` seconds.
    const args = ["-y", "-skip_frame", "nokey", "-ss", String(step), "-i", input, "-an", "-sn", "-filter_complex", filter];

    levels.forEach((l, i) => {
      args.push(
        "-map", `[t${i}]`,
        "-frames:v", "1",
        "-c:v", "libwebp",
        "-quality", "70",
        "-update", "1",
        l.file,
      );
    });

    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg preview sprites failed (${code}): ${stderr.slice(-2000)}`,
          ),
        );
    });
  });
}

function status() {
  return {
    queued: [...queued.entries()].map(([videoId, request]) => ({
      videoId,
      ...request,
    })),
    running: [...running],
    processing: Object.values(state.processing),
    failed: Object.values(state.failed),
  };
}

module.exports = {
  init,
  enqueue,
  status,
  setPaused,
  isBusy,
};
