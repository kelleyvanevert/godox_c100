// The firmware editor: 8 preset slots (palette, S-curve, film, contrast, brightness, tag,
// display code), each on or off, rnd and the normal mode, tags on or off, photo sizes
// and sounds; previewed on nine photos, kept in localStorage,
// and built into a firmware in the browser (firmware.js) from the template.
import { buildFirmware, configErrors, cropFor, encodeWav, hexToYuv, lumaMap, sha256, sizeErrors, slotSamples, tagCells, tagColours, tagWidth, yuvToHex, yuvToRgb } from "./firmware.js";
import { paintColours } from "./films.js";
import { buildLut, cameraFrame, render } from "./sim.js";

const STORE = "c100-editor-v3";
// a 3 x 3 grid: streets, natural, close-ups
const PHOTOS = [
  "street_sign", "street_duck", "snail", "hydrangeas", "mimosa", "turtle", "cup", "IMG_0577", "dessert",
].map((f) => `editor/photos/${f}.jpg`);
const noPhotos = () => PHOTOS.map(() => null);
const DEFAULT_SLOTS = [
  "EP6", "6FP", "BW", "GBC (4)",
  "db16 (16)", "sweetie16 (16)", "riso6 (6)", "nes (32)",
];
const DEFAULT_ON = 4; // EP6, 6FP, BW and GBC
// GBC's colours before it became the Game Boy Camera look (with white; then the 4 greens)
const OLD_GBC = [
  ["#071820", "#336856", "#89c06f", "#dff8d0", "#ffffff"],
  ["#071820", "#336856", "#89c06f", "#dff8d0"],
].map((hexes) => hexes.map((h) => yuvToHex(hexToYuv(h))).join());
const SOUND_PRESETS = { stock: "Stock", mario: "Super Mario" };
const SOUND_LABELS = { shutter: "Shutter", poweron: "Power-on" };
const SEGS = "abcdefg";

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
// PostHog (loaded in index.html), if it's there
const track = (event, props) => window.posthog?.capture(`editor_${event}`, props);

let m; // template.json
let library; // library.json: { palettes, films }
let state;
const frames = noPhotos(); // camera-size ImageData per photo
const images = noPhotos(); // the loaded photos themselves
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
    contrast: item.contrast ?? 0,
    brightness: item.brightness ?? 0,
    ...gbBits(item),
    sel: 0,
  };
}

// The Game Boy Camera's parts, each on its own (preview only so far): the
// colours as a ramp picked by brightness alone (shades), its tone (with a ramp
// only), 4x4 pixels, sharpening.
// A library preset may set them; otherwise they're off.
function gbBits(item) {
  return { shades: !!item.shades, gbTone: !!item.gbTone, pixel: item.pixel ?? 2, sharpen: item.sharpen ?? 0 };
}
const usesGbBits = (p) => p.shades || p.pixel !== 2 || p.sharpen > 0;

const defaultSizes = () => structuredClone(m.sizes);

