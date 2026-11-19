const crypto = require("crypto");
const { promisify } = require("util");

const { ACCOUNTS_FILE, SESSIONS_FILE, SESSION_DAYS } = require("./config");
const { readJson, writeJsonAtomic } = require("./atomic");
const log = require("./logger").for("auth");

const scrypt = promisify(crypto.scrypt);

// Accounts live in data/accounts.json:
//   { "accounts": [ { "id", "name", "color", "isAdmin", "passwordHash", "createdAt" } ] }
// Passwords are never stored in the clear. Convenience: add an account by hand
// with a plain "password" field and the server hashes it on the next start and
// removes the plain text from the file.

const COOKIE = "ms_session";
const COOKIE_ACCOUNT = "ms_acct"; // readable by scripts: namespaces per-profile local data
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 200;
const DAY = 86400000;
const COLORS = ["#f0344a", "#ff9f1c", "#2ec4b6", "#3a86ff", "#8338ec", "#ff006e", "#80b918", "#fb5607"];

let accounts = [];
const sessions = new Map(); // sha256(token) -> { accountId, createdAt, lastSeen, ip, ua }

const newId = () => `acc-${crypto.randomBytes(6).toString("base64url")}`;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

class AuthError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------- Passwords ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const [N, r, p] = [16384, 8, 1];
  const key = await scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function checkPassword(password) {
  const pw = String(password ?? "");
  if (pw.length < MIN_PASSWORD) throw new AuthError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > MAX_PASSWORD) throw new AuthError(400, "Password is too long");
  return pw;
}

function cleanName(raw) {
  const name = String(raw ?? "").normalize("NFC").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return name;
}

// ---------- Storage ----------
async function saveAccounts() {
  await writeJsonAtomic(ACCOUNTS_FILE, {
    version: 1,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      isAdmin: a.isAdmin,
      createdAt: a.createdAt,
      passwordHash: a.passwordHash,
    })),
  });
}

let persistTimer = null;

// Sessions are saved a second after they change. If the server is stopped in
// that second (restart, Ctrl+C) write them out synchronously instead of losing them.
process.on("exit", () => {
  if (!persistTimer) return;
  try {
    const out = {};
    for (const [hash, s] of sessions) out[hash] = s;
    require("fs").mkdirSync(require("path").dirname(SESSIONS_FILE), { recursive: true });
    require("fs").writeFileSync(SESSIONS_FILE, JSON.stringify({ version: 1, sessions: out }, null, 2));
  } catch {}
});

function persistSessions() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const out = {};
    for (const [hash, s] of sessions) out[hash] = s;
    await writeJsonAtomic(SESSIONS_FILE, { version: 1, sessions: out }).catch((err) =>
      log.warn("could not save sessions", err));
  }, 1000);
  persistTimer.unref?.();
}

async function init() {
  const saved = await readJson(ACCOUNTS_FILE, null); // a corrupt file throws: never overwrite it
  const list = Array.isArray(saved?.accounts) ? saved.accounts : [];
  let dirty = false;
  accounts = [];

  for (const raw of list) {
    const name = cleanName(raw?.name);
    if (!name) { log.warn("skipping an account entry without a name"); continue; }
    if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      log.warn(`skipping duplicate account name "${name}"`);
      continue;
    }
    const account = {
      id: raw.id || newId(),
      name,
      color: raw.color || COLORS[accounts.length % COLORS.length],
      isAdmin: Boolean(raw.isAdmin),
      createdAt: raw.createdAt || new Date().toISOString(),
      passwordHash: raw.passwordHash || "",
    };
    if (!raw.id || !raw.color || !raw.createdAt) dirty = true;

    if (typeof raw.password === "string" && raw.password) {
      account.passwordHash = await hashPassword(checkPassword(raw.password));
      dirty = true; // the plain text is dropped when the file is rewritten
      log.info(`hashed the plain-text password found for "${name}"`);
    }
    if (!account.passwordHash) log.warn(`account "${name}" has no password and cannot sign in until one is set`);
    accounts.push(account);
  }

  if (accounts.length && !accounts.some((a) => a.isAdmin)) {
    accounts[0].isAdmin = true;
    dirty = true;
    log.warn(`no admin found; "${accounts[0].name}" is now the admin`);
  }
  if (dirty) await saveAccounts();

  const savedSessions = await readJson(SESSIONS_FILE, null).catch(() => null);
  const now = Date.now();
  for (const [hash, s] of Object.entries(savedSessions?.sessions || {})) {
    if (accounts.some((a) => a.id === s.accountId) && now - s.lastSeen < SESSION_DAYS * DAY) sessions.set(hash, s);
  }
  log.info(`${accounts.length} account(s), ${sessions.size} active session(s)`);
}

