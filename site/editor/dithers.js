// The dithering options, over 2x2 blocks (the camera's unit), of three kinds:
//   offset   (the camera's own) a threshold map: a block's luma gets the
//            offset at its spot in the map before it's matched against the
//            palette; the offsets run from -32 (one BW_LEVELS step below) up,
//            as the camera's 4x4 Bayer always did: (B - 8) * 4
//   mix      palette-aware: per colour the pair of match colours whose mix
//            comes closest (sim.js mixLut), the map picks which one a block
//            gets; so hues dither too, not only light and dark
//   diffuse  error diffusion: a block's error (Y, U, V) against its match
//            colour is passed on to the blocks after it, by `kernel`
//            ([dx, dy, weight], over `div`); with `even`, Even Toned Screening
//            (Levien): blocks far from the last darker / lighter ones lean
//            that way, so sparse dots in highlights and shadows space evenly
//   riemersma error diffusion along a Hilbert curve, the error of the last
//            RIEMERSMA blocks (weighted, the newest most) added to the next;
//            the curve runs through 32x32-block tiles, left to right, so it
//            stays inside the camera's 32-block strips
// Maps are at most 32 rows high, so they line up across the camera's 64-row
// (32-block) strips.
//
// code: 2 characters, for the photo tag (the tag font, plus `extraFont`) and
// lcd: the 2 ISO cells of the see-through display (segments "abcdefg").

const bayer = (n) => {
  let m = [[0]];
  while (m.length < n) {
    const k = m.length;
    m = Array.from({ length: 2 * k }, (_, y) =>
      Array.from({ length: 2 * k }, (_, x) => 4 * m[y % k][x % k] + [[0, 2], [3, 1]][(y / k) | 0][(x / k) | 0]),
    );
  }
  return m.flat();
};

const FS = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];

// 1D Bayer over 8: lines that split in halves as the tone moves.
const LINE8 = [0, 4, 2, 6, 1, 5, 3, 7];

// 16x16 blue noise (void and cluster, sigma 1.5; made once, kept as is).
const BLUE16 = [
  201, 29, 230, 117, 250, 200, 135, 12, 226, 79, 160, 98, 57, 215, 148, 44, 162, 96, 170, 2, 147, 69, 40, 206, 118,
  189, 130, 223, 24, 88, 186, 110, 251, 72, 210, 54, 102, 222, 173, 92, 53, 27, 65, 199, 140, 240, 63, 13, 133, 22,
  122, 235, 187, 23, 128, 243, 145, 231, 163, 9, 104, 39, 154, 220, 49, 181, 151, 34, 80, 159, 62, 5, 196, 83, 115,
  252, 176, 211, 85, 193, 78, 244, 93, 205, 111, 254, 212, 106, 43, 178, 28, 75, 52, 124, 1, 112, 30, 136, 6, 172,
  51, 20, 142, 165, 233, 131, 218, 192, 141, 238, 168, 227, 195, 219, 68, 237, 129, 191, 70, 89, 16, 59, 155, 10, 91,
  36, 64, 153, 95, 119, 38, 157, 100, 228, 35, 207, 241, 120, 101, 246, 204, 179, 108, 19, 56, 185, 209, 82, 14, 177,
  114, 144, 184, 41, 164, 71, 48, 146, 214, 253, 167, 8, 138, 248, 50, 213, 60, 0, 77, 202, 26, 225, 123, 4, 76, 132,
  87, 234, 67, 109, 166, 134, 239, 161, 105, 255, 137, 174, 103, 188, 229, 31, 208, 149, 37, 197, 17, 90, 32, 194,
  127, 47, 86, 15, 217, 45, 158, 113, 55, 182, 97, 242, 125, 224, 74, 216, 18, 183, 232, 66, 150, 94, 247, 21, 121,
  221, 11, 156, 46, 180, 152, 58, 99, 143, 203, 116, 33, 198, 73, 171, 81, 139, 61, 190, 84, 25, 107, 245, 169, 42, 3,
  249, 175, 126, 7, 236,
];

const map = (w, h, f) => Array.from({ length: w * h }, (_, i) => f(i % w, (i / w) | 0));