function defaultState() {
  const slots = DEFAULT_SLOTS.map((name, i) =>
    slotFrom(library.palettes.find((l) => l.name === name) ?? library.palettes[i], i < DEFAULT_ON),
  );
  return {
    slots,
    selected: slots[0].id,
    rnd: true,
    normal: true,
    tags: true,
    sizes: defaultSizes(),
    sounds: { on: false, shutter: { src: "stock" }, poweron: { src: "stock" } },
    photos: noPhotos(),
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
        p.contrast ??= 0;
        p.brightness ??= 0;
        if (p.pixel === undefined) Object.assign(p, gbBits({}));
        // GBC became the Game Boy Camera look (the fork's 4 shades, its settings): an unedited old GBC follows
        const gbc = library.palettes.find((l) => l.tag === "GBC");
        if (gbc && OLD_GBC.includes(p.colours.map(yuvToHex).join()))
          Object.assign(p, { name: gbc.name, colours: gbc.colours.map((c) => [...c]), ...gbBits(gbc), sel: 0 });
      }
      // the preview photos changed: own photos don't carry over
      if (saved.photos?.length !== PHOTOS.length) saved.photos = noPhotos();
      saved.tags ??= true;
      saved.normal ??= true;
      if (Object.keys(saved.sizes ?? {}).join() !== Object.keys(m.sizes).join()) saved.sizes = defaultSizes();
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
const film = (p) => library.films.find((f) => f.id === p.film) ?? null;
// rnd picks among the palettes that are on, so it needs two
const rndOffered = () => enabled().length > 1;

async function paintOf(p) {
  const key = `${p.film}|${p.curve}|${p.colours.join(" ")}`;
  if (!paints.has(key)) paints.set(key, await paintColours(film(p), p.curve ? library.curve : null, p.colours));
  return paints.get(key);
}

async function config() {
  const on = enabled();
  return {
    presets: await Promise.all(on.map(async (p) => presetOf(p, await paintOf(p)))),
    rnd: state.rnd && rndOffered(),
    normal: state.normal,
    sounds: state.sounds.on,
    tags: state.tags,
    sizes: state.sizes,
  };
}

// A slot as the firmware takes it (firmware.js), given its paint colours.
function presetOf(p, paint) {
  return { tag: p.tag, match: p.colours, paint, contrast: p.contrast, brightness: p.brightness, lcd: p.lcd };
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

// ---- photo options: tags and sizes ----

// An aspect setting's size if it can go on the camera, else the template's
// (so the previews always have one).
function sizeOf(aspect) {
  const [w, h] = state.sizes[aspect];
  return sizeErrors(m, w, h).length ? m.sizes[aspect] : [w, h];
}
const sameSize = (a, b) => a.join("x") === b.join("x");

// The camera's see-through display (about 1.35:1) with the corner brackets it
// lights for an aspect setting. Measured from Godox's product photos: the
// brackets are always 64% of the display's height, from 19% below its top,
// centred, and only their width follows the aspect.
function bracketSvg(aspect) {
  const [cw, ch] = m.stockCrops[aspect];
  const [W, H] = [50, 37];
  const bh = 0.64 * H;
  const bw = (bh * cw) / ch;
  const [x0, y0, x1, y1, l] = [(W - bw) / 2, 0.19 * H, (W + bw) / 2, 0.19 * H + bh, 3.5];
  const d = `M${x0} ${y0 + l}V${y0}H${x0 + l}M${x1 - l} ${y0}H${x1}V${y0 + l}M${x1} ${y1 - l}V${y1}H${x1 - l}M${x0 + l} ${y1}H${x0}V${y1 - l}`;
  return `<svg class="ed-bracket" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="5" /><path d="${d}" /></svg>`;
}

function renderOptions() {
  const L = m.sizeLimits;
  $("#ed-tags").checked = state.tags;
  $("#ed-sizes").innerHTML = Object.keys(m.sizes)
    .map(
      (aspect) => `
      <div class="ed-size" data-aspect="${aspect}">
        <div class="ed-size-head">
          ${bracketSvg(aspect)}
          <span class="label">${aspect}</span>
          <button type="button" class="ed-size-reset" title="Back to ${m.sizes[aspect].join("x")}">reset</button>
        </div>
        <div class="ed-size-in">
          <input type="number" data-i="0" value="${state.sizes[aspect][0]}" min="${L.minW}" max="${L.maxW}" step="16"
            aria-label="Width of ${aspect} photos and videos" />
          <span>x</span>
          <input type="number" data-i="1" value="${state.sizes[aspect][1]}" min="${L.minH}" max="${L.maxH}" step="4"
            aria-label="Height of ${aspect} photos and videos" />
        </div>
        <div class="ed-size-box"><canvas class="ed-size-eg"></canvas></div>
        <span class="note ed-size-note"></span>
      </div>`,
    )
    .join("");
  for (const aspect of Object.keys(m.sizes)) renderSize(aspect);
}

// One size's example (the first preview photo at that size, drawn to scale
// with the others: the box's width is the widest size allowed) and its note.
function renderSize(aspect) {
  const el = $(`.ed-size[data-aspect="${aspect}"]`);
  const [w, h] = state.sizes[aspect];
  const need = sizeErrors(m, w, h);
  const [ow, oh] = sizeOf(aspect);
  const canvas = el.querySelector("canvas");
  [canvas.width, canvas.height] = [ow, oh];
  canvas.style.width = `${(100 * ow) / m.sizeLimits.maxW}%`;
  canvas.classList.toggle("stale", need.length > 0);
  const img = images[0];
  if (img) {
    const [iw, ih] = [img.naturalWidth, img.naturalHeight];
    const [sw, sh] = iw * oh > ih * ow ? [(ih * ow) / oh, ih] : [iw, (iw * oh) / ow];
    canvas.getContext("2d").drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, ow, oh);
  }
  const [cw, ch] = cropFor(m, aspect, ow, oh);
  el.querySelector(".ed-size-reset").hidden = sameSize([w, h], m.sizes[aspect]);
  el.querySelector(".ed-size-note").textContent = need.length
    ? `Needs ${need.join(", ")}.`
    : `${Math.round((w * h) / 1000)}k pixels · crop ${cw}x${ch}`;
  el.classList.toggle("bad", need.length > 0);
  fitSizeBoxes();
}

// The example boxes as tall as the tallest example, so there's no empty band
// above them all; the scale stays the same (the box width is the widest size).
function fitSizeBoxes() {
  const tallest = Math.max(...Object.keys(m.sizes).map((k) => sizeOf(k)[1]));
  for (const box of document.querySelectorAll(".ed-size-box")) box.style.aspectRatio = `${m.sizeLimits.maxW} / ${tallest}`;
}

function sizeEvents(e) {
  const el = e.target.closest(".ed-size");
  if (!el) return;
  const aspect = el.dataset.aspect;
  const inputs = el.querySelectorAll(".ed-size-in input");
  if (e.type === "click" && e.target.matches(".ed-size-reset")) {
    state.sizes[aspect] = [...m.sizes[aspect]];
    inputs.forEach((input, i) => (input.value = state.sizes[aspect][i]));
    track("reset_size", { aspect });
  } else if (e.target.matches(".ed-size-in input")) {
    if (e.type === "change") {
      const [w, h] = state.sizes[aspect];
      return track("change_size", { aspect, size: `${w}x${h}`, ok: !sizeErrors(m, w, h).length });
    }
    // an empty or half-typed field reads as NaN: "needs whole numbers"
    state.sizes[aspect][e.target.dataset.i] = e.target.value === "" ? NaN : +e.target.value;
  } else return;
  renderSize(aspect);
  changed({ list: false, preview: false });
}

function renderList() {
  const on = enabled().length;
  $("#ed-count").textContent = `${on} of ${m.maxPresets}`;
  $("#ed-list").innerHTML = state.slots
    .map(
      (p) => `
      <li class="${p.id === state.selected ? "sel" : ""} ${p.on ? "" : "off"} ${drag?.id === p.id && drag.moved ? "lifted" : ""}"
          data-id="${p.id}" tabindex="0" aria-current="${p.id === state.selected}">
        <input type="checkbox" class="ed-on" ${p.on ? "checked" : ""} aria-label="Put ${esc(state.tags ? p.tag : p.name)} on the camera" />
        <span class="ed-pick">
          ${state.tags ? tagCanvas("ed-tagc", p.tag, 3, true) : ""}
          <span class="ed-name">${esc(p.name)}</span>
          <span class="ed-strip"></span>
        </span>
        <span class="ed-handle" aria-hidden="true" title="Drag to rearrange"><i></i><i></i><i></i></span>
      </li>`,
    )
    .join("");
  const rnd = $("#ed-rnd");
  rnd.checked = state.rnd && rndOffered();
  rnd.disabled = !rndOffered();
  $("#ed-normal").checked = state.normal;
  renderStrips();
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  changed({ palette: true });
  track("select_palette", { tag: current().tag, name: current().name });
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
  if (moved) {
    changed();
    track("reorder_palette", { via: "drag" });
  } else if (e.type === "pointerup") select(id);
  else renderList();
}

function listChange(e) {
  if (!e.target.matches(".ed-on")) return;
  const p = state.slots.find((q) => q.id === e.target.closest("li").dataset.id);
  p.on = e.target.checked;
  changed();
  track("toggle_palette", { tag: p.tag, on: p.on, palettes: enabled().length });
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
      track("reorder_palette", { via: "keyboard" });
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
    ${state.tags ? tagCanvas("ed-tagc", p.tag, 3, false) : ""}
    <span><strong>Preview and edit this look</strong> &middot; ${esc(p.name)}${lookNote(p, f)}</span>`;
  const paint = await paintOf(p);
  const canvas = $("#ed-work-head .ed-tagc");
  if (canvas && current() === p) drawTag(canvas, p.tag, paint, 3, false);
}

const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

function lookNote(p, f) {
  return (
    (p.curve ? " &middot; S-curve" : "") + (f ? ` &middot; ${esc(f.name)}` : "") +
    (p.contrast ? ` &middot; contrast ${signed(p.contrast)}%` : "") +
    (p.brightness ? ` &middot; brightness ${signed(p.brightness)}` : "") +
    (p.shades ? " &middot; ramp" : "") + (p.shades && p.gbTone ? " &middot; Game Boy tone" : "") +
    (p.pixel !== 2 ? ` &middot; ${p.pixel}&times;${p.pixel} pixels` : "") +
    (p.sharpen ? ` &middot; sharpen ${p.sharpen}%` : "")
  );
}

function tagProblem(p) {
  if (!state.tags) return "";
  if (!p.tag) return "Give it a tag.";
  const bad = [...p.tag].find((ch) => !m.font[ch]);
  if (bad) return `No "${bad}" in the camera's tag font.`;
  if (tagWidth(m, p.tag) > m.tag.cols) return "Too wide for the photo tag (its W is extra wide).";
  if (p.on && enabled().some((q) => q !== p && q.tag === p.tag)) return "Another look already has this tag.";
  return "";
}

// Contrast and brightness: a slider each, applied to the luma before matching.
const FX_LABELS = { contrast: "Contrast", brightness: "Brightness", sharpen: "Sharpen" };
const fxText = (k, v) => (k === "sharpen" ? `${v}%` : signed(v) + (k === "contrast" ? "%" : ""));
const fxRange = (k) => (k === "sharpen" ? [0, 100] : m.fx[k]);

function fxRow(p, k) {
  const [lo, hi] = fxRange(k);
  return `
    <div class="ed-row ed-fx" data-k="${k}">
      <label for="ed-${k}">${FX_LABELS[k]}</label>
      <input type="range" id="ed-${k}" min="${lo}" max="${hi}" step="1" value="${p[k]}" />
      <output for="ed-${k}" id="ed-${k}-out">${fxText(k, p[k])}</output>
      <button type="button" class="ed-fx-reset" data-k="${k}" title="Back to 0" aria-label="Reset the ${k}"
        ${p[k] ? "" : "disabled"}>${RESET_ICON}</button>
    </div>`;
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
    ${fxRow(p, "contrast")}
    ${fxRow(p, "brightness")}
    <div class="ed-gb">
      <p class="note">From the Game Boy Camera. Preview only for now: the download doesn't include these yet.</p>
      <div class="ed-row">
        <span class="label">Ramp</span>
        <label class="ed-check"><input type="checkbox" id="ed-shades" ${p.shades ? "checked" : ""} />
          by brightness only, dark to light</label>
        <span class="ed-hint">Best with colours of one hue (greys, greens, sepia): mixed hues of about the same
          brightness end up side by side.</span>
      </div>
      <div class="ed-row">
        <span class="label">Tone</span>
        <label class="ed-check ${p.shades ? "" : "dim"}" title="${p.shades ? "" : "Needs a ramp"}">
          <input type="checkbox" id="ed-gbtone" ${p.gbTone ? "checked" : ""} ${p.shades ? "" : "disabled"} />
          Game Boy exposure and shade spacing</label>
      </div>
      <div class="ed-row">
        <label for="ed-pixel">Pixels</label>
        <select id="ed-pixel">
          ${[2, 4].map((n) => `<option value="${n}" ${p.pixel === n ? "selected" : ""}>${n}&times;${n}</option>`).join("")}
        </select>
      </div>
      ${fxRow(p, "sharpen")}
    </div>
    <div class="ed-row ed-tagrow" ${state.tags ? "" : "hidden"}>
      <label for="ed-tag">Tag</label>
      <input id="ed-tag" value="${esc(p.tag)}" maxlength="3" autocomplete="off" spellcheck="false" />
      ${tagCanvas("ed-tag-shown", p.tag, 5, false).replace("<canvas", '<canvas id="ed-tag-shown" title="The tag as the camera draws it"')}
      <span class="ed-problem" id="ed-tag-problem">${esc(tagProblem(p))}</span>
    </div>
    <div class="ed-row">
      <span class="label">Display</span>
      <span class="ed-lcd" id="ed-lcd">${p.lcd.map((s, i) => segSvg(s, i)).join("")}</span>
      <label class="ed-check" ${state.tags ? "" : "hidden"}><input type="checkbox" id="ed-lcd-auto" ${p.lcdAuto ? "checked" : ""} /> follow the tag</label>
    </div>
    <div class="ed-row ed-colours-head">
      <span class="label">Colours</span>
      <span class="ed-ncol" id="ed-ncol"></span>
      <span class="ed-seg" role="group" aria-label="Edit the colours with">
        <button type="button" data-mode="picker" title="Colour picker">${PICKER_ICON}</button>
        <button type="button" data-mode="text" title="Hex codes">${TEXT_ICON}</button>
      </span>
    </div>
    <div class="ed-swatches" id="ed-swatches"></div>
    <div class="ed-hexlist" id="ed-hexlist-box">
      <textarea id="ed-hexlist" rows="4" spellcheck="false" autocomplete="off"
        aria-label="The colours as hex codes" placeholder="#5D159F #9751D6 #00560D"></textarea>
      <span class="ed-problem" id="ed-hexlist-problem"></span>
    </div>
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
  renderColourMode();
  renderTagShown();
}

function setFx(p, k, v) {
  p[k] = v;
  $(`#ed-${k}`).value = v;
  $(`#ed-${k}-out`).textContent = fxText(k, v);
  $(`.ed-fx-reset[data-k="${k}"]`).disabled = !v;
  changed({ list: false });
}

// ---- colours as text: hex codes separated by spaces and/or commas ----

const PICKER_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
  <rect x="1.5" y="1.5" width="13" height="9" fill="none" stroke="currentColor" stroke-width="1.5" />
  <rect x="1.5" y="12.5" width="13" height="2" fill="currentColor" /><circle cx="10" cy="5" r="1.6" fill="currentColor" /></svg>`;
const RESET_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75">
  <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" /><path d="M4.5 1.8v3.2h3.2" /></svg>`;
const TEXT_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
  <rect x="1" y="2.5" width="14" height="2" /><rect x="1" y="7" width="10" height="2" /><rect x="1" y="11.5" width="12" height="2" /></svg>`;

const hexList = (p) => p.colours.map((c) => yuvToHex(c).toUpperCase()).join(" ");

// as tall as its text, so all 32 colours show without scrolling
function fitHexList() {
  const ta = $("#ed-hexlist");
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 4}px`; // + the 2px borders
}

