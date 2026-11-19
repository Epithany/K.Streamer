/* Search scoring shared by the browser (instant local search) and the server
   (/api/search), so both rank results identically. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SearchCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const norm = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  const TYPE_BIAS = { show: 8, movie: 6, song: 4, episode: 0, short: 0 };

  // Adds the lowercase haystacks used for matching. Mutates and returns items.
  function prepare(items) {
    for (const it of items) {
      it._t = norm(it.title);
      it._h = `${it._t} ${norm(it.sub)}`;
    }
    return items;
  }

  function score(it, tokens, full) {
    let total = 0;
    for (const tok of tokens) {
      if (it._h.indexOf(tok) < 0) return -1;
      const at = it._t.indexOf(tok);
      if (at === 0) total += 100;
      else if (at > 0 && /[\s\-_.()[\]]/.test(it._t[at - 1])) total += 70;
      else if (at > 0) total += 40;
      else total += 15; // only in the subtitle (artist, show name...)
    }
    if (it._t === full) total += 100;
    else if (it._t.startsWith(full)) total += 40;
    return total + (TYPE_BIAS[it.k] || 0) - Math.min(it._t.length, 60) / 10;
  }

  // kinds: optional array of item kinds to keep.
  function search(items, text, { limit = 40, kinds = null } = {}) {
    const full = norm(text).trim();
    const tokens = full.split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const out = [];
    for (const it of items) {
      if (kinds && !kinds.includes(it.k)) continue;
      const s = score(it, tokens, full);
      if (s >= 0) out.push({ it, s });
    }
    out.sort((a, b) => b.s - a.s || a.it._t.localeCompare(b.it._t));
    return out.slice(0, limit).map((r) => r.it);
  }

  return { norm, prepare, search };
});
