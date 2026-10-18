// The firmware editor: the dithers to cycle through (and rnd), 8 preset slots
// (palette, S-curve, film, tag, display code), each on or off, rnd and sounds;
// previewed on nine photos, kept in localStorage, and built into a firmware in
// the browser (firmware.js) from the template.
import { buildFirmware, configErrors, encodeWav, hexToYuv, sha256, slotSamples, tagCells, tagColours, tagWidth, yuvToHex, yuvToRgb } from "./firmware.js";
import { paintColours } from "./films.js";
import { DITHERS, RND_LCD, ditherById, hilbert } from "./dithers.js";
import { buildLut, cameraFrame, ditherTagCells, render } from "./sim.js";

const STORE = "c100-editor-v2";
// a 3 x 3 grid: streets, natural, close-ups
const PHOTOS = [
  "street_sign", "street_duck", "snail", "hydrangeas", "mimosa", "turtle", "cup", "IMG_0577", "dessert",
].map((f) => `editor/photos/${f}.jpg`);
const noPhotos = () => PHOTOS.map(() => null);
const DEFAULT_SLOTS = [
  "EP6 (current preset)", "6FP (current preset)", "BW (current preset)", "endesga32 (32)",
  "db16 + mixes (24)", "sweetie16 (16)", "riso6 + mixes (10)", "nes (32)",
];
const SOUND_PRESETS = { stock: "Stock", mario: "Super Mario" };
const SOUND_LABELS = { shutter: "Shutter", poweron: "Power-on" };
const SEGS = "abcdefg";
// on at the start: the camera's own 4x4 Bayer and a few that look different
const DEFAULT_DITHERS = ["bayer4", "mix4", "fs", "atkinson"];
const defaultDithers = () => DITHERS.map((d) => ({ id: d.id, on: DEFAULT_DITHERS.includes(d.id) }));

// The usual 7-segment letters, one cell each (M and W as well as can be).
const SEG7 = {
  A: "abcefg", B: "abcdefg", C: "adef", D: "bcdeg", E: "adefg", F: "aefg", G: "acdef", H: "bcefg",
  I: "ef", J: "bcde", K: "bcefg", L: "def", M: "abcef", N: "ceg", O: "abcdef", P: "abefg",
  Q: "abcfg", R: "eg", S: "acdfg", T: "defg", U: "bcdef", V: "cde", W: "bcdef", X: "bcefg",
  Y: "bcdfg", Z: "abdeg", 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg",
  6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g",
};

function autoLcd(tag) {
  const cells = [...tag].map((ch) => SEG7[ch] ?? "");
  while (cells.length < 3) cells.push("");
  return cells.slice(0, 3);
}

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const uid = () => Math.random().toString(36).slice(2, 9);

let m; // template.json
let library; // library.json: { palettes, films }
let state;
const frames = noPhotos(); // camera-size ImageData per photo
const soundCache = {}; // "stock/shutter" -> Uint8Array
const paints = new Map(); // film + colours -> paint colours

// ---- state ----

function slotFrom(item, on) {
  return {
    id: uid(),
    on,
    name: item.name,
    tag: item.tag,
    lcd: item.lcd ?? autoLcd(item.tag),
    lcdAuto: !item.lcd || item.lcd.join() === autoLcd(item.tag).join(),
    colours: item.colours.map((c) => [...c]),
    curve: !!item.curve,
    film: item.film,
    sel: 0,
  };
}

function defaultState() {
  const slots = DEFAULT_SLOTS.map((name, i) =>
    slotFrom(library.palettes.find((l) => l.name === name) ?? library.palettes[i], i < 3),
  );
  return {
    dithers: defaultDithers(),
    ditherSel: "bayer4", // the previewed dither
    ditherRnd: true,
    slots,
    selected: slots[0].id,
    rnd: true,
    sounds: { on: false, shutter: { src: "stock" }, poweron: { src: "stock" } },
    photos: noPhotos(),
    view: "grid", // or "detail": one photo large, all of them in a strip below
    big: 0, // the large one
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved?.slots?.length === m.maxPresets) {
      for (const p of saved.slots) {
        // the S-curve used to be one of the films
        if (p.film === "scurve") Object.assign(p, { film: null, curve: true });
        p.curve = !!p.curve;
      }
      // the preview photos changed: own photos don't carry over
      if (saved.photos?.length !== PHOTOS.length) saved.photos = noPhotos();
      // from before the dithers (and the dither list changed): the defaults
      const ids = saved.dithers?.map((d) => d.id).join();
      if (ids !== DITHERS.map((d) => d.id).join()) {
        saved.dithers = defaultDithers();
        saved.ditherSel = "bayer4";
        saved.ditherRnd = true;
      }
      if (!DITHERS.some((d) => d.id === saved.ditherSel)) saved.ditherSel = "bayer4";
      saved.view ??= "grid";
      saved.big ??= 0;
      return saved;
    }
  } catch {}
  return defaultState();
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch {
      // full (big uploaded photos): keep the rest
      try {
        localStorage.setItem(STORE, JSON.stringify({ ...state, photos: noPhotos() }));
      } catch {}
    }
  }, 250);
}

const current = () => state.slots.find((p) => p.id === state.selected) ?? state.slots[0];
const enabled = () => state.slots.filter((p) => p.on);
const dithersOn = () => state.dithers.filter((d) => d.on).map((d) => ditherById(d.id));
const ditherRndOn = () => state.ditherRnd && dithersOn().length > 1;
const film = (p) => library.films.find((f) => f.id === p.film) ?? null;

