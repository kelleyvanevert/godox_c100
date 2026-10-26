// The camera's effect in the browser, integer for integer as the firmware
// (tools/sim_look.py is the exact reference): per block (2x2, or 4x4) the
// mean luma through the look's luma map (contrast, brightness, the Game Boy
// tone), sharpened, plus its dither offset; the block's Y, U, V looked up in
// a 33x33x33 table of nearest match colours (or for a ramp, the even shade
// of its luma), painted with the paint colour at that index; then the tag.
import { cropFor, ditherTable, lumaMap, sharpenWeight, tagCells, tagColours, yuvToRgb } from "./firmware.js";

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

// The aspect setting nearest a photo's shape (by the settings' stock crops),
// with its crop and output size; sizes = { "16:9": [w, h], ... }.
export function cameraSize(m, sizes, w, h) {
  const off = (k) => Math.abs(m.stockCrops[k][0] / m.stockCrops[k][1] - w / h);
  const name = Object.keys(m.stockCrops).reduce((a, b) => (off(a) <= off(b) ? a : b));
  return { crop: cropFor(m, name, ...sizes[name]), size: sizes[name] };
}

// The photo cropped (centred, to the crop's aspect) and scaled to the output.
export function cameraFrame(m, sizes, img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const { crop, size } = cameraSize(m, sizes, w, h);
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

// A look on the camera's planes, as tools/sim_look.py (the exact reference;
// tools/look_check.mjs checks this against it): Y per pixel (w x h), U, V per
// 2x2 block (w/2 x h/2 pairs); p a preset as the firmware gets it (firmware.js
// sortedRamp: a ramp's colours dark to light); lut = buildLut(p.match) unless a
// ramp. Returns the colour index per 2x2 block (a 4x4 block's four alike).
export function lookBlocks(Y, UV, w, h, p, lut) {
  const s = p.pixel ?? 2;
  const k = s >> 1;
  const bw = Math.floor(w / s);
  const bh = Math.floor(h / s);
  const ymap = lumaMap(p);
  const dither = ditherTable(p);
  const wgt = sharpenWeight(p);
  const n = p.match.length;
  const out = new Uint8Array((w >> 1) * (h >> 1));
  const row = new Int32Array(bw);
  const us = new Int32Array(bw);
  const vs = new Int32Array(bw);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let ysum = 0, usum = 0, vsum = 0;
      for (let dy = 0; dy < s; dy++)
        for (let dx = 0; dx < s; dx++) ysum += Y[(s * by + dy) * w + s * bx + dx];
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const i = ((k * by + dy) * (w >> 1) + k * bx + dx) * 2;
          usum += UV[i];
          vsum += UV[i + 1];
        }
      row[bx] = ymap[ysum >> (s === 2 ? 2 : 4)];
      us[bx] = usum >> (s === 2 ? 0 : 2);
      vs[bx] = vsum >> (s === 2 ? 0 : 2);
    }
    for (let bx = 0; bx < bw; bx++) {
      let y = row[bx];
      if (wgt) y += ((2 * y - row[Math.max(bx - 1, 0)] - row[Math.min(bx + 1, bw - 1)]) * wgt) >> 7;
      y = Math.max(0, Math.min(255, y + dither[(by & 3) * 4 + (bx & 3)]));
      const q = (y + 4) >> 3;
      const idx = p.ramp
        ? Math.min(n - 1, (8 * q * n) >> 8)
        : lut[(q * N + ((us[bx] + 4) >> 3)) * N + ((vs[bx] + 4) >> 3)];
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) out[(k * by + dy) * (w >> 1) + k * bx + dx] = idx;
    }
  }
  return out;
}

// The camera's planes of a frame (an ImageData): Y per pixel, U and V per 2x2
// block (the mean of its pixels'), JFIF YCbCr as firmware.js rgbToYuv.
export function planes(frame) {
  const { width: w, height: h, data } = frame;
  const Y = new Uint8Array(w * h);
  const UV = new Uint8Array((w >> 1) * (h >> 1) * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      Y[y * w + x] = Math.max(0, Math.min(255, Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])));
    }
  for (let by = 0; by < h >> 1; by++)
    for (let bx = 0; bx < w >> 1; bx++) {
      let us = 0, vs = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((2 * by + dy) * w + 2 * bx + dx) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        us += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        vs += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      const o = (by * (w >> 1) + bx) * 2;
      UV[o] = Math.max(0, Math.min(255, Math.round(us / 4)));
      UV[o + 1] = Math.max(0, Math.min(255, Math.round(vs / 4)));
    }
  return { Y, UV };
}

// frame: ImageData at camera size; p: the look as the firmware gets it, plus
// its tag ("" for none); returns a new ImageData.
export function render(m, frame, p, lut) {
  const { width: w, height: h } = frame;
  const { Y, UV } = planes(frame);
  const blocks = lookBlocks(Y, UV, w, h, p, lut);
  const bw = w >> 1;
  const paint = p.paint.map(yuvToRgb);
  if (p.tag) {
    const [dark, light] = tagColours(p.paint);
    const cells = tagCells(m, p.tag);
    const t = m.tag.scale;
    const c0 = bw - m.tag.right - cells[0].length * t;
    cells.forEach((cellRow, r) =>
      cellRow.forEach((v, c) => {
        if (!v) return;
        for (let yy = 0; yy < t; yy++)
          for (let xx = 0; xx < t; xx++) blocks[(m.tag.top + r * t + yy) * bw + c0 + c * t + xx] = v === 1 ? dark : light;
      }),
    );
  }
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint[blocks[Math.min(y >> 1, (h >> 1) - 1) * bw + Math.min(x >> 1, bw - 1)]];
      const i = (y * w + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  return out;
}
