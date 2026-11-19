const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { Chess } = require("chess.js");

const log = require("./logger").for("chess");
const { readJson, writeJsonAtomic } = require("./atomic");
const accounts = require("./accounts");
const { DATA_DIR, TOOLS_DIR, STOCKFISH_PATH } = require("./config");

const STATS_FILE = path.join(DATA_DIR, "chessStats.json");

// Bot strength: an ELO ceiling for the engine plus how long it may think.
const LEVELS = {
  beginner: { label: "Beginner", elo: 1320, ms: 150 },
  casual: { label: "Casual", elo: 1700, ms: 250 },
  club: { label: "Club", elo: 2100, ms: 400 },
  master: { label: "Master", elo: 2600, ms: 700 },
  max: { label: "Maximum", elo: null, ms: 1500 },
};

// ---------- Records ----------
// One win/loss/draw record per account (games against the bot are not counted).
let stats = {};

async function init() {
  stats = (await readJson(STATS_FILE, {})) || {};
  const enginePath = findEngine();
  if (enginePath) log.info(`Stockfish found at ${enginePath}`);
  else log.warn(`no Stockfish in ${TOOLS_DIR} - bot games are disabled until it is added`);
}

const record = (accountId) => stats[accountId] || { w: 0, l: 0, d: 0 };

function saveStats() {
  return writeJsonAtomic(STATS_FILE, stats).catch((error) => log.warn("could not save chess records", error));
}

// ---------- Stockfish ----------
// A UCI engine is a plain executable: commands go in on stdin, lines come back
// on stdout. One process is shared; searches run one at a time.
function findEngine() {
  const override = String(STOCKFISH_PATH || "").trim();
  if (override) return fs.existsSync(override) ? override : null;

  const wanted = /^stockfish(\.exe)?$/i;
  const anyEngine = /^stockfish.*\.exe?$/i;
  const list = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && anyEngine.test(entry.name)) files.push(full);
      else if (entry.isDirectory() && depth > 0) files.push(...list(full, depth - 1));
    }
    return files;
  };

  const found = list(TOOLS_DIR, 2)
    .filter((file) => (/\.exe$/i.test(file) ? process.platform === "win32" : process.platform !== "win32"))
    // A plain stockfish.exe wins over a variant build.
    .sort((a, b) => Number(wanted.test(path.basename(b))) - Number(wanted.test(path.basename(a))) || a.length - b.length);
  return found[0] || null;
}

let engine = null;
let engineReady = false;
let engineCooldownUntil = 0;
let currentJob = null;
let buffer = "";
const jobs = [];

function writeEngine(command) {
  try {
    engine.stdin.write(`${command}\n`);
  } catch (error) {
    log.warn(`could not talk to Stockfish: ${error.message}`);
  }
}

function settle(job, move) {
  clearTimeout(job.timer);
  job.resolve(move);
}

function flushJobs() {
  if (currentJob) {
    settle(currentJob, null);
    currentJob = null;
  }
  for (const job of jobs.splice(0)) settle(job, null);
}

function stopEngine(reason) {
  if (engine) log.warn(`Stockfish stopped (${reason})`);
  engine = null;
  engineReady = false;
  engineCooldownUntil = Date.now() + 30000;
  flushJobs();
}

function onEngineOutput(chunk) {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (line.startsWith("uciok")) {
      engineReady = true;
      pump();
      continue;
    }
    const best = /^bestmove\s+(\S+)/.exec(line);
    if (best && currentJob) {
      const job = currentJob;
      currentJob = null;
      settle(job, best[1]);
      pump();
    }
  }
}

function startEngine() {
  const file = findEngine();
  if (!file) return false;
  try {
    engine = spawn(file, [], { cwd: path.dirname(file), windowsHide: true });
  } catch (error) {
    log.error(`Stockfish could not be started: ${error.message}`);
    engine = null;
    return false;
  }
  engine.stdout.setEncoding("utf8");
  engine.stdout.on("data", onEngineOutput);
  engine.on("error", (error) => {
    log.error(`Stockfish error: ${error.message}`);
    stopEngine("error");
  });
  engine.on("exit", (code) => stopEngine(`exit ${code}`));
  writeEngine("uci");
  return true;
}