async function paintOf(p) {
  const key = `${p.film}|${p.curve}|${p.colours.join(" ")}`;
  if (!paints.has(key)) paints.set(key, await paintColours(film(p), p.curve ? library.curve : null, p.colours));
  return paints.get(key);
}

async function config() {
  const on = enabled();
  return {
    presets: await Promise.all(
      on.map(async (p) => ({ tag: p.tag, match: p.colours, paint: await paintOf(p), lcd: p.lcd })),
    ),
    rnd: state.rnd && on.length > 1,
    dithers: dithersOn().map((d) => ({ code: d.code, lcd: d.lcd, w: d.w, h: d.h, offsets: [...d.offsets] })),
    ditherRnd: ditherRndOn(),
    sounds: state.sounds.on,
  };
}

function changed({ list = true, palette = false, preview = true } = {}) {
  if (list) renderList();
  if (palette) renderPalette();
  renderHead();
  renderDownload();
  if (preview) schedulePreview();
  save();
}

// ---- 7-segment cells ----

const SEG_RECTS = {
  a: [2, 0, 8, 2], b: [10, 2, 2, 7], c: [10, 11, 2, 7], d: [2, 18, 8, 2],
  e: [0, 11, 2, 7], f: [0, 2, 2, 7], g: [2, 9, 8, 2],
};

function segSvg(segs, cell) {
  const rects = [...SEGS]
    .map((s) => {
      const [x, y, w, h] = SEG_RECTS[s];
      return `<rect class="seg${segs.includes(s) ? " on" : ""}" data-seg="${s}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
    })
    .join("");
  return `<svg class="seg7" data-cell="${cell}" viewBox="-3 -2 18 24" aria-hidden="true">${rects}</svg>`;
}

// The segment nearest the pointer, so the whole display is one big target:
// every point of a cell belongs to one of its segments.
function segAt(e) {
  const svg = e.target.closest?.(".seg7");
  if (!svg) return null;
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  let best = null;
  let dist = Infinity;
  for (const [s, [x, y, w, h]] of Object.entries(SEG_RECTS)) {
    const dx = Math.max(x - pt.x, 0, pt.x - (x + w));
    const dy = Math.max(y - pt.y, 0, pt.y - (y + h));
    const d = dx * dx + dy * dy;
    if (d < dist) (dist = d), (best = s);
  }
  return { svg, cell: +svg.dataset.cell, seg: best };
}

function hoverSeg(e) {
  const at = e.type === "mouseleave" ? null : segAt(e);
  for (const r of document.querySelectorAll("#ed-lcd .seg.hover")) r.classList.remove("hover");
  if (at) at.svg.querySelector(`[data-seg="${at.seg}"]`).classList.add("hover");
}

// ---- dithering ----

const previewDither = () => ditherById(state.ditherSel);

// The threshold map, tiled to a square: a cell's grey is its level. For error
// diffusion, the kernel: the block in black, where its error goes in greys;
// for Riemersma, the curve its error follows.
function drawDitherMap(canvas, d) {
  if (d.kind === "diffuse") return drawKernel(canvas, d);
  if (d.kind === "riemersma") return drawCurve(canvas);
  const n = Math.max(d.w, d.h);
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const l = d.levels[(y % d.h) * d.w + (x % d.w)];
      const g = d.n < 2 ? 128 : Math.round((l / (d.n - 1)) * 255);
      img.data.set([g, g, g, 255], (y * n + x) * 4);
    }
  ctx.putImageData(img, 0, 0);
}

function drawKernel(canvas, d) {
  const n = 5; // dx -2..2, dy 0..2, centred
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, n, n);
  const most = Math.max(...d.kernel.map(([, , w]) => w));
  for (const [dx, dy, w] of d.kernel) {
    const g = Math.round(225 - (w / most) * 120);
    ctx.fillStyle = `rgb(${g} ${g} ${g})`;
    ctx.fillRect(2 + dx, 1 + dy, 1, 1);
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(2, 1, 1, 1);
}

// An 8x8 Hilbert curve, two pixels a step.
function drawCurve(canvas) {
  const pts = hilbert(8);
  canvas.width = canvas.height = 17;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 17, 17);
  ctx.fillStyle = "#000";
  pts.forEach(([x, y], i) => {
    ctx.fillRect(2 * x + 1, 2 * y + 1, 1, 1);
    const next = pts[i + 1];
    if (next) ctx.fillRect(x + next[0] + 1, y + next[1] + 1, 1, 1);
  });
}

// The dither's photo tag, as the cam-tag images: white letters, black outline.
function drawDitherTag(canvas, d, scale) {
  const cells = ditherTagCells(m, d);
  canvas.width = cells[0].length;
  canvas.height = cells.length;
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
  const ctx = canvas.getContext("2d");
  cells.forEach((row, y) =>
    row.forEach((v, x) => {
      if (!v) return;
      ctx.fillStyle = v === 1 ? "#000" : "#fff";
      ctx.fillRect(x, y, 1, 1);
    }),
  );
}

const lcdCells = (segs) => `<span class="ed-lcd ed-lcd-ro" title="On the display (ISO digits)">${segs.map((x, i) => segSvg(x, i)).join("")}</span>`;

function renderDithers() {
  const on = dithersOn().length;
  $("#ed-dcount").textContent = `${on} of ${DITHERS.length}`;
  const card = (id, cls, check, body) => `
    <li class="ed-dither ${cls} ${state.ditherSel === id ? "sel" : ""}" data-id="${id}" tabindex="0" aria-current="${state.ditherSel === id}">
      ${check}
      ${body}
    </li>`;
  $("#ed-dlist").innerHTML =
    state.dithers
      .map(({ id, on }) => {
        const d = ditherById(id);
        return card(
          id,
          on ? "" : "off",
          `<input type="checkbox" class="ed-don" ${on ? "checked" : ""} aria-label="Put ${esc(d.name)} on the camera" />`,
          `<span class="ed-dname" title="${esc(d.name)}">${esc(d.name)}</span>
          <span class="ed-dbody">
            <canvas class="ed-dmap" title="${
              d.kind === "diffuse" ? "Where a block's error goes" : d.kind === "riemersma" ? "The curve the error follows" : `The ${d.w}&times;${d.h} threshold map`
            }"></canvas>
            <span class="ed-dside"><canvas class="ed-dtag" role="img" aria-label="${esc(d.code)}" title="The photo tag"></canvas>${lcdCells(d.lcd)}</span>
          </span>`,
        );
      })
      .join("") +
    // rnd only goes on or off (its checkbox, as the others'), nothing to preview
    `<li class="ed-dither rnd ${ditherRndOn() ? "" : "off"}" data-id="rnd">
      <input type="checkbox" class="ed-don" ${ditherRndOn() ? "checked" : ""} ${on < 2 ? "disabled" : ""} aria-label="Also a random dithering per photo" />
      <span class="ed-dname">Random</span>
      <span class="ed-dbody">
        <span class="ed-dmap ed-drnd">also a random one of these per photo</span>
        <span class="ed-dside">${lcdCells(RND_LCD)}</span>
      </span>
    </li>`;
  for (const li of document.querySelectorAll("#ed-dlist li:not(.rnd)")) {
    const d = ditherById(li.dataset.id);
    drawDitherMap(li.querySelector(".ed-dmap"), d);
    drawDitherTag(li.querySelector(".ed-dtag"), d, 2);
  }
}

function selectDither(id) {
  if (state.ditherSel === id) return;
  state.ditherSel = id;
  renderDithers();
  changed({ list: false });
}

function ditherEvents(e) {
  const li = e.target.closest("li");
  if (!li) return;
  const id = li.dataset.id;
  if (e.type === "change" && e.target.matches(".ed-don")) {
    if (id === "rnd") state.ditherRnd = e.target.checked;
    else state.dithers.find((d) => d.id === id).on = e.target.checked;
    renderDithers();
    return changed({ list: false, preview: false });
  }
  if (e.target.closest("input") || id === "rnd") return;
  if (e.type === "click") selectDither(id);
  else if (e.type === "keydown" && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    selectDither(id);
    $(`#ed-dlist li[data-id="${id}"]`).focus();
  }
}

