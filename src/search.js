const SearchCore = require("../public/js/search-core.js");

// Flat, per-account list of everything searchable. `lib`, `songs` and `shorts`
// must already be filtered to what the account may see (access.filter*).
function buildItems({ lib, songs, shorts }) {
  const items = [];
  const videoById = new Map(lib.videos.map((v) => [v.id, v]));
  const showName = new Map(lib.shows.map((s) => [s.id, s.name]));

  for (const show of lib.shows) {
    const first = videoById.get(show.videoIds[0]);
    if (!first) continue;
    const added = show.videoIds.reduce((m, id) => Math.max(m, Date.parse(videoById.get(id)?.addedAt) || 0), 0);
    const seasons = show.seasons?.length || 1;
    items.push({
      k: "show", id: show.id, title: show.name,
      sub: `${show.videoIds.length} episode${show.videoIds.length === 1 ? "" : "s"}${seasons > 1 ? ` · ${seasons} seasons` : ""}`,
      url: first.url, thumb: show.thumbnail || first.thumbnail || "", at: added,
    });
  }
  for (const v of lib.videos) {
    const at = Date.parse(v.addedAt) || 0;
    if (!v.showId) {
      items.push({ k: "movie", id: v.id, title: v.name, sub: v.ownerName || "", url: v.url, thumb: v.thumbnail || "", at });
    } else {
      const season = v.seasonNumber ? `Season ${v.seasonNumber}` : "";
      const ep = v.episodeNumber && Number.isFinite(v.episodeNumber) ? `Episode ${v.episodeNumber}` : "";
      items.push({
        k: "episode", id: v.id, title: v.name,
        sub: [showName.get(v.showId), season, ep].filter(Boolean).join(" · "),
        url: v.url, thumb: v.thumbnail || "", at,
      });
    }
  }
  for (const s of songs.songs) {
    items.push({
      k: "song", id: s.id, title: s.title || s.name,
      sub: [s.artist, s.album].filter(Boolean).join(" · ") || s.ownerName || "",
      url: s.url, thumb: `/api/songs/cover/${encodeURIComponent(s.id)}`,
    });
  }
  for (const s of shorts) {
    items.push({ k: "short", id: s.id, title: s.name, sub: s.ownerName ? `Short · ${s.ownerName}` : "Short", url: `/shorts?s=${encodeURIComponent(s.id)}`, thumb: "" });
  }
  return items;
}

function query(items, text, { limit = 40, kinds = null } = {}) {
  const copies = SearchCore.prepare(items.map((i) => ({ ...i })));
  return SearchCore.search(copies, text, { limit, kinds }).map(({ _t, _h, ...rest }) => rest);
}

module.exports = { buildItems, query };
