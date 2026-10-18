# Godox C100 firmware hacking

_Last updated 2026-10-18_

**Working on the camera (`v021`):** pixel-art photos and videos at ~274k
pixels for every aspect ratio, three presets (EP6, 6FP, BW) plus rnd chosen
with the center button and remembered across power-off, the preset's tag on
photos and video and its code on the see-through display, and a silent
camera. The preset data has fixed slots, so the
[site's editor](#the-sites-firmware-editor) builds custom firmware (1–8
presets, rnd, sounds) in the browser; those work on the camera too.

Goal: make the C100 produce pixel-art photos and videos in the spirit of the
[Pixless camera](https://petapixel.com/2025/01/09/0-03-megapixel-pixless-camera-captures-charming-pixel-art-photos/):
small resolution, a limited colour palette, and dithering.

## Status

| Feature | State |
|---|---|
| 640-wide photos at every aspect ratio | on the camera, working |
| Palette dithering on photos (8 palettes, 10–32 colours, random per photo) | on the camera, working |
| Palette tag (two letters, top right) on photos | on the camera, working (e.g. IMG_0304: `HB`) |
| Speaker never switched on, no sounds (`SILENT=1`) | on the camera, working |
| 640-wide video at every aspect ratio | on the camera, working (IMG_0300–0303) |
| Palette dithering on video (random palette per recording) | on the camera, working (IMG_0318–0321) |
| Palette tag on video (every frame) | on the camera, working (IMG_0322–0325: `MC`, `HB`, `EG`, `DB`) |
| Next palette's tag on the see-through display (`LCDTAG=1`) | on the camera, working (`v013`) |
| 12 presets: 3 palettes × 4 films, random per photo/recording | on the camera, working (`v014`) |
| Three-letter preset code, top right on photos and video | on the camera, working (`v014`) |
| Next preset's code on the display's shutter-speed cells | on the camera, working (`v014`) |
| [3 presets](#presets) EP6, 6FP, BW (S-curved dithered greyscale) + rnd mode | on the camera, working (`v015`) |
| Center button cycles the preset mode in photo/video mode, display shows it | on the camera, working (`v016`; `v015` hooked an arrow) |
| Preset mode remembered across power-off (byte `0xf1` of the saved settings) | on the camera, working (`v017`) |
| [Larger photos](#size-and-aspect-ratios): ~420k pixels per aspect, video unchanged | on the camera, working (`v018`; more than wanted) |
| Photos at ~274k pixels per aspect (the old 3:2 count), video unchanged | on the camera, working (`v019`) |
| Video at the photo sizes (hook takes any width up to `MAX_W`) | on the camera, working (`v020`) |
| Preset data in fixed slots (8 presets × 32 colours), preset count and rnd patchable | on the camera, working (`v021`) |
| [Site editor](#the-sites-firmware-editor) builds: own presets, S-curve, films, tags, display codes, rnd, sounds | on the camera, working (2026-10-18: photos, video, sounds, palettes) |
| [Dithering as a setting](#dithering-algorithms): 16 algorithms + random, left arrow, ISO digits, photo tag | editor preview only (branch `dithering-algorithms`); feasibility estimated, not measured |
| Table kept when the preset doesn't change (no ~60 ms fill before the capture) | built (`v015`), emulator |

Open: [repeated frames](#timing-and-headroom) in some dithered videos.

Contents: [The device](#the-device) · [Image layout](#firmware-image-layout-gp_cardvr_upgradebin-v116) ·
[Tooling](#tooling) · [Backups](#backups-in-build_backups) · [Code caves and hooks](#code-caves-and-hooks) ·
[Photos](#photos) · [Palettes](#palettes) · [Presets](#presets) · [Video](#video) · [Sounds](#sounds) ·
[Site editor](#the-sites-firmware-editor) · [Dithering algorithms](#dithering-algorithms) · [Look knobs](#look-knobs-contrast--brightness) · [UI graphics](#ui-graphics-gpzp-logos-and-the-osd-overlay) ·
[History](#history-the-v1-effect) · [Ideas](#ideas-not-yet-done) · [Palette colours](#appendix-palette-colours)

## The device

- Chip: **GeneralPlus GP22B** (ARM926-class, little-endian ARMv5TE, runs
  FreeRTOS). Measured at ~310 M instructions/s in the video hook (see
  [Video timing](#timing-and-headroom)); an ARM926 retires at most one
  instruction per cycle, so it runs at **≥ ~310 MHz**.
- Sensor: **GalaxyCore GC2083**, 1920×1080 native (16:9 uses the whole sensor;
  the other aspect ratios are crops of it).
- Storage: SPI flash; photos and videos on the microSD (TF) card in `DCIM`, as
  `IMG_xxxx.jpg` and `IMG_xxxx.mov`.
- Firmware update: copy `GP_CARDVR_UPGRADE.BIN` to the SD card root, restart,
  wait for the LED to stop flashing. The updater checks only a 4-byte magic:
  **no checksum, no signature**, so modified firmware is accepted.

## Firmware image layout (`GP_CARDVR_UPGRADE.BIN`, v1.1.6)

| File offset | Contents |
|---|---|
| `0x00000` | bootloader + `PGpssiipps` header (no SD-update code here) |
| `0x10000` | app header `GPCODEROM` |
| `0x10200` | **app code**, loaded at **RAM 0x0** (so `file offset = addr + 0x10200`) |
| `0x170000` | resource table (sounds, logos, fonts), 512-byte-sector offsets |

The SD updater lives in the app, so a patch that still boots and still reaches
the SD-card check is always recoverable by re-flashing a good build. Only
breaking the boot path or the updater itself would remove SD recovery. Photo
and video code only runs while taking a photo or recording, so bugs there are
always recoverable.

## Tooling

In `tools/`:

- `build.sh` — **rebuilds `build/GP_CARDVR_UPGRADE.BIN` from the original**:
  applies sounds, then assembles each `tools/patches/*.s` and patches it in.
  Fails if a patch overflows its slot or has an unresolved relocation. Options
  (environment variables):

  | Variable | Default | Effect |
  |---|---|---|
  | `SILENT` | 0 | 1 = no sounds and the speaker amp never switched on; 0 = Super Mario kick (shutter) and coin (power-on) |
  | `SMALLVID` | 1 | 640-wide video at every aspect; 0 = stock full-size video |
  | `VIDFX` | 1 | preset dithering + tag on video; 0 = plain small video |
  | `VIDTIMING` | 0 | 1 = draw each video strip's hook time (test builds only) |
  | `LCDTAG` | 1 | 1 = the center button [cycles the preset mode](#preset-mode-center-button-and-display) and the display shows it; 0 = stock blank display, no button, always the first preset |
  | `CONTRAST`, `BRIGHT` | 100, 0 | look knobs, see [below](#look-knobs-contrast--brightness) |

  e.g. `SILENT=1 sh tools/build.sh`. The UI/focus beep (`BEEP.wav`) is
  silenced in every build.
- `patch_code.py` — apply byte patches addressed by RAM address; refuses to
  touch the bootloader or the SD updater, and verifies the original bytes first.
- `gp_res.py` — list/extract the resource table. `patch_res.py` — replace a
  resource (e.g. a WAV) in place, format- and size-checked. `mk_silence.py` —
  make a silent copy of a WAV (same header/size, data zeroed).
- `palettes.py` — the palettes and the [presets](#presets)
  (`PRESETS`: a `MATCH` palette and a film), tags and display codes; `palettes.py asm` generates
  `palettes.inc`, which the caves include. The presets' film colours are in
  `film_colours.py`, generated by `film.py gen` from the LUTs in `film_luts/`
  (not committed), so the build doesn't need the LUTs; `palettes.py` refuses
  a stale one.
- `sim_palette.py` — exact off-camera replica of the effect (blocks, Bayer,
  weighted nearest colour, lookup-table quantisation, tag).
  `palette_preview.py` renders every palette on photos (contact sheets).
  `grade.py` makes endesga32 variants from a spec like `eg:t200:d14r1`:
  regraded (its cool tint on the neutrals swapped for another hue, strength
  or split tone) and/or thinned (colours dropped, keeping the neutral ramp
  and every hue family). `palette_sheet.py` renders them on plain photos
  (`images/plain/`, taken with `v003_smaller_image.bin`) next to EG and db16.
- `sort_images.py` — reads the palette tag off each photo/video in `images/`
  and moves it to `images/<tag>/` (rerun after adding new ones).
  `sim_dither.py` is the early grayscale-ramp version.
- `emu_cave.py` — runs the built photo cave in an ARM emulator (Unicorn) and
  checks it pixel-for-pixel against `sim_palette.py`. `emu_video.py` — the
  same for the video hook. Both run against `build/GP_CARDVR_UPGRADE.BIN`:

  ```
  uv run --with unicorn,numpy,pillow tools/emu_cave.py images/IMG_0184.jpg
  uv run --with unicorn,numpy,pillow tools/emu_video.py images/IMG_0184.jpg   # add --timing for a VIDTIMING=1 build
  ```
- `emu_seg.py` — runs the transparent display's segment code (HT1621) in the
  emulator and decodes what it sends to the panel (see
  [The transparent display](#the-transparent-display-a-segment-panel-ht1621)).
- `gpzp.py` — decode/encode the GPZP UI images (see [UI graphics](#ui-graphics-gpzp-logos-and-the-osd-overlay)).
- `editor_data.py` — builds the [editor's](#the-sites-firmware-editor) template
  and writes `site/editor/` (patch offsets, palettes, sounds, preview photos).
  `editor_check.sh` checks the editor's patcher against `build.sh`.

  Build options for a custom config (what the editor makes): `PRESETS_JSON`
  (presets, tags, display segments, rnd; see `palettes.py config()`),
  `SHUTTER_WAV`, `POWERON_WAV` (11025 Hz mono 16-bit, at most the slot).

Reverse engineering: Ghidra headless project under `build/ghidra/`, decompiled
C in `decomp/c100.c`, string→function index in `decomp/strings.tsv`
(scripts in `tools/ghidra/`). Raw disassembly via Homebrew `llvm-mc
--disassemble` on bytes sliced from the image (disassemble word by word:
literal pools are invalid instructions, and llvm-mc silently drops those,
which shifts every address after them).

## Backups (in `build_backups/`)

- `v001_original.bin` — factory v1.1.6.
- `v002_updated_sounds.bin` — + custom shutter / power-on sounds.
- `v003_smaller_image.bin` — + 4:3 photo mode remapped to 320×240.
- `v004_bw.bin` — + clean black & white (320×240). Re-flashed to confirm the
  photo path is fully recoverable.
- `v005_bw_dithering.bin`, `v006_first_colored_dithering.bin`,
  `v007_cycled_color_palettes_dithering.bin`,
  `v008_cycled_color_palettes_dithering_larger.bin` — the dithering steps up to
  the v1 palettes at 640 wide (see [History](#history-the-v1-effect)).
- `v009_more_palettes.bin` — 8 palettes of 10–32 colours, lookup table,
  random palette per photo (first photos: IMG_0199–0209).
- `v010_speaker_silenced.bin` — + palette tag, speaker amp never switched on
  (`SILENT=1`).
- `v011_small_video.bin` — + 640-wide video at every aspect ratio.
- `v012_color_dithered_video.bin` — + palette dithering and the palette tag on
  video (`SILENT=1`, default settings otherwise).
- `v013_active_palette_displayed.bin` — + the next palette's tag on the
  see-through display (ISO cells).
- `v014_presets.bin` — the 8 palettes replaced by 12 presets (3 palettes × 4
  films), three-letter code on photos/video and on the display's SS cells
  (`SILENT=1`). Works on the camera.
- `v015_preset_modes.bin` — 3 presets (EP6, 6FP, BW) + rnd, chosen with the
  center button, shown on the display; table kept while the preset stays
  (`SILENT=1`). On the camera the presets and display work, but the center
  button does nothing: it hooked the `IO_ISO` key, which is an arrow.
- `v016_center_button.bin` — v015 with the hook on the real center key
  (`F_key`, `0x1ddf8`). Works on the camera.
- `v017_mode_saved.bin` — + the mode kept in the camera's saved settings
  (survives power-off), W on the display with mirrored halves. Works on the
  camera.
- `v018_larger_photos.bin` — photos at ~420k pixels (864×484, 800×536,
  752×564, 640×640), video unchanged. Works on the camera.
- `v019_photos_274k.bin` — photos at ~274k pixels (704×396, 640×428, 608×456,
  528×528), video unchanged. Works on the camera.
- `v020_video_274k.bin` — video at the same sizes as photos. Works on the
  camera.
- `v021_editor_template.bin` — v020's code with the preset data in fixed
  slots (room for 8 presets of 32 colours), silent (`SILENT=1`), the same
  three presets and rnd. Behaves as v020 does; differs from it only in the
  photo cave's literals, the preset data and the display table. The current
  build, the site's default download (a copy in `site/editor/`) and the
  template the [site's editor](#the-sites-firmware-editor) patches. Works on
  the camera, and so do editor builds from it (2026-10-18).

## Code caves and hooks

Everything is patched into dead code, and every hook replaces the first
instruction of a firmware function with a branch to a cave, which re-runs that
instruction and jumps back (e.g. the photo hook replaces `str lr, [sp, #-4]!`
at `0x15448` and returns to `0x1544c`; the video hook replaces `ldr r3, [r0]`
at `0x18d14` and returns to `0x18d18`).

| Hook point | When it runs | Cave entry | Purpose |
|---|---|---|---|
| `FUN_00015448` | scaler "strip ready" callback, photo only, **interrupt** | `hook` | photo pixel effect |
| `FUN_000187c4` | capture handler, once per photo, camera task | `idx_stub` → `lut_build` | pick preset, fill table |
| `FUN_00018d14` | each 64-row video strip → H.264 encoder, camera task | `vhook` | video pixel effect |
| tail call `b 0x20fd0` at `0x21218` | SS readout on the see-through display, every refresh tick, peripheral task | `lcd_hook` | preset mode on the display |
| `bl 0x42c` at `0x1ddf8` (post `0x7041`) | center button, once per press, peripheral task | `center_hook` | step the preset mode |
| jump tables `0xf3d0`, `0xf0a0` | photo / video size setup | size stubs | 640-wide output |
| `0x22b38`, `0x350f0`, `0x2ed50` | — | (NOPs) | speaker amp off |

**Photo cave** — dead `FUN_000bab6c`, `0xbab6c–0xbb340` (verified against all
B/BL targets and pointers, ARM and Thumb):

| Address | Contents |
|---|---|
| `0xbab6c` | `hook` (fixed: `hook_jump.s` branches here) |
| `0xbad6c` | `draw_tag` (subroutine, also called by the video hook) |
| `0xbae98` | `lut_build` (per photo) |
| `0xbaeb0` | `lut_fill` (subroutine, also called by the video hook) |
| `0xbb000` | `pick` (random preset ≠ `PAL_IDX`; also called by the display hook) |
| `0xbb03c` | `BAYER`, then `VARS` (`LUT_PTR`, `CUR_PAL`, `PAL_IDX`, `STRIP_N`; the mode is in the saved settings since `v017`) |
| `0xbb060` | size stubs (`photo43`/`vid43`, `stub169`/`vid169`, `stub32`/`vid32`, `stub11`/`vid11`, `size_common`) |
| `0xbb0e4` | `idx_stub`: `b lut_build` (cave ends `0xbb0e8`; ~600 B free) |

(Addresses as of `v014`, `v015` within a few words; the preset data moved out
to its own cave, below.)

**Video cave** — `0xbb774–0xbbc00` (of the dead range `0xbb774–0xbc744`), the unreferenced functions
`FUN_000bb774…FUN_000bc19c` (no branch or pointer into the range; they only
call the libgcc division helpers). `FUN_000bb3f8` just before it is avoided: a
word in a libm constant table happens to equal `0xbb679`, which looks like a
pointer into it. Currently `vhook` at `0xbb774`, `BAYER` and `VVARS` after it;
ends `0xbb9a0`.

**Preset data cave** — `0xbbc00–0xbc400`, the end of that range
(`preset_data.s`, data only): `MATCH_PALETTES` (`0xbbc00`), `PRESET_MATCH`,
`TAGS`, the film colours (`DISPLAY`), `DISPLAY_PTRS`; ends `0xbc12c`.
`build.sh` assembles it first and passes its label addresses to the photo
cave as `--defsym`s.

**Display cave** — `0xbc400–0xbc744`, the rest of that dead range (the only
branches into it come from the dead `FUN_000bc19c` itself): `lcd_hook` at
`0xbc400`, then `LCD_TAGS`; ends `0xbc4e4`.

Only `hook` and `vhook` have fixed addresses. `build.sh` reads every other
address from the object files (`llvm-nm`) and patches the jump tables and
`cyc_jump.s` with them. It passes `lut_fill`, `draw_tag` and `VARS` to the
video cave, and `pick` and `VARS` to the display cave, as `--defsym`s, so
layouts can change freely.

Assembly conventions:

- Caves are assembled unlinked from `.org 0`. Labels in literal pools are
  written as `label - base`, so they assemble to absolute constants instead of
  relocations (the image is loaded at 0).
- No `bl` to anything: llvm-mc leaves a relocation even for a local label. Use
  `mov lr, pc` + `b target` (absolute firmware addresses are `.set X, base + addr`).
- `build.sh` runs Python with `-I`, which leaves the script's own folder off
  `sys.path`: a tool that imports a sibling module adds it itself.

> **Lesson, the hard way:** when you intercept the *first* instruction of a
> function and later rejoin it, `r0–r3` still hold that function's live
> arguments. The hook must `push {r0-r11, lr}` / `pop {r0-r11, lr}`; saving
> only `r4-r11` corrupts the callback's arguments and produces
> non-deterministic rainbow noise. A whole "it must be too slow" theory
> evaporated once this was fixed; it was never a performance problem.

## Photos

### Size and aspect ratios

`FUN_0000f004` builds each capture size (`APMode` `0x102` = photo, `0x101` =
video). The photo resolution switch dispatches through a jump table at
`0xf3d0` (`ldrls pc,[pc,idx,lsl#2]` at `0xf3c8`) whose entries are **absolute
handler addresses**, so each aspect ratio can be pointed straight at a cave
stub:

| case | native | routed to | crop → photo (since `v019`) | video (until `v019`; since `v020` = photo) |
|---|---|---|---|---|
| 0, 1 | 1920×1080 (16:9) | `stub169` | 1920×1080 → 704×396 | 640×360 |
| 2 | 1616×1080 (3:2) | `stub32` | 1616×1080 → 640×428 | 640×428 |
| 3, 11, 12 | 1440×1080 (4:3) | `photo43` | 1440×1080 → 608×456 | 640×480 |
| 4 | 1024×1024 (1:1) | `stub11` | 1024×1024 → 528×528 | 640×640 |

The native sizes are just constants in the stock handlers (`mov r3, #1616`
at `0xf7bc`; height 1080 from a literal): 1616 is the multiple of 16 nearest
an exact 3:2 crop of 1080 rows (1620), not a sensor limit. Every stock width
is a multiple of 16 (scaler, JPEG blocks); heights needn't be (1080 isn't;
the encoder pads the last block row). Our heights are multiples of 4 (2×2
blocks, 4:2:0 chroma; 428 is known to work), widths multiples of 16. The
photo sizes (`palettes.py SIZES`, emitted into `palettes.inc`) give
every aspect about the same pixel count, ~274k (the old 3:2 640×428), and each
crop has its output's aspect, because the scaler scales x and y
independently (stock 1616×1080 into 800×528 would have stretched the image
1.3% wide): 16:9 is exactly 0.3667 of the full 1920×1080, 4:3 0.4222 of
1440×1080, 1:1 0.5156 of 1024×1024, 3:2 0.396 of 1616×1080 (0.07% off).
Until `v017` all photos were 640 wide (640×360, 640×428, 640×480, 640×640);
`v018` had ~420k (1920×1076 → 864×484, 1600×1072 → 800×536, 1440×1080 →
752×564, 640×640), which worked on the camera (so non-1080 crop heights are
fine) but was more than wanted.

Since `v020` video uses the same sizes (the `vid169`/`vid32`/`vid43`/`vid11`
labels are on the photo stubs again; `size_common` sets the first scaler to
the target for video). `v018`/`v019` kept video at 640 in separate stubs:
its hook runs per frame in the camera task, and at 1:1/640 it took 65% of
the frame, and an earlier try at larger video sizes went over budget and
starved the camera (video broke, buttons stopped responding). At the
`v020` sizes every aspect needs about the same: see
[Timing and headroom](#timing-and-headroom). The video hook reads the width
from the encoder struct (`+0xdc`) and touches any multiple of 16 up to
`MAX_W` (704); `v017` and before only touched exactly 640.

The size struct (`r4`, printed by the firmware as `[R]Tw,Th, Sw,Sh, Cw,Ch`):
crop C at +10/+12, first scaler S at +6/+8, target T at +14/+16, mode byte at
+4 (photo 1, video 3). The photo stubs set C = S = the crop and T small,
then rejoin the photo path at `0xf188`. (The first attempt set only T, which
makes the firmware crop instead of scale; the crop and first scaler must be
set too.) The effect reads the width from the strip size, so it works at any
of these widths; the tag is placed from the right edge.

### Strip buffer format

Decoded from on-camera diagnostics. The scaler delivers the photo in
**32-row strips** into a double buffer (strip A at `PHOTO+0x18`, strip B right
after it; `PHOTO = 0x1317ac`); the hook processes 64 rows from strip A.
`STRIP_BYTES` (value at `0x13155c`) `= width × 32 × 3/2`. The pixel format
(`PHOTO+0x20`) is `'"'` (0x22) = **YUV 4:2:0**, laid out **row-interleaved
with a parity twist**. With `stride = width × 3/2` and `third = width/2`, each
2-row band (rows `2b`, `2b+1`) is:

```
even row:  luma Y [0, 2*third)            chroma pairs 0..third/2-1  [2*third, 3*third)
odd  row:  chroma pairs third/2..third-1  [0, third)   luma Y [third, 3*third)
```

So one **2×2 block** = one chroma (U,V) pair shared by 4 luma samples (2 in the
even row, 2 in the odd), U and V interleaved. The video strips use the same
layout (see [Video](#frame-hook-and-strip-format)).

The hook derives `stride`, `third` and the split point from `STRIP_BYTES`, so
it is width-agnostic. It does cache maintenance around its writes (`0x401ac`
invalidate, `0x401b8` clean) so the JPEG encoder sees them, and only ever
writes a buffer whose address matches strip A/B: an unexpected call leaves
memory untouched.

Verifying these primitives in isolation (a per-row brightness gradient, then
five solid colour bars) before attempting colour matching is what made the
colour work predictable: it separated "can we address and write pixels" from
"is the colour maths right". The video format was decoded the same way.

### The effect: palette dithering with a lookup table

**Per photo — `idx_stub` → `lut_build` → `lut_fill`** (camera task, before
the capture starts):

1. **Random palette per photo.** Index = (FreeRTOS tick count & 0xff) mod
   `NPAL`. The tick count (`xTickCount` at `0x126b80`, found via
   `xTaskIncrementTick` `FUN_0005df2c` and `xTaskGetTickCount` `FUN_0005dee4`)
   counts milliseconds since boot, so its low bits at the shutter press are
   effectively random. If it equals the previous photo's palette, the next one
   is used, so the same palette never comes twice in a row.
2. **Table buffer**, allocated once with `pvPortMalloc(35937, 64)` (thunk at
   `0x5374c` → `FUN_0005ca54`) and kept. If the allocation fails, the photo is
   left unprocessed and the next photo tries again.
3. **Fill:** for every bin centre (Y, U, V in 0, 8, …, 256) find the nearest
   palette colour (`2·|dY| + |dU| + |dV|`, first one wins on a tie, as in the
   simulator) and store its byte offset (3 × index). The last bin's centre is
   256, not 255, which adds the same amount to every distance, so the winner
   is the same.
4. Set `CUR_PAL` (the palette's colours) last; while it is 0 the hook leaves
   strips alone. `lut_build` also resets the strip counter `STRIP_N`.

**Per strip — `hook`** (interrupt), per 2×2 block:

1. average the block's 4 luma;
2. apply `CONTRAST` / `BRIGHT` (assemble-time constants);
3. add a **4×4 Bayer** ordered-dither offset (±32), clamp to 0–255;
4. read the block's U, V;
5. one table read at `((yq·33 + uq)·33 + vq)`, `q = (x + 4) >> 3`
   (multiplying by 33 is `x + (x << 5)`);
6. paint the whole block that palette colour (Y to all four luma, U, V to the
   pair).

That's **66 instructions per block**, against 147 for the v1 6-colour search
(both counted in the emulator, v1 on the v008 backup). Per-block is the natural
unit in 4:2:0 (one chroma pair per block).

**Palette data:** generated by `palettes.py asm` into
`build/obj/palettes.inc` (`.equ NPAL` plus a `PALETTE_DATA` macro: per palette
a count byte, then the Y, U, V triplets), which `build.sh` creates and
`photo_cave.s` includes. 8 palettes, 144 colours, 440 B.

### Palette tag

Every photo gets its palette's tag in the top right corner. Since `v014` that
is the [preset](#presets)'s code (e.g. `EP6`, in a 13×7 font-pixel field =
52×28 image pixels, 25 B per preset; shorter codes like `BW` are
right-aligned, and W is 5 pixels wide because a 3-wide W reads as H). Before,
the two-letter palette tags:

| riso6 | refreshing | mid_century | harbour | db16 | endesga32 | sweetie16 | nes |
|---|---|---|---|---|---|---|---|
| R6 | RF | MC | HB | DB | EG | S6 | NS |

- **Font:** 3×5 pixels per letter (`FONT` in `palettes.py`), one pixel = 2×2
  blocks = 4×4 image pixels. With a 1-pixel gap and a 1-pixel outline the tag
  is 9×7 font pixels = 36×28 image pixels, 8 px from the top and right edges.
- **Colours:** letters in the palette's lightest colour (by Y), outline (the
  8 neighbours of every letter pixel) in its darkest, so the tag stays within
  the palette. Elsewhere the photo shows through.
- **Data:** `palettes.py asm` precomputes each palette's 9×7 grid as 2-bit
  cells (16 B) plus the dark and light colour offsets: 18 B per palette.
- **Firmware:** after the hook has processed a strip, it checks `STRIP_N`, and
  on a photo's first strip calls `draw_tag`, which overwrites the tag's blocks
  (always in the right half, so the chroma sits in the odd row) before the
  cache clean. `draw_tag` is a plain subroutine (strip in r11, stride r7,
  third r8, palette r5), shared with the video hook.
- The previews and `sim_palette.render(..., tag=...)` draw the same tag.

### Verification

`tools/emu_cave.py` runs the built firmware in Unicorn, with the cache
maintenance calls and `pvPortMalloc` stubbed. It runs `idx_stub` for a series
of tick values, then feeds the hook 640×64 strips of a real photo in the
camera's layout:

- every 2×2 block is exactly the palette colour the simulator picks, for all
  8 palettes, on IMG_0184 and IMG_0186 (0.00% difference), including the tag
  on a photo's first strip and no tag on the second;
- the palette follows the tick (300 → 300 & 0xff = 44 → 44 mod 8 = 4), and a
  repeat is bumped (tick 7 twice → palettes 7, then 0);
- `pvPortMalloc` is called once, on the first photo;
- with a failing allocation the strip comes back byte-for-byte untouched.

Re-run it after any change to the photo cave. It was re-run after `lut_fill`
and `draw_tag` were split out into subroutines for video (2026-10-14): still
0.00%.

### Timing

- The strip hook runs in an interrupt with a per-strip deadline. If a size
  ever outruns it, it shows as the **lower part of each photo turning to noise
  while the top is correct**: the cue to optimise or shrink.
- Per 64-row strip (`emu_cave.py` counts the instructions; ms at the measured
  ~310 M instructions/s): 640 wide 0.68 M (~2.2 ms, matching the video hook's
  measured 2.17 ms), 752 wide 0.80 M (~2.6 ms), 800 wide 0.85 M (~2.7 ms), 864
  wide 0.92 M (~3.0 ms; worked on the camera in `v018`). At the `v019` sizes:
  704 wide 0.75 M (~2.4 ms), 608 wide 0.65 M (~2.1 ms), 528 wide 0.56 M
  (~1.8 ms).
- Table fill: 15.8M instructions for a 24-colour palette, 21M for 32 (counted
  in the emulator). At the measured ~310 M instructions/s that is roughly
  **50–70 ms** before each capture.

## Palettes

### Why v2

The first daylight photos with the v1 palettes looked over-compressed: big
areas collapse into a single colour and you can't make out much. Three causes:

1. **Most v1 palettes really had 5 colours.** In 5 of the 7 palettes the 6th
   entry was a padded copy of the 5th.
2. **Big brightness gaps.** e.g. riso6 jumps from navy (Y=30) to the next
   colour at Y=115, so every shadow between them becomes flat navy.
3. **Hue counted as much as brightness** in the nearest-colour search, while
   brightness is what makes a photo readable.

| Setting | v1 | v2 (current) |
|---|---|---|
| Palettes | 7 | 8 |
| Colours per palette | 6 slots (often 5 distinct) | **10 to 32** |
| Match distance | `ΔY + ΔU + ΔV` | **`2·ΔY + ΔU + ΔV`** |
| Colour search | 6 unrolled comparisons per block | **lookup table**, filled once per photo |
| Palette per photo | next in the cycle (random start per boot) | **random**, never the same twice in a row; picked one photo ahead so the display can show it |
| Dither, block, `CONTRAST` / `BRIGHT`, size | 4×4 Bayer ±32, 2×2, 100 / 0, 640 wide | unchanged |

### The palette set

| Palette | Colours | Origin |
|---|---|---|
| riso6 | 6 → 10 | v1 |
| refreshing | 5 → 10 | v1 |
| mid_century | 5 + 2 dark → 10 | new |
| harbour | 5 → 10 | new |
| db16 | 16 → **24** | DawnBringer 16 (Lospec) |
| endesga32 | 32 | Endesga 32 (Lospec) |
| sweetie16 | 16 | Sweetie 16 (Lospec) |
| nes | 55 → 32 | NES 2C02, thinned |

Tried and dropped: vibrant_summer, fiesta, bold_hues, dark_sunset,
vibrant_nature, seventies, pixnote24, pico8, db32, earthy.

Hex values for the pixel-art palettes are the published Lospec values. Colours
sampled from the source screenshots (after applying the screenshot's colour
profile) matched them to ±1. All palette data lives in
[`tools/palettes.py`](../tools/palettes.py) (`python3 tools/palettes.py` lists
them; the full colour tables are in the [appendix](#appendix-palette-colours)).

**Small palettes, topped up to 10 with "overprint" mixes.** Each 5–6 colour
palette is topped up to 10 with **midpoints of two base colours**, like two
riso inks printed over each other (navy + teal → dark teal, navy + pink →
plum), so the new colours stay in the palette's family. They are picked
greedily: each step adds the mix that is farthest (Manhattan, Y+U+V) from every
colour already in the set, so the biggest gaps get filled first. Mixes that
come out greyer than their less-saturated parent are skipped (grey mixes, e.g.
navy + cream, made everything muddy in tests).

**db16, topped up to 24.** db16 came out muted and slightly purple at 16. It
gets 8 extra colours (`SIZE` in `palettes.py`), all mixes of two db16 colours,
even though that departs from the original palette. Grass comes out greener
and the purple cast is lighter.

**mid_century, two dark colours added.** Its darkest colour was `#126D68`
(Y = 81), and a mix can't be darker than its darkest parent, so every shadow
came out as one flat teal. It now has a dark teal `#093634` and a dark navy
`#1A1B3A` (riso6's navy). The navy takes the deepest shadows, the dark teal the
ones just above, and the mixes now include a rust brown. Comparison (original /
+ dark teal / + dark navy / + both):
[previews/palettes_v2/mid_century_dark.png](../previews/palettes_v2/mid_century_dark.png).
An experiment with **shades and tints** (a base colour mixed half with black or
white, to top up earthy to 16) was dropped together with earthy. It also
showed that the order of the top-up pools matters: putting shades/tints before
the greying mixes changed harbour's 10th colour from the dark plum `#584056` to
a light mint, and harbour's shadows turned harsh red and blue.

**NES, thinned from 55 to 32.** The full NES list has many near-duplicates
(e.g. `FCFCFC`/`F8F8F8`, `7C7C7C`/`787878`, several almost-equal blues and
greens). `thin()` in `palettes.py` repeatedly takes the closest pair and drops
whichever of the two is closer to the rest of the set, until 32 are left. One
of each grey (`000000`, `7C7C7C`, `BCBCBC`, `FCFCFC`) is protected, because
photos lean on greys; without that, the light grey went first. Dropped:
`F8F8F8` `0078F8` `B8B8F8` `6888FC` `0000BC` `D8B8F8` `6844FC` `F8A4C0`
`F0D0B0` `A81000` `FCE0A8` `FCA044` `E45C10` `881400` `F8D878` `00B800`
`006800` `B8F8D8` `00A844` `005800` `00E8D8` `F8D8F8` `787878`.
Caveat: the source screenshot showed only the first 32 NES colours; the rest of
`NES_FULL` is the standard 2C02 list from memory (55 here, while the source
says 53), so a few of those may differ. Both skin tones (`F0D0B0`, `FCE0A8`)
were thinned out.

### Choosing the table size

Bin size, simulated with `sim_palette.py --lut YS CS` (share of blocks that
come out different from the exact search, IMG_0184 / IMG_0186; db16 measured
at 16 colours):

| Steps (Y, U/V) | Entries | Size | riso6 | db16 | endesga32 | nes |
|---|---|---|---|---|---|---|
| 8, 16 | 33×17×17 | ~9.5 KB | 12% / 8% | 14% / 14% | 23% / 17% | 16% / 15% |
| 8, 8 | 33×33×33 | ~36 KB | 8% / 6% | 10% / 11% | 16% / 13% | 8% / 11% |

Bins must be **centred on multiples of the step** (index = `(x + step/2) >>
shift`). The first try used plain `x >> shift`, which puts neutral grey
(U=V=128) on a bin edge and gave every grey a pink cast. With centred bins,
the 36 KB table is visually indistinguishable from the exact search; the
9.5 KB one shows slight colour shifts on large flat areas. **Chosen: 36 KB**
(33×33×33 = 35,937 entries). The previews use the same quantisation (`LUT` in
`palettes.py`), so they show exactly what the camera produces.

### Previews

Off-camera previews with [`tools/palette_preview.py`](../tools/palette_preview.py).
It shrinks each stock-firmware photo to the camera's output size (3:2,
1616×1080 → 640×428) and runs it through `sim_palette.py`. The v1 settings
reproduce the look of real camera photos, so the previews are trustworthy.

```
uv run --with numpy,pillow tools/palette_preview.py previews/palettes_v2 images/IMG_0184.jpg images/IMG_0185.jpg images/IMG_0186.jpg
```

- Swatches: [previews/palettes_v2/swatches.png](../previews/palettes_v2/swatches.png)
  (base colours big, mixes small)
- Contact sheets, original + all 8:
  [IMG_0184](../previews/palettes_v2/IMG_0184/sheet.png) (street, daylight),
  [IMG_0185](../previews/palettes_v2/IMG_0185/sheet.png) (balcony),
  [IMG_0186](../previews/palettes_v2/IMG_0186/sheet.png) (monstera, indoors)
- Full-size single results: `previews/palettes_v2/<photo>/<palette>.png`

Observations:

- The small palettes stay strongly stylised. riso6 and refreshing read best:
  a real dark colour plus a spread of mid-tones.
- harbour has no really dark colour (darkest Y = 65); its shadows come out as
  a flat dark plum (`#584056`, a mix of its red and blue). mid_century had the
  same problem until it got its dark teal and navy.
- With brightness counting double, hue matters less: green grass can go pink
  or red in riso6, since riso6 has no green.
- The big palettes (db16, endesga32, sweetie16, nes) look like a real photo in
  a retro palette: much more recognisable, softer than the small ones.
- Cutting the big palettes to 10 was tried and rejected. Picking the most
  different colours looked garish; picking the 10 that best reproduce 35 stock
  photos kept mostly greys and browns (grass turned brown). They need their
  full colour set.
- `sim_palette.py --sat` tries a chroma boost before matching. 160% makes
  grass a bit greener in the big palettes, but the effect is small; not used.

### Survey and EG variants (2026-10-16)

**Verdict on the 8 palettes** after ~230 real photos, sorted by tag with
`sort_images.py`: endesga32 best, db16 good (both realistic, a bit retro);
harbour and riso6 too dramatic but can stay; mid_century (a near-duotone
harbour), nes, refreshing and sweetie16 to be removed ("too grey and dull").

Measured on those photos: the liked palettes aren't the most colourful (db16
photos are the greyest of all, 57% near-grey pixels). What they have is a
colour of roughly the right hue for every hue in the scene, at several
lightnesses. refreshing and sweetie16 pull every hue into one blue-grey
family; harbour and riso6 have a few strong inks and no muted colours, so
photos posterise.

**EG is a full set, colour-graded** (OKLCH, measured): its neutrals are one
steady cool ramp (hue 260–295, chroma ~0.06 in the midtones, fading to pure
white), beside a warm skin/wood ramp (`#3E2731` → `#EAD4AA`, hue 26–83), four
greens, and red/yellow/cyan accents. db16's neutrals wander (violet, grey,
olive, steel, pink-beige, green-white `#DEEED6`): no consistent grade, which
is why its light areas can go green.

**Variants** (`grade.py`, sheets in `previews/palettes_v4/` on 8 plain photos
from `v003_smaller_image.bin`):

| Kind | Specs tried | Verdict |
|---|---|---|
| regrade: EG's tint swapped for another hue / strength | `eg:x0`, `eg:x2`, `eg:t200`, `eg:t300`, `eg:t60` | liked |
| split tone: shadows / highlights hue | `eg:t220/60`, `eg:t300/80`, `eg:t180/30`, `eg:t260/200`, `eg:t240:x1.5:sat115` | liked |
| thinned: colours dropped, neutral ramp and every family kept | `eg:d8r1`, `eg:d14r1`, `eg:d14r2`, `eg:d20r1`, `eg:d20r2` | not liked |
| regrade + thinned | `eg:t200:d14r1`, … | not liked |

Why: a regrade moves every colour by a smooth function of its lightness, so
the palette keeps full coverage and the whole photo shifts coherently, like a
film grade. Thinning leaves holes; nearest-colour matching then sends the
pixels in a hole to whatever is closest, often another hue (the tree turns
red, a white wall neon green when the greys went too). That's the same
"random mapping" that makes the small palettes feel too funky, and the same
failure as cutting the big palettes to 10 above. Lesson: **keep the set full,
change the grade.** Not yet on the camera.

### Film simulations × EG (2026-10-16)

A film simulation is a 3D LUT (every RGB → an RGB). Tried 39 of Pat David's
G'MIC HaldCLUTs ([gmic.eu/color_presets](https://gmic.eu/color_presets/),
colour negative + colour slide packs, unpacked in `film_luts/`, not committed:
licence unclear) with `film.py` / `film_sheet.py`, two ways (sheets in
`previews/films/`, also not committed, 150 MB):

- **film → EG:** film on the photo, then nearest EG colour (what a
  film-transformed camera table would do). Most of the film is lost: the
  neutrals snap back onto EG's own cool ramp, so walls stay EG-blue under
  every film; and where a film pushes colours far (Kodak Elite Xpro), they land
  in a hole of the palette and jump hue (green blotches on a grey wall).
- **EG → film:** nearest EG colour on the untouched photo, painted with
  film(that colour). The matching stays where EG works, and the film's grade
  shows in full on the neutrals (Polaroid 669: a cyan, faded wall; 690: pink).
  It is the regrade from above with a real film's curve instead of a tint
  curve. Cheapest on the camera too: `lut_fill` still matches against EG, and
  `CUR_PAL` points at a per-film table of 32 display colours (96 B per film),
  so the hook doesn't change.

Most stocks are subtle at 32 colours (the Fuji/Kodak negatives look alike);
the ones that clearly differ: `kodak_elite_100_xpro`, `polaroid_669`,
`polaroid_690`, `lomography_redscale_100`, the Kodachromes, `fuji_velvia_50`.

## Presets

A preset is a **match palette** (each block gets its nearest colour, as
before) and what the block is painted with: the same colour **as a film
simulation renders it** (a G'MIC HaldCLUT applied to the palette's colours),
or for BW a set of greys. Since `v015` there are three, and the center button
picks one (see [Preset mode](#preset-mode-center-button-and-display)):

| Code | Match palette (`palettes.py MATCH`) | Painted with |
|---|---|---|
| `EP6` | `E`: endesga32 + 3 greens (OKLCH L 0.40/0.53/0.67, C 0.09, hue 140; foliage was landing on its browns), minus `#FF0044`, `#FEE761`, `#2CE8F5` (used 0.0% on the plain photos): 32 colours | `polaroid_690` |
| `6FP` | `6`: riso6, overprint-expanded to 16 instead of 10 (calmer) | `fuji_provia_100_generic` |
| `BW` | `B`: greys at Y 0, 80, 128, 176, 255 | greys at Y 0, 64, 128, 191, 255 |

**BW.** Five greys one Bayer swing (−32..+28 on luma) apart, so every tone
dithers between two neighbours: the dithered greyscale look. It matches
against greys whose inner levels are moved out by 16, so the dither blend
maps input to output along a slight S-curve: shadows ~8 darker, highlights
~8 brighter, mids ~10% steeper. The camera's table compares luma in bins of
8, which makes 16 the smallest move that changes anything (8 changed
nothing). A true S needs more levels than five; the stronger steps (88, 96)
start crushing shadows.

**History.** `v014` had 12 presets: palettes `E`, `6`, `H` (harbour + a dark
`#011F2A`, expanded to 16) × films `AV` (`agfa_vista_200`), `FP`, `FV`
(`fuji_velvia_100_generic`), `P6`, picked at random per photo. H, AV and FV
were dropped on 2026-10-17 after looking at the camera's photos. Photos taken
with `v014` carry those tags, which `sort_images.py` no longer knows.

The greens are a compromise. The worst-matched foliage blocks cluster at
OKLCH chroma ~0.06, hue 119–131, but greens that muted steal beige too (a
beige owl and a cream lamp went olive): on these low-saturation photos beige
and olive are barely apart. Greener and stronger (hue 140, chroma 0.09), and
no light green, leaves the tree part green, part autumn orange, and beige
mostly beige.

**Firmware.** `lut_fill` takes the preset from `MODE` (or `pick` in the rnd
mode), looks up its match palette (`PRESET_MATCH`), fills the table from it
(at most 32 colours), then sets `CUR_PAL` to the preset's paint colours
(`DISPLAY_PTRS`): the same number of colours, index for index. The photo and
video hooks read colours through `CUR_PAL`, so they paint film colours with
no change, and `draw_tag` paints the tag in their darkest and lightest
colour. If the preset is the one the table already holds (and the table is
complete), `lut_fill` keeps it: with a fixed preset, only the first photo
after a change pays the ~50–70 ms fill before the capture. The data is in
the [preset data cave](#code-caves-and-hooks) (`0xbbc00`–`0xbbd9c` in
`v015`).

**Verified in the emulator:** `emu_cave.py` steps through every mode, a
repeated preset and rnd: the right preset each time, the table kept exactly
when the preset repeats (the fill's inner loop runs zero times), and every
block, tag included, equals the sim (0.00% differing). `emu_video.py` (rnd
mode): two recordings, a new preset for the second, 0.00% differing.

## The site's firmware editor

`site/editor/` (on godox.klve.nl) lets anyone fill 8 preset slots (palette,
S-curve, film, tag, display code) and tick 1–8 of them, turn rnd on or off, and sounds
on or off (stock, Mario or their own), previews them on photos, and builds
the firmware in the browser.

**S-curve and films.** A preset's paint colours are its colours through the
S-curve (a checkbox), then through its film (a dropdown); the camera only sees
the result, so neither costs anything on the camera. The S-curve is BW's tone
curve, luma through `BW_MATCH` -> `BW_LEVELS` (chroma kept): on BW's greys it
gives exactly `BW_LEVELS`, so BW is "greys + S-curve". It works on the paint
colours, after matching: the dither blends then follow the curve, and the
palette itself gets the contrast. (Before matching, on the photo, it would
keep the palette's colours pure and only change which get picked; that needs
a luma table in the photo and video hooks, about as fast as today's
contrast/brightness maths, but wasn't needed.) `films.js` repeats `film.py`'s
trilinear HaldCLUT lookup step for step (float32 where numpy has float32,
round half to even), and gives exactly `film_colours.py` for EP6 and 6FP.
`editor_data.py FILMS` picks the 12 films the editor offers (copied from
`film_luts/` to `site/editor/films/`, ~200 KB each, loaded when chosen).

**Template, not assembler.** Everything the editor changes is data or an
immediate, so it patches one template build (`site/editor/v021_editor_template.bin`,
checked against its sha256) instead of assembling:

- The preset data cave has a fixed layout (`palettes.py PD`): each table is
  padded to room for `MAX_PRESETS` = 8 of `NMAX` = 32 colours (0xbbc00–
  0xbc2f8), and `LCD_TAGS` to 9 entries. The caves already walk the match
  palettes by their counts and the paint colours by pointer, so only the
  labels had to stop moving. Since then every build uses this layout (one
  match palette per preset, no sharing).
- `NPAL` is an immediate in six instructions (`npal_*` labels in
  `photo_cave.s` and `lcd_cave.s`; ARM immediates under 256 are the
  instruction's low byte). `last_center` holds `NPAL - 1 + RND_MODE`, where
  the center button wraps: with rnd off it skips the rnd mode. A saved mode
  the build doesn't have (e.g. from a build with more presets) already
  counts as the first preset.
- Sounds: the speaker's three amp-on calls (on, or NOPs when silent, as
  `SILENT=1`) and the CAMERA, POWERON_AUDIO and CLICK slots, written as
  `patch_res.py` does (0xFF padding; silent = the WAV with its data zeroed).
  The template is silent, so with sounds on the editor also puts the
  factory's CLICK slot back, byte for byte (`sounds/stock_click.wav`).

`site/editor/template.json` lists every offset, read from the assembled caves
by `editor_data.py`. `firmware.js` is the patcher (no DOM, runs in Node),
`sim.js` the preview (the camera's table and Bayer, as `sim_palette.py`, and
the other [dithering algorithms](#dithering-algorithms) from `dithers.js`),
`editor.js` the UI (state in localStorage).

**Verified (2026-10-18):** `editor_check.sh` (16 random configs: 1–8 presets
of 1–32 colours, random tags and segments, rnd and sounds on/off, random and
stock WAVs) gives byte-identical files from the editor and `build.sh`; so did
two downloads from the page itself (7 presets and an uploaded sound; 5
presets, one with an edited palette through Kodachrome 64). The emulator
tests pass on the default template, on 8 presets of up to 32 colours and on
the downloaded config. With one preset rnd can only repeat it, so the editor
offers rnd from two presets on.

### Dithering algorithms

**Planned, not on the camera yet** (2026-10-18, branch
`dithering-algorithms`; tentative, to come back to): the dithering becomes a
setting of its own, next to the palette, for all palettes alike. The editor
previews all of them (`dithers.js`, `sim.js`); the firmware still does Bayer
4x4 only, and an editor download ignores the dithering choice.

- **Buttons, remapped:** left arrow cycles the dithering (the ones the editor
  turned on, then random if on), center cycles the aspect ratio, right arrow
  cycles the palette (today the center button does that, and the arrows the
  aspect, -1/+1).
- **Display:** the dithering on the two ISO digits (bottom left), the palette
  on the SS digits as now. The ISO readout has only two real digits: its
  "third and fourth" are the fixed `0` segments `03.0` and `05.0` (plus the
  `ISO` label `00.0`/`02.0`), all blank in photo and video mode, so ours. The
  F readout (2 digits, decimal point `09.2`, label `06.1`/`06.2`) is blank and
  free too. Segment wiring, found by running the digit routines for 0–9 in
  the emulator (as the SS cells were):

  | Cell | a | b | c | d | e | f | g |
  |---|---|---|---|---|---|---|---|
  | ISO 1 (`FUN_00049ea8`, args 0,1,2) | `01.0` | `02.1` | `02.2` | `01.2` | `00.2` | `00.1` | `01.1` |
  | ISO 2 (`FUN_00049ea8`, args 3,4,5) | `04.0` | `05.1` | `05.2` | `04.2` | `03.2` | `03.1` | `04.1` |
  | F 1 (`FUN_0004a4ec`) | `07.0` | `08.0` | `09.1` | `08.2` | `07.2` | `07.1` | `08.1` |
  | F 2 (`FUN_0004a074`, args 9,a,b) | `0a.0` | `0b.0` | `0b.1` | `0b.2` | `0a.2` | `09.0` | `0a.1` |

  Addresses `0x00`–`0x05` hold only the ISO segments, so the ISO code can be
  written as six whole nibbles, as `lcd_hook` does for SS. Random shows `rn`.
- **Photo tag:** the dithering's two-letter code, one font cell left of the
  palette's tag (outline to outline). The camera's palette tags are drawn
  right-aligned in a 13-cell field, so `draw_tag` needs each tag's real width
  (a byte per palette) to place it. Two extra glyphs (`≡`, `/`) beyond the tag
  font.
- **Editor:** a Dithering section above Palettes: a card per dithering (its
  threshold map, error-diffusion kernel or curve; photo tag; display code),
  each on or off, plus Random (only on or off). The selected one is
  previewed. Defaults: Bayer 4x4, Colour Bayer 4x4, Floyd–Steinberg, Atkinson
  and random. The preview can show all nine photos or one large with a strip.

**Open decisions** (nothing settled yet):

- Which to keep: 16 is too many to cycle with one button.
- The codes, e.g. whether `≡≡` and `//` read well enough (`//` is only a rough
  slash on 7 segments).
- Fixed order, or reorderable as the palettes are; the camera starts on the
  first one that's on.
- Blue noise 16x16 (repeats every 32 px) or 32x32 (1 KB).
- Error diffusion on video: fall back to Bayer 4x4 (proposed below), or not
  offer those at all.

**Next steps** before any firmware: measure the photo strip deadline (a
diagnostic build padding the hook with a growing busy loop, until the bottom
of the photo turns to noise; the left arrow could step through the delays in
one build), and assemble Floyd–Steinberg and count it in the emulator
(`emu_cave.py`), to check the estimates below; then find code space (below).

They all work on the camera's 2x2 blocks, as the Bayer does.

| Algorithm | Code | Kind | ~instr/block | Photo | Video |
|---|---|---|---|---|---|
| None, Bayer 2x2 / 4x4 / 8x8, Lines, Diagonal, Blue noise (16x16) | `--` `B2` `B4` `B8` `≡≡` `//` `BN` | threshold map: luma offset, -32 up | 66 (as now) | yes | yes |
| Colour Bayer 4x4 / 8x8, Colour blue noise | `C4` `C8` `CN` | colour mix | ~70 | yes | yes |
| Sierra Lite | `SL` | error diffusion | ~100 | yes | maybe; shimmers |
| Floyd–Steinberg, Atkinson | `FS` `AT` | error diffusion | ~115 | yes | unlikely; shimmers |
| Riemersma | `RI` | error diffusion along a Hilbert curve | ~125 | yes (just) | no |
| Jarvis–Judice–Ninke | `JN` | error diffusion, 3 rows | ~190 | unknown: past what's proven | no |
| Even toned | `ET` | error diffusion + distance feedback | ~190 | unknown: past what's proven | no |

**Feasibility (2026-10-18, estimates).** Instruction counts per 2x2 block
are estimated from the current loop (66, counted in the emulator) plus each
algorithm's extra work, written as tight ARM as we'd write it (errors as int16
row buffers, the right neighbour's error in a register, the match colour
loaded for the error). Not yet assembled or counted. The budgets:

- *Photo* (interrupt, per-strip deadline, real limit unmeasured): the v1
  effect ran 147 instructions per block at 640 wide (`v008`) and worked: ~1.5M
  per 64-row strip, so **~134 per block at 704 wide** is proven. Beyond that
  is unknown until measured: a diagnostic build that pads the hook with a
  growing busy loop (until the bottom of the photo turns to noise) would find
  the real deadline. JJN and Even toned need that first.
- *Video* (camera task, 33.3 ms per frame, ≤ ~79k blocks per frame at the
  `v020` sizes): the most proven is 640x640 at 65% of the frame (6.8M
  instructions), **~86 per block**; the ceiling is perhaps ~118 (~90% of the
  frame), unproven, and the repeated-frames issue suggests the margin isn't
  free. Optimising the base loop (word loads/stores, fewer branches) could win
  maybe 15–20 per block for everything.
- *Video also argues against error diffusion regardless of time:* its grain
  moves every frame, which shimmers, and makes the H.264 stream much harder to
  compress, while dithered video's bitrate is already the
  [suspected cause](#timing-and-headroom) of the repeated frames. An ordered
  dither stays put wherever the scene does. So: video uses the chosen dither
  when it's a threshold map or colour mix, and falls back to Bayer 4x4 otherwise; the video tag shows what it used.
- *Colour mix tables:* the fill also finds the 6 nearest colours and tries 15
  pairs per bin (with each pair's 1/|a-b|² precomputed, no division): roughly
  40M instructions, **~130 ms** instead of 50–70 ms, only when the palette or
  the kind of table changes. 72 KB instead of 36 KB from `pvPortMalloc`
  (whether the heap has it is untested). Video: the first strip's fill drops a
  few more frames at the start of a recording.
- *Code space* is the other limit: about 600 B free in each of the photo,
  video and display caves. The maps are data (4–256 B each, ~420 B all
  together), but every error-diffusion loop is a few hundred bytes, and today
  the photo and video hooks each have their own copy of the loop. Doing more
  than the maps and colour mix needs one shared strip routine (photo and
  video strips have the same layout) and more dead code found (candidates:
  the TFT driver and the OSD compositor, see
  [What the old notes got wrong](#ui-graphics-gpzp-logos-and-the-osd-overlay)).
- Error rows carry across strips: photo strips arrive in order, video strips
  top to bottom per frame (from a pool, but in order), so a few KB of row
  buffers is all it takes. Riemersma's Hilbert curve runs through 32x32-block
  tiles, one strip high.

- **Threshold maps.** The camera's own kind: the block's luma plus the map's
  offset at its spot, then the table. Offsets run from -32 up in 64/n steps
  for n levels, so Bayer 4x4 is exactly `(B - 8) * 4`. Maps are at most 32
  rows, so they tile the 32-block (64-row) strips without seams.
- **Colour mix** (palette-aware ordered dithering, a cheap
  [Yliluoma](https://bisqwit.iki.fi/story/howto/dither/jy/)): the plain kind
  only dithers light against dark, so a hue between two palette colours turns
  into grey or brown speckle. Here every table bin holds a pair of match
  colours a, b and the share t of b whose mix comes closest to the bin's
  colour, counting the mix's grain t(1-t)|a-b|² against it (x 0.08), so
  far-apart colours only mix when nothing nearer does; only pairs among the
  6 nearest colours are tried. A block gets b where the map's threshold is
  under t, else a. Clearly better with small palettes (6FP keeps its pinks
  and greens); with BW a little flatter than the plain Bayer, as BW's greys
  were made one Bayer step apart. Camera: a, b, t in 2 bytes per bin (72 KB
  instead of 36 KB), a longer table fill; per block the same work.
- **Error diffusion** (all in Y, U and V, the error against the match colour
  the block got): Floyd–Steinberg (7 3 5 1 /16), Sierra Lite (2 1 1 /4,
  the cheapest: 3 neighbours), Jarvis–Judice–Ninke (12 neighbours over 3 rows,
  /48: smoother, less wormy, ~3x FS's work), Atkinson (6 neighbours x 1/8,
  only 3/4 of the error passed on: the classic Mac look, more contrast).
  (Sierra, 3 rows /32, was dropped: too close to Sierra Lite for its cost.)
  The most faithful colours of all. On the camera: rows top to bottom as the
  strips arrive, with the error rows carried from strip to strip; photos
  should be fine, but the per-strip time (now ~2.2 ms) has to be measured
  against the strip deadline. Video: it shimmers (no fixed pattern, so the
  grain moves every frame) and there is
  [headroom](#timing-and-headroom) for maybe 2x the work at 16:9 and 1.5x at
  1:1: FS / Sierra Lite might fit, JJN not.
- **Even toned:** after Raph Levien's
  [Even Toned Screening](https://levien.com/artofcode/eventone/) (his page
  gives no formulas; this is the idea, tuned by eye): Floyd–Steinberg, but
  each block also knows how far the nearest earlier "dark dot" and "light
  dot" are (an offset vector per column, from the left neighbour and the row
  above), and leans darker by 5 luma per block of distance to the last dark
  dot minus the distance to the last light one (capped at 8). The error is
  still against the unbiased colour, so the tone stays. A dot is a block that
  came out darker / lighter than its own nearest palette colour, i.e. the
  minority between two palette colours (taking any block darker / lighter
  than asked made it identical to FS: with 5 greys almost every block is).
  Subtle by design: sparse dots in highlights and shadows space evenly
  instead of forming FS's worms.
- **Riemersma:** error diffusion along a Hilbert curve; each block gets the
  last 16 errors, weighted 1 (oldest) to 16 (newest), over 16. No directional
  artefacts. The textbook version runs one curve over the whole image; the
  camera only sees 32-block strips, so the curve runs through 32x32-block
  tiles, left to right, carrying the history from tile to tile (the preview
  does the same).

**Honourable mention: Teddy-Beau** (diid's "Untitled",
[cada.art](https://www.cada.art/columns/untitled), source
[gen.js](https://untitled.cada.art/gen.js), CC0). Reimplemented in
`tools/teddy_beau.mjs`, for use elsewhere; not on the camera.

- *How it works:* blur a little; make 9 versions of the photo: the grey at
  exposures 0, +0.1, -0.1 (`px + px * e`), and 6 channel mixes (one channel at
  1 - 2d, the other two at d, d = 0.1 and 0.3); dither each with diid's
  clustered 8x8 pattern of 18 levels (after stretching its min..max to the
  full range), which repeats recognisable little motifs; then fuse them one
  by one: per pixel keep the version whose dithered result has the most
  local contrast (absolute 9x9 Laplacian of Gaussian, centre -10) times its
  well-exposedness (a Gaussian around mid grey, sd 0.2). Two tones out
  (gen.js: light blue `#7e8ffa` on `#2f2f2f`). Strong edges, details kept,
  the patterns as texture; few true mid-tones. (gen.js's grey is the blue
  channel; ours is the luma.)
- *Colour version* (ours): the two-tone result as a nudge instead of the
  answer: luma +28 where it's light, -32 where it's dark, then the nearest
  palette colour, as the threshold maps do. The palette keeps the colours,
  Teddy-Beau's motifs and edges come through as texture. Good with 6FP.
- *Why not on the camera:* it needs the whole frame before the first strip
  goes out (the min..max stretch, the 9x9 window across strip edges, 20
  fuse passes over 9 versions), and photos pass through in 32-row strips under
  a per-strip deadline. On the camera that would take a two-pass capture
  (keep the whole frame, then write), and likely seconds of work per photo (~150 ms
  in a desktop browser at 304x228 blocks, at least 10x that on the camera). Video: no.

## Video

Stock video: H.264 High@4.1, 1920×1080, ~28 fps, ~9 Mbit/s, 16 kHz mono PCM,
in a QuickTime `.mov` named `IMG_xxxx.mov` (the `MOVA%04d.avi` strings in the
firmware are leftovers).

### Small video

The same `FUN_0000f004` sizes video (`APMode 0x101`). The video setting
(`FUN_00023888`) dispatches through its own jump table at `0xf0a0` (`ldrls` at
`0xf098`) and **follows the camera's aspect setting**. Native entries: 0/1/9 =
1920×1080, 2 = 1616×1080, 3 = 1440×1080, 4 = 1024², 5 = 1344×1080, 6 =
816×1080, 7 = 320×240, 11 = 3840×2160, 12 = 2560×1440, 15 = 2592×1944, others
1280×720. Every stock video size has C = S = T (so the native small sizes would
crop, not scale).

**Video differs from photo:** photos need S = C (full size) with only T small,
because the final scaler shrinks. For video that gives garbage: video needs
S = T (the first scaler shrinks; there is no final downscale stage).

`SMALLVID=1` points entries 0/1/9 (16:9), 2 (3:2), 3 (4:3) and 4 (1:1) at
`vid169`/`vid32`/`vid43`/`vid11`: C = native crop for the aspect, S = T = 640
wide, mode 3, rejoining the video branch at `0xf410` (which expects T in
r6/r7). They share `size_common` with the photo stubs, which tells photo and
video apart by `APMode` bit 1. The H.264 setup (`FUN_00010090`) has its own
buffer sizing for widths ≤ 1280.

Test log:

- IMG_0293 (3:2) — 1616×1080: only the 16:9 entries were patched, so the stub
  never ran.
- IMG_0294 (3:2) — S = C = 1616×1080, T = 640×428: H.264 accepts 640×428, but
  the picture is garbage horizontal bands and frames come in bursts of 2–3
  (1 ms apart, every ~40 ms): the encoder is fed data of another shape.
- IMG_0295 (3:2) — C = 1616×1080, S = T = 640×428: **works**. Found with one
  flash that ran four independent experiments, one per aspect setting.
- IMG_0300–0303 — all four aspects (640×360/428/480/640), ~30 fps. Field of
  view matches photos of the same scene (IMG_0304–0307): the laptop measures
  ~850 sensor px wide in all four, so each is its aspect's native crop scaled
  down, not cropped further.

### Frame hook and strip format

- **Handoff:** `FUN_00018d14(venc, timestamp)` hands video to the H.264
  encoder, from the camera task (`FUN_00019568`), not an interrupt. It runs
  **once per 64-row strip**, not per frame.
- **`venc` = `0x131490`:** `[0]` = 1 on the front-camera path; `+0x101` =
  format (`'#'` = 0x23 for video); `[2]` = this strip's buffer, tagged
  `| 0x30000000` (`0x50000000` = none; `FUN_00047228` strips the tag with
  `& 0xcfffffff`); `+0xdc`/`+0xe0` = width/height; `+0xc8` = strips per frame
  (`ceil(H/64)`: 6, 7, 8, 10 for 360/428/480/640 rows); `+0xec` = that minus
  one.
- **Strip buffers:** a pool of 20 at `0x303e9a00 + k × 0xF000` (61440 =
  640 × 64 × 1.5 bytes), used in no fixed order. A frame's last strip is
  partial (40/44/32/64 valid rows) but still a full 64-row buffer.
- **Layout:** within a strip, exactly the photo strip layout above. The
  date-stamp routine had already hinted at it: just before the encoder call,
  `FUN_00010e90(strip, 0x21, …)` → `FUN_00010544` draws the date stamp, and
  its `'#'` branch addresses luma as `row × 1.5W + x` (even rows) and
  `+ W/2` (odd rows).
- **Frames:** the timestamp argument is the same for every strip of a frame
  and strips arrive top to bottom, so a new timestamp marks a frame's top
  strip.

How this was found (each a separate flash, `VIDDIAG`, since replaced; the
barcode version is in commit `ebfafdd`):

1. **Test card** (IMG_0309–0312): a luma gradient plus colour bars, written as
   if the buffer were a whole frame. Colours and gradient came out exactly
   right (so the per-row layout and U/V order are right), but every row of the
   output carried the gradient, and the bars appeared in 64-row blocks: the
   buffer is one strip, and the extra rows had landed in neighbouring pool
   buffers.
2. **Barcode** (IMG_0314–0317): the hook wrote 8 lines of 32 black/white cells
   with runtime values (marker `0xA5A5F00F`, call counter, buffer address,
   xTickCount, the timestamp argument, `venc+0xc8`, `+0xec`, `+0x164`) into
   each strip. The
   counter rose by one per strip within a frame, which settled the per-strip
   calls, the buffer pool, and the meaning of `+0xc8`/`+0xec`.

### Palette dithering on video

`tools/patches/video_cave.s` (`VIDFX=1`) runs the photo hook's per-block work
on every 64-row strip: 2×2 luma average, `CONTRAST`/`BRIGHT`, 4×4 Bayer, table
lookup, paint the block. Strips start on 64-row boundaries, so the Bayer phase
lines up across strips. It shares the photo cave's palettes, table and memory,
through two subroutines in the photo cave:

- `lut_fill` on the first strip of each recording (≥ 500 ms since the
  previous strip): every video gets a new random palette (never the same twice
  in a row, across photos and videos);
- `draw_tag` on the first strip of each frame (new timestamp), so every frame
  carries the palette tag, top right (confirmed on IMG_0322–0325).

The hook only writes a strip if it is on the front-camera path, in format
`'#'`, 640 wide, with a valid buffer, so stock full-size video (`SMALLVID=0`)
is left alone.

`tools/emu_video.py` checks it in Unicorn against `sim_palette.py`: 0.00%
blocks differing, the tag on exactly the first strip of each frame, table
reuse within a recording (one allocation), a new palette per recording, the
timing bar, and registers restored with `r3 = venc[0]` on return to `0x18d18`.

### Timing and headroom

Measured on the camera (IMG_0318–0321, `VIDTIMING=1`: each strip draws its
hook time as a bar, 16 px per ms of xTickCount, over a 16 ms scale):

| aspect | strips | hook per strip | hook per frame | of the 33.3 ms frame | free |
|---|---|---|---|---|---|
| 16:9 | 6 | 2.17 ms | 13.0 ms | 39% | ~60% |
| 3:2 | 7 | 2.16 ms | 15.0 ms | 45% | ~55% |
| 4:3 | 8 | 2.15 ms | 17.2 ms | 52% | ~48% |
| 1:1 | 10 | 2.17 ms | 21.5 ms | 65% | ~35% |

- xTickCount has 1 ms resolution: strips read 2 or 3 ms; the mean is what
  counts. All four clips record at ~30 fps.
- The emulator counts **~681k instructions per strip** (~66 per block); the
  camera does that in ~2.2 ms, so **~310 M instructions/s**.
- **At the `v020` sizes** (estimated: `emu_video.py` counts instructions per
  strip at each width, ~310 M instructions/s, strips per frame = height / 64
  rounded up; it gives 46% for the unchanged 3:2, against 45% measured):

  | aspect | size | strips | per strip | per frame | of the frame |
  |---|---|---|---|---|---|
  | 16:9 | 704×396 | 7 | 0.75 M (~2.4 ms) | ~16.9 ms | 51% |
  | 3:2 | 640×428 | 7 | 0.68 M (~2.2 ms) | ~15.4 ms | 46% |
  | 4:3 | 608×456 | 8 | 0.65 M (~2.1 ms) | ~16.7 ms | 50% |
  | 1:1 | 528×528 | 9 | 0.56 M (~1.8 ms) | ~16.3 ms | 49% |

  All below 1:1 at 640×640 (65%), which works.
- **Headroom (640 wide):** the per-strip work could roughly **double at 16:9** and still
  fit 30 fps, and grow by **~50% at 1:1**. The loop is still the
  straightforward byte-by-byte version (byte loads/stores, a branchy chroma
  address), so there is more to gain by optimising if needed.
- The first strip of a recording also builds the table (~7.4M instructions for
  riso6, ~24 ms): it maxes out the 16 ms bar and costs a frame or two at the
  start.
- Before the effect, the (deliberately slow) barcode diagnostic took ~7–8 ms
  per strip, and the encoder then repeated frames (15 unique of 44 at 1:1):
  that is what going over budget looks like.

**Open issue: repeated frames.** Many dithered clips repeat about one frame in
nine: IMG_0319 (3:2) and IMG_0321 (1:1), 22 of ~190 each; IMG_0324 (4:3) 24
of 213; IMG_0325 (1:1) 16 of 139. IMG_0323 (3:2) instead has one stall of
~0.4 s (frames 114–124 repeated). IMG_0318, IMG_0320 and IMG_0322, like the
stock small video, repeat only frames 9 and 18 at the start. It isn't the
hook: it never took more than 3 ms, and the same aspect ratio shows the
problem in one clip and not the next. A likely cause is the bitrate:
dithered video is hard to compress, 5–10 Mbit/s instead of ~1 Mbit/s
(keyframes up to ~100 KB), so the encoder output and file writer have far
more to move. Not proven: stock 1080p writes ~9 Mbit/s without trouble.

## Sounds

- Shutter (`CAMERA.wav`) and power-on (`POWERON_AUDIO.wav`): custom clips (the
  Super Mario kick and coin), or silent with `SILENT=1`.
- UI/focus beep (`BEEP.wav`): always silenced.
- Mode-switch sound = `CLICK.wav` (sound slot 0). The mode switch handlers
  (`------mode N------` at 0x1dc0c etc.) post message `0x7018` together with
  `MSG_APQ_MODE_TO_*`; the state loops answer `0x7018` with `FUN_00022a80(0)`,
  which plays `CLICK.WAV` if the key-tone setting (config byte +0x19) is on.
  Silenced with `SILENT=1`.
- Sound player `FUN_00022a80(slot)`: 0=CLICK, 1=CAMERA, 2/3=POWERON_AUDIO,
  4=unused handle, 5=BEEP. It turns the **speaker amp (GPIO 0x2c)** on, waits
  100 ms, then queues the WAV to the audio task. The amp is switched off by the
  peripheral task `FUN_00021e60` on message `0x6002` (posted every ~1 s): the
  first tick after a sound arms a counter, the second prints `@@@CLOSE SPEAKER`
  and drives GPIO 0x2c low. That is the ~1–2 s of hiss after every sound, even
  a silent one. Boot (`state_startup_init`, 0x350f0) also turns the amp on
  unconditionally.
- `SILENT=1` NOPs the three amp-on calls (0x22b38, 0x350f0, 0x2ed50), so the
  amp is never powered: no sounds and no hiss.

## Look knobs (contrast / brightness)

`build.sh` applies an optional per-block brightness pre-map before palette
matching (hue/colour mapping is untouched), to photos and videos alike, as
assemble-time constants so there is no runtime division:

- `CONTRAST` — percent, 100 = neutral. Higher (≈115–140) is more dramatic
  (pushes midtones to the palette's dark/bright ends, good for flat/dim
  scenes); lower (≈70–90) is softer. Useful range ~70–160.
- `BRIGHT` — luma offset, 0 = neutral; positive lifts, negative darkens
  (≈ −60…60).

e.g. `CONTRAST=130 BRIGHT=10 SILENT=1 sh tools/build.sh`.

## UI graphics (GPZP, logos, and the OSD overlay)

The firmware carries pixel graphics for a 320×240 TFT (below), but the C100's
own see-through display is a segment panel; see
[The transparent display](#the-transparent-display-a-segment-panel-ht1621).

### GPZP images (menu/status assets) — editable

`.gpzp` resources are `GPZP` magic + raw fixed-Huffman DEFLATE of **RGB565**
(little-endian, 2 B/px). `0x8C71` is the transparency key (the live LCD shows
through). The LCD is **320×240**. `tools/gpzp.py` decodes/encodes these:

```
gpzp.py decode IN.gpzp OUT.png [WIDTH]     # WIDTH auto-detected if omitted
gpzp.py encode IN.png  OUT.gpzp            # width/height from the PNG
gpzp.py decode-all FIRMWARE.BIN OUTDIR     # every GPZP -> PNG
```

Round-trip is pixel-exact and re-encodes smaller than the slot (fixed Huffman).
To change one: edit the PNG (same size; alpha-0 = transparent), `encode`, then
`patch_res.py` it in (size-checked). Decoded PNGs are in `gpzp/decoded/`.
Confirmed widths: BACKGROUND 320×240, TFT_WIFI_SYM 320×240, SELECTBAR_LONG
296×40. The small bars / SP_ICON sheet have ambiguous widths (colours are always
right; only the row-wrap may be off) — pin them from their draw calls if needed.

### Power logos — editable, and unused

`POWER_ON_LOGO.jpg` is a **beach photo** and `POWER_OFF_LOGO.jpg` is **"Good
Bye!"** — plain JPEGs, left over from the OEM/children's-camera software this
firmware descends from (like `WIFI.xml`). They are standard JPEGs: replace with
a 320×240 baseline JPEG that fits the slot via `patch_res.py`.

### The transparent display: a segment panel (HT1621)

The see-through display is a **segment display**: a fixed set of printed
shapes (the GODOX logo, the brackets, 7-segment digits, the icons), each
switched dark or clear. Technically it is a segment LCD with no backlight or
reflector, which is why you can see through it. It has no pixels. The code
draws nothing; it switches segments on and off through an
**HT1621**-compatible controller, bit-banged over GPIO.

Everything below was **confirmed in the emulator** (`tools/emu_seg.py` runs
the factory code, hooks the GPIO writes and decodes the HT1621 bitstream; see
the end of this section). Only the meaning of a few icon segments is still an
inference.

- **Pins:** GPIO `0x28` = CS, `0x29` = WR (clock), `0x2a` = DATA (`0x5f` is
  switched on with them; probably the panel's supply).
- **Protocol** (`FUN_00049dc0` sends n bits, MSB first):
  - command: `100` + 8 bits + 1 (`FUN_0004a01c`)
  - write: `101` + 6-bit address + 4 data bits (`0x49e34`, which Ghidra names
    `switchD_0004a0b8::default`; it is really `seg_write(addr, nibble)`).
- **Init** `FUN_0004ad68` (called by the display task at `0xe0dc`): commands
  `01 18 24 03` (SYS EN, RC 256K, BIAS 1/2 with 3 COMs, LCD ON). Then it clears
  all 25 addresses and calls `0x4a64c(1)` (logo on).
- **RAM:** 25 addresses × 3 COMs = 75 segments. The firmware keeps a copy at
  `0x1240e0` (one byte per address). Below, `AA.c` = address `AA`, COM `c`
  (COM0 is nibble bit `8`, COM1 `4`, COM2 `2`; bit `1` is unused).
- **Ghidra gets this code wrong:** `0x4a64c`, `0x4a6e0`, `0x4a700`,
  `0x4a894`, `0x4a9fc` and `0x4aae0` are real entry points that Ghidra never
  made into functions. It stitched them into their callers through tail
  branches, so the decompiled `FUN_0001ff10`, `FUN_00020afc`,
  `FUN_00021318` … contain code that is really in `0x4a6xx`–`0x4adxx`.
  Re-run the analysis with functions defined there before trusting
  decompiled code in this range.

**Refresh:** `FUN_00021318`, called periodically from the peripheral task
(`FUN_00021c9c`). After boot it returns early for its first 4 calls (counter
`0x12170c`). From then on, every call redraws the ISO/F/SS readouts. Every
other call (counter `0x1217b0`) also redraws the mode icons and logo
(`FUN_0001fe58`), the brackets (`FUN_0004a7f4`) and the battery
(`FUN_0002122c`).

**UI state** `0x121706` (set by the mode keys/switch, `FUN_0001e4f8`,
`FUN_0001e5a8`, `FUN_0001e658`) decides what is shown:

| State | Shown | Probably |
|---|---|---|
| 0 | bracket for the current aspect, `16.0`, `16.2`, battery; readouts blank | photo |
| 1 | bracket, `14.0` (blinks while recording, with the LED on GPIO `0x2b`), `16.2`, battery; readouts blank | video |
| 2 | ISO/F/SS readouts, `16.2`, `18.0`, battery; **no bracket** | light-meter readout (your second photo) |

**Boot, replayed in the emulator** (UI state 2, ISO 200, F5.6, SS 1/25),
matching the startup photo:

| Refresh call | Panel |
|---|---|
| (init) | logo only |
| 1–4 | logo only (refresh returns early) |
| 5 | logo + ISO 200 / F5.6 / SS 1/25 readouts, no icons or battery yet |
| 6 on | logo off (`FUN_0001fe58` → `FUN_0004a670` clears `16.1`), icons and battery on |

The logo stays on only if sensor preview init failed (flag `0xf187e`, set in
`FUN_0001109c`): then `FUN_0004a670` puts the logo back instead of clearing
it.

**Segment map:**

| Segment | What | How confirmed |
|---|---|---|
| `16.1` | **GODOX logo** | only segment lit by init; cleared on the 6th refresh call |
| `06.0` | **16:9 bracket** | aspect setting 1 |
| `15.0` | **3:2 bracket** | aspect setting 2 |
| `15.1` | **4:3 bracket** | aspect setting 3 |
| `15.2` | **1:1 bracket** | aspect setting 4 (0 and ≥5 light nothing; state 2 lights none) |
| `00.1 00.2 01.0 01.1 01.2 02.1 02.2` | ISO digit 1 | 7-segment cell (`FUN_00049ea8`) |
| `03.1 03.2 04.0 04.1 04.2 05.1 05.2` | ISO digit 2 | 7-segment cell |
| `00.0`, `02.0` | ISO label / box | always on with the readout |
| `05.0`, `03.0` | fixed "0"s: ISO 400 = `4` `0` + `05.0`, ISO 1600 = `1` `6` + `03.0` + `05.0` | readout values |
| `07.0 07.1 07.2 08.0 08.1 08.2 09.1` | F digit 1 | 7-segment cell (`FUN_0004a4ec`) |
| `09.0 0a.0 0a.1 0a.2 0b.0 0b.1 0b.2` | F digit 2 | 7-segment cell (`FUN_0004a074`) |
| `06.1`, `06.2` | F label / box | always on with the readout |
| `09.2` | F decimal point (5.6, 2.8; off for 11) | readout values |
| `0d.0 0d.1 0d.2 0e.0 0e.1 0e.2 0f.2` | SS digit 1 | 7-segment cell (`FUN_0004a374`) |
| `0f.0 0f.1 10.0 10.1 10.2 11.1 11.2` | SS digit 2 | 7-segment cell (`FUN_0004a1f0`) |
| `11.0 12.0 12.1 12.2 13.0 13.1 13.2` | SS digit 3 | 7-segment cell (`FUN_0004a074`) |
| `0c.0`, `0c.1`, `0c.2` | "SS", "1/", box | always on with the readout |
| `14.2` | fixed trailing "0" for 1/1000 and faster (1/8000 = `8` `0` `0` + `14.2`) | readout values |
| `14.1` | on when the SS value comes from the table (flag `0x12170b`) | meaning unknown |
| `16.0` | camera icon (inferred) | state 0 only |
| `14.0` | video icon (inferred) | state 1 only, blinks while recording |
| `16.2`, `18.0` | metering icon and centre reticle, not yet told apart | `16.2` in every state, `18.0` in state 2 only |
| `18.2`, `17.x` | battery outline and bars (inferred) | `FUN_0002122c`, blinks at level 0 |

The readouts come from the light-meter tables: F 1.0–14 at `0xe327c`, SS 1 s–1/8000
at `0xe31e4` (floats), indexed by config bytes `0x132160+0xeb` / `+0xea`; ISO
from `+0xec`. `FUN_00020c44` rounds a metered shutter speed to that scale.

**Patch points:**

- **No logo at boot:** `0x4ae30` `mov r0,#1` → `mov r0,#0`.
- **Keep the logo on:** `FUN_0004a670` clears `16.1` itself (`and r1,r3,#251`
  at `0x4a694`, `biceq r1,r3,#12` at `0x4a698`), so set it back:
  `orrne r1,r1,#10` at `0x4a69c` → `#14`, and `orreq r1,r1,#2` at
  `0x4a6a0` → `#6`.
- **Brackets:** jump table at `0x4a828` (`ldrls pc` at `0x4a820`, index
  `aspect − 1`) → handlers `0x4a878` (16:9, `orr r3,r3,#8` on address 6),
  `0x4a884` / `0x4a86c` / `0x4a838` (3:2 / 4:3 / 1:1, `mov r2,#8/#4/#2` into
  address `0x15`). Each bracket set is a single segment, so brackets can be
  combined (e.g. `mov r2,#0xe`) but not reshaped. They are hidden in state 2
  by the `cmp r0,#0; bne` at `0x4a804`/`0x4a814`.
- Anything else: write the segment through `seg_write` (`0x49e34`) and keep
  the copy at `0x1240e0` in sync, since the firmware read-modify-writes from it.

`tools/emu_seg.py` (`uv run --with unicorn tools/emu_seg.py`) prints the init
commands, the logo and bracket segments, checks that every digit routine
draws 7-segment digits (segment counts 6,2,5,5,4,5,6,3,7,6), decodes full
refreshes back into ISO/F/SS readouts, and replays the boot sequence.

### Preset mode: center button and display

With `LCDTAG=1` (default), in photo and video mode the **center button**
cycles the preset mode `EP6` → `6FP` → `BW` → `rnd` → `EP6`, and the display
shows it. A chosen preset is used for every photo and recording until you
change it, also across power-off (see below). In `rnd` mode each
photo/recording gets a random preset (never the last one); the display just
shows `rnd`, and the photo's tag tells which one it got. The readout state
(UI state 2) is unchanged: there the center button still cycles ISO/F/SS.

**Remembering the mode** (since `v017`; `v015`/`v016` kept it in RAM and
started at `EP6`). The camera keeps its settings in a 0xF4-byte struct at
`0x132160`, followed by a 4-byte checksum (`FUN_00023f04`). Whenever its dirty
byte `+0xa0` is 1 (the readout state sets it when you change ISO/F/SS), the
firmware writes the whole struct to NVRAM (SPI flash) and reads it back to
verify: at power-off (`FUN_00024094`, "config_store_power_off") and on a
peripheral-task event (the same code in the switch near `0x22f50`). At boot
it loads the struct as a whole, and only if that fails resets it
(`FUN_0002371c` → `FUN_0002352c`: memset 0, factory items, forced fields).
The mode lives in **byte `0xf1`**: inside the checksummed, saved range, and
unused. No load/store instruction in the firmware uses offset `0xf1`–`0xf3`
with any base register, no literal points into the struct, the decompiled
code never touches it, and it sits after the last fields (`0xe9`–`0xf0`, the
light meter's) as padding before the checksum. `center_hook` writes it and
sets `+0xa0`; `lut_fill` and `lcd_hook` read it directly, so nothing needs
loading at boot. Any value other than 0..NPAL (e.g. fresh settings after a
reset are 0 anyway) counts as the first preset. A power cut without a proper
power-off can lose a mode change made since the last save.

**Buttons** (`FUN_0001f7e8` builds the key table, normal key mode): ADC keys
`ok` (`FUN_0001df64`, ADC 0x60e–0x73a), `F` (`FUN_0001dd6c`, 0x898–0x956)
and `T` (`FUN_0001de20`, 0x9d8–0xabe); GPIO keys `pw` (pin 0x47, held: power
off), mode 1/mode 2 (`FUN_0001dc08` / `FUN_0001ded4`, pins 0x26/0x27: the
photo/video/readout switch, `0x703e`/`0x703f`) and `IO_ISO` (`FUN_0001dcb8`,
pins 0x3b and 0x22, scanned for a level change). The handlers' names don't
say which button is which; the states do:

| Handler | Posts | Photo/video mode | Readout state | Button |
|---|---|---|---|---|
| `F_key` `FUN_0001dd6c` | `0x7018`, `0x7041` | ignored | cycles ISO/F/SS (`*0x372bc + 1`) | **center** |
| `IO_ISO` `FUN_0001dcb8` | `0x7018`, `0x7042` | aspect −1 (`FUN_000213e0(-1)`) | value −1 | arrow |
| `T_key` `FUN_0001de20` | `0x7018`, `0x7043` | aspect +1 | value +1 | arrow |

Each posts once per press (press count < 0x19, a latch at `0x1217bc` shared by
the three, cleared by the timer `FUN_0001fdc8`). `v015` went by the name
"ISO" and hooked `IO_ISO`, an arrow, so the mode never moved on the camera.
`emu_seg.py` now takes the expected message from the readout state's cycle
code (`*0x372bc + 1`), and fails on that build.

**Hooks** (`lcd_cave.s`):
- `center_hook`: `key_jump.s` redirects the `bl 0x42c` in `F_key` that posts
  `0x7041` (at `0x1ddf8`). In UI state 0/1 and not recording (`0x132abb` bit 1) it
  steps the mode byte (`0x132160 + 0xf1`) and sets the settings' dirty byte,
  then posts the message as before (it returns into the key handler).
- `lcd_hook`: the display refresh draws the readouts with `0x21180(flag)`
  (flag 1 in the readout state): ISO (`FUN_0001ff10`), F (`FUN_00020afc`),
  then a tail call `b 0x20fd0` (video icon and SS, r0 = flag) at `0x21218`,
  or at `0x21200` in the readout state while SS blinks. In photo/video mode
  each of these writes blanks on **every** tick, so the code is written after
  the SS routine: `lcd_jump.s` patches the tail call at `0x21218`; with
  r0 ≠ 0 (readout state) `lcd_hook` tail-calls the stock routine, otherwise
  it calls it, then writes the mode's 7 nibbles to HT1621 addresses
  `0x0d`–`0x13` (only the SS cells live there) through `seg_write`
  (`0x49e34`), sending only what changed (after the stock blanks, that is all
  of them, every tick; the blank in between is microseconds). The ISO
  readout has only two real 7-segment cells (its third and fourth digit are
  the fixed "0" segments `05.0` and `03.0`), which is why the code is on SS.
  (`v013` hooked `FUN_0001ff10` and showed two letters on the ISO cells.)
- **SS cells** (`palettes.py SS_CELLS`, found by running the SS digit
  routines for 0–9 in the emulator), each wired differently:

  | Cell | a | b | c | d | e | f | g |
  |---|---|---|---|---|---|---|---|
  | 1 (`FUN_0004a374`) | `0d.0` | `0e.0` | `0f.2` | `0e.2` | `0d.2` | `0d.1` | `0e.1` |
  | 2 (`FUN_0004a1f0`) | `0f.0` | `10.0` | `11.1` | `11.2` | `10.2` | `0f.1` | `10.1` |
  | 3 (`FUN_0004a074`) | `12.0` | `13.0` | `13.1` | `13.2` | `12.2` | `11.0` | `12.1` |

- **Glyphs** (`SEG7`, `LCD`): `EP6`, `6FP`, `rnd` as written (lowercase
  r, n, d); `BW` as `8` and a W over two mirrored cells: `cdef` (full left
  side, bottom, lower right) and `bcde` (lower left, bottom, full right
  side). `v015`/`v016` had `bcd` for the right half.

Verified in the emulator (`uv run --with unicorn tools/emu_seg.py
build/GP_CARDVR_UPGRADE.BIN`), against the factory firmware's refresh run
side by side:
1. With fresh settings the mode is `EP6`, and the display shows it.
2. Four center presses through the stock key handler (`F_key`), alternating
   photo and video mode, step through `6FP`, `BW`, `rnd` and back to `EP6`;
   each press still posts `0x7018` and the readout state's cycle message,
   and marks the settings to be saved; the display shows each mode; everything
   outside the SS cells is exactly as stock.
3. With a fixed preset, captures use it.
4. A mode byte that isn't a mode (`0x37`) shows and captures as `EP6`, and
   a press then goes to `6FP`.
5. A press while recording, or in the readout state, leaves the mode alone
   and doesn't mark the settings (and still posts the stock messages); the
   readout state is exactly as stock.

Not covered by the emulator: the actual save to NVRAM and the load at boot
(the analysis above). To check on the camera: pick `BW`, power off with the
power button, power on: the display should show `BW`.

**What the old notes got wrong.** The 320×240 TFT driver
(`tft_auo_a027dtn019_init`, panel descriptor at `0xd5c40`: 320×240, RGB565),
the 108-icon OSD compositor (`FUN_0000adb4`, icon table loaded from
`SP_ICON.GPZP` by `FUN_0005ee84`), the GPRS.pak glyph/string engine
(`FUN_000242fc`, `FUN_000259c8` …) and the parking-guide line drawer
(`FUN_0000d2e8`) are all generic OEM dashcam code. `SP_ICON` holds dashcam
icons (battery, WDR, ISO, LDW, …), `GPRS.pak` holds dashcam menu strings
("Loop recording", "Gsensor", "LDW" …), and none of it contains a Godox logo
or aspect brackets. None of it can reach the see-through panel, which is
driven only through the HT1621 pins. Whether the TFT code still runs at boot
(with no TFT attached) has not been checked; it does not matter for the
panel.

## History: the v1 effect

The path to the current effect, for context (backups v003–v008):

- 320×240 photos, then clean black and white, then Bayer-dithered black and
  white, then the first colour version, then 640 wide.
- **v1 colour:** per 2×2 block, average luma + Bayer, then the nearest of
  **6 palette colours** in Y+U+V (Manhattan, unweighted), searched with 6
  unrolled comparisons in the interrupt (147 instructions per block).
- **v1 palettes:** 7 palettes of 6 colours (riso6, dark sunset, vibrant
  summer, fiesta, vibrant nature, bold hues, refreshing). `idx_stub` advanced
  the palette once per photo, wrapping at 7; on the first strip after boot the
  hook seeded the index from sensor pixel noise, so the cycle started at a
  different palette each power-on.

v2 (2026-10-14) replaced all of this with the lookup table, the 8 larger
palettes, brightness-weighted matching and a random palette per photo (see
[Palettes](#palettes)).

## Ideas not yet done

- [Dithering as its own setting](#dithering-algorithms), with the buttons
  remapped: decide the set, measure the photo deadline, then the firmware.
- Find the cause of the repeated frames in some dithered videos (bitrate?).
- Speed up the per-block loop (word loads/stores, fewer branches), if a richer
  video effect needs the time.
- Persist the palette index across power cycles (needs a spot that survives
  reboot, e.g. a tiny file on the card).
- Per-pixel (rather than per-2×2-block) luma dithering for finer gradients.
- Run a segment test on the transparent display to confirm the
  [segment map](#the-transparent-display-a-segment-panel-ht1621), then play
  with it (e.g. a custom startup animation from the logo and bracket segments).

## Appendix: palette colours

Hex is for reference; the camera works on the Y, U, V bytes (JPEG/JFIF
full-range YCbCr). The v1 palettes' hex was converted back from their cave
bytes and converts back to exactly the same bytes. Some new hex codes are off
by one from the source (e.g. `#E7DCC9` → `#E7DCCA`) because they are rounded
to YCbCr bytes.

### riso6 (10 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#1A1B3A` | 30, 144, 125 | base |
| 1 | `#E0405A` | 115, 114, 206 | base |
| 2 | `#F19041` | 164, 72, 183 | base |
| 3 | `#2AA0A0` | 125, 148, 69 | base |
| 4 | `#F0E0BF` | 225, 109, 139 | base |
| 5 | `#FFFFFF` | 255, 128, 128 | base |
| 6 | `#8DC0AF` | 175, 128, 104 | mix of #2AA0A0 + #F0E0BF |
| 7 | `#7D2D4A` | 72, 129, 166 | mix of #1A1B3A + #E0405A |
| 8 | `#F0A0AD` | 185, 121, 167 | mix of #E0405A + #FFFFFF |
| 9 | `#235E6E` | 78, 146, 97 | mix of #1A1B3A + #2AA0A0 |

### refreshing (10 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#A7D2E5` | 199, 145, 105 | base |
| 1 | `#4992B2` | 128, 156, 89 | base |
| 2 | `#102A43` | 37, 145, 113 | base |
| 3 | `#F1C23E` | 193, 54, 162 | base |
| 4 | `#E8892B` | 155, 65, 183 | base |
| 5 | `#7C5A37` | 96, 105, 148 | mix of #102A43 + #E8892B |
| 6 | `#C7AD88` | 177, 105, 144 | mix of #A7D2E5 + #E8892B |
| 7 | `#2C5E79` | 82, 150, 101 | mix of #4992B2 + #102A43 |
| 8 | `#79B3CB` | 164, 150, 97 | mix of #A7D2E5 + #4992B2 |
| 9 | `#5B7E94` | 118, 145, 109 | mix of #A7D2E5 + #102A43 |

### mid_century (10 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#F87523` | 147, 65, 200 | base |
| 1 | `#FFC31B` | 194, 34, 172 | base |
| 2 | `#E7DCCA` | 221, 117, 135 | base |
| 3 | `#1DB7B9` | 137, 155, 51 | base |
| 4 | `#126D68` | 81, 141, 83 | base |
| 5 | `#093534` | 40, 135, 106 | base |
| 6 | `#1A1B3A` | 30, 144, 125 | base |
| 7 | `#81562C` | 94, 100, 153 | mix of #F87523 + #093634 |
| 8 | `#82C9C1` | 179, 136, 93 | mix of #E7DCC9 + #1DB7B9 |
| 9 | `#F4CF74` | 208, 76, 154 | mix of #FFC31B + #E7DCC9 |

### harbour (10 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#FBD0A6` | 216, 100, 153 | base |
| 1 | `#F37022` | 142, 67, 200 | base |
| 2 | `#B11016` | 65, 104, 208 | base |
| 3 | `#2ABB9E` | 140, 138, 58 | base |
| 4 | `#007096` | 83, 166, 69 | base |
| 5 | `#F6A065` | 179, 84, 176 | mix of #FBD0A6 + #F37022 |
| 6 | `#D3401E` | 104, 86, 204 | mix of #F37022 + #B11016 |
| 7 | `#D5705E` | 140, 102, 180 | mix of #FBD0A6 + #B11016 |
| 8 | `#16959B` | 112, 152, 64 | mix of #2ABA9E + #007096 |
| 9 | `#584056` | 74, 135, 138 | mix of #B11016 + #007096 |

### db16 (24 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#140B1C` | 16, 135, 131 | base |
| 1 | `#442334` | 47, 131, 143 | base |
| 2 | `#2F346C` | 57, 157, 121 | base |
| 3 | `#4F4A4E` | 76, 129, 130 | base |
| 4 | `#854C2F` | 90, 104, 159 | base |
| 5 | `#346524` | 79, 104, 109 | base |
| 6 | `#D04548` | 111, 106, 197 | base |
| 7 | `#747160` | 112, 119, 131 | base |
| 8 | `#587DCE` | 123, 175, 103 | base |
| 9 | `#D27D2C` | 141, 73, 177 | base |
| 10 | `#8595A2` | 146, 137, 119 | base |
| 11 | `#6DAA2B` | 137, 75, 108 | base |
| 12 | `#D1AA99` | 180, 113, 149 | base |
| 13 | `#6DC2C9` | 169, 146, 85 | base |
| 14 | `#DAD35E` | 200, 68, 141 | base |
| 15 | `#DEEDD6` | 230, 119, 122 | base |
| 16 | `#A6D8CF` | 200, 132, 104 | mix of #6DC2CA + #DEEED6 |
| 17 | `#9EAA62` | 158, 94, 128 | mix of #6DAA2C + #D2AA99 |
| 18 | `#AB7B64` | 135, 108, 154 | mix of #854C30 + #D2AA99 |
| 19 | `#6CB679` | 153, 110, 96 | mix of #6DAA2C + #6DC2CA |
| 20 | `#53648F` | 100, 152, 116 | mix of #4E4A4E + #597DCE |
| 21 | `#AC652D` | 116, 88, 168 | mix of #854C30 + #D27D2C |
| 22 | `#D5A843` | 170, 70, 159 | mix of #D27D2C + #DAD45E |
| 23 | `#DDE09B` | 215, 94, 132 | mix of #DAD45E + #DEEED6 |

### endesga32 (32 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#BE4B30` | 106, 95, 188 | base |
| 1 | `#D77643` | 141, 86, 181 | base |
| 2 | `#EAD5AA` | 214, 103, 142 | base |
| 3 | `#E4A673` | 179, 92, 163 | base |
| 4 | `#B86F4F` | 129, 100, 167 | base |
| 5 | `#733E3A` | 77, 117, 155 | base |
| 6 | `#3E2731` | 47, 129, 139 | base |
| 7 | `#A32634` | 77, 114, 189 | base |
| 8 | `#E53B44` | 111, 104, 212 | base |
| 9 | `#F77622` | 147, 64, 199 | base |
| 10 | `#FEAE35` | 184, 54, 178 | base |
| 11 | `#FEE861` | 223, 57, 150 | base |
| 12 | `#63C74D` | 155, 84, 88 | base |
| 13 | `#3E8948` | 107, 108, 96 | base |
| 14 | `#265C42` | 73, 124, 103 | base |
| 15 | `#193C3E` | 50, 135, 110 | base |
| 16 | `#124E8A` | 67, 168, 93 | base |
| 17 | `#0099DC` | 115, 187, 46 | base |
| 18 | `#2CE8F4` | 177, 166, 33 | base |
| 19 | `#FFFFFF` | 255, 128, 128 | base |
| 20 | `#C0CCDC` | 202, 138, 121 | base |
| 21 | `#8B9BB4` | 153, 143, 118 | base |
| 22 | `#5A6988` | 104, 146, 118 | base |
| 23 | `#3A4467` | 69, 147, 120 | base |
| 24 | `#252B43` | 44, 141, 123 | base |
| 25 | `#181425` | 23, 136, 129 | base |
| 26 | `#FF0044` | 84, 119, 250 | base |
| 27 | `#68386C` | 76, 146, 148 | base |
| 28 | `#B55088` | 117, 139, 174 | base |
| 29 | `#F6757A` | 156, 109, 192 | base |
| 30 | `#E8B796` | 194, 103, 155 | base |
| 31 | `#C28569` | 148, 104, 161 | base |

### sweetie16 (16 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#1A1C2B` | 29, 136, 126 | base |
| 1 | `#5D265D` | 61, 146, 151 | base |
| 2 | `#B23E53` | 99, 119, 184 | base |
| 3 | `#EF7D58` | 155, 90, 188 | base |
| 4 | `#FFCD76` | 210, 76, 160 | base |
| 5 | `#A8F070` | 204, 76, 102 | base |
| 6 | `#38B865` | 136, 108, 71 | base |
| 7 | `#247179` | 91, 145, 89 | base |
| 8 | `#2A3670` | 57, 159, 117 | base |
| 9 | `#3B5DC9` | 95, 188, 102 | base |
| 10 | `#41A6F6` | 145, 185, 71 | base |
| 11 | `#73EFF7` | 203, 153, 65 | base |
| 12 | `#F4F4F4` | 244, 128, 128 | base |
| 13 | `#95B0C3` | 170, 142, 113 | base |
| 14 | `#566B86` | 104, 145, 115 | base |
| 15 | `#323C57` | 60, 143, 121 | base |

### nes (32 colours)

| | Hex | Y, U, V | Source |
|---|---|---|---|
| 0 | `#000000` | 0, 128, 128 | base |
| 1 | `#FCFCFC` | 252, 128, 128 | base |
| 2 | `#BCBCBC` | 188, 128, 128 | base |
| 3 | `#7C7C7C` | 124, 128, 128 | base |
| 4 | `#A4E4FD` | 212, 151, 94 | base |
| 5 | `#3CBCFD` | 157, 182, 59 | base |
| 6 | `#0100FC` | 29, 254, 108 | base |
| 7 | `#0058F8` | 80, 223, 71 | base |
| 8 | `#9877F9` | 144, 187, 134 | base |
| 9 | `#4428BB` | 65, 197, 130 | base |
| 10 | `#F8B7F7` | 210, 149, 155 | base |
| 11 | `#F978F7` | 173, 170, 182 | base |
| 12 | `#D800CD` | 88, 194, 219 | base |
| 13 | `#930084` | 59, 169, 191 | base |
| 14 | `#F85898` | 143, 133, 203 | base |
| 15 | `#E40059` | 78, 134, 235 | base |
| 16 | `#A80021` | 54, 116, 209 | base |
| 17 | `#F97858` | 155, 90, 195 | base |
| 18 | `#F93801` | 107, 68, 229 | base |
| 19 | `#F8B800` | 182, 25, 175 | base |
| 20 | `#AC7C00` | 124, 58, 162 | base |
| 21 | `#503001` | 52, 99, 148 | base |
| 22 | `#D8F977` | 224, 69, 122 | base |
| 23 | `#B7F818` | 203, 27, 114 | base |
| 24 | `#007700` | 70, 88, 78 | base |
| 25 | `#B8F9B9` | 222, 107, 101 | base |
| 26 | `#59D855` | 163, 84, 75 | base |
| 27 | `#01A800` | 99, 72, 58 | base |
| 28 | `#58F898` | 189, 107, 56 | base |
| 29 | `#00FCFD` | 177, 171, 2 | base |
| 30 | `#008888` | 95, 151, 60 | base |
| 31 | `#004059` | 48, 151, 94 | base |