// ---- the slot list ----

async function renderStrips() {
  for (const li of document.querySelectorAll("#ed-list li")) {
    const p = state.slots.find((q) => q.id === li.dataset.id);
    const paint = await paintOf(p);
    const strip = li.querySelector(".ed-strip");
    if (strip) strip.innerHTML = paint.map((c) => `<i style="background:${yuvToHex(c)}"></i>`).join("");
    const tag = li.querySelector(".ed-tagc");
    if (tag) drawTag(tag, p.tag, paint, 3, true);
  }
}

function renderList() {
  const on = enabled().length;
  $("#ed-count").textContent = `${on} of ${m.maxPresets}`;
  $("#ed-list").innerHTML = state.slots
    .map(
      (p) => `
      <li class="${p.id === state.selected ? "sel" : ""} ${p.on ? "" : "off"} ${drag?.id === p.id && drag.moved ? "lifted" : ""}"
          data-id="${p.id}" tabindex="0" aria-current="${p.id === state.selected}">
        <input type="checkbox" class="ed-on" ${p.on ? "checked" : ""} aria-label="Put ${esc(p.tag)} on the camera" />
        <span class="ed-pick">
          ${tagCanvas("ed-tagc", p.tag, 3, true)}
          <span class="ed-name">${esc(p.name)}</span>
          <span class="ed-strip"></span>
        </span>
        <span class="ed-handle" aria-hidden="true" title="Drag to rearrange"><i></i><i></i><i></i></span>
      </li>`,
    )
    .join("");
  const rnd = $("#ed-rnd");
  rnd.checked = state.rnd && on > 1;
  rnd.disabled = on < 2;
  renderStrips();
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  changed({ palette: true });
}

function move(id, to) {
  const from = state.slots.findIndex((p) => p.id === id);
  if (to === from || to < 0 || to >= state.slots.length) return false;
  const [p] = state.slots.splice(from, 1);
  state.slots.splice(to, 0, p);
  return true;
}

// Click a row to select it; drag it (or its handle, on touch screens) to move it.
let drag = null;

function listPointerDown(e) {
  const li = e.target.closest("li");
  if (!li || e.target.closest("input") || e.button > 0) return;
  // on touch screens only the handle drags, so the list still scrolls
  const tap = e.pointerType !== "mouse" && !e.target.closest(".ed-handle");
  drag = { id: li.dataset.id, y: e.clientY, moved: false, tap };
  if (tap) return;
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {} // a pointer the browser doesn't track: the drag just follows the list's own events
  e.preventDefault();
}

function listPointerMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.abs(e.clientY - drag.y) < 5) return;
  if (drag.tap) return (drag = null);
  if (!drag.moved) {
    drag.moved = true;
    $("#ed-list").classList.add("dragging");
    renderList();
  }
  const rows = [...$("#ed-list").children].filter((li) => li.dataset.id !== drag.id);
  const to = rows.filter((li) => {
    const r = li.getBoundingClientRect();
    return r.top + r.height / 2 < e.clientY;
  }).length;
  if (move(drag.id, to)) renderList();
}