// ---------- Accounts ----------
const publicAccount = (a) => (a ? { id: a.id, name: a.name, color: a.color, isAdmin: a.isAdmin } : null);
const list = () => accounts.map(publicAccount);
const get = (id) => accounts.find((a) => a.id === id) || null;
const needsSetup = () => accounts.length === 0;
const primaryAdminId = () =>
  (accounts.filter((a) => a.isAdmin).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || accounts[0])?.id || null;

async function create({ name, password, color, isAdmin = false }) {
  name = cleanName(name);
  if (!name) throw new AuthError(400, "Enter a name");
  if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new AuthError(409, "That name is already taken");
  const account = {
    id: newId(),
    name,
    color: COLORS.includes(color) ? color : COLORS[accounts.length % COLORS.length],
    isAdmin: Boolean(isAdmin) || accounts.length === 0,
    createdAt: new Date().toISOString(),
    passwordHash: await hashPassword(checkPassword(password)),
  };
  accounts.push(account);
  await saveAccounts();
  log.info(`account created: "${name}"${account.isAdmin ? " (admin)" : ""}`);
  return account;
}

async function setPassword(id, password) {
  const account = get(id);
  if (!account) throw new AuthError(404, "No such account");
  account.passwordHash = await hashPassword(checkPassword(password));
  await saveAccounts();
  log.info(`password changed for "${account.name}"`);
}

async function remove(id) {
  const account = get(id);
  if (!account) throw new AuthError(404, "No such account");
  accounts = accounts.filter((a) => a.id !== id);
  destroyAllFor(id);
  await saveAccounts();
  log.info(`account deleted: "${account.name}"`);
}

// ---------- Sessions ----------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

function sessionFor(token) {
  if (!token) return null;
  const s = sessions.get(sha(token));
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > SESSION_DAYS * DAY || !get(s.accountId)) {
    sessions.delete(sha(token));
    return null;
  }
  if (now - s.lastSeen > 10 * 60 * 1000) { // sliding expiry, written at most every 10 min
    s.lastSeen = now;
    persistSessions();
  }
  return s;
}

// Who owns this cookie? Used by WebSocket handshakes, which Express never sees.
function accountFor(cookieHeader) {
  const session = sessionFor(parseCookies(cookieHeader)[COOKIE]);
  return session ? get(session.accountId) : null;
}

// Express middleware: req.account is the signed-in account (or null).
function attach(req, res, next) {
  req.sessionToken = parseCookies(req.headers.cookie)[COOKIE] || null;
  const s = sessionFor(req.sessionToken);
  req.account = s ? get(s.accountId) : null;
  next();
}

function startSession(req, res, account) {
  if (req.sessionToken) sessions.delete(sha(req.sessionToken)); // switching: the old session dies
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions.set(sha(token), {
    accountId: account.id,
    createdAt: now,
    lastSeen: now,
    ip: String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
    ua: String(req.headers["user-agent"] || "").slice(0, 160),
  });
  persistSessions();

  const secure = req.socket.encrypted ? "; Secure" : "";
  const maxAge = SESSION_DAYS * 86400;
  res.append("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  res.append("Set-Cookie", `${COOKIE_ACCOUNT}=${account.id}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function endSession(req, res) {
  if (req.sessionToken) sessions.delete(sha(req.sessionToken));
  persistSessions();
  res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.append("Set-Cookie", `${COOKIE_ACCOUNT}=; Path=/; SameSite=Lax; Max-Age=0`);
}

function destroyAllFor(accountId, exceptToken = null) {
  const keep = exceptToken ? sha(exceptToken) : null;
  for (const [hash, s] of sessions) if (s.accountId === accountId && hash !== keep) sessions.delete(hash);
  persistSessions();
}

// ---------- Login with throttling ----------
const attempts = new Map(); // "ip|account" -> { count, until }

function throttleWait(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}

function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) a.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (a.count - 5)) * 1000;
  attempts.set(key, a);
}

async function login(req, accountId, password, { silent = false } = {}) {
  const ip = String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const key = `${ip}|${accountId}`;
  const wait = throttleWait(key);
  if (wait) throw new AuthError(429, `Too many attempts. Try again in ${wait}s.`, { retryAfter: wait });

  const account = get(accountId);
  const ok = account && (await verifyPassword(String(password ?? "").slice(0, MAX_PASSWORD), account.passwordHash));
  if (!ok) {
    recordFailure(key);
    log.warn(`failed sign-in for ${account ? `"${account.name}"` : `unknown account ${String(accountId).slice(0, 40)}`} from ${ip}`);
    throw new AuthError(401, "Wrong password");
  }
  attempts.delete(key);
  if (!silent) log.info(`signed in: "${account.name}" from ${ip}`);
  return account;
}

module.exports = {
  AuthError, COLORS, MIN_PASSWORD,
  init, attach, accountFor, list, get, publicAccount, needsSetup, primaryAdminId,
  create, setPassword, remove, verifyPassword,
  startSession, endSession, destroyAllFor, login,
};