function pump() {
  if (currentJob || !jobs.length) return;
  if (Date.now() < engineCooldownUntil || (!engine && !startEngine())) {
    for (const job of jobs.splice(0)) settle(job, null);
    return;
  }
  if (!engineReady) return; // "uciok" calls pump() again

  const job = (currentJob = jobs.shift());
  const level = LEVELS[job.level] || LEVELS.casual;
  writeEngine(`setoption name UCI_LimitStrength value ${level.elo ? "true" : "false"}`);
  if (level.elo) writeEngine(`setoption name UCI_Elo value ${level.elo}`);
  writeEngine(`position fen ${job.fen}`);
  writeEngine(`go movetime ${level.ms}`);
  job.timer = setTimeout(() => writeEngine("stop"), level.ms + 8000);
}

const search = (fen, level) =>
  new Promise((resolve) => {
    jobs.push({ fen, level, resolve });
    pump();
  });

// ---------- Games ----------
const games = new Map();
let queue = null; // quick-match game waiting for an opponent
let wss = null;

// ---------- Who is online ----------
// "Online" means the chess page is open on that account right now, which is
// the only place an invite can land. One account can have several tabs open.
function socketsFor(accountId) {
  if (!wss) return [];
  return [...wss.clients].filter((ws) => ws.account === accountId && ws.readyState === 1);
}

function onlineUsers() {
  if (!wss) return [];
  const seen = new Map();
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || !ws.account) continue;
    const account = accounts.get(ws.account);
    if (account) seen.set(account.id, { id: account.id, name: account.name, color: account.color });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastOnline() {
  if (!wss) return;
  const users = onlineUsers();
  for (const ws of wss.clients) if (ws.account) send(ws, { type: "online", users });
}

const newCode = () => {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase();
  while (games.has(code));
  return code;
};

function newGame() {
  const game = {
    code: newCode(),
    chess: new Chess(),
    seats: { w: null, b: null },
    names: { w: null, b: null },
    socks: new Set(),
    result: null,
    reason: null,
    drawOffer: null,
    last: null,
    invited: null,
    invitedName: null,
    touched: Date.now(),
  };
  games.set(game.code, game);
  return game;
}

// An invite only makes sense while its game is still waiting for the second seat.
function dropGame(game) {
  if (!game) return;
  games.delete(game.code);
  if (queue === game) queue = null;
  if (game.invited) {
    for (const socket of socketsFor(game.invited)) send(socket, { type: "invite-cancelled", code: game.code });
    game.invited = null;
    game.invitedName = null;
  }
}

const seatOf = (game, ws) => (game.seats.w === ws.ident ? "w" : game.seats.b === ws.ident ? "b" : null);
const takeSeat = (game, color, ws) => {
  game.seats[color] = ws.ident;
  game.names[color] = ws.name;
};
const send = (ws, payload) => ws.readyState === 1 && ws.send(JSON.stringify(payload));

function view(game, ws) {
  const chess = game.chess;
  const me = seatOf(game, ws);
  const turn = chess.turn();
  const full = game.seats.w && game.seats.b;
  const online = { w: false, b: false };
  for (const socket of game.socks) {
    const color = seatOf(game, socket);
    if (color) online[color] = true;
  }
  if (game.bot) online[game.bot.color] = true;

  return {
    type: "state",
    code: game.code,
    fen: chess.fen(),
    turn,
    you: me || "s",
    players: game.names,
    online,
    bot: Boolean(game.bot),
    status: game.result ? "over" : full ? "playing" : "waiting",
    result: game.result,
    reason: game.reason,
    check: chess.inCheck() ? turn : null,
    drawOffer: game.drawOffer,
    invited: game.invitedName,
    last: game.last,
    history: chess.history(),
    legal:
      !game.result && full && me === turn
        ? chess.moves({ verbose: true }).map((move) => ({ from: move.from, to: move.to, promo: Boolean(move.promotion) }))
        : [],
  };
}

function broadcast(game) {
  game.touched = Date.now();
  for (const socket of game.socks) send(socket, view(game, socket));
}

function finish(game, result, reason) {
  game.result = result;
  game.reason = reason;
  game.drawOffer = null;

  if (!game.bot) {
    for (const color of ["w", "b"]) {
      const ident = game.seats[color];
      if (!ident || !ident.startsWith("u:")) continue;
      const id = ident.slice(2);
      if (!accounts.get(id)) continue;
      const entry = (stats[id] = { ...record(id) });
      if (result === "1/2-1/2") entry.d += 1;
      else if ((result === "1-0") === (color === "w")) entry.w += 1;
      else entry.l += 1;
    }
    saveStats();
  }

  for (const socket of game.socks) {
    if (socket.account) send(socket, { type: "stats", stats: record(socket.account) });
  }
}