function listPointerUp(e) {
  if (!drag) return;
  const { id, moved } = drag;
  drag = null;
  $("#ed-list").classList.remove("dragging");
  if (moved) changed();
  else if (e.type === "pointerup") select(id);
  else renderList();
}

function listChange(e) {
  if (!e.target.matches(".ed-on")) return;
  const p = state.slots.find((q) => q.id === e.target.closest("li").dataset.id);
  p.on = e.target.checked;
  changed();
}

function listKey(e) {
  const li = e.target.closest("li");
  if (!li || e.target.closest("input")) return;
  const i = state.slots.findIndex((p) => p.id === li.dataset.id);
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select(li.dataset.id);
  } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    if (move(li.dataset.id, i + (e.key === "ArrowUp" ? -1 : 1))) {
      changed();
      $(`#ed-list li[data-id="${li.dataset.id}"]`).focus();
    }
  }
}

// ---- the preview and edit area ----

// The tag as the camera draws it on photos: letters in the paint colours'
// lightest, a one-cell outline in their darkest; `field` pads it on the left
// to the camera's 3-letter field, so a column of tags lines up on the right.
function drawTag(canvas, tag, paint, scale, field) {
  const drawable = tag && [...tag].every((ch) => m.font[ch]) && tagWidth(m, tag) <= m.tag.cols;
  const cells = drawable ? tagCells(m, tag, field ? m.tag.cols : undefined) : [];
  canvas.width = cells[0]?.length ?? (field ? m.tag.cols : 1);
  canvas.height = m.tag.rows;
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const [dark, light] = tagColours(paint).map((i) => yuvToHex(paint[i]));
  cells.forEach((row, y) =>
    row.forEach((v, x) => {
      if (!v) return;
      ctx.fillStyle = v === 1 ? dark : light;
      ctx.fillRect(x, y, 1, 1);
    }),
  );
}

// A tag's canvas at its final size: it's drawn once the preset's paint
// colours are known, which can take a moment (a film to download), and an
// unsized canvas is 300x150 until then.
function tagCanvas(cls, tag, scale, field) {
  const drawable = tag && [...tag].every((ch) => m.font[ch]) && tagWidth(m, tag) <= m.tag.cols;
  const w = field ? m.tag.cols : drawable ? tagWidth(m, tag) : 1;
  const h = m.tag.rows;
  return `<canvas class="${cls}" role="img" aria-label="${esc(tag)}" width="${w}" height="${h}"
    style="width:${w * scale}px;height:${h * scale}px"></canvas>`;
}

async function renderTagShown() {
  const p = current();
  const paint = await paintOf(p);
  const canvas = $("#ed-tag-shown");
  if (canvas && current() === p) drawTag(canvas, p.tag, paint, 5, false);
}

async function renderHead() {
  const p = current();
  const f = film(p);
  $("#ed-work-head").innerHTML = `
    ${tagCanvas("ed-tagc", p.tag, 3, false)}
    <span><strong>Preview and edit this palette</strong> &middot; ${esc(p.name)}${p.curve ? " &middot; S-curve" : ""}${f ? ` &middot; ${esc(f.name)}` : ""} &middot; ${esc(previewDither().name)}</span>`;
  const paint = await paintOf(p);
  const canvas = $("#ed-work-head .ed-tagc");
  if (canvas && current() === p) drawTag(canvas, p.tag, paint, 3, false);
}

function tagProblem(p) {
  if (!p.tag) return "Give it a tag.";
  const bad = [...p.tag].find((ch) => !m.font[ch]);
  if (bad) return `No "${bad}" in the camera's tag font.`;
  if (tagWidth(m, p.tag) > m.tag.cols) return "Too wide for the photo tag (its W is extra wide).";
  if (p.on && enabled().some((q) => q !== p && q.tag === p.tag)) return "Another palette already has this tag.";
  return "";
}

