/*!
 * Liquid glass for floating buttons and UI, drawn with canvas.
 *
 * Technique: arcaweb.ch "Recreate the liquid glass effect with HTML canvas".
 * Each glass element owns a <canvas>. The pixels behind the element are
 * copied into a buffer, then every pixel inside the rounded shape is
 * re-sampled from a point pulled toward the inside, by an amount that rises
 * steeply (cubic) near the edge. That bends the backdrop like a convex lens.
 * A rim highlight (Fresnel-style) and a faint tint are drawn on top.
 *
 * Two modes:
 *
 *  "svg" (Chrome, Edge and other Chromium browsers): the canvas draws the lens
 *  once as a displacement map, and the browser applies it to whatever is really
 *  behind the element through `backdrop-filter: url(#filter)`. Posters, video,
 *  text, scrolling: everything under the glass bends, live, at no per-frame cost.
 *
 *  "canvas" (Firefox, Safari, anything else): a canvas cannot read the page
 *  behind it, so it refracts a backdrop we can draw ourselves: the page
 *  background image and/or the <video>.
 *
 * Not applied on TVs (UA sniff + "no pointer, big screen" check).
 * Override: ?glass=on | off | auto and ?glassmode=svg | canvas | auto
 * (both remembered in localStorage).
 */
(function (root) {
  "use strict";

  // ======================================================================
  // Pure core: no DOM, so it can be unit-tested in Node.
  // ======================================================================

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /**
   * Precompute, once per size, where every output pixel samples from, its
   * edge alpha, and the rim/tint overlay.
   *
   * opts.radius    corner radius in px (clamped to a pill)
   * opts.bezel     width of the refracting band, as a fraction of half the
   *                shorter side (0.75 = the outer 75%)
   * opts.strength  how far edge pixels pull from the inside, as a fraction of
   *                the bezel. Above ~0.33 the rim folds over (stronger look).
   * opts.power     easing exponent; 3 = cubic falloff toward the centre
   * opts.light     direction toward the light, for the specular rim
   * opts.tint      overall white veil, 0..1
   */
  function buildLens(w, h, opts = {}) {
    const radius = Math.min(opts.radius ?? 9999, w / 2, h / 2);
    const bezel = Math.max(2, ((opts.bezel ?? 0.75) * Math.min(w, h)) / 2);
    const strength = opts.strength ?? 0.5;
    const power = opts.power ?? 3;
    const tint = opts.tint ?? 0.05;
    const rimStrength = opts.rim ?? 1;
    let [lx, ly] = opts.light ?? [-0.55, -0.83];
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll;
    ly /= ll;

    const n = w * h;
    const offset = new Int32Array(n).fill(-1);
    const alpha = new Uint8ClampedArray(n);
    const rim = new Uint8ClampedArray(n * 4);
    // Float sample offsets (for the displacement map), only when asked for.
    const wantOffsets = Boolean(opts.offsets);
    const ox = wantOffsets ? new Float32Array(n) : null;
    const oy = wantOffsets ? new Float32Array(n) : null;
    let maxOffset = 0;

    const cx = w / 2;
    const cy = h / 2;
    const ix = w / 2 - radius;
    const iy = h / 2 - radius;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const px = Math.abs(dx) - ix;
        const py = Math.abs(dy) - iy;
        // Signed distance to the rounded rectangle; positive = inside.
        const d =
          radius -
          (Math.hypot(Math.max(px, 0), Math.max(py, 0)) +
            Math.min(Math.max(px, py), 0));
        const a = clamp(d + 0.5, 0, 1); // one pixel of edge anti-aliasing
        if (a <= 0) continue;

        // Outward normal of the nearest edge.
        let nx;
        let ny;
        if (px > 0 && py > 0) {
          const len = Math.hypot(px, py) || 1;
          nx = (Math.sign(dx) * px) / len;
          ny = (Math.sign(dy) * py) / len;
        } else if (px > py) {
          nx = Math.sign(dx) || 1;
          ny = 0;
        } else {
          nx = 0;
          ny = Math.sign(dy) || 1;
        }

        const norm = Math.min(Math.max(d, 0) / bezel, 1); // 0 at the edge, 1 inside the bezel
        const fall = Math.pow(1 - norm, power);
        const disp = strength * bezel * fall;

        // Sample from further inside, so the rim magnifies what is near the middle.
        const sx = clamp(Math.round(x - nx * disp), 0, w - 1);
        const sy = clamp(Math.round(y - ny * disp), 0, h - 1);
        const i = y * w + x;
        offset[i] = sy * w + sx;
        alpha[i] = Math.round(a * 255);
        if (wantOffsets) {
          ox[i] = -nx * disp;
          oy[i] = -ny * disp;
          if (disp > maxOffset) maxOffset = disp;
        }

        // Rim light: bright where the edge faces the light, a weaker echo on
        // the opposite side, plus a hairline right at the edge.
        const edge = Math.pow(1 - norm, 2.4);
        const facing = nx * lx + ny * ly;
        const spec = Math.pow(Math.max(facing, 0), 1.6);
        const back = Math.pow(Math.max(-facing, 0), 1.6);
        const hair = d < 1.6 ? (1 - d / 1.6) * 0.35 : 0;
        const rimA = clamp(
          (edge * (0.75 * spec + 0.28 * back) + hair) * rimStrength + tint,
          0,
          1,
        );

        const j = i * 4;
        rim[j] = 255;
        rim[j + 1] = 255;
        rim[j + 2] = 255;
        rim[j + 3] = Math.round(rimA * a * 255);
      }
    }
    return { w, h, n, offset, alpha, rim, ox, oy, maxOffset };
  }

  /** Copy refracted pixels from `src` (RGBA, w*h) into `dst`. */
  function refract(src, dst, lens, opts = {}) {
    const saturate = opts.saturate ?? 1.2;
    const brightness = opts.brightness ?? 1.04;
    const { offset, alpha, n } = lens;
    for (let i = 0; i < n; i++) {
      const o = offset[i];
      const j = i * 4;
      if (o < 0) {
        dst[j + 3] = 0;
        continue;
      }
      const s = o * 4;
      let r = src[s];
      let g = src[s + 1];
      let b = src[s + 2];
      if (saturate !== 1) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = l + (r - l) * saturate;
        g = l + (g - l) * saturate;
        b = l + (b - l) * saturate;
      }
      dst[j] = r * brightness;
      dst[j + 1] = g * brightness;
      dst[j + 2] = b * brightness;
      dst[j + 3] = alpha[i];
    }
  }

  /**
   * Encode the lens as an SVG feDisplacementMap image: R = x offset, G = y
   * offset, 128 = no shift. feDisplacementMap reads
   *     out(x, y) = in(x + scale * (R/255 - 0.5), y + scale * (G/255 - 0.5))
   * so each pixel stores where it should sample from, relative to itself.
   * `unit` = map pixels per CSS pixel; `scale` comes back in CSS pixels.
   */
  function encodeDisplacement(lens, unit = 1) {
    const { n, ox, oy, maxOffset } = lens;
    const scale = Math.max(2, ((2 * maxOffset) / unit) * 1.02);
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      data[j] = 127.5 + ((ox ? ox[i] : 0) / unit / scale) * 255;
      data[j + 1] = 127.5 + ((oy ? oy[i] : 0) / unit / scale) * 255;
      data[j + 2] = 128;
      data[j + 3] = 255;
    }
    return { data, scale };
  }

  // ---- Contrast (WCAG 2.x) ----
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) =>
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const contrastRatio = (a, b) =>
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  /**
   * How opaque a backing layer must be for `text` to meet `contrast` against
   * `backdrop`. Light text gets a black layer, dark text a white one.
   * Colours are [r, g, b] 0..255, blended in sRGB like the browser does.
   * Returns { alpha, rgb, ratio }; alpha is 0 when the backdrop already works.
   */
  function scrimFor(backdrop, text, opts = {}) {
    const target = opts.contrast ?? 4.5;
    const max = opts.maxScrim ?? 0.8;
    const veil = opts.tint ?? 0.05; // the white tint the lens adds
    const boost = opts.brightness ?? 1.04; // and the brightness filter
    const lt = luminance(text);
    const edge = lt > 0.3 ? 0 : 255;
    const base = backdrop.map((v) => {
      const lit = Math.min(255, v * boost);
      return lit * (1 - veil) + 255 * veil;
    });
    const ratioAt = (a) =>
      contrastRatio(lt, luminance(base.map((v) => v * (1 - a) + edge * a)));

    const rgb = [edge, edge, edge];
    if (ratioAt(0) >= target) return { alpha: 0, rgb, ratio: ratioAt(0) };
    if (ratioAt(max) < target) return { alpha: max, rgb, ratio: ratioAt(max) };
    let lo = 0;
    let hi = max;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (ratioAt(mid) >= target) hi = mid;
      else lo = mid;
    }
    const alpha = Math.min(max, Math.round((hi + 0.02) * 100) / 100); // small safety margin
    return { alpha, rgb, ratio: ratioAt(alpha) };
  }

  const core = {
    buildLens,
    refract,
    encodeDisplacement,
    scrimFor,
    luminance,
    contrastRatio,
  };

  if (typeof window === "undefined" || typeof document === "undefined") {
    if (typeof module !== "undefined") module.exports = core;
    return;
  }

  // ======================================================================
  // Browser integration
  // ======================================================================

  const STORAGE_KEY = "media-server-glass";

  function isTV() {
    const ua = navigator.userAgent || "";
    if (
      /SMART-?TV|Tizen|Web0S|WebOS|NetCast|HbbTV|VIDAA|Viera|BRAVIA|\bAFT[A-Z]+\b|CrKey|GoogleTV|Android ?TV|\bRoku\b|AppleTV|PlayStation|Xbox|OPR\/.*TV|LG Browser|NETTV/i.test(
        ua,
      )
    ) {
      return true;
    }
    // Remote-only device on a big screen: no mouse, pen or touch at all.
    const noPointer = matchMedia("(any-pointer: none)").matches;
    return noPointer && Math.max(screen.width, screen.height) >= 1280;
  }

  function canvasOk() {
    try {
      return Boolean(document.createElement("canvas").getContext("2d"));
    } catch {
      return false;
    }
  }

  function enabled() {
    let saved = null;
    try {
      const q = new URLSearchParams(location.search).get("glass");
      if (q === "on" || q === "off") localStorage.setItem(STORAGE_KEY, q);
      else if (q === "auto") localStorage.removeItem(STORAGE_KEY);
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (saved === "off") return false;
    if (saved === "on") return canvasOk();
    if (isTV()) return true;
    // People who asked for system colours or less transparency get plain UI.
    if (matchMedia("(forced-colors: active)").matches) return false;
    if (matchMedia("(prefers-reduced-transparency: reduce)").matches)
      return false;
    return canvasOk();
  }

  // ---------- Backdrops: where the pixels behind the glass come from ----------

  /**
   * The page background image, laid out like CSS `background: url() center/cover`
   * inside a box at the top of the page (or fixed to the viewport), drawn
   * over a solid base colour, with an optional fade to the base at the bottom.
   */
  class ImageBackdrop {
    constructor(cfg) {
      this.cfg = {
        opacity: 1,
        base: "#000",
        height: "viewport",
        anchor: "page",
        fadeBottom: false,
        ...cfg,
      };
      this.kind = "page";
      this.img = new Image();
      this.img.decoding = "async";
      this.img.onload = () => api.refresh();
      this.img.src = cfg.image;
    }
    get scrollDependent() {
      return this.cfg.anchor === "page";
    }
    // Colours of a cols x rows grid under `rect`, as [r, g, b] (row-major).
    sampleGrid(rect, cols, rows) {
      const c = (this.grid ||= document.createElement("canvas"));
      c.width = cols;
      c.height = rows;
      const ctx = (this.gridCtx ||= c.getContext("2d", {
        willReadFrequently: true,
      }));
      ctx.clearRect(0, 0, cols, rows);
      this.draw(ctx, rect, cols / rect.width, rows / rect.height);
      const d = ctx.getImageData(0, 0, cols, rows).data;
      const out = [];
      for (let i = 0; i < cols * rows; i++)
        out.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
      return out;
    }
    draw(ctx, rect, scale, scaleY = scale) {
      const { base, opacity, height, anchor, fadeBottom } = this.cfg;
      const boxW = document.documentElement.clientWidth;
      const boxH = height === "viewport" ? innerHeight : Number(height);
      const top = anchor === "page" ? -scrollY : 0;

      ctx.save();
      ctx.scale(scale, scaleY);
      ctx.translate(-rect.left, -rect.top);
      ctx.fillStyle = base;
      ctx.fillRect(rect.left, rect.top, rect.width, rect.height);

      const img = this.img;
      if (img.complete && img.naturalWidth) {
        const k = Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight);
        const dw = img.naturalWidth * k;
        const dh = img.naturalHeight * k;
        ctx.globalAlpha = opacity;
        ctx.drawImage(img, (boxW - dw) / 2, top + (boxH - dh) / 2, dw, dh);
        ctx.globalAlpha = 1;
      }
      if (fadeBottom) {
        const g = ctx.createLinearGradient(0, top + boxH, 0, top);
        g.addColorStop(0, base);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(
          rect.left,
          Math.max(rect.top, top),
          rect.width,
          Math.min(rect.height, boxH),
        );
      }
      ctx.restore();
    }
  }

  /** The <video>, letterboxed like object-fit: contain, plus the player's shading. */
  class VideoBackdrop {
    constructor(cfg) {
      this.cfg = { fps: 30, shade: [], ...cfg };
      this.kind = "video";
      this.video =
        typeof cfg.element === "string"
          ? document.querySelector(cfg.element)
          : cfg.element;
      this.scrollDependent = false;
    }
    draw(ctx, rect, scale) {
      const v = this.video;
      if (!v) return;
      const box = v.getBoundingClientRect();
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-rect.left, -rect.top);
      ctx.fillStyle = "#000";
      ctx.fillRect(rect.left, rect.top, rect.width, rect.height);

      if (v.readyState >= 2 && v.videoWidth) {
        const k = Math.min(
          box.width / v.videoWidth,
          box.height / v.videoHeight,
        );
        const dw = v.videoWidth * k;
        const dh = v.videoHeight * k;
        try {
          ctx.drawImage(
            v,
            box.left + (box.width - dw) / 2,
            box.top + (box.height - dh) / 2,
            dw,
            dh,
          );
        } catch {}
      }

      // Repaint the gradients the page puts over the video so the glass
      // matches its surroundings.
      for (const s of this.cfg.shade) {
        const size = box.height * s.size;
        const y0 = s.edge === "top" ? box.top : box.bottom;
        const y1 = s.edge === "top" ? box.top + size : box.bottom - size;
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, `rgba(0,0,0,${s.from})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(box.left, Math.min(y0, y1), box.width, size);
      }
      ctx.restore();
    }
  }

  // ---------- Per-element glass ----------

  const lensCache = new Map();

  function lensFor(w, h, o) {
    const key = [
      w,
      h,
      o.radius,
      o.bezel,
      o.strength,
      o.power,
      o.tint,
      o.rim,
      o.offsets ? o.unit : 0,
    ].join("|");
    let hit = lensCache.get(key);
    if (hit) return hit;
    const lens = buildLens(w, h, o);
    const rimCanvas = document.createElement("canvas");
    rimCanvas.width = w;
    rimCanvas.height = h;
    rimCanvas
      .getContext("2d")
      .putImageData(new ImageData(lens.rim, w, h), 0, 0);
    hit = { lens, rimCanvas };
    if (o.offsets) {
      const enc = encodeDisplacement(lens, o.unit || 1);
      const mapCanvas = document.createElement("canvas");
      mapCanvas.width = w;
      mapCanvas.height = h;
      mapCanvas
        .getContext("2d")
        .putImageData(new ImageData(enc.data, w, h), 0, 0);
      hit.mapUrl = mapCanvas.toDataURL("image/png");
      hit.mapScale = enc.scale;
    }
    lensCache.set(key, hit);
    if (lensCache.size > 32) lensCache.delete(lensCache.keys().next().value);
    return hit;
  }

  const fixedLike = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };

  function readRadius(el, w, h) {
    const raw = getComputedStyle(el).borderTopLeftRadius.split(" ")[0];
    const num = parseFloat(raw) || 0;
    const px = raw.endsWith("%") ? (num / 100) * Math.min(w, h) : num;
    return Math.min(px, w / 2, h / 2);
  }

  function isShown(el) {
    if (el.closest("[inert],[hidden]")) return false;
    return el.checkVisibility
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : el.getClientRects().length > 0;
  }

  // Backing layer, drawn on the glass's own canvas (so it never fights the
  // site's CSS) and eased in and out.
  function paintScrim(ctx, w, h, radius, scrim) {
    if (!scrim || scrim.alpha <= 0.004) return;
    const [r, g, b] = scrim.rgb;
    ctx.fillStyle = `rgba(${r},${g},${b},${scrim.alpha.toFixed(3)})`;
    const rad = Math.min(radius || 0, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, w, h, rad);
    } else {
      ctx.moveTo(rad, 0);
      ctx.arcTo(w, 0, w, h, rad);
      ctx.arcTo(w, h, 0, h, rad);
      ctx.arcTo(0, h, 0, 0, rad);
      ctx.arcTo(0, 0, w, 0, rad);
      ctx.closePath();
    }
    ctx.fill();
  }

  // ---------- Adaptive contrast: what is behind the text? ----------
  //
  // The browser will not tell a script what it painted behind an element, so
  // this rebuilds it from what the page exposes: the configured page
  // background, then every element under the button from the bottom up
  // (background colours, <img>/<video>/<canvas> pixels). CSS gradients and
  // pseudo-element backgrounds are invisible to it; media it cannot read
  // counts as the worst case for the text colour.

  const GRID_X = 4;
  const GRID_Y = 2;
  const SAMPLE_W = 24;
  const SAMPLE_H = 14;
  const UNREADABLE = Symbol("unreadable");
  const staticSamples = new WeakMap(); // <img> -> { src, data }
  let sampleCanvas = null;

  function parseCssColor(str) {
    if (!str) return null;
    let m =
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(
        str,
      );
    if (m) {
      const a =
        m[4] === undefined
          ? 1
          : m[4].endsWith("%")
            ? parseFloat(m[4]) / 100
            : parseFloat(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    m =
      /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/.exec(
        str,
      );
    if (m) {
      const a =
        m[4] === undefined
          ? 1
          : m[4].endsWith("%")
            ? parseFloat(m[4]) / 100
            : parseFloat(m[4]);
      return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, a];
    }
    return null;
  }

  const over = (dst, src, a) => [
    src[0] * a + dst[0] * (1 - a),
    src[1] * a + dst[1] * (1 - a),
    src[2] * a + dst[2] * (1 - a),
  ];

  // Where a page point falls inside a media element, as 0..1 coordinates.
  function mediaUV(rect, nw, nh, fit, x, y) {
    const rw = rect.width;
    const rh = rect.height;
    let cw = rw;
    let ch = rh;
    if (fit === "cover") {
      const k = Math.max(rw / nw, rh / nh);
      [cw, ch] = [nw * k, nh * k];
    } else if (fit === "contain" || fit === "scale-down") {
      const k =
        fit === "scale-down"
          ? Math.min(1, rw / nw, rh / nh)
          : Math.min(rw / nw, rh / nh);
      [cw, ch] = [nw * k, nh * k];
    } else if (fit === "none") {
      [cw, ch] = [nw, nh];
    }
    const u = (x - rect.left - (rw - cw) / 2) / cw;
    const v = (y - rect.top - (rh - ch) / 2) / ch;
    return u < 0 || u > 1 || v < 0 || v > 1 ? null : [u, v];
  }

  class Round {
    constructor() {
      this.styles = new Map();
      this.media = new Map();
    }
    opacityOf(n) {
      const cached = this.styles.get(n)?.opacity;
      if (cached !== undefined) return cached;
      const own = parseFloat(getComputedStyle(n).opacity);
      const parent = n.parentElement ? this.opacityOf(n.parentElement) : 1;
      return (Number.isFinite(own) ? own : 1) * parent;
    }
    info(n) {
      let info = this.styles.get(n);
      if (info) return info;
      const cs = getComputedStyle(n);
      const bg = parseCssColor(cs.backgroundColor);
      info = {
        bg: bg && bg[3] > 0 ? bg : null,
        fit: cs.objectFit || "fill",
        media:
          ["IMG", "VIDEO", "CANVAS"].includes(n.tagName) &&
          cs.visibility !== "hidden",
        opacity: 1,
      };
      this.styles.set(n, info);
      info.opacity = this.opacityOf(n);
      return info;
    }
    // Pixel colour of a media element at a page point: [r,g,b] | null (nothing
    // painted there) | UNREADABLE (cannot be read, e.g. cross-origin).
    pixel(n, x, y) {
      const rect = n.getBoundingClientRect();
      let nw;
      let nh;
      if (n.tagName === "IMG") {
        if (!n.complete || !n.naturalWidth) return null;
        [nw, nh] = [n.naturalWidth, n.naturalHeight];
      } else if (n.tagName === "VIDEO") {
        if (n.readyState < 2 || !n.videoWidth) return null;
        [nw, nh] = [n.videoWidth, n.videoHeight];
      } else {
        [nw, nh] = [n.width, n.height];
      }
      if (!nw || !nh) return null;

      const uv = mediaUV(rect, nw, nh, this.info(n).fit, x, y);
      if (!uv) return null;

      let data = this.media.get(n);
      if (!data && n.tagName === "IMG") {
        const hit = staticSamples.get(n);
        if (hit && hit.src === n.currentSrc) data = hit.data;
      }
      if (!data) {
        try {
          sampleCanvas ||= document.createElement("canvas");
          sampleCanvas.width = SAMPLE_W;
          sampleCanvas.height = SAMPLE_H;
          const ctx = (sampleCanvas.ctx ||= sampleCanvas.getContext("2d", {
            willReadFrequently: true,
          }));
          ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
          ctx.drawImage(n, 0, 0, SAMPLE_W, SAMPLE_H);
          data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
        } catch {
          return UNREADABLE;
        }
        this.media.set(n, data);
        if (n.tagName === "IMG")
          staticSamples.set(n, { src: n.currentSrc, data });
      }
      const px =
        (Math.min(SAMPLE_H - 1, Math.floor(uv[1] * SAMPLE_H)) * SAMPLE_W +
          Math.min(SAMPLE_W - 1, Math.floor(uv[0] * SAMPLE_W))) *
        4;
      return data[px + 3] ? [data[px], data[px + 1], data[px + 2]] : null;
    }
  }

  // Colours under the glass at a small grid of points, plus whether anything
  // unreadable was found.
  function sampleBackdrop(g, round) {
    const el = g.el;
    const r = el.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const rect = {
      left: r.left + (r.width - w) / 2,
      top: r.top + (r.height - h) / 2,
      width: w,
      height: h,
    };
    const page = backdrops.page
      ? backdrops.page.sampleGrid(rect, GRID_X, GRID_Y)
      : null;

    const colors = [];
    let unreadable = false;
    for (let j = 0; j < GRID_Y; j++) {
      for (let i = 0; i < GRID_X; i++) {
        const x = rect.left + (rect.width * (i + 0.5)) / GRID_X;
        const y = rect.top + (rect.height * (j + 0.5)) / GRID_Y;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue; // cannot be hit-tested
        let c = page ? page[j * GRID_X + i].slice() : [255, 255, 255]; // no page background set: browser white

        const stack = document.elementsFromPoint
          ? document.elementsFromPoint(x, y)
          : [];
        const at = stack.indexOf(el);
        const below =
          at >= 0 ? stack.slice(at + 1) : stack.filter((n) => !el.contains(n));
        for (let k = below.length - 1; k >= 0; k--) {
          const n = below[k];
          const info = round.info(n);
          if (info.bg) c = over(c, info.bg, info.bg[3] * info.opacity);
          if (info.media) {
            const px = round.pixel(n, x, y);
            if (px === UNREADABLE) unreadable = true;
            else if (px) c = over(c, px, info.opacity);
          }
        }
        colors.push(c);
      }
    }
    return { colors, unreadable };
  }

  function adaptGlass(g, round) {
    if (!g.opts.adapt || !isShown(g.el)) return;
    const text = parseCssColor(getComputedStyle(g.el).color) || [
      255, 255, 255, 1,
    ];
    const lightText = luminance(text) > 0.3;
    const { colors, unreadable } = sampleBackdrop(g, round);
    if (!colors.length && !unreadable) return; // off-screen: nothing to measure
    if (unreadable) colors.push(lightText ? [255, 255, 255] : [0, 0, 0]); // assume the worst
    // The colour that is hardest to read against decides.
    const worst = colors.reduce((a, b) =>
      luminance(b) > luminance(a) === lightText ? b : a,
    );
    applyScrim(g, scrimFor(worst, text, g.opts));
  }

  // Raising the backing is applied at once (readability first); lowering it
  // waits for a clear difference so it does not flicker.
  function applyScrim(g, res) {
    const s = (g.scrim ||= { alpha: 0, target: 0, rgb: res.rgb });
    s.rgb = res.rgb;
    const raise = res.alpha > s.target;
    if (raise ? res.alpha - s.target >= 0.02 : s.target - res.alpha >= 0.06) {
      s.target = res.alpha;
      startTween();
    }
  }

  let tweenFrame = 0;
  function startTween() {
    if (!tweenFrame) tweenFrame = requestAnimationFrame(tween);
  }
  function tween() {
    tweenFrame = 0;
    let moving = false;
    for (const g of glasses.values()) {
      const s = g.scrim;
      if (!s || s.alpha === s.target) continue;
      const d = s.target - s.alpha;
      s.alpha = Math.abs(d) < 0.01 ? s.target : s.alpha + d * 0.3;
      if (s.alpha !== s.target) moving = true;
      g.repaint();
    }
    if (moving) tweenFrame = requestAnimationFrame(tween);
  }

  let adaptTimer = 0;
  let lastAdapt = 0;
  const ADAPT_GAP_MS = 250;
  function adaptAll() {
    lastAdapt = performance.now();
    const round = new Round();
    for (const g of glasses.values()) if (g.opts.adapt) adaptGlass(g, round);
  }
  function scheduleAdapt(delay = 0) {
    if (adaptTimer) return;
    const wait = Math.max(delay, lastAdapt + ADAPT_GAP_MS - performance.now());
    adaptTimer = setTimeout(() => {
      adaptTimer = 0;
      requestAnimationFrame(adaptAll);
    }, wait);
  }

  class Glass {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts;
      this.visible = true;
      this.dirty = true;
      this.failed = false;

      if (getComputedStyle(el).position === "static")
        el.style.position = "relative";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "lg-canvas";
      this.canvas.setAttribute("aria-hidden", "true");
      this.ctx = this.canvas.getContext("2d");
      this.region = document.createElement("canvas");
      this.rctx = this.region.getContext("2d", { willReadFrequently: true });
      el.prepend(this.canvas);
      el.classList.add("lg", "lg-on");

      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(el);
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries[entries.length - 1].isIntersecting;
        if (this.visible) this.render();
      });
      this.io.observe(el);
      this.measure();
    }

    measure() {
      const el = this.el;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      const dpr = Math.min(devicePixelRatio || 1, this.opts.maxScale);
      this.scale = dpr;
      this.pw = Math.max(2, Math.round(w * dpr));
      this.ph = Math.max(2, Math.round(h * dpr));
      for (const c of [this.canvas, this.region]) {
        c.width = this.pw;
        c.height = this.ph;
      }
      const radius = (this.opts.radius ?? readRadius(el, w, h)) * dpr;
      const lensOpts = { ...this.opts, radius };
      this.radiusPx = radius;
      ({ lens: this.lens, rimCanvas: this.rimCanvas } = lensFor(
        this.pw,
        this.ph,
        lensOpts,
      ));
      this.out = new ImageData(this.pw, this.ph);
      this.fixed = fixedLike(el);
      this.backdrop = api.backdropFor(el);
      this.dirty = true;
      this.render();
    }

    shown() {
      const el = this.el;
      if (!this.visible || el.closest("[inert],[hidden]")) return false;
      return el.checkVisibility
        ? el.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          })
        : el.getClientRects().length > 0;
    }

    // True when scrolling moves the backdrop under this element.
    get scrollSensitive() {
      const b = this.backdrop;
      return Boolean(
        b && b.kind === "page" && b.scrollDependent === this.fixed,
      );
    }

    render() {
      if (this.failed || !this.lens || !this.shown()) return;
      if (!this.backdrop) {
        // Nothing to refract, but the readability backing and rim still apply.
        this.ctx.clearRect(0, 0, this.pw, this.ph);
        paintScrim(this.ctx, this.pw, this.ph, this.radiusPx, this.scrim);
        this.ctx.drawImage(this.rimCanvas, 0, 0);
        return;
      }
      const el = this.el;
      const r = el.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // Layout box centred on the transformed box, so hover/focus scaling does
      // not shift what is sampled.
      const rect = {
        left: r.left + (r.width - w) / 2,
        top: r.top + (r.height - h) / 2,
        width: w,
        height: h,
      };

      this.rctx.clearRect(0, 0, this.pw, this.ph);
      if (this.opts.blur && "filter" in this.rctx)
        this.rctx.filter = `blur(${this.opts.blur * this.scale}px)`;
      this.backdrop.draw(this.rctx, rect, this.scale);
      this.rctx.filter = "none";

      let src;
      try {
        src = this.rctx.getImageData(0, 0, this.pw, this.ph);
      } catch {
        // Tainted canvas (cross-origin backdrop): give the element its own look back.
        this.destroy();
        this.failed = true;
        return;
      }
      refract(src.data, this.out.data, this.lens, this.opts);
      this.ctx.putImageData(this.out, 0, 0);
      paintScrim(this.ctx, this.pw, this.ph, this.radiusPx, this.scrim);
      this.ctx.drawImage(this.rimCanvas, 0, 0);
      this.dirty = false;
    }

    repaint() {
      this.render();
    }

    destroy() {
      this.resizeObserver.disconnect();
      this.io.disconnect();
      this.canvas.remove();
      this.el.classList.remove("lg", "lg-on");
    }
  }

  // ---------- SVG mode: the browser bends the real page ----------

  const SVG_NS = "http://www.w3.org/2000/svg";
  let defsEl = null;
  let filterSeq = 0;

  // Hidden <svg> that holds the filters. Not display:none, which would stop
  // Chromium from resolving url(#id) references.
  function svgDefs() {
    if (defsEl && defsEl.isConnected) return defsEl;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    defsEl = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(defsEl);
    document.body.appendChild(svg);
    return defsEl;
  }

  class SvgGlass {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts;
      this.filter = null;

      if (getComputedStyle(el).position === "static")
        el.style.position = "relative";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "lg-canvas";
      this.canvas.setAttribute("aria-hidden", "true");
      this.ctx = this.canvas.getContext("2d");
      el.prepend(this.canvas);
      el.classList.add("lg", "lg-on", "lg-svg");

      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(el);
      this.measure();
    }

    measure() {
      const el = this.el;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      const s = Math.min(devicePixelRatio || 1, this.opts.maxScale);
      const pw = Math.max(2, Math.round(w * s));
      const ph = Math.max(2, Math.round(h * s));
      this.canvas.width = pw;
      this.canvas.height = ph;

      const radius = (this.opts.radius ?? readRadius(el, w, h)) * s;
      const { rimCanvas, mapUrl, mapScale } = lensFor(pw, ph, {
        ...this.opts,
        radius,
        offsets: true,
        unit: s,
      });

      // The canvas carries the backing layer and rim light; the bending is
      // done by the browser. Drawn once per size (and when the backing eases).
      this.pw = pw;
      this.ph = ph;
      this.radiusPx = radius;
      this.rimCanvas = rimCanvas;
      this.repaint();
      this.buildFilter(w, h, mapUrl, mapScale);
    }

    repaint() {
      if (!this.rimCanvas) return;
      this.ctx.clearRect(0, 0, this.pw, this.ph);
      paintScrim(this.ctx, this.pw, this.ph, this.radiusPx, this.scrim);
      this.ctx.drawImage(this.rimCanvas, 0, 0);
    }

    buildFilter(w, h, mapUrl, scale) {
      // A new id every time: Chromium does not repaint a backdrop-filter whose
      // <filter> was edited in place.
      const id = `lg-f${++filterSeq}`;
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", id);
      filter.setAttribute("x", "0%");
      filter.setAttribute("y", "0%");
      filter.setAttribute("width", "100%");
      filter.setAttribute("height", "100%");
      filter.setAttribute("color-interpolation-filters", "sRGB"); // keep map values linear

      const map = document.createElementNS(SVG_NS, "feImage");
      map.setAttribute("href", mapUrl);
      map.setAttribute("x", "0");
      map.setAttribute("y", "0");
      map.setAttribute("width", String(w));
      map.setAttribute("height", String(h));
      map.setAttribute("preserveAspectRatio", "none");
      map.setAttribute("result", "map");

      const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
      displace.setAttribute("in", "SourceGraphic");
      displace.setAttribute("in2", "map");
      displace.setAttribute("scale", scale.toFixed(2));
      displace.setAttribute("xChannelSelector", "R");
      displace.setAttribute("yChannelSelector", "G");

      filter.append(map, displace);
      svgDefs().appendChild(filter);
      this.filter?.remove();
      this.filter = filter;

      const { blur, saturate, brightness } = this.opts;
      this.el.style.setProperty(
        "--lg-bd",
        `url(#${id}) ${blur ? `blur(${blur}px) ` : ""}saturate(${saturate}) brightness(${brightness}) blur(5px)`,
      );
    }

    render() {} // nothing to redraw: the browser re-applies the filter live

    shown() {
      return isShown(this.el);
    }

    destroy() {
      this.resizeObserver.disconnect();
      this.filter?.remove();
      this.canvas.remove();
      this.el.style.removeProperty("--lg-bd");
      this.el.classList.remove("lg", "lg-on", "lg-svg");
    }
  }

  // Chromium (Chrome, Edge, Brave, Samsung Internet...) renders SVG filters
  // in backdrop-filter. Firefox and every iOS browser do not.
  function supportsSvgBackdrop() {
    const ua = navigator.userAgent || "";
    const m = /\bChrome\/(\d+)/.exec(ua);
    if (!m || Number(m[1]) < 90) return false;
    if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
    return (
      typeof CSS === "undefined" ||
      !CSS.supports ||
      CSS.supports("backdrop-filter", "blur(1px)")
    );
  }

  function resolveMode(wanted) {
    let mode = wanted || "auto";
    try {
      const q = new URLSearchParams(location.search).get("glassmode");
      if (q === "svg" || q === "canvas")
        localStorage.setItem(STORAGE_KEY + "-mode", q);
      else if (q === "auto") localStorage.removeItem(STORAGE_KEY + "-mode");
      mode = localStorage.getItem(STORAGE_KEY + "-mode") || mode;
    } catch {}
    if (mode === "svg" || mode === "canvas") return mode;
    return supportsSvgBackdrop() ? "svg" : "canvas";
  }

  // ---------- Scheduling ----------

  const glasses = new Map(); // element -> Glass
  const backdrops = {};
  let globalOpts = {};
  let frame = 0;
  let videoLoop = 0;
  let animUntil = 0;

  function renderAll(filter) {
    for (const g of glasses.values()) if (!filter || filter(g)) g.render();
  }

  function scheduleRefresh() {
    scheduleAdapt(120);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderAll();
    });
  }

  function onScroll() {
    scheduleAdapt(150);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderAll((g) => g.scrollSensitive);
    });
  }

  // Redraw every frame while CSS transitions run, so glass on sliding or
  // scaling parents stays in sync.
  function animTick() {
    renderAll();
    if (performance.now() < animUntil) requestAnimationFrame(animTick);
  }
  function noteAnimation() {
    const running = performance.now() < animUntil;
    animUntil = performance.now() + 450;
    if (!running) requestAnimationFrame(animTick);
  }

  function startVideo(backdrop) {
    const v = backdrop.video;
    if (!v) return;
    const minGap = 1000 / (backdrop.cfg.fps || 30);
    let last = 0;

    const tick = (now) => {
      videoLoop = 0;
      if (v.paused || v.ended) return; // paused frames are drawn by the events below
      if (now - last >= minGap) {
        last = now;
        renderAll((g) => g.backdrop === backdrop);
      }
      next();
    };
    const next = () => {
      if (videoLoop) return;
      videoLoop = v.requestVideoFrameCallback
        ? v.requestVideoFrameCallback(() => tick(performance.now()))
        : requestAnimationFrame(tick);
    };
    const once = () =>
      requestAnimationFrame(() => renderAll((g) => g.backdrop === backdrop));

    v.addEventListener("play", () => next());
    v.addEventListener("playing", () => next());
    for (const type of ["pause", "seeked", "loadeddata", "resize", "emptied"])
      v.addEventListener(type, once);
    if (!v.paused) next();
  }

  // ---------- Public API ----------

  const api = {
    core,
    isTV,
    enabled: false,
    mode: "canvas",

    /** Pick the backdrop for an element: explicit, or the video if inside its player. */
    backdropFor(el) {
      const want = el.dataset.glassBackdrop;
      if (want && backdrops[want]) return backdrops[want];
      const v = backdrops.video?.video;
      if (v && v.parentElement && v.parentElement.contains(el))
        return backdrops.video;
      return backdrops.page || backdrops.video || null;
    },

    attach(el, opts = {}) {
      if (
        !this.enabled ||
        glasses.has(el) ||
        el.matches("input,img,video,canvas")
      )
        return;
      const d = el.dataset;
      const num = (v) => (v === undefined ? undefined : Number(v));
      const merged = {
        strength: 0.5,
        bezel: 0.75,
        power: 3,
        tint: 0.05,
        rim: 1,
        saturate: 1.2,
        brightness: 1.04,
        blur: 0,
        maxScale: 2,
        adapt: true, // keep text readable: back the glass with a scrim when needed
        contrast: 4.5, // WCAG AA for normal text; 7 = AAA, 3 = large text
        maxScrim: 0.8,
        ...globalOpts,
        ...opts,
        ...Object.fromEntries(
          Object.entries({
            strength: num(d.glassStrength),
            bezel: num(d.glassBezel),
            blur: num(d.glassBlur),
            radius: num(d.glassRadius),
            tint: num(d.glassTint),
            contrast: num(d.glassContrast),
            adapt: d.glassAdapt === "off" ? false : undefined,
          }).filter(([, v]) => v !== undefined),
        ),
      };
      if (matchMedia("(prefers-contrast: more)").matches) {
        merged.contrast = Math.max(merged.contrast, 7);
        merged.maxScrim = Math.max(merged.maxScrim, 0.85);
      }
      glasses.set(
        el,
        this.mode === "svg" ? new SvgGlass(el, merged) : new Glass(el, merged),
      );
      scheduleAdapt(60);
    },

    detach(el) {
      glasses.get(el)?.destroy();
      glasses.delete(el);
    },

    refresh: scheduleRefresh,
    adaptNow: adaptAll,

    /**
     * init({
     *   selector: ".ctl, .pill, .hbtn",
     *   mode: "auto",                          // "svg" | "canvas" | "auto"
     *   // page / video are only used by the canvas fallback:
     *   page:  { image: "/images/chromatic_light_2_preview.webp", opacity: 0.2, fadeBottom: true },
     *   video: { element: "#video", fps: 30, shade: [...] },
     *   strength, bezel, blur, ...                 // defaults for every glass
     * })
     * Returns false (and does nothing) on TVs or when disabled.
     */
    init(config = {}) {
      this.enabled = enabled();
      if (!this.enabled) return false;

      const { selector, page, video, mode, ...defaults } = config;
      globalOpts = defaults;
      this.mode = resolveMode(mode);
      // The page background also feeds the contrast measurement in svg mode;
      // the video backdrop is only for the canvas fallback (in svg mode the
      // <video> is read like any other element under the glass).
      if (page) backdrops.page = new ImageBackdrop(page);
      if (this.mode === "canvas") {
        if (video) {
          backdrops.video = new VideoBackdrop(video);
          startVideo(backdrops.video);
        }
      }

      const scan = (rootNode) => {
        if (!selector) return;
        if (rootNode.matches?.(selector)) this.attach(rootNode);
        rootNode.querySelectorAll?.(selector).forEach((el) => this.attach(el));
      };
      scan(document);
      new MutationObserver((mutations) => {
        let attrs = false;
        for (const m of mutations) {
          if (m.type === "childList") {
            m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
            m.removedNodes.forEach((n) => {
              if (n.nodeType !== 1) return;
              for (const el of [
                ...(n.matches?.(".lg") ? [n] : []),
                ...(n.querySelectorAll?.(".lg") ?? []),
              ])
                this.detach(el);
            });
          } else attrs = true;
        }
        if (attrs) scheduleRefresh();
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["inert", "hidden", "class"],
      });

      addEventListener("resize", scheduleRefresh);
      addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("transitionrun", noteAnimation, true);
      document.addEventListener("transitionend", scheduleRefresh, true);
      // Anything that changes what is behind the glass: images arriving,
      // video playing or seeking.
      document.addEventListener("load", () => scheduleAdapt(100), true);
      for (const type of ["timeupdate", "seeked", "loadeddata"])
        document.addEventListener(type, () => scheduleAdapt(0), true);
      return true;
    },
  };

  root.LiquidGlass = api;
})(typeof window !== "undefined" ? window : globalThis);