function applyMove(game, from, to, promotion) {
  const move = game.chess.move({
    from,
    to,
    promotion: "qrbn".includes(promotion || "x") ? promotion : undefined,
  });
  game.last = { from: move.from, to: move.to };
  game.drawOffer = null;
  if (game.chess.isCheckmate()) finish(game, move.color === "w" ? "1-0" : "0-1", "checkmate");
  else if (game.chess.isDraw()) {
    finish(
      game,
      "1/2-1/2",
      game.chess.isStalemate()
        ? "stalemate"
        : game.chess.isInsufficientMaterial()
          ? "insufficient material"
          : game.chess.isThreefoldRepetition()
            ? "threefold repetition"
            : "fifty-move rule",
    );
  }
}

async function botTurn(game) {
  const bot = game.bot;
  if (!bot || bot.busy || game.result || game.chess.turn() !== bot.color) return;
  bot.busy = true;
  const move = await search(game.chess.fen(), bot.level);
  bot.busy = false;
  if (!move) {
    log.warn(`Stockfish returned no move for game ${game.code}`);
    for (const socket of game.socks) {
      send(socket, { type: "error", msg: "Stockfish didn't answer. Check the engine file in the tools folder." });
    }
    return;
  }
  if (move === "(none)" || game.result || !games.has(game.code) || game.chess.turn() !== bot.color) return;
  try {
    applyMove(game, move.slice(0, 2), move.slice(2, 4), move[4]);
    broadcast(game);
  } catch (error) {
    log.warn(`Stockfish suggested an illegal move: ${move}`, error);
  }
}

function detach(ws) {
  if (!ws.game) return;
  const game = ws.game;
  game.socks.delete(ws);
  ws.game = null;
  broadcast(game);
}

function join(game, ws) {
  detach(ws);
  let color = seatOf(game, ws);
  if (!color) {
    color = !game.seats.w ? "w" : !game.seats.b ? "b" : null;
    if (color) takeSeat(game, color, ws);
  }
  game.socks.add(ws);
  ws.game = game;
  if (queue === game && game.seats.w && game.seats.b) queue = null;

  // The invited person joining is what accepts the invite.
  if (game.invited && ws.account === game.invited && game.seats.w && game.seats.b) {
    game.invited = null;
    game.invitedName = null;
    for (const socket of game.socks) {
      if (socket !== ws) send(socket, { type: "invite-accepted", code: game.code, by: { name: ws.name } });
    }
    // Other tabs of the invitee still show the notice; clear them.
    for (const socket of socketsFor(ws.account)) {
      if (!game.socks.has(socket)) send(socket, { type: "invite-cancelled", code: game.code });
    }
  }
  broadcast(game);
}

