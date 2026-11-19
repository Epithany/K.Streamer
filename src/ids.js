const crypto = require("crypto");

function createVideoId() {
  // URL-safe, short, collision-resistant identifier.
  return crypto.randomBytes(9).toString("base64url");
}

module.exports = { createVideoId };