export const DITHERS = [
  { id: "none", name: "None", code: "--", lcd: ["g", "g"], w: 1, h: 1, levels: [0] },
  { id: "bayer2", name: "Bayer 2×2", code: "B2", lcd: ["cdefg", "abdeg"], w: 2, h: 2, levels: bayer(2) },
  { id: "bayer4", name: "Bayer 4×4", code: "B4", lcd: ["cdefg", "bcfg"], w: 4, h: 4, levels: bayer(4) },
  { id: "bayer8", name: "Bayer 8×8", code: "B8", lcd: ["cdefg", "abcdefg"], w: 8, h: 8, levels: bayer(8) },
  { id: "lines", name: "Lines", code: "≡≡", lcd: ["adg", "adg"], w: 1, h: 8, levels: LINE8 },
  { id: "diagonal", name: "Diagonal", code: "//", lcd: ["beg", "beg"], w: 8, h: 8, levels: map(8, 8, (x, y) => LINE8[(x + y) & 7]) },
  { id: "blue", name: "Blue noise", code: "BN", lcd: ["cdefg", "ceg"], w: 16, h: 16, levels: BLUE16 },
  { id: "mix4", kind: "mix", name: "Colour Bayer 4\u00d74", code: "C4", lcd: ["deg", "bcfg"], w: 4, h: 4, levels: bayer(4) },
  { id: "mix8", kind: "mix", name: "Colour Bayer 8\u00d78", code: "C8", lcd: ["deg", "abcdefg"], w: 8, h: 8, levels: bayer(8) },
  { id: "mixblue", kind: "mix", name: "Colour blue noise", code: "CN", lcd: ["deg", "ceg"], w: 16, h: 16, levels: BLUE16 },
  {
    id: "fs", kind: "diffuse", name: "Floyd\u2013Steinberg", code: "FS", lcd: ["aefg", "acdfg"],
    kernel: FS, div: 16,
  },
  {
    id: "sierralite", kind: "diffuse", name: "Sierra Lite", code: "SL", lcd: ["acdfg", "def"],
    kernel: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]], div: 4,
  },
  { id: "even", kind: "diffuse", even: true, name: "Even toned", code: "ET", lcd: ["adefg", "defg"], kernel: FS, div: 16 },
  {
    id: "atkinson", kind: "diffuse", name: "Atkinson", code: "AT", lcd: ["abcefg", "defg"],
    kernel: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], div: 8,
  },
  {
    id: "jjn", kind: "diffuse", name: "Jarvis\u2013Judice\u2013Ninke", code: "JN", lcd: ["bcde", "ceg"],
    kernel: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
    div: 48,
  },
  { id: "riemersma", kind: "riemersma", name: "Riemersma", code: "RI", lcd: ["eg", "c"] },
];

// Riemersma: how many past errors count, and how much less the oldest does
// than the newest (Riemersma's own: 16 and 1/16).
export const RIEMERSMA = 16;
export const RIEMERSMA_WEIGHTS = Float32Array.from({ length: RIEMERSMA }, (_, i) =>
  Math.round(Math.exp((Math.log(RIEMERSMA) * i) / (RIEMERSMA - 1))),
); // oldest first

// The Hilbert curve through an n x n tile (n a power of 2), as [x, y] steps.
export function hilbert(n) {
  const out = [];
  for (let d = 0; d < n * n; d++) {
    let x = 0, y = 0, t = d;
    for (let s = 1; s < n; s *= 2) {
      const rx = 1 & (t >> 1);
      const ry = 1 & (t ^ rx);
      if (!ry) {
        if (rx) (x = s - 1 - x), (y = s - 1 - y);
        [x, y] = [y, x];
      }
      x += s * rx;
      y += s * ry;
      t >>= 2;
    }
    out.push([x, y]);
  }
  return out;
}

// What the display shows in the random mode: "rn".
export const RND_LCD = ["eg", "ceg"];

// Glyphs the dither tags need beyond the camera's tag font.
export const extraFont = {
  "≡": ["111", "000", "111", "000", "111"],
  "/": ["001", "001", "010", "100", "100"],
};

for (const d of DITHERS) {
  d.kind ??= "offset";
  if (!d.levels) continue;
  const n = Math.max(...d.levels) + 1;
  d.n = n;
  d.offsets = Int8Array.from(d.levels, (l) => (n < 2 ? 0 : Math.floor((l * 64) / n) - 32));
  d.thresholds = Float32Array.from(d.levels, (l) => (l + 0.5) / n);
}

export const ditherById = (id) => DITHERS.find((d) => d.id === id) ?? DITHERS[2];
