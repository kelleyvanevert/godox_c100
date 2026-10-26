// Builds a custom firmware from the template build (tools/editor_data.py) by
// writing a config into it, byte for byte what tools/build.sh would make from
// the same config (tools/editor_check.sh checks that). No DOM: runs in Node too.
//
// A config is { presets: [{ tag, match, paint, contrast, brightness, ramp, gbTone, pixel, sharpen, lcd }],
//   rnd, normal, sounds, tags, sizes }:
//   match, paint  [[Y, U, V], ...], index for index: blocks snap to a match
//                 colour and get painted with the paint colour at its index
//   contrast      percent added around mid-grey before matching (optional, 0)
//   brightness    luma levels added before matching (optional, 0)
//   ramp          pick by brightness only: the colours as a ramp of even shades, dark to
//                 light (sorted so here); gbTone: with a ramp, the Game Boy Camera's tone
//   pixel         2 or 4: the blocks' size; sharpen: 0..100, horizontal (optional)
//   lcd           the lit segments ("abcdefg") of each of the display's 3 cells
//   rnd           the center button also offers a random preset per photo
//   normal        and then the normal mode: no effect, photos and video as the
//                 factory makes them, at its sizes (optional, false)
//   sounds        play the shutter and power-on sounds (the speaker is never
//                 switched on otherwise)
//   tags          draw the preset's tag top right on photos and videos (the
//                 default; false leaves the tag records empty, so nothing is drawn)
//   sizes         { "16:9": [w, h], ... } for each aspect setting, photo and video
//                 (optional; the template's otherwise). The crop follows (cropFor).
// and two WAVs (11025 Hz mono 16-bit) for the shutter and power-on sounds,
// plus the factory's CLICK slot (sounds.click), which the template has
// silenced and sounds on puts back.

export const WAV_HEADER = 44;

// Python's round(): halves go to the even neighbour.
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const clamp = (x) => Math.max(0, Math.min(255, pyRound(x)));

// JFIF Y, Cb, Cr: what the camera's buffers hold (palettes.py hex_to_yuv).
export function rgbToYuv([r, g, b]) {
  return [
    clamp(0.299 * r + 0.587 * g + 0.114 * b),
    clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
    clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
  ];
}

export function yuvToRgb([y, u, v]) {
  u -= 128;
  v -= 128;
  return [clamp(y + 1.402 * v), clamp(y - 0.344136 * u - 0.714136 * v), clamp(y + 1.772 * u)];
}

export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
export const yuvToHex = (c) => rgbToHex(yuvToRgb(c));
export const hexToYuv = (hex) => rgbToYuv(hexToRgb(hex));

// ---- tags (palettes.py tag_cells, tag_colours) ----

export function tagWidth(m, text) {
  return [...text].reduce((w, ch) => w + m.font[ch][0].length + 1, 1);
}

// 0 = photo shows through, 1 = outline (darkest colour), 2 = letter (lightest).
export function tagCells(m, text, width) {
  const rows = m.tag.rows;
  const cols = tagWidth(m, text);
  const lit = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let x = 1;
  for (const ch of text) {
    m.font[ch].forEach((row, r) => [...row].forEach((bit, c) => (lit[1 + r][x + c] = +bit)));
    x += m.font[ch][0].length + 1;
  }
  const cells = lit.map((row, r) =>
    row.map((v, c) => {
      if (v) return 2;
      for (let rr = Math.max(r - 1, 0); rr < Math.min(r + 2, rows); rr++)
        for (let cc = Math.max(c - 1, 0); cc < Math.min(c + 2, cols); cc++) if (lit[rr][cc]) return 1;
      return 0;
    }),
  );
  return width ? cells.map((row) => new Array(width - cols).fill(0).concat(row)) : cells;
}

export function tagColours(paint) {
  const ys = paint.map((c) => c[0]);
  return [ys.indexOf(Math.min(...ys)), ys.indexOf(Math.max(...ys))];
}

function tagBytes(m, tag, paint) {
  const flat = tagCells(m, tag, m.tag.cols).flat();
  const packed = [];
  for (let i = 0; i < flat.length; i += 4)
    packed.push(flat.slice(i, i + 4).reduce((b, v, j) => b | (v << (2 * j)), 0));
  const [dark, light] = tagColours(paint);
  return [...packed, 3 * dark, 3 * light];
}

