const fs = require("fs/promises");
const path = require("path");

const fileLocks = new Map();

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Serializes operations per file. The map keeps only the newest tail and
// removes it when nothing is queued behind it (the previous version compared
// against the wrong promise, so entries were never removed).
async function withFileLock(file, operation) {
  const previous = fileLocks.get(file) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  fileLocks.set(file, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  }
}

// Windows can refuse a rename over a file that antivirus or the indexer is
// briefly holding (EPERM / EBUSY / EACCES): retry a few times.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 40 * 2 ** attempt));
    }
  }
}

// opts.pretty: indent for small, human-edited files (accounts, playlists).
// Large machine files (library, previews, media info) default to compact JSON.
async function writeJsonAtomic(file, value, { pretty = true } = {}) {
  return withFileLock(file, async () => {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    const data = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    try {
      await fs.writeFile(tmp, data, "utf8");
      await renameWithRetry(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  });
}

// Coalesces bursts of writes (e.g. one per thumbnail) into one write.
function debouncedWriter(file, getValue, { delay = 1500, pretty = false } = {}) {
  let timer = null;
  let dirty = false;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    await writeJsonAtomic(file, getValue(), { pretty });
  };
  const schedule = () => {
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => flush().catch(() => {}), delay);
      timer.unref?.();
    }
  };
  return { schedule, flush };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

module.exports = { ensureDir, writeJsonAtomic, debouncedWriter, readJson };
