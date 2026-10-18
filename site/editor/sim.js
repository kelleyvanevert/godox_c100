// The camera's effect in the browser (tools/sim_palette.py with the camera's
// lookup table): per 2x2 block the average luma plus the dither's offset
// (dithers.js; the camera's own is the 4x4 Bayer), the block's Y, U, V looked
// up in a 33x33x33 table of nearest match colours, painted with the paint
// colour at that index; then the tags, top right: the preset's, and left of
// it the dither's.
import { tagCells, tagColours, yuvToRgb } from "./firmware.js";
import { RIEMERSMA, RIEMERSMA_WEIGHTS, ditherById, extraFont, hilbert } from "./dithers.js";

const N = 33;

// What lut_fill puts in the table: per bin centre (multiples of 8), the
// nearest match colour by wy*|dY| + |dU| + |dV|, the first one on ties.
export function buildLut(match, wy) {
  const lut = new Uint8Array(N * N * N);
  let i = 0;
  for (let y = 0; y < N * 8; y += 8)
    for (let u = 0; u < N * 8; u += 8)
      for (let v = 0; v < N * 8; v += 8) {
        let best = Infinity;
        let at = 0;
        match.forEach((c, k) => {
          const d = wy * Math.abs(y - c[0]) + Math.abs(u - c[1]) + Math.abs(v - c[2]);
          if (d < best) (best = d), (at = k);
        });
        lut[i++] = at;
      }
  return lut;
}

// The photo cropped and scaled to the size the camera uses for its aspect.
export function cameraSize(m, w, h) {
  const name = Object.keys(m.sizes).reduce((a, b) =>
    Math.abs(m.sizes[a][0] / m.sizes[a][1] - w / h) <= Math.abs(m.sizes[b][0] / m.sizes[b][1] - w / h) ? a : b,
  );
  return { crop: m.crops[name], size: m.sizes[name] };
}

export function cameraFrame(m, img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const { crop, size } = cameraSize(m, w, h);
  let sx = 0, sy = 0, sw = w, sh = h;
  if (w * crop[1] > h * crop[0]) (sw = Math.round((h * crop[0]) / crop[1])), (sx = (w - sw) / 2);
  else (sh = Math.round((w * crop[1]) / crop[0])), (sy = (h - sh) / 2);
  const c = document.createElement("canvas");
  [c.width, c.height] = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size[0], size[1]);
  return ctx.getImageData(0, 0, size[0], size[1]);
}

// Font cells between the preset's tag and the dither's (outline to outline).
export const DITHER_TAG_GAP = 1;

export const ditherTagCells = (m, dither) => tagCells({ ...m, font: { ...m.font, ...extraFont } }, dither.code);

// What a mixing dither needs per table bin (the "mix" kind in dithers.js):
// the two match colours a, b and the share t of b whose mix comes closest to
// the bin centre, counting the mix's grain t(1-t)|a-b|^2 against it (MIX_GRAIN),
// so far-apart colours only mix when nothing nearer does. Only pairs among
// the MIX_NEAR nearest colours are tried: cheap enough for lut_fill.
const MIX_NEAR = 6;
const MIX_GRAIN = 0.08;
const mixCache = new WeakMap();

function mixLut(lut, match, wy) {
  if (mixCache.has(lut)) return mixCache.get(lut);
  const W = [wy * wy, 1, 1];
  const d2 = (p, q) => W[0] * (p[0] - q[0]) ** 2 + W[1] * (p[1] - q[1]) ** 2 + W[2] * (p[2] - q[2]) ** 2;
  const a = new Uint8Array(N * N * N);
  const b = new Uint8Array(N * N * N);
  const t = new Float32Array(N * N * N);
  let i = 0;
  for (let y = 0; y < N * 8; y += 8)
    for (let u = 0; u < N * 8; u += 8)
      for (let v = 0; v < N * 8; v += 8, i++) {
        const c = [y, u, v];
        const near = match.map((m, k) => [d2(c, m), k]).sort((p, q) => p[0] - q[0]).slice(0, MIX_NEAR);
        let best = near[0][0];
        a[i] = b[i] = near[0][1];
        t[i] = 0;
        for (let p = 0; p < near.length; p++)
          for (let q = p + 1; q < near.length; q++) {
            const A = match[near[p][1]];
            const B = match[near[q][1]];
            const ab = d2(A, B);
            if (!ab) continue;
            let dot = 0;
            for (let j = 0; j < 3; j++) dot += W[j] * (c[j] - A[j]) * (B[j] - A[j]);
            const s = Math.max(0, Math.min(1, dot / ab));
            const mix = [0, 1, 2].map((j) => A[j] + s * (B[j] - A[j]));
            const err = d2(c, mix) + MIX_GRAIN * s * (1 - s) * ab;
            if (err < best) (best = err), (a[i] = near[p][1]), (b[i] = near[q][1]), (t[i] = s);
          }
      }
  const out = { a, b, t };
  mixCache.set(lut, out);
  return out;
}

