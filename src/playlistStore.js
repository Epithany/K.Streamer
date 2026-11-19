const crypto = require("crypto");
const { PLAYLISTS_FILE } = require("./config");
const { readJson, writeJsonAtomic } = require("./atomic");

// Per-account saved playlists: data/playlists.json
//   { playlists: [ { id, owner, name, kind: "video" | "song", items: [<content key>], ... } ] }
// Items are stored as content keys (see access.js), so they survive rescans.

let store = { version: 1, playlists: [] };

async function init() {
  const saved = await readJson(PLAYLISTS_FILE, null);
  if (saved && Array.isArray(saved.playlists)) store = { version: 1, playlists: saved.playlists };
}

const save = () => writeJsonAtomic(PLAYLISTS_FILE, store);
const get = (id) => store.playlists.find((p) => p.id === id) || null;
const list = (owner, kind) => store.playlists.filter((p) => p.owner === owner && (!kind || p.kind === kind));

function cleanName(raw) {
  return String(raw ?? "").normalize("NFC").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function create(owner, name, kind) {
  name = cleanName(name);
  if (!name) throw Object.assign(new Error("Enter a playlist name"), { status: 400 });
  if (!["video", "song"].includes(kind)) throw Object.assign(new Error("Unknown playlist type"), { status: 400 });
  if (list(owner, kind).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error("You already have a playlist with that name"), { status: 409 });
  }
  const now = new Date().toISOString();
  const playlist = { id: `pl${crypto.randomBytes(6).toString("base64url")}`, owner, name, kind, items: [], thumbnailVideoId: null, createdAt: now, updatedAt: now };
  store.playlists.push(playlist);
  await save();
  return playlist;
}

async function rename(id, name) {
  const p = get(id);
  name = cleanName(name);
  if (!name) throw Object.assign(new Error("Enter a playlist name"), { status: 400 });
  if (list(p.owner, p.kind).some((q) => q.id !== id && q.name.toLowerCase() === name.toLowerCase())) {
    throw Object.assign(new Error("You already have a playlist with that name"), { status: 409 });
  }
  p.name = name;
  p.updatedAt = new Date().toISOString();
  await save();
}

async function setThumbnail(id, videoId) {
  const p = get(id);
  p.thumbnailVideoId = videoId || null;
  p.updatedAt = new Date().toISOString();
  await save();
}

async function remove(id) {
  store.playlists = store.playlists.filter((p) => p.id !== id);
  await save();
}

async function addItem(id, key) {
  const p = get(id);
  if (!p.items.includes(key)) p.items.push(key);
  p.updatedAt = new Date().toISOString();
  await save();
}

async function removeItem(id, key) {
  const p = get(id);
  p.items = p.items.filter((k) => k !== key);
  p.updatedAt = new Date().toISOString();
  await save();
}

async function removeItemEverywhere(key) {
  let changed = false;
  for (const p of store.playlists) {
    const next = p.items.filter(item => item !== key);
    if (next.length === p.items.length) continue;
    p.items = next;
    if (p.thumbnailVideoId && !next.length) p.thumbnailVideoId = null;
    p.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await save();
}

async function clearThumbnailForVideo(videoId) {
  let changed = false;
  for (const p of store.playlists) {
    if (p.thumbnailVideoId !== videoId) continue;
    p.thumbnailVideoId = null;
    p.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await save();
}

async function removeOwner(owner) {
  store.playlists = store.playlists.filter((p) => p.owner !== owner);
  await save();
}

module.exports = { init, get, list, create, rename, setThumbnail, remove, addItem, removeItem, removeItemEverywhere, clearThumbnailForVideo, removeOwner };