function renderPalette() {
  const p = current();
  $("#ed-palette").innerHTML = `
    <div class="ed-row">
      <label for="ed-from">Preset</label>
      <select id="ed-from">
        <option value="">Start from&hellip;</option>
        ${library.palettes.map((l, i) => `<option value="${i}">${esc(l.name)}</option>`).join("")}
      </select>
    </div>
    <div class="ed-row">
      <span class="label">Curve</span>
      <label class="ed-check"><input type="checkbox" id="ed-curve" ${p.curve ? "checked" : ""} /> S-curve: more contrast (as BW)</label>
    </div>
    <div class="ed-row">
      <label for="ed-film">Film</label>
      <select id="ed-film">
        <option value="">None</option>
        ${library.films.map((f) => `<option value="${f.id}" ${f.id === p.film ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
      </select>
    </div>
    <div class="ed-row ed-tagrow">
      <label for="ed-tag">Tag</label>
      <input id="ed-tag" value="${esc(p.tag)}" maxlength="3" autocomplete="off" spellcheck="false" />
      ${tagCanvas("ed-tag-shown", p.tag, 5, false).replace("<canvas", '<canvas id="ed-tag-shown" title="The tag as the camera draws it"')}
      <span class="ed-problem" id="ed-tag-problem">${esc(tagProblem(p))}</span>
    </div>
    <div class="ed-row">
      <span class="label">Display</span>
      <span class="ed-lcd" id="ed-lcd">${p.lcd.map((s, i) => segSvg(s, i)).join("")}</span>
      <label class="ed-check"><input type="checkbox" id="ed-lcd-auto" ${p.lcdAuto ? "checked" : ""} /> follow the tag</label>
    </div>
    <div class="ed-row ed-colours-head">
      <span class="label">Colours</span>
      <span class="ed-ncol" id="ed-ncol"></span>
    </div>
    <div class="ed-swatches" id="ed-swatches"></div>
    <div class="ed-colour" id="ed-colour">
      <div class="ed-colour-head">
        <span id="ed-colour-name"></span>
        <span>
          <button type="button" id="ed-dupcol">Duplicate</button>
          <button type="button" id="ed-delcol">Remove</button>
        </span>
      </div>
      <div class="ed-sv" id="ed-sv"><canvas width="256" height="128"></canvas><i class="ed-node"></i></div>
      <div class="ed-hue" id="ed-hue"><i class="ed-node"></i></div>
      <div class="ed-hexrow"><label for="ed-hex">Hex</label><input id="ed-hex" maxlength="7" spellcheck="false" autocomplete="off" /></div>
    </div>`;
  renderSwatches();
  pickerFromColour();
  renderTagShown();
}

function renderSwatches() {
  const p = current();
  $("#ed-ncol").textContent = `${p.colours.length} of ${m.maxColours}`;
  $("#ed-swatches").innerHTML = p.colours
    .map(
      (c, i) => `<button type="button" class="sw${i === p.sel ? " sel" : ""}" data-i="${i}"
        style="--c:${yuvToHex(c)}" aria-label="Colour ${i + 1}" aria-pressed="${i === p.sel}"></button>`,
    )
    .join("");
  $("#ed-dupcol").disabled = p.colours.length >= m.maxColours;
  $("#ed-dupcol").title = p.colours.length >= m.maxColours ? `${m.maxColours} colours is the most` : "";
  $("#ed-delcol").disabled = p.colours.length < 2;
  $("#ed-colour-name").textContent = `Colour ${p.sel + 1}`;
}

// The colour picker: saturation x value field and a hue strip, for the
// selected colour. hsv is kept while dragging, so greys don't lose their hue.
let hsv = [0, 0, 0];

function rgbToHsv([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? hsv[0] : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [d === 0 ? hsv[0] : h * 60, max === 0 ? 0 : d / max, max];
}

function hsvToRgb([h, s, v]) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function drawSv() {
  const c = $("#ed-sv canvas");
  const ctx = c.getContext("2d");
  ctx.fillStyle = `hsl(${hsv[0]} 100% 50%)`;
  ctx.fillRect(0, 0, c.width, c.height);
  const white = ctx.createLinearGradient(0, 0, c.width, 0);
  white.addColorStop(0, "#fff");
  white.addColorStop(1, "rgb(255 255 255 / 0)");
  ctx.fillStyle = white;
  ctx.fillRect(0, 0, c.width, c.height);
  const black = ctx.createLinearGradient(0, 0, 0, c.height);
  black.addColorStop(0, "rgb(0 0 0 / 0)");
  black.addColorStop(1, "#000");
  ctx.fillStyle = black;
  ctx.fillRect(0, 0, c.width, c.height);
}

function placeNodes(hex) {
  const sv = $("#ed-sv .ed-node");
  sv.style.left = `${hsv[1] * 100}%`;
  sv.style.top = `${(1 - hsv[2]) * 100}%`;
  sv.style.background = hex;
  const hue = $("#ed-hue .ed-node");
  hue.style.left = `${(hsv[0] / 360) * 100}%`;
  hue.style.background = `hsl(${hsv[0]} 100% 50%)`;
}

function pickerFromColour() {
  const p = current();
  const hex = yuvToHex(p.colours[p.sel]);
  hsv = rgbToHsv(yuvToRgb(p.colours[p.sel]));
  drawSv();
  placeNodes(hex);
  $("#ed-hex").value = hex.toUpperCase();
}

function setColour(yuv) {
  const p = current();
  p.colours[p.sel] = yuv;
  const sw = $(`#ed-swatches .sw[data-i="${p.sel}"]`);
  if (sw) sw.style.setProperty("--c", yuvToHex(yuv));
  renderTagShown();
  changed({ list: false, preview: true });
  renderStrips();
}

function pickerFromHsv() {
  const rgb = hsvToRgb(hsv);
  const hex = "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
  drawSv();
  placeNodes(hex);
  $("#ed-hex").value = hex.toUpperCase();
  setColour(hexToYuv(hex));
}

let picking = null;

function pickerPointer(e) {
  if (e.type === "pointerdown") {
    const area = e.target.closest("#ed-sv, #ed-hue");
    if (!area || e.button > 0) return;
    picking = area.id;
    area.setPointerCapture(e.pointerId);
    e.preventDefault();
  } else if (e.type === "pointerup" || e.type === "pointercancel") {
    picking = null;
    return;
  }
  if (!picking) return;
  const r = $(`#${picking}`).getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  if (picking === "ed-sv") hsv = [hsv[0], x, 1 - y];
  else hsv = [Math.min(x * 360, 359.9), hsv[1], hsv[2]];
  pickerFromHsv();
}

function paletteInput(e) {
  const p = current();
  if (e.target.id === "ed-tag") {
    const caret = e.target.selectionStart;
    p.tag = e.target.value.toUpperCase().slice(0, 3);
    e.target.value = p.tag;
    e.target.setSelectionRange(caret, caret);
    if (p.lcdAuto) {
      p.lcd = autoLcd(p.tag);
      $("#ed-lcd").innerHTML = p.lcd.map((s, i) => segSvg(s, i)).join("");
    }
    $("#ed-tag-problem").textContent = tagProblem(p);
    renderTagShown();
    return changed();
  }
  if (e.target.id === "ed-hex") {
    const v = e.target.value.trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      hsv = rgbToHsv([1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)));
      drawSv();
      placeNodes(v);
      setColour(hexToYuv(v));
    }
  }
}