// ---- Even Toned Screening: distance to the last darker / lighter block ----
// Per block, the offset (dx, dy) to the nearest block before it that came out
// darker (lighter) than asked, from the left neighbour and the row above.
const EVEN_GAIN = 5; // luma per block of distance
const EVEN_MAX = 8; // blocks: further than this counts as this

function nearest(prev, cur, x, bw) {
  let best = [EVEN_MAX, EVEN_MAX], bd = 2 * EVEN_MAX * EVEN_MAX;
  const consider = (vx, vy) => {
    const d = vx * vx + vy * vy;
    if (d < bd) (bd = d), (best = [vx, vy]);
  };
  if (x > 0) consider(cur[2 * (x - 1)] - 1, cur[2 * (x - 1) + 1]);
  for (const k of [-1, 0, 1]) {
    const xx = x + k;
    if (xx >= 0 && xx < bw) consider(prev[2 * xx] + k, prev[2 * xx + 1] - 1);
  }
  return [best, Math.min(Math.sqrt(bd), EVEN_MAX)];
}

const bin = (y, u, v) => (((y + 4) >> 3) * N + ((u + 4) >> 3)) * N + ((v + 4) >> 3);
const clamp8 = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

// frame: ImageData at camera size; returns a new ImageData.
// dither: one of DITHERS (default: the 4x4 Bayer); with preset.ditherTag its
// code is drawn left of the preset's tag.
export function render(m, frame, preset, lut, dither = ditherById("bayer4")) {
  const { width: w, height: h, data } = frame;
  const bw = w >> 1;
  const bh = h >> 1;
  const paint = preset.paint.map(yuvToRgb);
  const blocks = new Uint8Array(bw * bh);
  // the blocks' average Y, U, V
  const Y = new Uint8Array(bw * bh);
  const U = new Uint8Array(bw * bh);
  const V = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let ys = 0, us = 0, vs = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((2 * by + dy) * w + 2 * bx + dx) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        ys += 0.299 * r + 0.587 * g + 0.114 * b;
        us += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        vs += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      const k = by * bw + bx;
      Y[k] = Math.round(ys) >> 2;
      U[k] = Math.max(0, Math.min(255, Math.round(us / 4)));
      V[k] = Math.max(0, Math.min(255, Math.round(vs / 4)));
    }

  if (dither.kind === "diffuse") {
    // error diffusion in Y, U and V: each block's error against its match
    // colour goes to the neighbours still to come, rows top to bottom
    const rows = Math.max(...dither.kernel.map(([, dy]) => dy)) + 1;
    const err = Array.from({ length: rows }, () => [0, 1, 2].map(() => new Float32Array(bw + 4)));
    // even toned: offsets to the nearest darker / lighter block, this row and the last
    const far = () => new Float32Array(2 * bw).fill(EVEN_MAX);
    let [darkPrev, darkCur, lightPrev, lightCur] = [far(), far(), far(), far()];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const k = by * bw + bx;
        const c = [Y[k] + err[0][0][bx + 2], U[k] + err[0][1][bx + 2], V[k] + err[0][2][bx + 2]].map(clamp8);
        let idx;
        if (dither.even) {
          // lean darker the further the last darker block is (and the nearer
          // the last lighter one), and the other way round; the error is
          // still against c, so the tone stays
          const [dv, dd] = nearest(darkPrev, darkCur, bx, bw);
          const [lv, ld] = nearest(lightPrev, lightCur, bx, bw);
          idx = lut[bin(clamp8(c[0] - EVEN_GAIN * (dd - ld)), c[1], c[2])];
          // a dot: darker / lighter than the block's own nearest colour (the
          // minority level between two palette colours)
          const my = preset.match[idx][0];
          const own = preset.match[lut[bin(Y[k], U[k], V[k])]][0];
          const dot = (cur, v, on) => ((cur[2 * bx] = on ? 0 : v[0]), (cur[2 * bx + 1] = on ? 0 : v[1]));
          dot(darkCur, dv, my < own);
          dot(lightCur, lv, my > own);
        } else idx = lut[bin(...c)];
        blocks[k] = idx;
        const e = [0, 1, 2].map((j) => c[j] - preset.match[idx][j]);
        for (const [dx, dy, wt] of dither.kernel)
          for (let j = 0; j < 3; j++) err[dy][j][bx + 2 + dx] += (e[j] * wt) / dither.div;
      }
      err.push(err.shift());
      for (const ch of err[rows - 1]) ch.fill(0);
      [darkPrev, darkCur] = [darkCur, darkPrev];
      [lightPrev, lightCur] = [lightCur, lightPrev];
    }
  } else if (dither.kind === "riemersma") {
    // along the Hilbert curve, tile by tile: each block gets the weighted
    // sum of the last errors (Y, U, V), its own error joins them
    const T = 32;
    const curve = hilbert(T);
    const hist = [0, 1, 2].map(() => new Float32Array(RIEMERSMA));
    const top = RIEMERSMA_WEIGHTS[RIEMERSMA - 1];
    let at = 0; // the newest entry in the ring
    for (let ty = 0; ty < bh; ty += T)
      for (let tx = 0; tx < bw; tx += T)
        for (const [x, y] of curve) {
          const bx = tx + x, by = ty + y;
          if (bx >= bw || by >= bh) continue;
          const k = by * bw + bx;
          const own = [Y[k], U[k], V[k]];
          const c = [0, 1, 2].map((j) => {
            let e = 0;
            for (let i = 0; i < RIEMERSMA; i++) e += hist[j][(at + 1 + i) % RIEMERSMA] * RIEMERSMA_WEIGHTS[i];
            return clamp8(own[j] + e / top);
          });
          const idx = lut[bin(...c)];
          blocks[k] = idx;
          at = (at + 1) % RIEMERSMA;
          for (let j = 0; j < 3; j++) hist[j][at] = own[j] - preset.match[idx][j];
        }
  } else if (dither.kind === "mix") {
    // the bin's colour pair, b where the map's threshold is under its share
    const mix = mixLut(lut, preset.match, m.wy);
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const k = by * bw + bx;
        const i = bin(Y[k], U[k], V[k]);
        blocks[k] = mix.t[i] > dither.thresholds[(by % dither.h) * dither.w + (bx % dither.w)] ? mix.b[i] : mix.a[i];
      }
  } else {
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const k = by * bw + bx;
        const y = Math.max(0, Math.min(255, Y[k] + dither.offsets[(by % dither.h) * dither.w + (bx % dither.w)]));
        blocks[k] = lut[bin(y, U[k], V[k])];
      }
  }

  const [dark, light] = tagColours(preset.paint);
  const s = m.tag.scale;
  const stamp = (cells, c0) =>
    cells.forEach((row, r) =>
      row.forEach((v, c) => {
        if (!v) return;
        for (let yy = 0; yy < s; yy++)
          for (let xx = 0; xx < s; xx++) blocks[(m.tag.top + r * s + yy) * bw + c0 + c * s + xx] = v === 1 ? dark : light;
      }),
    );
  let left = bw - m.tag.right;
  if (preset.tag) {
    const cells = tagCells(m, preset.tag);
    left -= cells[0].length * s;
    stamp(cells, left);
    left -= DITHER_TAG_GAP * s;
  }
  if (preset.ditherTag) {
    const cells = ditherTagCells(m, dither);
    stamp(cells, left - cells[0].length * s);
  }

  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint[blocks[(y >> 1) * bw + (x >> 1)]];
      const i = (y * w + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  return out;
}
