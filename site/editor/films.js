// A preset's paint colours: its colours through the S-curve (if on), then
// through its film (if any). The camera only sees the result: it matches
// against the colours and paints with these, index for index. Films are G'MIC
// HaldCLUTs (level 8: a 64^3 cube in a 512x512 PNG), looked up trilinearly
// exactly as tools/film.py does it (numpy: x in float32, the cube in float32,
// the rest in float64, rounded half to even), so the current presets get the
// same colours as tools/film_colours.py. The S-curve is BW's tone curve:
// luma through BW_MATCH -> BW_LEVELS, piecewise linear, chroma kept; on BW's
// greys it gives exactly BW_LEVELS.
import { rgbToYuv, yuvToRgb } from "./firmware.js?v=202610262303";

const f32 = Math.fround;
const cubes = {};

function roundEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  return d === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
}

function loadCube(file) {
  return (cubes[file] ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const count = img.width * img.height;
      const n = Math.round(Math.cbrt(count));
      const cube = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) cube[3 * i + k] = f32(f32(px[4 * i + k]) / 255);
      resolve({ n, cube });
    };
    img.onerror = () => reject(new Error(`couldn't load ${file}`));
    img.src = new URL(file, import.meta.url).href;
  }));
}

function lookup({ n, cube }, rgb) {
  const x = rgb.map((v) => f32(f32(f32(v) / 255) * (n - 1)));
  const i0 = x.map((v) => Math.min(Math.max(Math.floor(v), 0), n - 2));
  const f = x.map((v, k) => v - i0[k]);
  const [fr, fg, fb] = f;
  const [r0, g0, b0] = i0;
  const out = [0, 0, 0];
  for (const [db, wb] of [[0, 1 - fb], [1, fb]])
    for (const [dg, wg] of [[0, 1 - fg], [1, fg]])
      for (const [dr, wr] of [[0, 1 - fr], [1, fr]]) {
        const at = 3 * (((b0 + db) * n + g0 + dg) * n + r0 + dr);
        const w = wb * wg * wr;
        for (let k = 0; k < 3; k++) out[k] = out[k] + w * cube[at + k];
      }
  return out.map((v) => Math.min(Math.max(roundEven(v * 255), 0), 255));
}

function curve(points, y) {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (y <= x1) return roundEven(y0 + ((y - x0) * (y1 - y0)) / (x1 - x0));
  }
  return y;
}

// film: an entry of library.json films, or null; points: the S-curve
// (library.json curve), or null.
export async function paintColours(film, points, colours) {
  let out = points ? colours.map(([y, u, v]) => [curve(points, y), u, v]) : colours;
  if (film) {
    const cube = await loadCube(film.file);
    out = out.map((c) => rgbToYuv(lookup(cube, yuvToRgb(c))));
  }
  return out;
}
