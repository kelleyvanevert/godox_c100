#!/usr/bin/env python3
"""Off-camera replica of the photo_cave.s pixel hook, for trying palette ideas.

Mirrors the firmware: 4:2:0 2x2 blocks, block luma average, the preset's
luma map (contrast/brightness, clamped), 4x4 Bayer (+-32) on luma, Manhattan nearest colour in JFIF Y,U,V.
Extra knobs (not on the camera yet) are off by default, so the defaults
reproduce what the camera does today.

Usage (needs numpy + pillow; e.g. `uv run --with numpy,pillow tools/sim_palette.py ...`):
  sim_palette.py IN.jpg OUT.png PALETTE [--width 640] [--mix N] [--wy 1]
                 [--cdither 0] [--contrast 100] [--bright 0]
  PALETTE: a name from photo_cave.s (riso6, dark_sunset, ...)
  --mix N      add N "overprint" colours: midpoints of palette pairs, chosen
               greedily to fill the biggest gaps in the palette
  --how H      which pairs may mix: gap (any), vivid (no greying), shade (with
               the darkest colour only)
  --wy W       luma weight in the distance (W*|dY| + |dU| + |dV|)
  --cdither A  also dither U,V with Bayer amplitude A (luma uses 32)
  --sat S      chroma gain in percent before matching (100 = neutral)
  --lut YS CS  match via a lookup table on Y,U,V quantised to steps of 2^YS and
               2^CS, as the camera would; 3 4 = 33x17x17 entries (~9.5 KB)
"""
import argparse, os, re
import numpy as np
from PIL import Image

BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]])
CAVE = os.path.join(os.path.dirname(__file__), 'patches', 'photo_cave.s')


def load_palettes():
    pals = {}
    src = open(CAVE).read()
    for line in src[src.index('PALETTES:'):].splitlines():
        m = re.match(r'\s*\.byte\s+([\d,\s]+)@\s*(\w+)', line)
        if m:
            v = [int(x) for x in m.group(1).replace(' ', '').strip(',').split(',')]
            cols = [tuple(v[i:i + 3]) for i in range(0, len(v), 3)]
            pals[m.group(2)] = list(dict.fromkeys(cols))  # drop padded duplicates
    return pals


def chroma(c):
    return abs(c[1] - 128) + abs(c[2] - 128)


def add_mixes(pal, n, how='gap'):
    """Greedily add pairwise midpoints, each time the one farthest from the set.

    how='gap'   any pair
        'vivid' skip mixes that come out greyer than their less-saturated parent
        'shade' only mixes with the darkest colour (riso: overprint the dark ink)
    """
    pal = [np.array(c, float) for c in pal]
    base = list(pal)
    dark = min(range(len(base)), key=lambda i: base[i][0])
    pairs = [(i, j) for i in range(len(base)) for j in range(i + 1, len(base))]
    if how == 'shade':
        pairs = [p for p in pairs if dark in p]
    cands = [(base[i] + base[j]) / 2 for i, j in pairs]
    if how == 'vivid':
        cands = [c for c, (i, j) in zip(cands, pairs)
                 if chroma(c) >= 0.8 * min(chroma(base[i]), chroma(base[j]))]
    for _ in range(n):
        if not cands:
            break
        d = [min(np.abs(c - p).sum() for p in pal) for c in cands]
        pal.append(cands.pop(int(np.argmax(d))))
    return [tuple(int(round(x)) for x in c) for c in pal]