// The picker or the text box (the swatches show either way).
function renderColourMode() {
  const text = state.colourMode === "text";
  for (const b of document.querySelectorAll(".ed-seg button")) b.setAttribute("aria-pressed", b.dataset.mode === (text ? "text" : "picker"));
  $("#ed-colour").hidden = text;
  $("#ed-hexlist-box").hidden = !text;
  if (text) {
    $("#ed-hexlist").value = hexList(current());
    $("#ed-hexlist-problem").textContent = "";
    fitHexList();
  }
}

// "#5D159F 9751d6, #ABC" -> { hexes: ["#5d159f", ...] } or { problem }.
function parseHexList(text) {
  const words = text.split(/[\s,;]+/).filter(Boolean);
  const bad = words.find((w) => !/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(w));
  if (bad) return { problem: `"${bad}" isn't a hex colour (like #5D159F).` };
  if (!words.length) return { problem: "At least one colour." };
  if (words.length > m.maxColours) return { problem: `At most ${m.maxColours} colours; this is ${words.length}.` };
  return {
    hexes: words.map((w) => {
      const h = w.replace("#", "").toLowerCase();
      return "#" + (h.length === 3 ? [...h].map((ch) => ch + ch).join("") : h);
    }),
  };
}

// Typed colours in: ones already in the palette keep their exact value (a
// hex goes through YUV and may come back one off), the rest are new.
// The colour the text cursor is in (or right after, or before the next one).
function caretColour() {
  const ta = $("#ed-hexlist");
  const words = ta.value.slice(0, ta.selectionStart).split(/[\s,;]+/);
  const i = words.filter(Boolean).length - (words.at(-1) ? 1 : 0);
  return Math.max(0, Math.min(i, current().colours.length - 1));
}

