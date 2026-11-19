const path = require("path");

const ROOT = path.resolve(__dirname, "..");

module.exports = {
  ROOT,
  FFMPEG_PATH: path.join(ROOT, "ffmpeg", "ffmpeg.exe"),
  FFPROBE_PATH: path.join(ROOT, "ffmpeg", "ffprobe.exe"),
  VIDEOS_DIR: path.join(ROOT, "Videos"),
  OLD_DIR: path.join(ROOT, "Old"),
  SHORTS_DIR: path.join(ROOT, "Shorts"),
  // TikTok / Instagram saves end with an outro card; this much is cut off
  // the tail of shorts uploaded from those sources.
  SHORTS_TRIM_SECONDS: Number(process.env.SHORTS_TRIM_SECONDS || 4),

  // Audio library. Top-level folders are playlists; loose files are "Singles".
  SONGS_DIR: path.join(ROOT, "Songs"),
  SONGS_META_FILE: path.join(ROOT, "data", "songMeta.json"),
  COVERS_DIR: path.join(ROOT, "thumbnails", "covers"),
  AUDIO_EXTENSIONS: new Set([
    ".mp3",
    ".m4a",
    ".aac",
    ".wav",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".weba",
  ]),
  // Third-party executables (Stockfish for the chess page). Override with
  // STOCKFISH_PATH; otherwise tools/ is searched on startup.
  TOOLS_DIR: path.join(ROOT, "tools"),
  STOCKFISH_PATH: process.env.STOCKFISH_PATH || "",
  THUMBNAILS_DIR: path.join(ROOT, "thumbnails"),
  PREVIEWS_DIR: path.join(ROOT, "thumbnails", "previews"),
  DATA_DIR: path.join(ROOT, "data"),
  LOGS_DIR: path.join(ROOT, "logs"),

  // Accounts. Everything is JSON under data/; passwords are stored hashed.
  ACCOUNTS_FILE: path.join(ROOT, "data", "accounts.json"),
  SESSIONS_FILE: path.join(ROOT, "data", "sessions.json"),
  ACCESS_FILE: path.join(ROOT, "data", "access.json"),
  PLAYLISTS_FILE: path.join(ROOT, "data", "playlists.json"),
  SESSION_DAYS: Number(process.env.SESSION_DAYS || 30),
  // Files that existed before accounts were introduced belong to the first
  // admin. Until that person decides otherwise they are visible to everyone
  // ("public"); set LEGACY_VISIBILITY=private to hide them by default.
  LEGACY_VISIBILITY: process.env.LEGACY_VISIBILITY === "private" ? "private" : "public",
  LIBRARY_FILE: path.join(ROOT, "data", "library.json"),
  THUMBNAIL_PROCESS_FILE: path.join(ROOT, "data", "thumbnailProcess.json"),
  PREVIEW_RECORD_FILE: path.join(ROOT, "data", "previews.json"),
  MEDIA_INFO_FILE: path.join(ROOT, "data", "mediaInfo.json"),

  HOST: process.env.HOST || "0.0.0.0",
  PORT: Number(process.env.PORT || 443),

  // How often to re-scan Videos/ for changes. No fs watcher - see server.js.
  LIBRARY_POLL_INTERVAL_MS: Math.max(
    2000,
    Number(process.env.LIBRARY_POLL_INTERVAL_MS || 15000),
  ),

  // This machine is also the media host. One FFmpeg process keeps thumbnail
  // work from competing with playback on low-power CPUs; raise explicitly if
  // the host has CPU headroom.
  THUMBNAIL_CONCURRENCY: Math.max(
    1,
    Number(process.env.THUMBNAIL_CONCURRENCY || 1),
  ),

  // Scrubber preview strip: N evenly-spaced frames per video, used for the
  // timeline hover/scrub preview image in the player. These are MAX boxes,
  // not fixed dimensions - a source video is never upscaled past its own
  // resolution, and dimensions preserve the source's actual aspect ratio.
  // See thumbnailQueue.js's fitWithinBox().
  PREVIEW_COUNT: 14,
  PREVIEW_MAX_WIDTH: 320,
  PREVIEW_MAX_HEIGHT: 180,

  THUMBNAIL_MAX_WIDTH: 640,
  THUMBNAIL_MAX_HEIGHT: 360,

  // Supported video extensions.
  VIDEO_EXTENSIONS: new Set([
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".m4v",
    ".avi",
    ".wmv",
    ".flv",
    ".ts",
    ".m2ts",
  ]),

  HTTPS_KEY: path.join(ROOT, "certs", "server.key"),
  HTTPS_CERT: path.join(ROOT, "certs", "server.crt"),
};