function paletteChange(e) {
  const p = current();
  if (e.target.id === "ed-from" && e.target.value !== "") {
    const item = library.palettes[+e.target.value];
    const fresh = slotFrom(item, p.on);
    Object.assign(p, { name: item.name, colours: fresh.colours, curve: fresh.curve, film: item.film, sel: 0 });
    if (!enabled().some((q) => q !== p && q.tag === item.tag)) Object.assign(p, { tag: item.tag, lcd: fresh.lcd, lcdAuto: fresh.lcdAuto });
    return changed({ palette: true });
  }
  if (e.target.id === "ed-film" || e.target.id === "ed-curve") {
    if (e.target.id === "ed-film") p.film = e.target.value || null;
    else p.curve = e.target.checked;
    renderTagShown();
    renderStrips();
    return changed({ list: false });
  }
  if (e.target.id === "ed-lcd-auto") {
    p.lcdAuto = e.target.checked;
    if (p.lcdAuto) p.lcd = autoLcd(p.tag);
    return changed({ palette: true, preview: false });
  }
  if (e.target.id === "ed-hex") pickerFromColour();
}

function paletteClick(e) {
  const p = current();
  const at = e.target.closest("#ed-lcd") && segAt(e);
  if (at) {
    const cur = p.lcd[at.cell];
    p.lcd[at.cell] = [...SEGS].filter((x) => (x === at.seg ? !cur.includes(x) : cur.includes(x))).join("");
    p.lcdAuto = false;
    $("#ed-lcd").innerHTML = p.lcd.map((s, i) => segSvg(s, i)).join("");
    $("#ed-lcd-auto").checked = false;
    hoverSeg(e);
    return changed({ list: false, preview: false });
  }
  const sw = e.target.closest(".sw[data-i]");
  if (sw) {
    p.sel = +sw.dataset.i;
    renderSwatches();
    pickerFromColour();
    return save();
  }
  if (e.target.closest("#ed-dupcol") || e.target.closest("#ed-delcol")) {
    if (e.target.closest("#ed-dupcol")) {
      p.colours.splice(p.sel + 1, 0, [...p.colours[p.sel]]);
      p.sel++;
    } else {
      p.colours.splice(p.sel, 1);
      p.sel = Math.min(p.sel, p.colours.length - 1);
    }
    renderSwatches();
    pickerFromColour();
    renderStrips();
    return changed({ list: false });
  }
}

// ---- preview ----

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    renderPreview();
  });
}

async function renderPreview() {
  const p = current();
  const paint = await paintOf(p);
  if (current() !== p) return;
  const drawable = [...p.tag].every((ch) => m.font[ch]) && tagWidth(m, p.tag) <= m.tag.cols;
  const preset = { tag: drawable ? p.tag : "", ditherTag: true, match: p.colours, paint };
  const lut = buildLut(preset.match, m.wy);
  document.querySelectorAll("#ed-photos .ed-photo canvas").forEach((canvas, i) => {
    const frame = frames[i];
    if (!frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas._out = render(m, frame, preset, lut, previewDither());
    if (!canvas.matches(":hover")) canvas.getContext("2d").putImageData(canvas._out, 0, 0);
  });
  renderBig();
}

// The detail view: the large photo is the strip's selected one, as rendered.
function renderBig() {
  $("#ed-shots").classList.toggle("detail", state.view === "detail");
  for (const b of document.querySelectorAll(".ed-view button")) b.setAttribute("aria-pressed", b.dataset.view === state.view);
  const thumbs = [...document.querySelectorAll("#ed-photos .ed-photo")];
  thumbs.forEach((f, i) => f.classList.toggle("big", state.view === "detail" && i === state.big));
  const big = $("#ed-big canvas");
  const src = thumbs[state.big]?.querySelector("canvas");
  if (state.view !== "detail" || !big || !src?._out) return;
  big.width = src._out.width;
  big.height = src._out.height;
  big._out = src._out;
  if (!big.matches(":hover")) big.getContext("2d").putImageData(big._out, 0, 0);
}

function loadPhoto(i) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      frames[i] = cameraFrame(m, img);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = state.photos[i] ?? PHOTOS[i];
  });
}

function renderPhotos() {
  const figure = (i, cls = "") => `
    <figure class="ed-photo ${cls}" data-i="${i}">
      <canvas width="608" height="456"></canvas>
      <figcaption>
        <label class="ed-upload">Your photo&hellip;<input type="file" accept="image/*" /></label>
        ${state.photos[i] ? `<button type="button" class="ed-reset">Reset</button>` : ""}
      </figcaption>
    </figure>`;
  $("#ed-big").innerHTML = figure(state.big, "ed-large");
  $("#ed-photos").innerHTML = PHOTOS.map((_, i) => figure(i)).join("");
}

