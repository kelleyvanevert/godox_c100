// The camera's effect in the browser (tools/sim_palette.py with the camera's
// lookup table): per 2x2 block the average luma through the preset's luma map
// (contrast, brightness) plus a 4x4 Bayer offset, the
// block's Y, U, V looked up in a 33x33x33 table of nearest match colours,
// painted with the paint colour at that index; then the tag, top right.
// Preview only so far (not in the firmware yet): a ramp picked by brightness,
// 4x4 pixels and sharpening (render's preset.shades, pixel, sharpen).
import { cropFor, tagCells, tagColours, yuvToRgb } from "./firmware.js";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
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

// frame: ImageData at camera size; returns a new ImageData. preset:
//   paint      the paint colours
//   ymap       firmware.js lumaMap (contrast, brightness, the Game Boy tone), the identity if left out
//   shades     null: each block gets the nearest match colour (lut); else a ramp: the colour
//              indices dark to light, and a block's brightness alone picks one, as that many even shades
//   pixel      2 or 4: the blocks' size in pixels (2 if left out)
//   sharpen    0..1: horizontal edge sharpening of the blocks' brightness (0.5 = the Game Boy's)
//   tag        drawn top right, in 2x2 blocks whatever the pixel size
export function render(m, frame, preset, lut) {
  const { width: w, height: h, data } = frame;
  const s = preset.pixel ?? 2;
  const bw = Math.floor(w / s);
  const bh = Math.floor(h / s);
  const n = s * s;
  const paint = preset.paint.map(yuvToRgb);
  const shades = preset.shades;
  const blocks = new Uint8Array(bw * bh);
  const row = new Int16Array(bw); // a row of blocks' mapped brightness, for the sharpening
  const us = new Uint8Array(bw);
  const vs = new Uint8Array(bw);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let ysum = 0, usum = 0, vsum = 0;
      for (let dy = 0; dy < s; dy++)
        for (let dx = 0; dx < s; dx++) {
          const i = ((s * by + dy) * w + s * bx + dx) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          ysum += 0.299 * r + 0.587 * g + 0.114 * b;
          usum += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          vsum += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      const y = Math.min(255, Math.floor(Math.round(ysum) / n));
      row[bx] = preset.ymap ? preset.ymap[y] : y;
      us[bx] = Math.max(0, Math.min(255, Math.round(usum / n)));
      vs[bx] = Math.max(0, Math.min(255, Math.round(vsum / n)));
    }
    for (let bx = 0; bx < bw; bx++) {
      let y = row[bx];
      if (preset.sharpen) {
        const left = row[Math.max(bx - 1, 0)];
        const right = row[Math.min(bx + 1, bw - 1)];
        y = Math.max(0, Math.min(255, y + Math.trunc((2 * y - left - right) * preset.sharpen)));
      }
      const bayer = BAYER[(by & 3) * 4 + (bx & 3)];
      if (shades) {
        // even shades: 256 / count levels each, dithered across one level
        const k = shades.length;
        const shade = Math.floor(((y + ((bayer - 7.5) * 16) / k) * k) / 256);
        blocks[by * bw + bx] = shades[Math.max(0, Math.min(k - 1, shade))];
      } else {
        y = Math.max(0, Math.min(255, y + (bayer - 8) * 4));
        blocks[by * bw + bx] = lut[(((y + 4) >> 3) * N + ((us[bx] + 4) >> 3)) * N + ((vs[bx] + 4) >> 3)];
      }
    }
  }

  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const by = Math.min(Math.floor(y / s), bh - 1);
      const bx = Math.min(Math.floor(x / s), bw - 1);
      const [r, g, b] = paint[blocks[by * bw + bx]];
      const i = (y * w + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }

  if (preset.tag) {
    const [dark, light] = tagColours(preset.paint).map((i) => paint[i]);
    const cells = tagCells(m, preset.tag);
    const t = 2 * m.tag.scale; // pixels per tag cell
    const x0 = 2 * ((w >> 1) - m.tag.right) - cells[0].length * t;
    const y0 = 2 * m.tag.top;
    cells.forEach((cellRow, r) =>
      cellRow.forEach((v, c) => {
        if (!v) return;
        const [cr, cg, cb] = v === 1 ? dark : light;
        for (let yy = 0; yy < t; yy++)
          for (let xx = 0; xx < t; xx++) {
            const i = ((y0 + r * t + yy) * w + x0 + c * t + xx) * 4;
            out.data[i] = cr;
            out.data[i + 1] = cg;
            out.data[i + 2] = cb;
          }
      }),
    );
  }
  return out;
}
