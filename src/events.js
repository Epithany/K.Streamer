const { EventEmitter } = require("events");

// Single shared bus. library.js emits "library:update" whenever the on-disk
// library changes (full rescan or a single thumbnail landing); server.js
// relays that straight to every open /api/events connection.
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