function shrinkImage(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function photoEvents(e) {
  const fig = e.target.closest(".ed-photo");
  if (!fig) return;
  const i = +fig.dataset.i;
  if (e.type === "change" && e.target.files?.[0]) {
    state.photos[i] = await shrinkImage(e.target.files[0]);
  } else if (e.type === "drop") {
    e.preventDefault();
    fig.classList.remove("drop");
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    state.photos[i] = await shrinkImage(file);
  } else if (e.type === "click" && e.target.closest(".ed-reset")) {
    state.photos[i] = null;
  } else if (e.type === "click" && e.target.matches("canvas")) {
    // in the detail view the strip picks the large photo
    if (state.view === "detail" && !fig.matches(".ed-large")) {
      if (state.big === i) return;
      state.big = i;
      renderPhotos();
      renderPreview();
      return save();
    }
    return showLarge(e.target);
  } else return;
  await loadPhoto(i);
  renderPhotos();
  renderPreview();
  save();
}

// The page's photo viewer (main.js), with the photos as the preset renders
// them; the arrow keys step through all of them.
function showLarge(canvas) {
  if (!window.viewer) return;
  const canvases = [...document.querySelectorAll("#ed-photos .ed-photo canvas")].filter((c) => c._out);
  if (canvas.closest(".ed-large")) canvas = canvases.find((c) => c.closest(".ed-photo").dataset.i === String(state.big));
  const photos = canvases.map((cv) => () => {
    const c = document.createElement("canvas");
    c.width = cv._out.width;
    c.height = cv._out.height;
    c.getContext("2d").putImageData(cv._out, 0, 0);
    return { src: c.toDataURL(), ar: c.width / c.height };
  });
  window.viewer.open(photos, Math.max(0, canvases.indexOf(canvas)));
}

function hoverPhoto(e) {
  const canvas = e.target.closest?.(".ed-photo canvas");
  if (!canvas) return;
  const i = +canvas.closest(".ed-photo").dataset.i;
  const show = e.type === "mouseover" ? frames[i] : canvas._out;
  if (show) canvas.getContext("2d").putImageData(show, 0, 0);
}

// ---- sounds ----

async function soundBytes(slot) {
  const s = state.sounds[slot];
  if (s.src === "own" && s.wav) return Uint8Array.from(atob(s.wav), (ch) => ch.charCodeAt(0));
  const src = s.src === "own" ? "stock" : s.src;
  const key = `${src}/${slot}`;
  soundCache[key] ??= new Uint8Array(await (await fetch(`editor/sounds/${src}_${slot}.wav`)).arrayBuffer());
  return soundCache[key];
}

// The factory's mode-switch click, slot and all: the template has it silenced.
async function stockClick() {
  soundCache.click ??= new Uint8Array(await (await fetch("editor/sounds/stock_click.wav")).arrayBuffer());
  return soundCache.click;
}

// Any audio file -> 11025 Hz mono 16-bit, leading silence trimmed, cut to the
// slot with a short fade, peak-normalised.
async function convertSound(file, slot) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const rate = m.wav.rate;
  const len = Math.ceil(Math.min(decoded.duration, 20) * rate);
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const data = (await off.startRendering()).getChannelData(0);
  const peak = data.reduce((a, x) => Math.max(a, Math.abs(x)), 0) || 1;
  let start = data.findIndex((x) => Math.abs(x) > peak * 0.05);
  start = Math.max(0, start - Math.round(rate * 0.005));
  const n = Math.min(slotSamples(m, slot), data.length - start);
  const fade = Math.min(n, Math.round(rate * 0.02));
  const gain = 0.9 / peak;
  const samples = Int16Array.from({ length: n }, (_, i) => {
    const f = i >= n - fade && n < data.length - start ? (n - i) / fade : 1;
    return Math.max(-32768, Math.min(32767, Math.round(data[start + i] * gain * f * 32767)));
  });
  return { wav: encodeWav(m, samples), cut: data.length - start > n };
}

function renderSounds() {
  const s = state.sounds;
  $("#ed-sound-on").checked = s.on;
  $("#ed-sounds").classList.toggle("off", !s.on);
  $("#ed-sound-slots").innerHTML = Object.entries(SOUND_LABELS)
    .map(([slot, label]) => {
      const cur = s[slot];
      const max = (slotSamples(m, slot) / m.wav.rate).toFixed(2);
      return `
      <div class="ed-sound" data-slot="${slot}">
        <span class="label">${label}</span>
        <select class="ed-sound-src" ${s.on ? "" : "disabled"}>
          ${Object.entries(SOUND_PRESETS).map(([k, v]) => `<option value="${k}" ${cur.src === k ? "selected" : ""}>${v}</option>`).join("")}
          <option value="own" ${cur.src === "own" ? "selected" : ""}>${cur.name ? esc(cur.name) : "Your own"}&hellip;</option>
        </select>
        <label class="ed-upload ${s.on ? "" : "dim"}">Upload&hellip;<input type="file" accept="audio/*" ${s.on ? "" : "disabled"} /></label>
        <button type="button" class="ed-play" ${s.on ? "" : "disabled"}>&#9654; Play</button>
        <span class="note">${cur.note ? esc(cur.note) + " " : ""}up to ${max} s</span>
      </div>`;
    })
    .join("");
}

async function soundEvents(e) {
  if (e.target.id === "ed-sound-on") {
    state.sounds.on = e.target.checked;
    renderSounds();
    return changed({ list: false, preview: false });
  }
  const row = e.target.closest(".ed-sound");
  if (!row) return;
  const slot = row.dataset.slot;
  const s = state.sounds[slot];
  if (e.type === "change" && e.target.matches(".ed-sound-src")) {
    if (e.target.value === "own" && !s.wav) {
      row.querySelector("input[type=file]").click();
      e.target.value = s.src;
      return;
    }
    s.src = e.target.value;
  } else if (e.type === "change" && e.target.files?.[0]) {
    const file = e.target.files[0];
    try {
      const { wav, cut } = await convertSound(file, slot);
      Object.assign(s, {
        src: "own",
        name: file.name.slice(0, 40),
        wav: btoa(String.fromCharCode(...wav)),
        note: cut ? "Cut to fit:" : "",
      });
    } catch {
      alert(`Couldn't read ${file.name} as audio.`);
    }
  } else if (e.type === "click" && e.target.closest(".ed-play")) {
    const audio = new Audio(URL.createObjectURL(new Blob([await soundBytes(slot)], { type: "audio/wav" })));
    audio.play();
    return;
  } else return;
  renderSounds();
  changed({ list: false, preview: false });
}