// ---- the look's settings (palettes.py luma_map, dither_table, ramp_shade, fx_bytes) ----
// tools/sim_look.py is the exact reference of what the camera does with them;
// sim.js repeats it.

const contrastFix = (p) => Math.floor(((100 + (p.contrast ?? 0)) * 128) / 100);
export const sharpenWeight = (p) => Math.floor(((p.sharpen ?? 0) * 128 + 50) / 100);
const FX_RAMP = 1, FX_GBTONE = 2, FX_PIX4 = 4;
const GB_RANGE = [0x89, 0x92, 0xa2, 0xd2];

// The Game Boy Camera's tone for a ramp of n shades (palettes.py gb_tone): its
// fixed 4x exposure to the MAC-GBD code, 128 + (t - 32) / 2 toward zero, then the
// code's place among GB_RANGE as k whole steps + d / w of the next (w its width),
// stretched over the ramp's n - 1 steps and put in the middle of its shade, rounded.
function gbTone(t, n) {
  const code = 128 + Math.trunc((t - 32) / 2);
  let [k, d, w] = [0, 0, 1];
  if (code >= GB_RANGE[3]) [k, d, w] = [2, 1, 1];
  else if (code >= GB_RANGE[0]) {
    k = [2, 1, 0].find((i) => code >= GB_RANGE[i]);
    [d, w] = [code - GB_RANGE[k], GB_RANGE[k + 1] - GB_RANGE[k]];
  }
  return Math.floor((256 * (2 * (k * w + d) * (n - 1) + 3 * w) + 3 * w * n) / (6 * w * n));
}

