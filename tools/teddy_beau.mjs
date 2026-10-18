// Teddy-Beau, diid's "Untitled" dither (https://www.cada.art/columns/untitled,
// source untitled.cada.art/gen.js, CC0), reimplemented for any RGB grid, plus
// a colour version of it. Not on the camera (too slow for photos, impossible
// for video: see docs/c100-firmware.md, "Dithering algorithms"); kept here to
// build on elsewhere.
//
//   teddyBeau(r, g, b, w, h)  -> Uint8Array w*h of 0 / 255: the two-tone result
//   teddyBeauColour(r, g, b, w, h, nearest) -> Uint8Array w*h of colour indices
//
// r, g, b: Float32Array (or any array) w*h, 0..255. The steps, as gen.js:
//  1. blur the image a little (gen.js: p5's BLUR 1.1; here [1 2 1] both ways)
//  2. make versions: the grey at exposures 0, +0.1, -0.1 (px + px * e,
//     clamped), and per exposure the 6 channel mixes: channel c at 1 - 2d, the
//     other two at d, for d = 0.1, 0.3 (gen.js doesn't pass the exposure to
//     these, so they repeat; kept)
//  3. dither each: stretch its min..max to 0..255, scale to 0..18, white where
//     v + 1 > the pattern (diid's clustered 8x8, values 1..18)
//  4. fuse them one by one into the result so far: per pixel keep whichever
//     scores higher, score = |9x9 LoG of the dithered image| (centre -10,
//     gen.js's off-by-one offset of 5 kept) x well-exposedness
//     exp(-((v - 128) / 256)^2 / (2 * 0.2^2)) of the dithered value; ties go
//     to the newer one
// gen.js's grey is the blue channel (imgPixels[i + 2]); here it's the luma,
// 0.299 R + 0.587 G + 0.114 B. gen.js paints white (126, 143, 250) and the
// rest (47, 47, 47).
//
// The colour version (mine): the two-tone result as a nudge instead of the
// answer. Each pixel's luma goes up 28 where it's white and down 32 where
// it's black, and then to the nearest palette colour, as the camera's ordered
// dithers do with their threshold maps. So the palette keeps the colours and
// Teddy-Beau's patterns and edges come through as texture.
//
// Usage on a photo (needs pillow for the decode):
//   node tools/teddy_beau.mjs in.rgba w h out.rgba   (raw RGBA in and out)

// diid's pattern, gen.js's diid8x8, read as matrix[x % 8][y % 8].
const DIID = [
  [1, 13, 7, 16, 3, 13, 7, 18],
  [10, 8, 11, 9, 10, 8, 11, 9],
  [6, 14, 5, 12, 6, 14, 5, 12],
  [11, 9, 10, 8, 11, 9, 10, 8],
  [4, 13, 7, 17, 2, 13, 7, 15],
  [10, 8, 11, 9, 10, 8, 11, 9],
  [6, 14, 5, 12, 6, 14, 5, 12],
  [11, 9, 10, 8, 11, 9, 10, 8],
];

// gen.js's LoGKernel ("MIDDLE MODIFIED FROM -40 TO -10").
const LOG = [
  [0, 1, 1, 2, 2, 2, 1, 1, 0],
  [1, 2, 4, 5, 5, 5, 4, 2, 1],
  [1, 4, 5, 3, 0, 3, 5, 4, 1],
  [2, 5, 3, -12, -24, -12, 3, 5, 2],
  [2, 5, 0, -24, -10, -24, 0, 5, 2],
  [2, 5, 3, -12, -24, -12, 3, 5, 2],
  [1, 4, 5, 3, 0, 3, 5, 4, 1],
  [1, 2, 4, 5, 5, 5, 4, 2, 1],
  [0, 1, 1, 2, 2, 2, 1, 1, 0],
];

export const EXPOSURES = [0, 0.1, -0.1]; // gen.js's defaults (slider 2 of 5)
export const DIFFS = [0.1, 0.3]; // (slider 3 of 5)

export function teddyBeau(R, G, B, w, h) {
  const n = w * h;
  const blur = (ch) => {
    const t = new Float32Array(n);
    const o = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        t[y * w + x] = (ch[y * w + Math.max(x - 1, 0)] + 2 * ch[y * w + x] + ch[y * w + Math.min(x + 1, w - 1)]) / 4;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        o[y * w + x] = (t[Math.max(y - 1, 0) * w + x] + 2 * t[y * w + x] + t[Math.min(y + 1, h - 1) * w + x]) / 4;
    return o;
  };
  const rgb = [blur(R), blur(G), blur(B)];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const grey = (e) =>
    Float32Array.from({ length: n }, (_, i) => {
      const l = 0.299 * rgb[0][i] + 0.587 * rgb[1][i] + 0.114 * rgb[2][i];
      return clamp(l + l * e);
    });
  const channel = (c, d) =>
    Float32Array.from({ length: n }, (_, i) => clamp((1 - 2 * d) * rgb[c][i] + d * (rgb[0][i] + rgb[1][i] + rgb[2][i] - rgb[c][i])));
  const dither = (p) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of p) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = (((255 * (p[y * w + x] - lo)) / (hi - lo || 1)) * 18) / 256;
        out[y * w + x] = v + 1 > DIID[x & 7][y & 7] ? 255 : 0;
      }
    return out;
  };
  const expo = (v) => Math.exp(-(((v - 128) / 256) ** 2) / (2 * 0.2 ** 2));
  const score = (p, x, y) => {
    let acc = 0;
    for (let i = 0; i < 9; i++) {
      const xx = x + i - 5; // gen.js convolves over [x][y]: i runs along x
      if (xx < 0 || xx >= w) continue;
      for (let j = 0; j < 9; j++) {
        const yy = y + j - 5;
        if (yy >= 0 && yy < h && p[yy * w + xx]) acc += LOG[i][j] * 255;
      }
    }
    return Math.abs(acc) * expo(p[y * w + x]);
  };
  // where both agree the choice doesn't matter, so only score where they differ
  const fuse = (gold, opt) => {
    const out = gold.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (gold[i] !== opt[i] && score(gold, x, y) <= score(opt, x, y)) out[i] = opt[i];
      }
    return out;
  };
  let gold;
  for (const e of EXPOSURES) {
    const g = dither(grey(e));
    gold = gold ? fuse(gold, g) : g;
    for (const d of DIFFS) for (let c = 0; c < 3; c++) gold = fuse(gold, dither(channel(c, d)));
  }
  return gold;
}

// nearest(y, u, v) -> palette index (on the camera: the lookup table).
export function teddyBeauColour(R, G, B, w, h, nearest) {
  const bits = teddyBeau(R, G, B, w, h);
  return Uint8Array.from({ length: w * h }, (_, i) => {
    const [r, g, b] = [R[i], G[i], B[i]];
    const y = 0.299 * r + 0.587 * g + 0.114 * b + (bits[i] ? 28 : -32);
    const u = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const v = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return nearest(Math.max(0, Math.min(255, y)), u, v);
  });
}

// node tools/teddy_beau.mjs in.rgba w h out.rgba: the two-tone result, in
// gen.js's colours.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const [file, w, h, outFile] = process.argv.slice(2);
  const px = readFileSync(file);
  const n = +w * +h;
  const ch = (c) => Float32Array.from({ length: n }, (_, i) => px[4 * i + c]);
  const bits = teddyBeau(ch(0), ch(1), ch(2), +w, +h);
  const out = new Uint8Array(4 * n);
  bits.forEach((v, i) => out.set(v ? [126, 143, 250, 255] : [47, 47, 47, 255], 4 * i));
  writeFileSync(outFile, out);
}