// The other way round: select colour i's hex code in the text box.
function selectHexWord(i) {
  const ta = $("#ed-hexlist");
  const word = [...ta.value.matchAll(/[^\s,;]+/g)][i];
  if (!word) return;
  ta.focus();
  ta.setSelectionRange(word.index, word.index + word[0].length);
}

// Moving the cursor in the text box selects its swatch (while the text is
// valid: otherwise words and colours needn't line up).
function selectAtCaret() {
  const ta = $("#ed-hexlist");
  if (document.activeElement !== ta || !parseHexList(ta.value).hexes) return;
  const p = current();
  const i = caretColour();
  if (i === p.sel) return;
  p.sel = i;
  renderSwatches();
  pickerFromColour();
  save();
}

function coloursFromText(text) {
  const p = current();
  const { hexes, problem } = parseHexList(text);
  $("#ed-hexlist-problem").textContent = problem ?? "";
  if (!hexes) return;
  const had = new Map(p.colours.map((c) => [yuvToHex(c), c]));
  p.colours = hexes.map((h) => had.get(h) ?? hexToYuv(h));
  p.sel = caretColour();
  renderSwatches();
  pickerFromColour();
  renderTagShown();
  renderStrips();
  changed({ list: false });
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
    if (picking) track("pick_colour", { via: picking === "ed-sv" ? "field" : "hue", hex: $("#ed-hex").value });
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
  const fx = e.target.closest(".ed-fx");
  if (fx && e.target.type === "range") return setFx(p, fx.dataset.k, +e.target.value);
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
  if (e.target.id === "ed-hexlist") {
    fitHexList();
    return coloursFromText(e.target.value);
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
    Object.assign(p, { name: item.name, colours: fresh.colours, curve: fresh.curve, film: item.film, contrast: fresh.contrast, brightness: fresh.brightness, ...gbBits(item), sel: 0 });
    if (!enabled().some((q) => q !== p && q.tag === item.tag)) Object.assign(p, { tag: item.tag, lcd: fresh.lcd, lcdAuto: fresh.lcdAuto });
    track("choose_preset", { preset: item.name });
    return changed({ palette: true });
  }
  if (e.target.id === "ed-film" || e.target.id === "ed-curve") {
    if (e.target.id === "ed-film") {
      p.film = e.target.value || null;
      track("choose_film", { film: film(p)?.name ?? "none" });
    } else {
      p.curve = e.target.checked;
      track("toggle_curve", { on: p.curve });
    }
    renderTagShown();
    renderStrips();
    return changed({ list: false });
  }
  if (["ed-shades", "ed-gbtone", "ed-pixel"].includes(e.target.id)) {
    if (e.target.id === "ed-pixel") p.pixel = +e.target.value;
    else p[e.target.id === "ed-shades" ? "shades" : "gbTone"] = e.target.checked;
    track(`change_${e.target.id.slice(3)}`, { value: e.target.type === "checkbox" ? e.target.checked : +e.target.value });
    // the tone needs a ramp: its checkbox follows
    const tone = $("#ed-gbtone");
    tone.disabled = !p.shades;
    tone.closest("label").classList.toggle("dim", !p.shades);
    tone.closest("label").title = p.shades ? "" : "Needs a ramp";
    return changed({ list: false });
  }
  if (e.target.id === "ed-lcd-auto") {
    p.lcdAuto = e.target.checked;
    if (p.lcdAuto) p.lcd = autoLcd(p.tag);
    track("toggle_display_follows_tag", { on: p.lcdAuto });
    return changed({ palette: true, preview: false });
  }
  // dragging and typing are tracked once they're done
  if (e.target.closest(".ed-fx")) track(`change_${e.target.closest(".ed-fx").dataset.k}`, { value: +e.target.value });
  if (e.target.id === "ed-tag") track("change_tag", { tag: p.tag, problem: tagProblem(p) || null });
  if (e.target.id === "ed-hex") {
    track("pick_colour", { via: "hex", hex: yuvToHex(p.colours[p.sel]).toUpperCase() });
    pickerFromColour();
  }
  // done typing: show the colours as stored (unless the text is wrong, to fix)
  if (e.target.id === "ed-hexlist") {
    const ok = !!parseHexList(e.target.value).hexes;
    track("edit_colours_as_text", { ok, colours: p.colours.length });
    if (ok) e.target.value = hexList(p);
    fitHexList();
  }
}