// What lut_fill puts in the look's luma map: contrast around mid-grey,
// brightness, clamped; then with a ramp and p.gbTone the Game Boy tone.
export function lumaMap(p) {
  const fix = contrastFix(p);
  const b = p.brightness ?? 0;
  const tone = p.ramp && p.gbTone;
  return Uint8Array.from({ length: 256 }, (_, y) => {
    const t = Math.max(0, Math.min(255, (((y - 128) * fix) >> 7) + 128 + b));
    return tone ? gbTone(t, p.match.length) : t;
  });
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// The 16 luma offsets by (row & 3) * 4 + (col & 3): the Bayer swing of +-32, or
// for a ramp of n one shade's width.
export function ditherTable(p) {
  const n = p.match.length;
  return BAYER.map((b) => (p.ramp ? Math.floor(((2 * b + 1) * 8) / n) - Math.floor(128 / n) : (b - 8) * 4));
}

// A ramp's colours sorted dark to light by match luma (stably), as the camera
// wants them: its shade k is colour k.
export function sortedRamp(p) {
  if (!p.ramp) return p;
  const order = p.match.map((_, i) => i).sort((a, b) => p.match[a][0] - p.match[b][0] || a - b);
  return { ...p, match: order.map((i) => p.match[i]), paint: order.map((i) => p.paint[i]) };
}

const fxBytes = (p) => [
  (p.ramp ? FX_RAMP : 0) | (p.ramp && p.gbTone ? FX_GBTONE : 0) | (p.pixel === 4 ? FX_PIX4 : 0),
  contrastFix(p),
  (p.brightness ?? 0) & 0xff,
  sharpenWeight(p),
];

// ---- the see-through display (palettes.py lcd_nibbles) ----

export function lcdNibbles(m, segments) {
  const nib = new Array(m.ssCount).fill(0);
  segments.forEach((segs, i) => {
    for (const seg of segs) {
      const [addr, com] = m.ssCells[i][seg];
      nib[addr - m.ssFirst] |= 8 >> com;
    }
  });
  return nib;
}

// ---- sizes (palettes.py crop_for, size_errors) ----

// The largest crop at the output's aspect inside the aspect setting's stock
// crop, rounded half up: the width to 16, the height to 4.
export function cropFor(m, aspect, w, h) {
  const [cw, ch] = m.stockCrops[aspect];
  if (w * ch >= h * cw) return [cw, Math.floor((2 * cw * h + 4 * w) / (8 * w)) * 4];
  return [Math.floor((2 * ch * w + 16 * h) / (32 * h)) * 16, ch];
}

// What a size still needs, as phrases ("a width that is a multiple of 16").
export function sizeErrors(m, w, h) {
  const L = m.sizeLimits;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return ["whole numbers"];
  const errors = [];
  if (w % 16) errors.push("a width that is a multiple of 16");
  if (h % 4) errors.push("a height that is a multiple of 4");
  if (w < L.minW || h < L.minH) errors.push(`at least ${L.minW}x${L.minH}`);
  if (w > L.maxW) errors.push(`a width of at most ${L.maxW}`);
  if (h > L.maxH) errors.push(`a height of at most ${L.maxH}`);
  if (w * h > L.maxPixels) errors.push(`at most ${L.maxPixels.toLocaleString("en")} pixels`);
  return errors;
}

// cmp r1, #imm as llvm-mc encodes it: an 8-bit value rotated right by an even
// amount, the smallest such value.
function cmpImmediate(insn, v) {
  let rot = 0;
  if (v > 0xff) {
    const tz = 31 - Math.clz32(v & -v);
    rot = (32 - (tz & ~1)) & 31;
    v >>>= tz & ~1;
  }
  if (v > 0xff) throw new Error(`${v} isn't an ARM immediate`);
  return ((insn & ~0xfff) | ((rot >> 1) << 8) | v) >>> 0;
}

// ---- checks ----

export function configErrors(m, cfg) {
  const errors = [];
  const n = cfg.presets.length;
  if (n < 1) errors.push("Turn on at least one look.");
  if (n > m.maxPresets) errors.push(`At most ${m.maxPresets} looks fit; ${n} are on.`);
  const seen = new Set();
  for (const p of cfg.presets) {
    const name = p.tag || "(no tag)";
    for (const k of ["contrast", "brightness", "sharpen"]) {
      const [lo, hi] = m.fx[k];
      const v = p[k] ?? 0;
      if (!Number.isInteger(v) || v < lo || v > hi) errors.push(`${name}: ${k} from ${lo} to ${hi}.`);
    }
    if (![2, 4, undefined].includes(p.pixel)) errors.push(`${name}: pixels 2 or 4.`);
    // without tags on the photos, they needn't be valid
    if (cfg.tags !== false) {
      if (!p.tag) errors.push("Every look needs a tag.");
      else if ([...p.tag].some((ch) => !m.font[ch])) errors.push(`${name}: the tag font has no "${[...p.tag].find((ch) => !m.font[ch])}".`);
      else if (p.tag.length > m.tag.letters || tagWidth(m, p.tag) > m.tag.cols) errors.push(`${name}: the tag is too wide.`);
      if (seen.has(p.tag)) errors.push(`Two looks are tagged ${name}.`);
      seen.add(p.tag);
    }
    if (p.match.length < 1 || p.match.length > m.maxColours) errors.push(`${name}: 1 to ${m.maxColours} colours.`);
    if (p.paint.length !== p.match.length) errors.push(`${name}: paint and match colours differ in number.`);
  }
  for (const [aspect, [w, h]] of Object.entries(cfg.sizes ?? {})) {
    const need = sizeErrors(m, w, h);
    if (need.length) errors.push(`${aspect} photos need ${need.join(", ")}.`);
  }
  return errors;
}

// ---- WAVs (tools/mk_silence.py, tools/patch_res.py) ----

export function slotSamples(m, slot) {
  const [start, end] = m.slots[slot];
  return Math.floor((end - start - WAV_HEADER) / 2);
}

export function encodeWav(m, samples) {
  const { rate, channels, bits } = m.wav;
  const align = (channels * bits) / 8;
  const out = new Uint8Array(WAV_HEADER + samples.length * 2);
  const dv = new DataView(out.buffer);
  const ascii = (o, s) => [...s].forEach((ch, i) => (out[o + i] = ch.charCodeAt(0)));
  ascii(0, "RIFF");
  dv.setUint32(4, out.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * align, true);
  dv.setUint16(32, align, true);
  dv.setUint16(34, bits, true);
  ascii(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => dv.setInt16(WAV_HEADER + 2 * i, s, true));
  return out;
}

function chunks(wav) {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const out = {};
  for (let off = 12; off + 8 <= wav.length; ) {
    const id = String.fromCharCode(...wav.subarray(off, off + 4));
    const size = dv.getUint32(off + 4, true);
    out[id] ??= [off + 8, size];
    off += 8 + size + (size & 1);
  }
  return out;
}

export function wavFormat(wav) {
  const [off] = chunks(wav)["fmt "] || [];
  if (off === undefined || String.fromCharCode(...wav.subarray(0, 4)) !== "RIFF") return null;
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return { format: dv.getUint16(off, true), channels: dv.getUint16(off + 2, true), rate: dv.getUint32(off + 4, true), bits: dv.getUint16(off + 14, true) };
}

// Same bytes, the data chunk zeroed (mk_silence.py).
export function silence(wav) {
  const out = wav.slice();
  const [off, size] = chunks(out).data;
  out.fill(0, off, Math.min(off + size, out.length));
  return out;
}

function writeSlot(fw, m, slot, wav) {
  const [start, end] = m.slots[slot];
  const f = wavFormat(wav);
  const { rate, channels, bits } = m.wav;
  if (!f || f.format !== 1 || f.channels !== channels || f.rate !== rate || f.bits !== bits)
    throw new Error(`the ${slot} sound is not ${rate} Hz mono ${bits}-bit PCM`);
  if (wav.length > end - start) throw new Error(`the ${slot} sound is ${wav.length} B, the slot ${end - start} B`);
  fw.set(wav, start);
  fw.fill(0xff, start + wav.length, end);
}

// ---- the build ----

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildFirmware(template, m, cfg, sounds) {
  const errors = configErrors(m, cfg);
  if (errors.length) throw new Error(errors.join(" "));
  const fw = template.slice();
  const at = (addr) => m.appOffset + addr; // RAM address -> file offset
  const { pd } = m;
  const n = cfg.presets.length;
  cfg = { ...cfg, presets: cfg.presets.map(sortedRamp) };

  fw.fill(0, at(pd.MATCH), at(pd.END));
  let o = at(pd.MATCH);
  for (const p of cfg.presets) {
    fw[o++] = p.match.length;
    for (const c of p.match) fw.set(c, (o += 3) - 3);
  }
  cfg.presets.forEach((p, i) => {
    fw[at(pd.PMATCH) + i] = i;
    if (cfg.tags !== false) fw.set(tagBytes(m, p.tag, p.paint), at(pd.TAGS) + i * m.tag.bytes);
    fw.set(fxBytes(p), at(pd.FX) + i * m.fx.bytes);
  });
  o = at(pd.DISPLAY);
  const dv = new DataView(fw.buffer);
  cfg.presets.forEach((p, i) => {
    dv.setUint32(at(pd.DPTRS) + 4 * i, o - m.appOffset, true);
    for (const c of p.paint) fw.set(c, (o += 3) - 3);
  });

  // the presets' codes, padded to maxPresets, then rnd's and nor's (fixed)
  fw.fill(0, at(m.lcdTags), at(m.lcdTags) + m.maxPresets * m.ssCount);
  cfg.presets.forEach((p, i) => fw.set(lcdNibbles(m, p.lcd), at(m.lcdTags) + i * m.ssCount));
  const sizes = { ...m.sizes, ...cfg.sizes };
  Object.keys(m.sizes).forEach((aspect, i) => {
    const [w, h] = sizes[aspect];
    [w, h, ...cropFor(m, aspect, w, h)].forEach((x, j) => dv.setUint32(at(m.sizeTable) + 16 * i + 4 * j, x, true));
  });
  const maxW = Math.max(...Object.values(sizes).map(([w]) => w));
  dv.setUint32(at(m.maxWCmp), cmpImmediate(dv.getUint32(at(m.maxWCmp), true), maxW), true);

  for (const a of m.npal) fw[at(a)] = n;
  for (const a of m.npal1) fw[at(a)] = n + 1;
  for (const a of m.modeMax) fw[at(a)] = n + (cfg.normal ? 1 : 0);
  fw[at(m.lastCenter)] = n - 1 + (cfg.rnd ? 1 : 0);
  fw[at(m.afterLast)] = cfg.normal ? n + 1 : 0;

  for (const [addr, on, off] of m.speaker)
    fw.set(Uint8Array.from((cfg.sounds ? on : off).match(/../g), (h) => parseInt(h, 16)), at(addr));
  writeSlot(fw, m, "shutter", cfg.sounds ? sounds.shutter : silence(sounds.shutter));
  writeSlot(fw, m, "poweron", cfg.sounds ? sounds.poweron : silence(sounds.poweron));
  const [start, end] = m.slots.click;
  if (cfg.sounds) {
    if (sounds.click?.length !== end - start) throw new Error("the stock click sound is missing");
    fw.set(sounds.click, start);
  }
  return fw;
}
