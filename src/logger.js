const fs = require("fs");
const path = require("path");
const util = require("util");

const { LOGS_DIR } = require("./config");

// Everything the server has to say goes to logs/<category>.log - nothing is
// printed to the console. Layout:
//
//   errors.log      every warning + error from every category (start here)
//   server.log      startup, shutdown, environment checks, listen problems
//   http.log        failed requests (5xx always, 4xx apart from expected ones)
//   uploads.log     every upload: accepted, rejected, failed (ffmpeg trim...)
//   library.log     video library scans
//   thumbnails.log  cover + scrubber-preview generation (ffmpeg / ffprobe)
//   songs.log       tag probing, Songs/ scanning
//   shorts.log      Shorts/ scanning
//   devices.log     devices connecting, console commands
//   client.log      errors reported by the browsers (JS errors, playback errors)
//   process.log     uncaught exceptions, unhandled rejections, Node warnings
//
// Each entry starts with a local timestamp, so `grep` / sorting just works:
//   2026-10-20 14:03:22.123 +02:00 ERROR [uploads] message
//       indented details / stack trace
//
// Files rotate at LOG_MAX_BYTES (5 MB) and keep 3 older copies (<name>.1.log...).

const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024);
const BACKUPS = 3;
const FLUSH_MS = 100;
const DEBUG = process.env.LOG_DEBUG === "1";
const APP = "K. Streamer";

const pad = (n, l = 2) => String(n).padStart(l, "0");

function stamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

// ---------- File sinks (batched, synchronous flush: ordered and crash-safe) ----------
let reportedFailure = false;

class Sink {
  constructor(name) {
    this.base = path.join(LOGS_DIR, name);
    this.file = `${this.base}.log`;
    this.buffer = [];
    this.size = null;
    this.timer = null;
  }

  add(line) {
    this.buffer.push(line);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length) return;
    const chunk = this.buffer.join("");
    this.buffer = [];
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      if (this.size === null) {
        try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
      }
      const bytes = Buffer.byteLength(chunk);
      if (this.size > 0 && this.size + bytes > MAX_BYTES) this.rotate();
      fs.appendFileSync(this.file, chunk);
      this.size += bytes;
    } catch (err) {
      // Logging must never take the server down. Say so once, then stay quiet.
      if (!reportedFailure) {
        reportedFailure = true;
        process.stderr.write(`${APP}: cannot write to ${LOGS_DIR}: ${err.message}\n`);
      }
    }
  }

  rotate() {
    for (let i = BACKUPS - 1; i >= 1; i--) {
      try { fs.renameSync(`${this.base}.${i}.log`, `${this.base}.${i + 1}.log`); } catch {}
    }
    try { fs.renameSync(this.file, `${this.base}.1.log`); } catch {}
    this.size = 0;
  }
}

const sinks = new Map();
function sink(name) {
  if (!sinks.has(name)) sinks.set(name, new Sink(name));
  return sinks.get(name);
}

function flush() {
  for (const s of sinks.values()) s.flush();
}

// ---------- Formatting ----------
function detailText(detail) {
  if (detail == null || detail === "") return "";
  if (detail instanceof Error) {
    const extra = [detail.code && `code=${detail.code}`, detail.syscall && `syscall=${detail.syscall}`, detail.path && `path=${detail.path}`]
      .filter(Boolean)
      .join(" ");
    const cause = detail.cause ? `\nCaused by: ${detailText(detail.cause)}` : "";
    return `${detail.stack || String(detail)}${extra ? `\n(${extra})` : ""}${cause}`;
  }
  if (typeof detail === "string") return detail;
  return util.inspect(detail, { depth: 4, breakLength: 120 });
}

function indent(text, spaces) {
  const pre = " ".repeat(spaces);
  return String(text).split(/\r?\n/).map((l) => pre + l).join("\n");
}

function format(level, category, message, detail) {
  const [first, ...rest] = String(message ?? "").split(/\r?\n/);
  let out = `${stamp()} ${level.toUpperCase().padEnd(5)} [${category}] ${first}\n`;
  if (rest.length) out += `${indent(rest.join("\n"), 4)}\n`;
  const d = detailText(detail);
  if (d) out += `${indent(d, 4)}\n`;
  return out;
}

function write(level, category, message, detail) {
  if (level === "debug" && !DEBUG) return;
  category = String(category || "server").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32) || "server";
  const line = format(level, category, message, detail);
  sink(category).add(line);
  if (level === "warn" || level === "error") sink("errors").add(line);
}

function forCategory(category) {
  return {
    debug: (message, detail) => write("debug", category, message, detail),
    info: (message, detail) => write("info", category, message, detail),
    warn: (message, detail) => write("warn", category, message, detail),
    error: (message, detail) => write("error", category, message, detail),
  };
}

// Last resort: log it, flush to disk, leave ONE line on the console so a
// vanished server isn't a mystery, and exit.
function fatal(category, message, err) {
  write("error", category, `FATAL: ${message}`, err);
  flush();
  process.stderr.write(`\n${APP} stopped: ${message}\nDetails: ${path.join(LOGS_DIR, "errors.log")}\n`);
  process.exit(1);
}

// ---------- Hooks ----------
// Anything that still calls console.* is redirected into the log, filed by its
// "[tag]" prefix. The interactive device console doesn't use console.*.
const TAGS = {
  library: "library",
  thumbnail: "thumbnails",
  preview: "thumbnails",
  upload: "uploads",
  songs: "songs",
  shorts: "shorts",
  device: "devices",
  client: "client",
};

function captureConsole() {
  const levels = { log: "info", info: "info", debug: "debug", warn: "warn", error: "error", trace: "debug" };
  for (const [method, level] of Object.entries(levels)) {
    console[method] = (...args) => {
      const text = util.format(...args);
      const tag = /^\[([a-z]+)/i.exec(text)?.[1]?.toLowerCase();
      const category = TAGS[tag] || "server";
      // "[library] scanning..." -> filed in library.log as "scanning...". Tags
      // that carry an id ("[thumbnail abc123] ...") are kept: they say which video.
      write(level, category, TAGS[tag] ? text.replace(/^\[[a-z]+\]\s*/i, "") : text);
    };
  }
}

function installProcessHandlers() {
  process.on("uncaughtException", (err) => fatal("process", "uncaught exception", err));
  process.on("unhandledRejection", (reason) => {
    write("error", "process", "unhandled promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on("warning", (w) => write("warn", "process", `${w.name}: ${w.message}`, w.stack));
  process.on("exit", flush);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      write("info", "server", `shutting down (${signal})`);
      flush();
      process.exit(0);
    });
  }
}

module.exports = {
  LOGS_DIR,
  stamp,
  flush,
  fatal,
  captureConsole,
  installProcessHandlers,
  for: forCategory,
  debug: (c, m, d) => write("debug", c, m, d),
  info: (c, m, d) => write("info", c, m, d),
  warn: (c, m, d) => write("warn", c, m, d),
  error: (c, m, d) => write("error", c, m, d),
};
