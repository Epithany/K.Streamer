const fs = require("fs/promises");
const path = require("path");
const readline = require("readline");
const { writeJsonAtomic } = require("./atomic");

const log = require("./logger").for("devices");
// The device console is interactive output, not a log: it stays on the terminal.
const print = (...args) => process.stdout.write(`${args.join(" ")}\n`);

const DEVICE_FILE = path.join(__dirname, "..", "data", "devices.json");
const sockets = new Map();
let devices = {};

// ---------- What a device can be asked to do ----------
// One catalogue feeds the server terminal, the browser console and the Remote
// page, so the GUI can only offer commands some page actually handles.
// `pages` limits a group to pages whose script implements it; empty = all pages.
const COMMAND_GROUPS = [
  {
    id: "playback",
    title: "Playback",
    icon: "fa-clapperboard",
    pages: ["/watch"],
    controls: [
      { label: "Play", icon: "fa-play", command: "video-play" },
      { label: "Pause", icon: "fa-pause", command: "video-pause" },
      { label: "Play / pause", icon: "fa-circle-play", command: "video-toggle-play" },
      { label: "Back 10s", icon: "fa-rotate-left", command: "video-skip-back-10" },
      { label: "Forward 10s", icon: "fa-rotate-right", command: "video-skip-forward-10" },
      { label: "Skip intro", icon: "fa-forward-fast", command: "video-skip-intro" },
      { label: "Skip outro", icon: "fa-angles-right", command: "video-skip-outro" },
      { label: "Previous", icon: "fa-backward", command: "video-previous" },
      { label: "Next", icon: "fa-forward", command: "video-next" },
      { label: "Fullscreen", icon: "fa-expand", command: "video-f-screen" },
      { label: "Episodes", icon: "fa-list", command: "video-episodes" },
      { label: "Mini player", icon: "fa-window-restore", command: "video-mini-player" },
      { type: "range", label: "Volume", command: "video-volume-value", min: 0, max: 100, step: 5, value: 50, unit: "%" },
      {
        type: "select", label: "Autoplay", command: "video-autoplay", value: "on",
        options: [{ label: "On", value: "on" }, { label: "Off", value: "off" }],
      },
    ],
  },
  {
    id: "music",
    title: "Music",
    icon: "fa-music",
    pages: ["/listen"],
    controls: [
      { label: "Play", icon: "fa-play", command: "audio-play" },
      { label: "Pause", icon: "fa-pause", command: "audio-pause" },
      { label: "Play / pause", icon: "fa-circle-play", command: "audio-toggle-play" },
      { label: "Back 10s", icon: "fa-rotate-left", command: "audio-skip-back-10" },
      { label: "Forward 10s", icon: "fa-rotate-right", command: "audio-skip-forward-10" },
      { label: "Previous", icon: "fa-backward", command: "audio-previous" },
      { label: "Next", icon: "fa-forward", command: "audio-next" },
      {
        type: "select", label: "Shuffle", command: "audio-shuffle", value: "off",
        options: [{ label: "On", value: "on" }, { label: "Off", value: "off" }],
      },
      {
        type: "select", label: "Autoplay", command: "audio-autoplay", value: "on",
        options: [{ label: "On", value: "on" }, { label: "Off", value: "off" }],
      },
      { type: "range", label: "Volume", command: "audio-volume-value", min: 0, max: 100, step: 5, value: 50, unit: "%" },
    ],
  },
  {
    id: "navigation",
    title: "Navigation",
    icon: "fa-compass",
    pages: [],
    controls: [
      { label: "Open sidebar", icon: "fa-bars", command: "sidebar-open" },
      { label: "Scroll up", icon: "fa-arrow-up", command: "page-button-click-up" },
      { label: "Scroll down", icon: "fa-arrow-down", command: "page-button-click-down" },
      { label: "Playlist up", icon: "fa-chevron-up", command: "playlist-button-click-up" },
      { label: "Playlist down", icon: "fa-chevron-down", command: "playlist-button-click-down" },
      { label: "Playlist", icon: "fa-rectangle-list", command: "playlist-button-click" },
      {
        type: "number", label: "Scroll by (px)", command: "scroll-page", placeholder: "500",
        min: 100, max: 5000, step: 100, value: 500,
      },
      {
        type: "text", label: "Point at", command: "move-cursor", placeholder: "320,180 or #menuBtn",
      },
    ],
  },
  {
    id: "page",
    title: "This page",
    icon: "fa-window-maximize",
    pages: [],
    controls: [
      { label: "Reload page", icon: "fa-rotate", command: "reload" },
      { label: "Refresh styles", icon: "fa-wand-magic-sparkles", command: "refresh-styles" },
      { type: "text", label: "Open page", command: "page-", prefix: true, placeholder: "/watch?v=…" },
      { type: "text", label: "Play video id", command: "video-play-", prefix: true, placeholder: "video id" },
    ],
  },
  {
    id: "messages",
    title: "Message",
    icon: "fa-comment",
    pages: [],
    controls: [
      { type: "text", label: "Show on screen", command: "send-message", placeholder: "Movie starts in five minutes" },
    ],
  },
];

