const { ACCESS_FILE, LEGACY_VISIBILITY } = require("./config");
const { readJson, writeJsonAtomic } = require("./atomic");
const accounts = require("./accounts");
const log = require("./logger").for("auth");

// Who owns each file and who may see it. Records are keyed by the file's
// path, not its id, so they survive library rescans:
//   "video:Show/S1/e1.mp4"   "short:clip.mp4"   "song:Gym/beat.mp3"
// Files with no record predate accounts: owned by the first admin, with
// LEGACY_VISIBILITY. Visibility is "private" (owner only), "public" (every
// account) or "shared" (owner plus the accounts in `shared`).

let store = { version: 1, items: {} };

const norm = (rel) => String(rel).split("\\").join("/");
const keys = {
  video: (rel) => `video:${norm(rel)}`,
  short: (filename) => `short:${norm(filename)}`,
  song: (rel) => `song:${norm(rel)}`,
};

async function init() {
  const saved = await readJson(ACCESS_FILE, null);
  if (saved && typeof saved.items === "object") store = { version: 1, items: saved.items };
}

const save = () => writeJsonAtomic(ACCESS_FILE, store);
const legacyOwner = () => accounts.primaryAdminId();

function record(key) {
  return store.items[key] || { owner: legacyOwner(), visibility: LEGACY_VISIBILITY, shared: [] };
}

function canView(account, key) {
  if (!account) return false;
  const r = record(key);
  if (r.owner === account.id || r.visibility === "public") return true;
  return r.visibility === "shared" && r.shared.includes(account.id);
}

const ownerOf = (key) => record(key).owner;
const isOwner = (account, key) => Boolean(account) && record(key).owner === account.id;
const ownerName = (key) => accounts.get(ownerOf(key))?.name || "Unknown uploader";

function cleanSharing(visibility, shared, owner) {
  if (!["private", "public", "shared"].includes(visibility)) visibility = "private";
  const ids = visibility === "shared"
    ? [...new Set((Array.isArray(shared) ? shared : []).map(String))].filter((id) => id !== owner && accounts.get(id))
    : [];
  // "Specific people" with nobody picked is just private.
  return { visibility: visibility === "shared" && !ids.length ? "private" : visibility, shared: ids };
}

// Called when a file is uploaded.
async function recordUpload(key, ownerId, visibility, shared) {
  store.items[key] = { owner: ownerId, ...cleanSharing(visibility, shared, ownerId), createdAt: new Date().toISOString() };
  await save();
}

async function forget(key) {
  if (store.items[key]) {
    delete store.items[key];
    await save();
  }
}

async function renameKey(oldKey, newKey) {
  if (oldKey === newKey || !store.items[oldKey]) return;
  store.items[newKey] = store.items[oldKey];
  delete store.items[oldKey];
  await save();
}

// Owner changes sharing on files they own. Anything not theirs is skipped.
async function setSharing(account, keyList, visibility, shared) {
  let updated = 0;
  let skipped = 0;
  for (const key of keyList) {
    if (!isOwner(account, key)) { skipped += 1; continue; }
    const prev = store.items[key] || {};
    store.items[key] = { owner: account.id, ...cleanSharing(visibility, shared, account.id), createdAt: prev.createdAt || new Date().toISOString() };
    updated += 1;
  }
  if (updated) await save();
  log.info(`${account.name} changed sharing on ${updated} item(s) -> ${visibility}${skipped ? ` (${skipped} skipped: not theirs)` : ""}`);
  return { updated, skipped };
}

// An account is being deleted: hand its files to the primary admin as private,
// and drop the account from everyone's share lists.
async function releaseAccount(accountId) {
  const heir = legacyOwner();
  let moved = 0;
  for (const rec of Object.values(store.items)) {
    if (rec.owner === accountId) {
      Object.assign(rec, { owner: heir, visibility: "private", shared: [] });
      moved += 1;
    } else if (rec.shared?.includes(accountId)) {
      rec.shared = rec.shared.filter((id) => id !== accountId);
      if (rec.visibility === "shared" && !rec.shared.length) rec.visibility = "private";
    }
  }
  await save();
  return moved;
}

// ---------- Filtering what an account is allowed to see ----------
function filterLibrary(lib, account) {
  const kept = new Map();
  const videos = [];
  for (const v of lib.videos) {
    const key = keys.video(v.relativePath);
    if (!canView(account, key)) continue;
    const r = record(key);
    const out = { ...v, ownerId: r.owner, ownerName: ownerName(key) };
    if (r.owner === account.id) out.visibility = r.visibility;
    videos.push(out);
    kept.set(v.id, out);
  }

  const shows = [];
  for (const s of lib.shows) {
    const videoIds = s.videoIds.filter((id) => kept.has(id));
    if (!videoIds.length) continue;
    const seasons = (s.seasons || [])
      .map((se) => ({ ...se, videoIds: se.videoIds.filter((id) => kept.has(id)) }))
      .filter((se) => se.videoIds.length);
    shows.push({
      ...s,
      videoIds,
      seasons,
      // Recomputed: the original cover could belong to an episode you can't see.
      thumbnail: kept.get(videoIds[0])?.thumbnail || "",
      ownerIds: [...new Set(videoIds.map((id) => kept.get(id).ownerId))],
    });
  }
  return { ...lib, videos, shows };
}

function filterShorts(shorts, account) {
  return shorts
    .filter((s) => canView(account, keys.short(s.filename)))
    .map((s) => {
      const key = keys.short(s.filename);
      return { ...s, ownerId: ownerOf(key), ownerName: ownerName(key) };
    });
}

function filterSongs(snapshot, account) {
  const songs = snapshot.songs
    .filter((s) => canView(account, keys.song(s.relativePath)))
    .map((s) => {
      const key = keys.song(s.relativePath);
      return { ...s, ownerId: ownerOf(key), ownerName: ownerName(key) };
    });
  const ids = new Set(songs.map((s) => s.id));
  const playlists = snapshot.playlists
    .map((p) => ({ ...p, songIds: p.songIds.filter((id) => ids.has(id)) }))
    .filter((p) => p.id === "all" || p.songIds.length);
  return { ...snapshot, songs, playlists };
}

module.exports = {
  keys, init, record, canView, ownerOf, ownerName, isOwner, recordUpload, forget, renameKey, setSharing, releaseAccount,
  filterLibrary, filterShorts, filterSongs,
};
