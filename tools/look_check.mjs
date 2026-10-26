// Writes random strips and looks for tools/look_check.py, which checks the
// editor's preview core (site/editor/sim.js lookBlocks) against the exact
// reference (tools/sim_look.py). Needs no DOM.
//   node tools/look_check.mjs COUNT > cases.json
import { sortedRamp } from "../site/editor/firmware.js";
import { buildLut, lookBlocks } from "../site/editor/sim.js";

const count = +process.argv[2] || 40;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const int = (n) => Math.floor(rand() * n);
const between = (lo, hi) => lo + int(hi - lo + 1);

const cases = [];
for (let c = 0; c < count; c++) {
  const w = [704, 640, 608, 528, 208, 64][c % 6];
  const h = 64;
  // smooth-ish random images (gradients plus noise), and plain noise every 4th
  const Y = Uint8Array.from({ length: w * h }, (_, i) =>
    c % 4 === 3 ? int(256) : Math.max(0, Math.min(255, ((i % w) * 255) / w + ((i / w) | 0) * 2 + int(40) - 20)));
  const UV = Uint8Array.from({ length: (w >> 1) * (h >> 1) * 2 }, () => between(60, 196));
  const n = 1 + int(c % 5 === 0 ? 32 : 12);
  const match = Array.from({ length: n }, () => [int(256), int(256), int(256)]);
  const ramp = rand() < 0.5;
  const p = sortedRamp({
    match, paint: match, ramp, gbTone: ramp && rand() < 0.6, pixel: rand() < 0.5 ? 4 : 2,
    sharpen: rand() < 0.3 ? 0 : int(101), contrast: between(-50, 50), brightness: between(-50, 50),
  });
  const lut = p.ramp ? null : buildLut(p.match, 2);
  const idx = lookBlocks(Y, UV, w, h, p, lut);
  cases.push({ w, h, p, Y: Buffer.from(Y).toString("base64"), UV: Buffer.from(UV).toString("base64"),
               idx: Buffer.from(idx).toString("base64") });
}
process.stdout.write(JSON.stringify(cases));
