const crypto = require("crypto");
const { promisify } = require("util");
const { ACCOUNTS_FILE, SESSIONS_FILE } = require("./config");
const { readJson, writeJsonAtomic } = require("./atomic");

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const [N, r, p] = [16384, 8, 1];
  const key = await scrypt(password, salt, 64, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

(async () => {
  const [name, given] = process.argv.slice(2);
  if (!name) {
    console.error("Usage: node recacc.js <user> [newPassword]");
    process.exit(1);
  }

  const data = await readJson(ACCOUNTS_FILE, null);
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const account = accounts.find(
    (a) => a.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!account) {
    console.error(
      `No account named "${name}". Existing: ${accounts.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }

  const password = given || crypto.randomBytes(6).toString("base64url"); // 8 chars if none given
  if (password.length < 4) {
    console.error("Password must be at least 4 characters");
    process.exit(1);
  }

  account.passwordHash = await hashPassword(password);
  await writeJsonAtomic(ACCOUNTS_FILE, data);

  // Sign out existing sessions of this account
  const saved = await readJson(SESSIONS_FILE, null).catch(() => null);
  if (saved?.sessions) {
    for (const [hash, s] of Object.entries(saved.sessions)) {
      if (s.accountId === account.id) delete saved.sessions[hash];
    }
    await writeJsonAtomic(SESSIONS_FILE, saved);
  }

  console.log(`Password for "${account.name}" is now: ${password}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