def match(img, pal, wy=1, cdither=0, contrast=100, bright=0, sat=100, lut=None):
    """Palette index chosen for each 2x2 block, as the camera would."""
    ycc = np.asarray(img.convert('YCbCr'), dtype=np.int32)
    h, w = ycc.shape[0] // 2 * 2, ycc.shape[1] // 2 * 2
    blk = ycc[:h, :w].reshape(h // 2, 2, w // 2, 2, 3).sum(axis=(1, 3)) // 4
    Y, U, V = blk[..., 0], blk[..., 1], blk[..., 2]
    Y = np.clip((Y - 128) * (contrast * 128 // 100) // 128 + 128 + bright, 0, 255)   # the luma map
    U = np.clip((U - 128) * (sat * 128 // 100) // 128 + 128, 0, 255)
    V = np.clip((V - 128) * (sat * 128 // 100) // 128 + 128, 0, 255)
    bh, bw = Y.shape
    b = (BAYER[np.arange(bh)[:, None] & 3, np.arange(bw)[None, :] & 3] - 8)
    Y = np.clip(Y + b * 4, 0, 255)
    if cdither:
        # transposed matrix so the chroma pattern does not line up with luma
        bc = (BAYER.T[np.arange(bh)[:, None] & 3, np.arange(bw)[None, :] & 3] - 8)
        U = np.clip(U + bc * cdither // 8, 0, 255)
        V = np.clip(V - bc * cdither // 8, 0, 255)
    P = np.array(pal)
    if lut:  # camera-style lookup: table indexed by quantised Y,U,V, entry =
        # nearest colour at the bin centre. Bins are centred on multiples of the
        # step, so neutral grey (U=V=128) sits mid-bin instead of on an edge.
        ys, cs = lut
        Y = np.clip((Y + (1 << ys >> 1)) >> ys << ys, 0, 255)
        U = np.clip((U + (1 << cs >> 1)) >> cs << cs, 0, 255)
        V = np.clip((V + (1 << cs >> 1)) >> cs << cs, 0, 255)
    d = (wy * np.abs(Y[..., None] - P[:, 0]) + np.abs(U[..., None] - P[:, 1])
         + np.abs(V[..., None] - P[:, 2]))
    return d.argmin(axis=-1)


def add_tag(blocks, text, cols):
    """Draw tag text into a block-index array, as the camera does; cols = the
    colours (Y,U,V) it is painted with (the tag uses the darkest and lightest)."""
    from palettes import TAG_RIGHT, TAG_SCALE, TAG_TOP, tag_cells, tag_colours
    dark, light = tag_colours(cols)
    cells = tag_cells(text)
    c0 = blocks.shape[1] - TAG_RIGHT - len(cells[0]) * TAG_SCALE
    for r, row in enumerate(cells):
        for c, v in enumerate(row):
            if v:
                y, x = TAG_TOP + r * TAG_SCALE, c0 + c * TAG_SCALE
                blocks[y:y + TAG_SCALE, x:x + TAG_SCALE] = (dark, light)[v - 1]
    return blocks


def render(img, pal, tag=None, **kw):
    """Camera output; tag = (text, colours) draws a tag."""
    blocks = match(img, pal, **kw)
    if tag:
        add_tag(blocks, *tag)
    out = np.array(pal)[blocks].astype(np.uint8)
    out = out.repeat(2, axis=0).repeat(2, axis=1)
    return Image.fromarray(out, 'YCbCr').convert('RGB')


def prepare(path, width):
    img = Image.open(path).convert('RGB')
    return img.resize((width, round(img.height * width / img.width / 2) * 2), Image.BOX)


def prepare_camera(path):
    """The photo at the camera's output size for the nearest aspect setting
    (palettes.py SIZES): centre-cropped to that crop's aspect, then
    scaled down."""
    from palettes import camera_size
    img = Image.open(path).convert('RGB')
    (cw, ch), size = camera_size(*img.size)
    w, h = img.size
    if w * ch > h * cw:                       # too wide: trim the sides
        nw = round(h * cw / ch)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:                                     # too tall: trim top and bottom
        nh = round(w * ch / cw)
        img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return img.resize(size, Image.BOX)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst'); ap.add_argument('palette')
    ap.add_argument('--width', type=int, default=640)
    ap.add_argument('--mix', type=int, default=0)
    ap.add_argument('--how', default='gap', choices=['gap', 'vivid', 'shade'])
    ap.add_argument('--wy', type=int, default=1)
    ap.add_argument('--cdither', type=int, default=0)
    ap.add_argument('--contrast', type=int, default=100)
    ap.add_argument('--bright', type=int, default=0)
    ap.add_argument('--sat', type=int, default=100)
    ap.add_argument('--lut', type=int, nargs=2, metavar=('YSHIFT', 'CSHIFT'))
    a = ap.parse_args()
    pal = add_mixes(load_palettes()[a.palette], a.mix, a.how)
    render(prepare(a.src, a.width), pal, a.wy, a.cdither, a.contrast, a.bright, a.sat, a.lut).save(a.dst)
    print(f'{len(pal)} colours:', pal)


if __name__ == '__main__':
    main()