function paletteClick(e) {
  const p = current();
  const reset = e.target.closest(".ed-fx-reset");
  if (reset) {
    track(`reset_${reset.dataset.k}`);
    return setFx(p, reset.dataset.k, 0);
  }
  const at = e.target.closest("#ed-lcd") && segAt(e);
  if (at) {
    const cur = p.lcd[at.cell];
    p.lcd[at.cell] = [...SEGS].filter((x) => (x === at.seg ? !cur.includes(x) : cur.includes(x))).join("");
    p.lcdAuto = false;
    $("#ed-lcd").innerHTML = p.lcd.map((s, i) => segSvg(s, i)).join("");
    $("#ed-lcd-auto").checked = false;
    hoverSeg(e);
    track("edit_display", { cell: at.cell, segment: at.seg });
    return changed({ list: false, preview: false });
  }
  const mode = e.target.closest(".ed-seg button");
  if (mode) {
    state.colourMode = mode.dataset.mode;
    track("colour_mode", { mode: state.colourMode });
    renderColourMode();
    return save();
  }
  const sw = e.target.closest(".sw[data-i]");
  if (sw) {
    p.sel = +sw.dataset.i;
    track("select_colour", { colour: p.sel + 1 });
    renderSwatches();
    pickerFromColour();
    if (state.colourMode === "text") selectHexWord(p.sel);
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
    track(e.target.closest("#ed-dupcol") ? "duplicate_colour" : "remove_colour", { colours: p.colours.length });
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
  const drawable = state.tags && [...p.tag].every((ch) => m.font[ch]) && tagWidth(m, p.tag) <= m.tag.cols;
  // even shades: the colour indices by brightness, dark to light
  const shades = p.shades ? p.colours.map((c, i) => [c[0], i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i) : null;
  const preset = { tag: drawable ? p.tag : "", match: p.colours, paint, ymap: lumaMap(p), shades, pixel: p.pixel, sharpen: p.sharpen / 100 };
  const lut = shades ? null : buildLut(preset.match, m.wy);
  document.querySelectorAll(".ed-photo canvas").forEach((canvas, i) => {
    const frame = frames[i];
    if (!frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas._out = render(m, frame, preset, lut);
    if (!canvas.matches(":hover")) canvas.getContext("2d").putImageData(canvas._out, 0, 0);
  });
}

function loadPhoto(i) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      images[i] = img;
      // at the template's size whatever the sizes are set to: the grid is for
      // judging the palette, the size cards show the sizes
      frames[i] = cameraFrame(m, m.sizes, img);
      if (i === 0) for (const aspect of Object.keys(m.sizes)) renderSize(aspect);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = state.photos[i] ?? PHOTOS[i];
  });
}