// ---------- Sockets ----------
// The site's sign-in cookie is checked here: Express never sees an upgrade
// request, so the session is resolved straight from the handshake headers.
function attach(server) {
  wss = new WebSocketServer({ server, path: "/chess/ws" });

  wss.on("connection", (ws, req) => {
    const account = accounts.accountFor(req.headers.cookie);
    if (!account) {
      ws.close(1008, "Sign in required");
      return;
    }
    ws.ident = `u:${account.id}`;
    ws.account = account.id;
    ws.name = account.name;
    log.info(`socket opened: ${account.name}`);
    send(ws, {
      type: "welcome",
      id: account.id,
      name: account.name,
      user: account.name,
      color: account.color,
      stats: record(account.id),
      online: onlineUsers(),
    });
    broadcastOnline();

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      const game = ws.game;
      const err = (msg) => send(ws, { type: "error", msg });

      switch (message.type) {
        case "create": {
          detach(ws);
          const next = newGame();
          takeSeat(next, message.color === "b" || (message.color === "r" && Math.random() < 0.5) ? "b" : "w", ws);
          join(next, ws);
          break;
        }
        case "join": {
          const target = games.get(String(message.code || "").toUpperCase());
          if (!target) return err("Game not found.");
          join(target, ws);
          break;
        }
        case "quick": {
          if (queue && !queue.result && !seatOf(queue, ws)) return join(queue, ws);
          detach(ws);
          const next = newGame();
          takeSeat(next, Math.random() < 0.5 ? "w" : "b", ws);
          queue = next;
          join(next, ws);
          break;
        }
        case "bot": {
          if (!findEngine()) {
            return err("Stockfish isn't installed. Put the engine in the server's tools folder and restart.");
          }
          detach(ws);
          const level = LEVELS[message.level] ? message.level : "casual";
          const human =
            message.color === "b" || (message.color === "r" && Math.random() < 0.5) ? "b" : "w";
          const next = newGame();
          const botColor = human === "w" ? "b" : "w";
          takeSeat(next, human, ws);
          next.seats[botColor] = "bot";
          next.names[botColor] = `Stockfish · ${LEVELS[level].label}`;
          next.bot = { color: botColor, level, busy: false };
          join(next, ws);
          botTurn(next);
          break;
        }
        case "invite": {
          const target = accounts.get(String(message.to || ""));
          if (!target) return err("That account doesn't exist any more.");
          if (target.id === ws.account) return err("You can't invite yourself.");
          if (!socketsFor(target.id).length) {
            return err(`${target.name} isn't online right now. Invites only reach people with the chess page open.`);
          }
          detach(ws);
          const next = newGame();
          const human = message.color === "b" || (message.color === "r" && Math.random() < 0.5) ? "b" : "w";
          takeSeat(next, human, ws);
          next.invited = target.id;
          next.invitedName = target.name;
          join(next, ws);
          for (const socket of socketsFor(target.id)) {
            send(socket, { type: "invite", code: next.code, from: { id: ws.account, name: ws.name } });
          }
          send(ws, { type: "invite-sent", code: next.code, to: { id: target.id, name: target.name } });
          break;
        }
        case "inviteCancel": {
          const code = String(message.code || "").toUpperCase();
          const cancel = games.get(code);
          if (!cancel || (cancel.seats.w && cancel.seats.b)) {
            send(ws, { type: "invite-cancelled", code });
            break;
          }
          if (cancel.seats.w !== ws.ident && cancel.seats.b !== ws.ident) return err("That invite isn't yours.");
          dropGame(cancel);
          detach(ws);
          send(ws, { type: "invite-cancelled", code });
          send(ws, { type: "left" });
          break;
        }
        case "inviteDecline": {
          const code = String(message.code || "").toUpperCase();
          const declined = games.get(code);
          const mine = declined && (ws.account === declined.invited || declined.seats.w === ws.ident || declined.seats.b === ws.ident);
          if (!declined || !mine) {
            send(ws, { type: "invite-cancelled", code });
            break;
          }
          for (const socket of declined.socks) send(socket, { type: "invite-declined", code, by: { name: ws.name } });
          dropGame(declined);
          detach(ws);
          send(ws, { type: "invite-cancelled", code });
          send(ws, { type: "left" });
          break;
        }
        case "leave": {
          if (game && game.bot) dropGame(game);
          else if (game && !game.result && !(game.seats.w && game.seats.b) && seatOf(game, ws)) dropGame(game);
          detach(ws);
          send(ws, { type: "left" });
          break;
        }
        case "move": {
          if (!game || game.result) return;
          const me = seatOf(game, ws);
          if (!game.seats.w || !game.seats.b) return err("Waiting for an opponent.");
          if (me !== game.chess.turn()) return err("Not your turn.");
          try {
            applyMove(game, message.from, message.to, message.promotion);
          } catch {
            return err("Illegal move.");
          }
          broadcast(game);
          botTurn(game);
          break;
        }
        case "resign": {
          const me = game && seatOf(game, ws);
          if (!me || game.result || !(game.seats.w && game.seats.b)) return;
          finish(game, me === "w" ? "0-1" : "1-0", "resignation");
          broadcast(game);
          break;
        }
        case "offerDraw": {
          const me = game && seatOf(game, ws);
          if (!me || game.bot || game.result || !(game.seats.w && game.seats.b) || game.drawOffer) return;
          game.drawOffer = me;
          broadcast(game);
          break;
        }
        case "acceptDraw": {
          const me = game && seatOf(game, ws);
          if (!me || game.result || !game.drawOffer || game.drawOffer === me) return;
          finish(game, "1/2-1/2", "agreement");
          broadcast(game);
          break;
        }
        case "declineDraw": {
          const me = game && seatOf(game, ws);
          if (!me || !game.drawOffer || game.drawOffer === me) return;
          game.drawOffer = null;
          broadcast(game);
          break;
        }
      }
    });

    ws.on("close", () => {
      const name = ws.name;
      const game = ws.game;
      detach(ws);
      // A waiting game nobody is sitting in can never start: drop it, which
      // also clears the invite notice on the other person's screen.
      if (game && !game.result && !(game.seats.w && game.seats.b) && !game.socks.size) dropGame(game);
      broadcastOnline();
      if (name) log.info(`socket closed: ${name}`);
    });
  });

  // Drop idle games after two quiet hours.
  const sweep = setInterval(() => {
    for (const game of [...games.values()]) {
      if (!game.socks.size && Date.now() - game.touched > 2 * 3600e3) dropGame(game);
    }
  }, 10 * 60e3);
  sweep.unref?.();

  return wss;
}

module.exports = { attach, init };