// ---- download ----

function renderDownload() {
  const on = enabled();
  const errors = configErrors(m, {
    presets: on.map((p) => ({ tag: p.tag, match: p.colours, paint: p.colours, lcd: p.lcd })),
    rnd: state.rnd,
    sounds: state.sounds.on,
  });
  if (!dithersOn().length) errors.unshift("Turn on at least one dithering.");
  const rnd = state.rnd && on.length > 1;
  $("#ed-summary").textContent =
    `${dithersOn().length} dithering${dithersOn().length === 1 ? "" : "s"} (${dithersOn().map((d) => d.code).join(", ")})` +
    `${ditherRndOn() ? " + rnd" : ""} · ` +
    `${on.length} palette${on.length === 1 ? "" : "s"} (${on.map((p) => p.tag || "?").join(", ")})` +
    `${rnd ? " + rnd" : ""} · ${state.sounds.on ? "sounds on" : "silent"}`;
  $("#ed-errors").innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join("");
  $("#ed-download").disabled = errors.length > 0;
}

let template;
async function getTemplate() {
  if (template) return template;
  const bytes = new Uint8Array(await (await fetch(`editor/${m.file}`)).arrayBuffer());
  if ((await sha256(bytes)) !== m.sha256) throw new Error("the template firmware isn't the expected one");
  return (template = bytes);
}

async function download() {
  const button = $("#ed-download");
  button.disabled = true;
  button.textContent = "Building…";
  try {
    const fw = buildFirmware(await getTemplate(), m, await config(), {
      shutter: await soundBytes("shutter"),
      poweron: await soundBytes("poweron"),
      click: await stockClick(),
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([fw], { type: "application/octet-stream" }));
    a.download = "GP_CARDVR_UPGRADE.BIN";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    alert(`Couldn't build the firmware: ${err.message}`);
  } finally {
    button.textContent = "Download GP_CARDVR_UPGRADE.BIN";
    renderDownload();
  }
}

// ---- start ----

async function main() {
  [m, library] = await Promise.all(
    ["editor/template.json", "editor/library.json"].map((u) => fetch(u).then((r) => r.json())),
  );
  state = load();
  $("#ed-max").textContent = m.maxPresets;
  const list = $("#ed-list");
  list.addEventListener("pointerdown", listPointerDown);
  list.addEventListener("pointermove", listPointerMove);
  list.addEventListener("pointerup", listPointerUp);
  list.addEventListener("pointercancel", listPointerUp);
  list.addEventListener("change", listChange);
  list.addEventListener("keydown", listKey);
  $("#ed-rnd").addEventListener("change", (e) => {
    state.rnd = e.target.checked;
    changed({ preview: false });
  });
  const panel = $("#ed-palette");
  panel.addEventListener("input", paletteInput);
  panel.addEventListener("change", paletteChange);
  panel.addEventListener("click", paletteClick);
  panel.addEventListener("mousemove", (e) => e.target.closest("#ed-lcd") && hoverSeg(e));
  panel.addEventListener("mouseout", (e) => e.target.closest("#ed-lcd") && !e.relatedTarget?.closest?.("#ed-lcd") && hoverSeg({ type: "mouseleave" }));
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) panel.addEventListener(type, pickerPointer);
  const dlist = $("#ed-dlist");
  dlist.addEventListener("change", ditherEvents);
  dlist.addEventListener("click", ditherEvents);
  dlist.addEventListener("keydown", ditherEvents);
  $(".ed-view").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b || b.dataset.view === state.view) return;
    state.view = b.dataset.view;
    renderBig();
    save();
  });
  const photos = $("#ed-shots");
  photos.addEventListener("change", photoEvents);
  photos.addEventListener("click", photoEvents);
  photos.addEventListener("drop", photoEvents);
  photos.addEventListener("dragover", (e) => {
    const fig = e.target.closest(".ed-photo");
    if (!fig || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    for (const f of photos.querySelectorAll(".ed-photo")) f.classList.toggle("drop", f === fig);
  });
  photos.addEventListener("dragleave", (e) => {
    const fig = e.target.closest(".ed-photo");
    if (fig && !fig.contains(e.relatedTarget)) fig.classList.remove("drop");
  });
  photos.addEventListener("mouseover", hoverPhoto);
  photos.addEventListener("mouseout", hoverPhoto);
  const sounds = $("#ed-sounds");
  sounds.addEventListener("change", soundEvents);
  sounds.addEventListener("click", soundEvents);
  $("#ed-download").addEventListener("click", download);
  $("#ed-reset-all").addEventListener("click", async () => {
    if (!confirm("Start over? This forgets your ditherings, palettes, sounds and photos.")) return;
    state = defaultState();
    renderDithers();
    renderPhotos();
    renderSounds();
    changed({ palette: true, preview: false });
    await Promise.all(PHOTOS.map((_, i) => loadPhoto(i)));
    renderPreview();
  });

  renderDithers();
  renderList();
  renderHead();
  renderPalette();
  renderSounds();
  renderDownload();
  renderPhotos();
  await Promise.all(PHOTOS.map((_, i) => loadPhoto(i)));
  await renderPreview();
  $("#editor").classList.add("ready");
}

main();