function renderPhotos() {
  $("#ed-photos").innerHTML = PHOTOS.map(
    (_, i) => `
    <figure class="ed-photo" data-i="${i}">
      <canvas width="608" height="456"></canvas>
      <figcaption>
        <label class="ed-upload">Your photo&hellip;<input type="file" accept="image/*" /></label>
        ${state.photos[i] ? `<button type="button" class="ed-reset">Reset</button>` : ""}
      </figcaption>
    </figure>`,
  ).join("");
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
    track("upload_photo", { via: "picker" });
  } else if (e.type === "drop") {
    e.preventDefault();
    fig.classList.remove("drop");
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    state.photos[i] = await shrinkImage(file);
    track("upload_photo", { via: "drop" });
  } else if (e.type === "click" && e.target.closest(".ed-reset")) {
    state.photos[i] = null;
    track("reset_photo");
  } else if (e.type === "click" && e.target.matches("canvas")) {
    track("open_photo", { photo: i, own: !!state.photos[i] });
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
  const canvases = [...document.querySelectorAll(".ed-photo canvas")].filter((c) => c._out);
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

// Biquads in a chain, from [type, Hz, Q, dB]; lowpass/highpass Q is in dB in Web
// Audio, so -3.01 is Butterworth.
function filters(ctx, specs) {
  return specs.map(([type, frequency, Q, gain = 0]) => new BiquadFilterNode(ctx, { type, frequency, Q, gain }));
}
const chain = (from, nodes, to) => [...nodes, to].reduce((a, b) => (a.connect(b), b), from);

// Highest 50 ms RMS (half-overlapping windows): how loud a clip sounds at its loudest.
function rmsPeak(data, rate) {
  const win = Math.round(rate * 0.05);
  let best = 0;
  for (let i = 0; i + win <= data.length; i += win >> 1) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += data[j] * data[j];
    best = Math.max(best, s / win);
  }
  return Math.sqrt(best);
}