// Commands that carry their argument in the name: page-<path>, video-play-<id>.
const PREFIX_COMMANDS = ["page-", "video-play-"];

function allowedCommand(command) {
  const name = String(command || "");
  if (!name || name.length > 200) return false;
  return COMMAND_GROUPS.some((group) => group.controls.some((control) => control.command === name)) ||
    PREFIX_COMMANDS.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

// ---------- Registration ----------
async function init() {
  try {
    devices = JSON.parse(await fs.readFile(DEVICE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function ipOf(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
}

function safeName(name) {
  return String(name || "").trim().replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 48);
}

// Which icon the Remote page draws: a TV, a phone, a tablet or a computer.
function kindOf(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (/smart-tv|smarttv|hbbtv|netcast|viera|bravia|webos|tizen|appletv|googletv|android tv|crkey|roku|aft[bmst]|fire tv|firetv|playstation|xbox|nintendo/.test(ua)) {
    return "tv";
  }
  if (/ipad|tablet|kindle|silk|playbook/.test(ua)) return "tablet";
  if (/android/.test(ua) && !/mobile/.test(ua)) return "tablet";
  if (/mobile|iphone|ipod|android|windows phone/.test(ua)) return "phone";
  return "laptop";
}

function save() {
  return writeJsonAtomic(DEVICE_FILE, devices);
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name || null,
    kind: device.kind || "laptop",
    ip: device.ip,
    page: device.page || "unknown",
    watching: device.watching || null,
    connected: sockets.has(device.id),
    lastSeen: device.lastSeen,
  };
}

function list() {
  return Object.values(devices).filter(device => sockets.has(device.id)).map(publicDevice);
}

function send(id, payload) {
  const response = sockets.get(id);
  if (!response || response.writableEnded) return false;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function find(target) {
  const key = String(target || "").trim().toLowerCase();
  if (key === "all") return list();
  return list().filter(device =>
    device.id === target ||
    device.ip === target ||
    String(device.name || "").toLowerCase() === key,
  );
}

function attach(app) {
  app.get("/api/device/events", (req, res) => {
    const id = String(req.query.id || "").slice(0, 80);
    if (!id) return res.status(400).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");
    sockets.set(id, res);
    log.info(`connected: ${devices[id]?.name || "unnamed"} (${id}) from ${ipOf(req)}`);
    if (devices[id]) send(id, { type: "identity", name: devices[id].name || null });
    req.on("close", () => {
      if (sockets.get(id) === res) sockets.delete(id);
      log.info(`disconnected: ${devices[id]?.name || "unnamed"} (${id})`);
    });
  });

  app.post("/api/device/heartbeat", async (req, res, next) => {
    try {
      const id = String(req.body?.id || "").slice(0, 80);
      if (!id) return res.status(400).json({ error: "Missing device id" });
      if (!devices[id]) log.info(`new device registered: ${id} from ${ipOf(req)} on ${String(req.body?.page || "unknown").slice(0, 120)}`);
      const current = devices[id] || { id };
      const requestedName = safeName(req.body?.name);
      devices[id] = {
        ...current,
        id,
        ip: ipOf(req),
        kind: kindOf(req.headers["user-agent"]),
        name: current.name || requestedName || null,
        page: String(req.body?.page || "unknown").slice(0, 120),
        watching: req.body?.watching || null,
        lastSeen: new Date().toISOString(),
      };
      await save();
      res.json({ ok: true, name: devices[id].name });
    } catch (error) {
      next(error);
    }
  });

  // ---------- Remote page ----------
  app.get("/api/devices", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ devices: list(), commands: COMMAND_GROUPS });
  });

  app.post("/api/devices/:id/command", (req, res) => {
    const device = devices[req.params.id];
    if (!device || !sockets.has(device.id)) return res.status(404).json({ error: "That device is not connected" });

    const command = String(req.body?.command || "").slice(0, 200);
    if (!allowedCommand(command)) return res.status(400).json({ error: "Unknown command" });

    const raw = Array.isArray(req.body?.args?.values) ? req.body.args.values.slice(0, 5) : [];
    const values = raw.map((value) => String(value).slice(0, 300));
    if (!values.length && req.body?.args?.message !== undefined) values.push(String(req.body.args.message).slice(0, 300));
    const args = command === "send-message" ? { message: values.join(" ") } : { values };
    send(device.id, { type: "command", command, args });
    log.info(`remote: ${req.account?.name || "someone"} sent ${command} to ${device.name || device.ip}`);
    res.json({ ok: true });
  });

  app.post("/api/devices/:id/name", async (req, res, next) => {
    try {
      const device = devices[req.params.id];
      if (!device) return res.status(404).json({ error: "Unknown device" });
      const name = safeName(req.body?.name);
      if (!name) return res.status(400).json({ error: "A name is required" });
      device.name = name;
      send(device.id, { type: "set-name", name });
      await save();
      log.info(`remote: ${req.account?.name || "someone"} named ${device.ip} "${name}"`);
      res.json({ ok: true, name });
    } catch (error) {
      next(error);
    }
  });

  // The browser console: same commands as the server terminal, one line at a time.
  app.post("/api/console", async (req, res, next) => {
    try {
      const line = String(req.body?.line || "").slice(0, 500);
      if (!line.trim()) return res.status(400).json({ error: "Type a command" });
      const lines = [];
      await execute(line, (text) => lines.push(String(text)), {
        actor: req.account?.name,
        canRestart: Boolean(req.account?.isAdmin),
      });
      res.json({ lines });
    } catch (error) {
      next(error);
    }
  });
}

function emit(target, command, args) {
  const matches = find(target);
  for (const device of matches) send(device.id, { type: "command", command, args });
  return matches;
}

function help(output) {
  for (const line of [
    "Commands:",
    "  /device list                        connected devices",
    "  /device <name|ip|id|all> <command>  send a command",
    "  /device <name|ip|id> register-name <name>",
    "  /reload [name|ip|id|all]            reload page(s), keeping playback",
    "  /devices                            same as /device list",
    "  /restart                            restart the server (admins only here)",
    "  /help                               this list",
    "The same console with buttons for every command is at /remote",
  ]) output(line);
}

async function execute(line, output = print, options = {}) {
  const text = String(line || "").trim();
  if (!text) return;
  const actor = options.actor ? ` (${options.actor})` : "";
  log.info(`console command${actor}: ${text}`);
  const parts = text.match(/(?:[^\s"]+|\"[^\"]*\")+/g) || [];
  let prefix = parts.shift()?.toLowerCase();

  if (prefix === "/help" || prefix === "/?") return help(output);

  if (prefix === "/restart") {
    if (options.canRestart === false) return output("Only an admin can restart the server.");
    log.info(`restart requested${actor}`);
    output("Restarting the server…");
    // The watchdog starts the server again; give the response time to arrive.
    setTimeout(() => process.exit(0), 400);
    return;
  }

  if (prefix === "/devices") {
    prefix = "/device";
    parts.unshift("list");
  }

  if (prefix === "/reload") {
    const target = parts.shift() || "all";
    const matches = emit(target, "reload", { values: [] });
    return output(matches.length ? `Reloading ${matches.length} device(s).` : `No active device matches '${target}'.`);
  }
  if (prefix !== "/device") {
    return output("Commands start with /device. Try /help");
  }
  const target = parts.shift();
  if (!target) return output("Usage: /device list | /device <name|ip|all> <command>");
  if (target.toLowerCase() === "list") {
    const active = list();
    if (!active.length) return output("No active devices.");
    active.forEach(device => output(`${device.name || "unnamed"}\t${device.kind}\t${device.ip}\t${device.page}\t${device.id}`));
    return;
  }
  const rawCommand = (parts.shift() || "").replace(/^\//, "");
  const command = rawCommand.toLowerCase();
  if (!command) return output("Missing command.");

  const matches = find(target);
  if (!matches.length) return output(`No active device matches '${target}'.`);
  if (command === "register-name") {
    const name = safeName(parts.join(" "));
    if (!name) return output("A name is required.");
    for (const device of matches) {
      devices[device.id].name = name;
      send(device.id, { type: "set-name", name });
    }
    await save();
    return output(`Named ${matches.length} device(s) '${name}'.`);
  }
  const args = command === "send-message" ? { message: parts.join(" ") } : { values: parts };
  const emittedCommand = PREFIX_COMMANDS.some((p) => rawCommand.toLowerCase().startsWith(p)) ? rawCommand : command;
  emit(target, emittedCommand, args);
  output(`Sent '${command}' to ${matches.map(device => device.name || device.ip).join(", ")}.`);
}

function startConsole() {
  if (!process.stdin.isTTY) return;
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "device> " });
  print("Device console ready. /device list or /device <name|ip|all> <command>");
  terminal.prompt();
  terminal.on("line", line => execute(line).catch(error => {
    log.error(`console command failed: ${line}`, error);
    print("Command failed - details in logs/devices.log");
  }).finally(() => terminal.prompt()));
}

module.exports = { attach, emit, execute, init, list, startConsole };