// Any audio file -> 11025 Hz mono 16-bit, voiced for the camera's speaker,
// leading silence trimmed, cut to the slot with a short fade. The speaker plays
// nothing below ~1 kHz, and the DAC mirrors whatever is near 5.5 kHz back down,
// so both are filtered out. The level is that of the stock and Mario clips
// (loudest 50 ms at -16 dB RMS, peaks at most -3 dB): a peak-normalised voice
// is 6-8 dB hotter and the amp distorts it.
async function convertSound(file, slot) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const rate = m.wav.rate;
  const len = Math.ceil(Math.min(decoded.duration, 20) * rate);
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  chain(src, filters(off, [["highpass", 800, -3.01], ["highpass", 800, -3.01], ["lowpass", 4500, -3.01]]), off.destination);
  src.start();
  const data = (await off.startRendering()).getChannelData(0);
  const peak = data.reduce((a, x) => Math.max(a, Math.abs(x)), 0) || 1;
  let start = data.findIndex((x) => Math.abs(x) > peak * 0.05);
  start = Math.max(0, start - Math.round(rate * 0.005));
  const n = Math.min(slotSamples(m, slot), data.length - start);
  const fade = Math.min(n, Math.round(rate * 0.02));
  const gain = Math.min(10 ** (-16 / 20) / (rmsPeak(data.subarray(start, start + n), rate) || 1), 10 ** (-3 / 20) / peak);
  const samples = Int16Array.from({ length: n }, (_, i) => {
    const f = i >= n - fade && n < data.length - start ? (n - i) / fade : 1;
    return Math.max(-32768, Math.min(32767, Math.round(data[start + i] * gain * f * 32767)));
  });
  return { wav: encodeWav(m, samples), cut: data.length - start > n };
}

// A WAV's 16-bit samples as -1..1 (the stock ones have a LIST chunk before the data).
function wavSamples(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length && String.fromCharCode(...bytes.subarray(o, o + 4)) !== "data") o += 8 + dv.getUint32(o + 4, true);
  const n = Math.min(dv.getUint32(o + 4, true), bytes.length - o - 8) >> 1;
  return Float32Array.from({ length: n }, (_, i) => dv.getInt16(o + 8 + i * 2, true) / 32768);
}

// Play a clip roughly as the camera does, fitted to a phone recording of it: the
// DAC holds each sample for 4 output samples (no smoothing filter, so the sound
// is mirrored around 11 kHz), the amp soft-clips, and the tiny speaker has no
// bass and peaks around 2 and 7.5 kHz.
async function playOnCamera(bytes) {
  const x = wavSamples(bytes);
  const rate = m.wav.rate * 4;
  const ctx = new AudioContext({ sampleRate: rate });
  const buf = ctx.createBuffer(1, x.length * 4, rate);
  const held = buf.getChannelData(0);
  held.forEach((_, i) => (held[i] = Math.tanh(3 * x[i >> 2]) / 3));
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  const speaker = filters(ctx, [
    ["highpass", 1200, -3.01], ["highpass", 1200, -3.01], ["highpass", 1200, -3.01],
    ["peaking", 2000, 1.2, 11], ["peaking", 7500, 0.9, 14], ["lowpass", 11000, -3.01],
  ]);
  chain(src, speaker, new GainNode(ctx, { gain: 0.4 })).connect(ctx.destination);
  src.onended = () => ctx.close();
  src.start();
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
    if (e.type !== "change") return;
    state.sounds.on = e.target.checked;
    track("toggle_sounds", { on: state.sounds.on });
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
    track("choose_sound", { slot, src: s.src });
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
      track("upload_sound", { slot, ok: true, cut });
    } catch {
      track("upload_sound", { slot, ok: false });
      alert(`Couldn't read ${file.name} as audio.`);
    }
  } else if (e.type === "click" && e.target.closest(".ed-play")) {
    await playOnCamera(await soundBytes(slot));
    track("play_sound", { slot, src: s.src });
    return;
  } else return;
  renderSounds();
  changed({ list: false, preview: false });
}

// ---- download ----

function renderDownload() {
  const on = enabled();
  const errors = configErrors(m, {
    presets: on.map((p) => presetOf(p, p.colours)),
    rnd: state.rnd && rndOffered(),
    normal: state.normal,
    sounds: state.sounds.on,
    tags: state.tags,
    sizes: state.sizes,
  });
  const rnd = state.rnd && rndOffered();
  const sized = Object.keys(m.sizes).some((k) => !sameSize(state.sizes[k], m.sizes[k]));
  $("#ed-summary").textContent =
    `${on.length} look${on.length === 1 ? "" : "s"} (${on.map((p) => (state.tags ? p.tag || "?" : p.name)).join(", ")})` +
    `${rnd ? " + rnd" : ""}${state.normal ? " + nor" : ""} · ${state.tags ? "tagged" : "no tags"}${sized ? " · own sizes" : ""}` +
    ` · ${state.sounds.on ? "sounds on" : "silent"}` +
    (on.some(usesGbBits) ? " · the Game Boy settings are preview only, not in the download yet" : "");
  $("#ed-errors").innerHTML = errors.map((e) => `<li>${esc(e)}</li>`).join("");
  $("#ed-download").disabled = errors.length > 0;
}

// What the downloaded firmware is made of.
function downloadProps() {
  const on = enabled();
  return {
    palettes: on.length,
    tags: on.map((p) => p.tag),
    films: on.map((p) => film(p)?.name ?? "none"),
    contrast: on.map((p) => p.contrast),
    brightness: on.map((p) => p.brightness),
    rnd: state.rnd && rndOffered(),
    normal: state.normal,
    tagged: state.tags,
    sizes: Object.values(state.sizes).map((s) => s.join("x")),
    sounds: state.sounds.on,
    shutter: state.sounds.on ? state.sounds.shutter.src : null,
    poweron: state.sounds.on ? state.sounds.poweron.src : null,
  };
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
    track("download_customized_firmware", downloadProps());
  } catch (err) {
    track("download_customized_firmware_failed", { ...downloadProps(), error: err.message });
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
    track("toggle_rnd", { on: state.rnd });
  });
  $("#ed-normal").addEventListener("change", (e) => {
    state.normal = e.target.checked;
    changed({ preview: false });
    track("toggle_normal", { on: state.normal });
  });
  $("#ed-tags").addEventListener("change", (e) => {
    state.tags = e.target.checked;
    track("toggle_tags", { on: state.tags });
    changed({ palette: true });
  });
  const sizes = $("#ed-sizes");
  sizes.addEventListener("input", sizeEvents);
  sizes.addEventListener("change", sizeEvents);
  sizes.addEventListener("click", sizeEvents);
  const panel = $("#ed-palette");
  panel.addEventListener("input", paletteInput);
  document.addEventListener("selectionchange", selectAtCaret);
  panel.addEventListener("change", paletteChange);
  panel.addEventListener("click", paletteClick);
  panel.addEventListener("mousemove", (e) => e.target.closest("#ed-lcd") && hoverSeg(e));
  panel.addEventListener("mouseout", (e) => e.target.closest("#ed-lcd") && !e.relatedTarget?.closest?.("#ed-lcd") && hoverSeg({ type: "mouseleave" }));
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) panel.addEventListener(type, pickerPointer);
  const photos = $("#ed-photos");
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
    const sure = confirm("Start over? This forgets your looks, sounds and photos.");
    track("start_over", { confirmed: sure });
    if (!sure) return;
    state = defaultState();
    renderOptions();
    renderPhotos();
    renderSounds();
    changed({ palette: true, preview: false });
    await Promise.all(PHOTOS.map((_, i) => loadPhoto(i)));
    renderPreview();
  });

  renderOptions();
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
