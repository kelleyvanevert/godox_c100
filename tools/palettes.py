#!/usr/bin/env python3
"""The photo palettes: base colours (hex), each brought to NMIN..NMAX colours.

A palette with fewer than NMIN colours is topped up by expand() with
"overprint" mixes -- the midpoint of two base colours, like two riso inks
printed over each other -- picking each time the mix farthest from the colours
already in the set, and preferring mixes that don't come out greyer than their
parents (those muddy the look). A palette with more than NMAX is thin()ned by
dropping near-duplicates. Colours are JPEG/JFIF YCbCr, which is what the
camera's buffer holds.

The camera uses presets (below): a match palette x a film simulation.

  palettes.py            print every preset (match colour -> film colour)
  palettes.py asm        print palettes.inc for the caves (presets, tags,
                         display codes); PRESETS_JSON=file.json builds the
                         presets from that file instead (the site's editor
                         writes the same config, see config())
"""
import json, os, sys

NMIN = 10   # small palettes are topped up to this many colours
NMAX = 32   # big palettes are thinned to at most this many
WY = 2      # luma weight in the match distance: WY*|dY| + |dU| + |dV|
LUT = (3, 3)  # camera lookup-table steps: Y and U/V in bins of 2^3 (photo_cave.s)

# Photo and video sizes per aspect setting: (crop, output), about the same pixel count
# for every aspect: ~274k, the old 3:2 640x428 (2026-10-17; v018 had ~420k,
# 864x484 .. 640x640, which worked but was more than wanted). Widths are
# multiples of 16 (like every stock size; the scaler and the JPEG blocks),
# heights multiples of 4 (2x2 blocks, 4:2:0 chroma; 428 is known to work).
# Each crop has the output's aspect, so the scaler doesn't stretch: 16:9 is
# exactly 0.3667 of the full 1920x1080, 4:3 0.4222 of 1440x1080, 1:1 0.5156
# of 1024x1024, 3:2 0.396 of 1616x1080 (0.07% off, as before). The crop is
# only two numbers in the size struct; 1616 is the stock 3:2 crop (the
# multiple of 16 nearest 1620). Video uses the same sizes since v020 (before:
# 640 wide at every aspect); its hook takes any multiple of 16 up to MAX_W.
SIZES = {
    '16:9': ((1920, 1080), (704, 396)),
    '3:2':  ((1616, 1080), (640, 428)),
    '4:3':  ((1440, 1080), (608, 456)),
    '1:1':  ((1024, 1024), (528, 528)),
}


# A config may set its own sizes (the site's editor): {aspect: [w, h]} for all
# four. Each crop is then the largest at the output's aspect inside the aspect
# setting's stock crop, so the camera's bracket still marks about what's in
# the photo (rounded half up, as the editor does: W to 16, H to 4). This
# gives back the crops above for the built-in sizes. Limits: W a multiple of
# 16, H of 4, at least 64x48 (the tag and its margins), at most 864 wide (the
# widest photo tried, v018), 576 tall (video 640 tall alternates between two
# crops 4 px apart, a shake: IMG_0990, IMG_0994; 576 doesn't, IMG_0996) and
# 640x640 pixels (the hook's time grows with the pixel count; 848x480 is fine,
# IMG_0993).
STOCK_CROPS = {'16:9': (1920, 1080), '3:2': (1616, 1080), '4:3': (1440, 1080), '1:1': (1024, 1024)}
SIZE_LIMITS = {'minW': 64, 'minH': 48, 'maxW': 864, 'maxH': 576, 'maxPixels': 640 * 640}


def crop_for(aspect, w, h):
    cw, ch = STOCK_CROPS[aspect]
    if w * ch >= h * cw:
        return cw, (2 * cw * h + 4 * w) // (8 * w) * 4
    return (2 * ch * w + 16 * h) // (32 * h) * 16, ch


def size_errors(aspect, w, h):
    L = SIZE_LIMITS
    if not (isinstance(w, int) and isinstance(h, int)):
        return ['whole numbers']
    errors = []
    if w % 16:
        errors.append('a width that is a multiple of 16')
    if h % 4:
        errors.append('a height that is a multiple of 4')
    if w < L['minW'] or h < L['minH']:
        errors.append(f"at least {L['minW']}x{L['minH']}")
    if w > L['maxW']:
        errors.append(f"a width of at most {L['maxW']}")
    if h > L['maxH']:
        errors.append(f"a height of at most {L['maxH']}")
    if w * h > L['maxPixels']:
        errors.append(f"at most {L['maxPixels']:,} pixels")
    return errors


def config_sizes(cfg):
    """{aspect: (crop, output)} for a config: its own sizes, or SIZES."""
    if 'sizes' not in cfg:
        return SIZES
    return {k: (crop_for(k, *cfg['sizes'][k]), tuple(cfg['sizes'][k])) for k in STOCK_CROPS}


assert all(crop_for(k, *o) == c for k, (c, o) in SIZES.items())


def camera_size(w, h):
    """(crop aspect, output size) of the aspect setting nearest w x h."""
    name = min(SIZES, key=lambda k: abs(SIZES[k][1][0] / SIZES[k][1][1] - w / h))
    return SIZES[name]

GREYS = {'000000', '7C7C7C', 'BCBCBC', 'FCFCFC'}   # NES greys thin() must keep

# The full NES (2C02) palette. The source screenshot showed the first 32; the
# rest is the standard Lospec list. thin() takes it down to NMAX for BASE.
NES_FULL = [
    '000000', 'FCFCFC', 'F8F8F8', 'BCBCBC', '7C7C7C', 'A4E4FC', '3CBCFC', '0078F8',
    '0000FC', 'B8B8F8', '6888FC', '0058F8', '0000BC', 'D8B8F8', '9878F8', '6844FC',
    '4428BC', 'F8B8F8', 'F878F8', 'D800CC', '940084', 'F8A4C0', 'F85898', 'E40058',
    'A80020', 'F0D0B0', 'F87858', 'F83800', 'A81000', 'FCE0A8', 'FCA044', 'E45C10',
    '881400', 'F8D878', 'F8B800', 'AC7C00', '503000', 'D8F878', 'B8F818', '00B800',
    '007800', 'B8F8B8', '58D854', '00A800', '006800', 'B8F8D8', '58F898', '00A844',
    '005800', '00FCFC', '00E8D8', '008888', '004058', 'F8D8F8', '787878',
]


def clamp(x):
    return max(0, min(255, round(x)))


def hex_to_yuv(h):
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return (clamp(0.299 * r + 0.587 * g + 0.114 * b),
            clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
            clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b))


def yuv_to_hex(c):
    y, u, v = c[0], c[1] - 128, c[2] - 128
    rgb = (y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u)
    return ''.join(f'{clamp(x):02X}' for x in rgb)


def chroma(c):
    return abs(c[1] - 128) + abs(c[2] - 128)


def dist(a, b):
    return sum(abs(x - y) for x, y in zip(a, b))


def thin(hexes, n, protect=()):
    """Drop near-duplicates until n colours are left: take the closest pair
    (Y+U+V) and drop whichever of the two is closer to the rest of the set.
    Colours in protect are never dropped (the greys, which photos lean on)."""
    yuv = {h: hex_to_yuv(h) for h in hexes}
    keep = list(dict.fromkeys(hexes))
    while len(keep) > n:
        pairs = [(dist(yuv[a], yuv[b]), a, b) for i, a in enumerate(keep) for b in keep[i + 1:]
                 if not (a in protect and b in protect)]
        _, a, b = min(pairs)
        rest = lambda x, other: min(dist(yuv[x], yuv[y]) for y in keep if y not in (x, other))
        if a in protect or (b not in protect and rest(b, a) < rest(a, b)):
            a, b = b, a
        keep.remove(a)
    return keep


# riso6 and refreshing are from the v1 cave (hex converted back from its Y,U,V
# bytes, round-trips exactly). The rest were added 2026-10-14; the pixel-art
# palettes use the canonical Lospec values. Tried and dropped: vibrant_summer,
# fiesta, bold_hues, dark_sunset, vibrant_nature, seventies, pixnote24, pico8,
# db32, earthy. GBC (2026-10-23): the Game Boy Color's greens, plus white.
BASE = {
    'riso6':       ['1A1B3A', 'E0405A', 'F19041', '2AA0A0', 'F0E0BF', 'FFFFFF'],
    'GBC':         ['071820', '336856', '89C06F', 'DFF8D0', 'FFFFFF'],
    'refreshing':  ['A7D2E5', '4992B2', '102A43', 'F1C23E', 'E8892B'],
    'mid_century': ['F87523', 'FFC31B', 'E7DCC9', '1DB7B9', '126D68',
                    '093634', '1A1B3A'],  # + dark teal, dark navy
    'harbour':     ['FBD0A6', 'F37022', 'B11016', '2ABA9E', '007096'],
    'db16': ['140C1C', '442434', '30346D', '4E4A4E', '854C30', '346524', 'D04648', '757161',
             '597DCE', 'D27D2C', '8595A1', '6DAA2C', 'D2AA99', '6DC2CA', 'DAD45E', 'DEEED6'],
    'endesga32': ['BE4A2F', 'D77643', 'EAD4AA', 'E4A672', 'B86F50', '733E39', '3E2731', 'A22633',
                  'E43B44', 'F77622', 'FEAE34', 'FEE761', '63C74D', '3E8948', '265C42', '193C3E',
                  '124E89', '0099DB', '2CE8F5', 'FFFFFF', 'C0CBDC', '8B9BB4', '5A6988', '3A4466',
                  '262B44', '181425', 'FF0044', '68386C', 'B55088', 'F6757A', 'E8B796', 'C28569'],
    'sweetie16': ['1A1C2C', '5D275D', 'B13E53', 'EF7D57', 'FFCD75', 'A7F070', '38B764', '257179',
                  '29366F', '3B5DC9', '41A6F6', '73EFF7', 'F4F4F4', '94B0C2', '566C86', '333C57'],
    'nes': thin(NES_FULL, NMAX, protect=GREYS),
}

# Palettes topped up past NMIN (breaking their original set for more range).
SIZE = {'db16': 24}


def expand(base, n=NMIN):
    """Return [(yuv, parents)]: the base colours, topped up with mixes to n.

    parents is None for a base colour, else the (i, j) indices it mixes.
    """
    base = list(dict.fromkeys(base))
    out = [(hex_to_yuv(h), None) for h in base]
    pairs = [(i, j) for i in range(len(base)) for j in range(i + 1, len(base))]
    mix = {p: tuple((out[p[0]][0][k] + out[p[1]][0][k]) / 2 for k in range(3)) for p in pairs}
    vivid = [p for p in pairs
             if chroma(mix[p]) >= 0.8 * min(chroma(out[p[0]][0]), chroma(out[p[1]][0]))]
    for pool in (vivid, pairs):          # greying mixes only if vivid runs out
        while len(out) < n:
            pool = [p for p in pool if p not in [q for _, q in out]]
            if not pool:
                break
            best = max(pool, key=lambda p: min(dist(mix[p], c) for c, _ in out))
            out.append((tuple(clamp(x) for x in mix[best]), best))
    return out


def source(name, par):
    """Human-readable origin of a colour in palette name."""
    if par is None:
        return 'base'
    return f'mix of #{BASE[name][par[0]]} + #{BASE[name][par[1]]}'


def expanded():
    pals = {name: expand(cols, SIZE.get(name, NMIN)) for name, cols in BASE.items()}
    assert all(NMIN <= len(c) <= NMAX for c in pals.values())
    return pals


# ---- Presets (2026-10-17): EP6, 6FP, BW ----
# Each block gets its nearest colour in the preset's match palette (as with the
# plain palettes), and is painted with that colour as the preset's film
# simulation would render it: a G'MIC film LUT applied to the palette's
# colours by film.py, kept in film_colours.py so the build doesn't need the
# LUTs. BW has no film: it paints BW_LEVELS. The match palettes:
#   E  endesga32 + 3 greens (foliage landed on its browns), minus 3 colours
#      that were used 0.0% on the plain photos, to stay at NMAX
#   6  riso6, overprint-expanded to 16 instead of 10 (less funky)
#   B  5 neutral greys (BW_LEVELS), one Bayer swing (-32..+28 on luma) apart,
#      so every tone dithers between two neighbours: the dithered greyscale
#      look. BW has no film, but matches against BW_MATCH: the inner greys
#      moved out by 16, so the dither blends map input -> output along a
#      slight S-curve (shadows ~8 darker, highlights ~8 brighter, mids ~10%
#      steeper; the table's 8-step luma bins make 16 the smallest move that
#      changes anything)
# (H, harbour + a dark, and the AV/FV films were tried 2026-10-16 and dropped.)
EG_GREENS = ['2B5322', '4F7945', '77A36E']  # OKLCH L 0.40/0.53/0.67, C 0.09, hue 140
EG_UNUSED = {'FF0044', 'FEE761', '2CE8F5'}
BW_LEVELS = [0, 64, 128, 191, 255]
BW_MATCH = [0, 80, 128, 176, 255]
# 6FP's colours since 2026-10-26 (riso6 and its mixes, chosen in the editor; was riso6
# overprint-expanded to 16), and GBC's: the Game Boy Camera look's grey-greens, from
# Donald Sayers' fork, dark to light.
SIX_FP = ['1A1B3A', '3A3C62', 'E0405A', 'F19041', '2AA0A0', 'FFFFFF', '8DC0AF', '7D2D4A',
          'F0A0AD', '235E6E', '85553E']
GB_SHADES = ['252525', '4B564D', '9AA57C', 'E0E9C4']
MATCH = {
    'E': [hex_to_yuv(h) for h in BASE['endesga32'] if h not in EG_UNUSED]
         + [hex_to_yuv(h) for h in EG_GREENS],
    '6': [hex_to_yuv(h) for h in SIX_FP],
    'G': [hex_to_yuv(h) for h in GB_SHADES],
    'B': [(y, 128, 128) for y in BW_MATCH],
}
# (tag, match palette, film or None), in firmware order: the center button
# cycles through them, then RND (a random preset per photo/recording).
PRESETS = [('EP6', 'E', 'polaroid_690'),
           ('6FP', '6', 'fuji_provia_100_generic'),
           ('BW', 'B', None),
           ('GBC', 'G', None)]
# Their settings (2026-10-26, as in the editor): contrast, brightness, sharpening, and
# GBC as the Game Boy Camera (a ramp, its tone, 4x4 pixels).
PRESET_SETTINGS = {
    '6FP': {'contrast': 7, 'brightness': -4, 'sharpen': 16},
    'BW': {'contrast': 6, 'sharpen': 23},
    'GBC': {'ramp': True, 'gbTone': True, 'pixel': 4, 'sharpen': 50},
}
RND = 'rnd'


def presets():
    """[(tag, match colours, display colours)] in firmware order, as (Y,U,V)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # build.sh runs python -I
    from film_colours import DISPLAY, SOURCE
    out = []
    for tag, p, film in PRESETS:
        cols = MATCH[p]
        if film is None:      # BW paints its levels (the S-curve), GBC its own colours
            out.append((tag, cols, [(y, 128, 128) for y in BW_LEVELS] if p == 'B' else cols))
            continue
        assert SOURCE.get(tag) == [yuv_to_hex(c) for c in cols] and tag in DISPLAY, \
            f'film_colours.py is stale for {tag}: run tools/film.py gen'
        out.append((tag, cols, [hex_to_yuv(h) for h in DISPLAY[tag]]))
    assert all(len(m) <= NMAX for _, m, _ in out)
    return out


# Tag: the letters in a 3x5 pixel font, drawn top right on every photo so you
# can tell which preset it got. Letters in the lightest colour, with a
# one-pixel outline (8 neighbours) in the darkest. TAG names the old palettes
# (sort_images.py still reads them); the presets' tags are up to 3 letters,
# right-aligned in a 3-letter field.
TAG = {'riso6': 'R6', 'GBC': 'GBC', 'refreshing': 'RF', 'mid_century': 'MC', 'harbour': 'HB',
       'db16': 'DB', 'endesga32': 'EG', 'sweetie16': 'S6', 'nes': 'NS'}
FONT = {  # rows top to bottom, 3 pixels each (W: 5)
    'A': ['010', '101', '111', '101', '101'],
    'B': ['110', '101', '110', '101', '110'], 'C': ['111', '100', '100', '100', '111'],
    'D': ['110', '101', '101', '101', '110'], 'E': ['111', '100', '110', '100', '111'],
    'F': ['111', '100', '110', '100', '100'], 'G': ['111', '100', '101', '101', '111'],
    'H': ['101', '101', '111', '101', '101'], 'M': ['101', '111', '111', '101', '101'],
    'N': ['110', '101', '101', '101', '101'], 'P': ['110', '101', '110', '100', '100'],
    'R': ['110', '101', '110', '101', '101'], 'S': ['011', '100', '010', '001', '110'],
    'V': ['101', '101', '101', '101', '010'], 'W': ['10001', '10001', '10101', '10101', '01010'],  # 5 wide: a 3-wide W reads as H
    '6': ['111', '100', '111', '101', '111'],
    # the rest of the alphabet and the digits, for the site's editor
    'I': ['111', '010', '010', '010', '111'], 'J': ['001', '001', '001', '101', '111'],
    'K': ['101', '101', '110', '101', '101'], 'L': ['100', '100', '100', '100', '111'],
    'O': ['111', '101', '101', '101', '111'], 'Q': ['111', '101', '101', '111', '001'],
    'T': ['111', '010', '010', '010', '010'], 'U': ['101', '101', '101', '101', '111'],
    'X': ['101', '101', '010', '101', '101'], 'Y': ['101', '101', '010', '010', '010'],
    'Z': ['111', '001', '010', '100', '111'],
    '0': ['010', '101', '101', '101', '010'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'], '-': ['000', '000', '111', '000', '000'],
    # lowercase r, n, d, o shaped as the display's 7-segment rnd and nor (eg,
    # ceg, bcdeg, cdeg), for the site's rnd and nor tags; preset tags are uppercase
    'r': ['000', '000', '111', '100', '100'], 'n': ['000', '000', '111', '101', '101'],
    'd': ['001', '001', '111', '101', '111'], 'o': ['000', '000', '111', '101', '111'],
}
TAG_LETTERS = 3
TAG_ROWS, TAG_COLS = 7, 4 * TAG_LETTERS + 1  # 3 letters, 1-pixel gaps, plus the outline (firmware)
TAG_SCALE = 2               # blocks per font pixel (a block is 2x2 image pixels)
TAG_TOP, TAG_RIGHT = 4, 4   # margins in blocks


def tag_cells(text, width=None):
    """7-row grid, letters with 1-cell gaps plus a 1-cell outline: 0 = photo
    shows through, 1 = dark, 2 = light; padded on the left with 0s to `width`
    columns if given."""
    cols = sum(len(FONT[ch][0]) + 1 for ch in text) + 1
    assert width is None or cols <= width, f'tag {text} is wider than {width} cells'
    lit = [[0] * cols for _ in range(TAG_ROWS)]
    x = 1
    for ch in text:
        for r, row in enumerate(FONT[ch]):
            for c, bit in enumerate(row):
                lit[1 + r][x + c] = int(bit)
        x += len(FONT[ch][0]) + 1
    cells = [[0] * cols for _ in range(TAG_ROWS)]
    for r in range(TAG_ROWS):
        for c in range(cols):
            if lit[r][c]:
                cells[r][c] = 2
            elif any(lit[rr][cc] for rr in range(max(r - 1, 0), min(r + 2, TAG_ROWS))
                     for cc in range(max(c - 1, 0), min(c + 2, cols))):
                cells[r][c] = 1
    if width:
        cells = [[0] * (width - cols) + row for row in cells]
    return cells


def tag_colours(cols):
    """Indices of the darkest and lightest colour (by Y) in a list of (Y,U,V)."""
    ys = [c[0] for c in cols]
    return ys.index(min(ys)), ys.index(max(ys))


# The same code on the camera's see-through display, on the three 7-segment
# cells of the shutter-speed (SS) readout, blank in photo and video mode: the
# chosen preset, or rnd. Glyphs per cell (LCD); BW is an 8 and a W over two
# mirrored cells: full left side + bottom + lower right, then lower left +
# bottom + full right side.
SEG7 = {'E': 'adefg', 'F': 'aefg', 'P': 'abefg', '6': 'acdefg', '8': 'abcdefg', 'G': 'acdef', 'C': 'adef',
        'W<': 'cdef', 'W>': 'bcde', 'r': 'eg', 'n': 'ceg', 'd': 'bcdeg', 'o': 'cdeg'}
LCD = {'EP6': ['E', 'P', '6'], '6FP': ['6', 'F', 'P'], 'BW': ['8', 'W<', 'W>'],
       'GBC': ['G', '8', 'C'], RND: ['r', 'n', 'd'], 'nor': ['n', 'o', 'r']}
# Segment -> (HT1621 address, COM) for each SS cell, left to right, found by
# running the firmware's SS digit routines (FUN_0004a374, FUN_0004a1f0,
# FUN_0004a074) for 0..9 in tools/emu_seg.py. Each cell is wired differently.
# Addresses 0x0d..0x13 hold nothing but these 21 segments.
SS_CELLS = [
    {'a': (0x0d, 0), 'b': (0x0e, 0), 'c': (0x0f, 2), 'd': (0x0e, 2), 'e': (0x0d, 2), 'f': (0x0d, 1), 'g': (0x0e, 1)},
    {'a': (0x0f, 0), 'b': (0x10, 0), 'c': (0x11, 1), 'd': (0x11, 2), 'e': (0x10, 2), 'f': (0x0f, 1), 'g': (0x10, 1)},
    {'a': (0x12, 0), 'b': (0x13, 0), 'c': (0x13, 1), 'd': (0x13, 2), 'e': (0x12, 2), 'f': (0x11, 0), 'g': (0x12, 1)},
]
SS_FIRST, SS_COUNT = 0x0d, 7    # HT1621 addresses written


def lcd_text(code):
    return ''.join(LCD[code])


def lcd_segments(code):
    """The lit segments per SS cell for a built-in code, e.g. ['adefg', ...]."""
    return [SEG7[glyph] for glyph in LCD[code]]


def lcd_nibbles(segments):
    """Nibbles for HT1621 addresses 0x0d..0x13 that light `segments` (one
    string of a..g per SS cell) (COM0 = nibble bit 8, COM1 = 4, COM2 = 2)."""
    nib = [0] * SS_COUNT
    for cell, segs in zip(SS_CELLS, segments):
        for seg in segs:
            addr, com = cell[seg]
            nib[addr - SS_FIRST] |= 8 >> com
    return nib


# ---- Config: what the caves get (2026-10-18) ----
# The presets as plain data: per preset its tag, match and paint colours
# (Y,U,V, index for index) and the segments its code lights on the display;
# plus whether the center button offers rnd, and (optional, default true)
# whether photos and videos get the preset's tag. Built from PRESETS above, or
# read from PRESETS_JSON (the site's editor writes the same shape). The preset data
# has a fixed layout with room for MAX_PRESETS of NMAX colours, so the editor
# can patch any config into one template build (tools/editor_data.py).
# Optional per preset (2026-10-26):
#   contrast    percent added around mid-grey, CONTRAST_RANGE, 0 = as shot
#   brightness  luma levels added, BRIGHTNESS_RANGE, 0 = as shot
#   ramp        pick by brightness only: the colours as a ramp of even shades, dark
#               to light (the build sorts them so), each block's shade from its luma
#   gbTone      with a ramp: the Game Boy Camera's exposure and shade spacing
#   pixel       2 or 4: the blocks' size in pixels
#   sharpen     0..100: horizontal sharpening of the blocks' luma (50 = the Game Boy's)
# The last four are the Game Boy Camera look, after Donald Sayers' fork; see
# luma_map, dither_table, ramp_shade and tools/sim_look.py, the exact reference.
# And (optional, default false) 'normal': the center button also offers the
# normal mode after rnd (from Donald Sayers' fork): no effect at all, photos and
# video as the factory makes them, at the factory's sizes. Its code is NORMAL.
MAX_PRESETS = 8
SEGMENTS = 'abcdefg'
CONTRAST_RANGE = BRIGHTNESS_RANGE = (-50, 50)
NORMAL = 'nor'


def builtin_config():
    return {'presets': [{'tag': tag, 'match': [list(c) for c in cols], 'paint': [list(c) for c in disp],
                         'lcd': lcd_segments(tag), **PRESET_SETTINGS.get(tag, {})} for tag, cols, disp in presets()],
            'rnd': True, 'normal': True}


def contrast_fix(p):
    """The luma map's slope in /128 (128 = as shot)."""
    return (100 + p.get('contrast', 0)) * 128 // 100


GB_RANGE = (0x89, 0x92, 0xA2, 0xD2)   # gb-photo's shade boundaries on the MAC-GBD code (contrast 7, high light)
PIXELS = (2, 4)
SHARPEN_RANGE = (0, 100)
FX_RAMP, FX_GBTONE, FX_PIX4 = 1, 2, 4     # PRESET_FX flags


def gb_tone(t, n):
    """The Game Boy Camera's tone for a ramp of n shades: its fixed 4x exposure to the MAC-GBD
    code, 128 + (t - 32) / 2 toward zero, then the code's place among GB_RANGE as u = 0..3
    (k whole steps + d / w of the next, w its width), stretched over the ramp's n - 1 steps
    and put in the middle of its shade: (u (n - 1) / 3 + 1/2) * 256 / n, rounded half up.
    With 4 shades the shades dither between k and k + 1 as the camera's thresholds do."""
    code = 128 + int((t - 32) / 2)
    if code < GB_RANGE[0]:
        k, d, w = 0, 0, 1
    elif code >= GB_RANGE[3]:
        k, d, w = 2, 1, 1
    else:
        k = max(i for i in range(3) if code >= GB_RANGE[i])
        d, w = code - GB_RANGE[k], GB_RANGE[k + 1] - GB_RANGE[k]
    num = 256 * (2 * (k * w + d) * (n - 1) + 3 * w) + 3 * w * n
    return num // (6 * w * n)


def luma_map(p):
    """What lut_fill puts in the preset's 256-byte luma map: contrast and brightness,
    clamped, then (with a ramp) the Game Boy tone."""
    fix, b = contrast_fix(p), p.get('brightness', 0)
    out = [max(0, min(255, ((y - 128) * fix >> 7) + 128 + b)) for y in range(256)]
    if p.get('ramp') and p.get('gbTone'):
        out = [gb_tone(t, len(p['match'])) for t in out]
    return out


BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]


def dither_table(p):
    """The 16 luma offsets lut_fill puts in VARS (index (row & 3) * 4 + (col & 3), in blocks):
    the Bayer swing of +-32 for a palette, or one shade's width for a ramp of n."""
    if not p.get('ramp'):
        return [(b - 8) * 4 for b in BAYER]
    n = len(p['match'])
    return [(2 * b + 1) * 8 // n - 128 // n for b in BAYER]


def ramp_shade(q, n):
    """A ramp's shade for luma bin q (the table's, (y + 4) >> 3): its centre's even shade."""
    return min(n - 1, 8 * q * n >> 8)


def sharpen_weight(p):
    """The sharpening in /128 (64 = 50 %)."""
    return (p.get('sharpen', 0) * 128 + 50) // 100


def tag_width(text):
    return sum(len(FONT[ch][0]) + 1 for ch in text) + 1


def check_config(cfg):
    pre = cfg['presets']
    assert 1 <= len(pre) <= MAX_PRESETS, f'{len(pre)} presets: 1..{MAX_PRESETS}'
    assert isinstance(cfg['rnd'], bool)
    assert isinstance(cfg.get('tags', True), bool)
    assert isinstance(cfg.get('normal', False), bool)
    for p in pre:
        assert 1 <= len(p['match']) <= NMAX and len(p['paint']) == len(p['match']), p['tag']
        assert all(len(c) == 3 and all(0 <= x <= 255 for x in c) for c in p['match'] + p['paint']), p['tag']
        assert all(isinstance(p.get(k, 0), int) and lo <= p.get(k, 0) <= hi
                   for k, (lo, hi) in (('contrast', CONTRAST_RANGE), ('brightness', BRIGHTNESS_RANGE),
                                       ('sharpen', SHARPEN_RANGE))), p['tag']
        assert isinstance(p.get('ramp', False), bool) and isinstance(p.get('gbTone', False), bool), p['tag']
        assert p.get('pixel', 2) in PIXELS, p['tag']
        if cfg.get('tags', True):
            assert 1 <= len(p['tag']) <= TAG_LETTERS and all(ch in FONT for ch in p['tag']), p['tag']
            assert tag_width(p['tag']) <= TAG_COLS, f'tag {p["tag"]} is too wide'
        assert len(p['lcd']) == len(SS_CELLS) and all(set(s) <= set(SEGMENTS) for s in p['lcd']), p['tag']
    if 'sizes' in cfg:
        assert set(cfg['sizes']) == set(STOCK_CROPS), cfg['sizes']
        for k, (w, h) in cfg['sizes'].items():
            assert not size_errors(k, w, h), f'{k} {w}x{h}: needs {", ".join(size_errors(k, w, h))}'
    return cfg


def config():
    """The config the caves get: a ramp's colours sorted dark to light (by match luma, stably),
    so the camera's shade k is colour k."""
    path = os.environ.get('PRESETS_JSON')
    cfg = check_config(json.load(open(path)) if path else builtin_config())
    for p in cfg['presets']:
        if p.get('ramp'):
            order = sorted(range(len(p['match'])), key=lambda i: p['match'][i][0])
            p['match'], p['paint'] = [p['match'][i] for i in order], [p['paint'][i] for i in order]
    return cfg


def config_presets():
    """config() as presets() gives it: [(tag, match colours, paint colours)]."""
    return [(p['tag'], [tuple(c) for c in p['match']], [tuple(c) for c in p['paint']])
            for p in config()['presets']]


# Fixed layout of the preset data cave (preset_data.s), from 0xbbc00: every
# table has room for MAX_PRESETS, so the addresses never move.
NCOL_BYTES = 3 * NMAX
TAG_BYTES = (TAG_ROWS * TAG_COLS + 3) // 4 + 2   # 2-bit cells, dark and light offset
# PRESET_FX, per preset: flags (FX_RAMP, FX_GBTONE, FX_PIX4), the luma map's
# contrast_fix, its brightness (a signed byte), the sharpening weight (/128).
FX_BYTES = 4
PD = {'MATCH': 0xbbc00}
PD['PMATCH'] = PD['MATCH'] + MAX_PRESETS * (1 + NCOL_BYTES)
PD['TAGS'] = PD['PMATCH'] + MAX_PRESETS
PD['DISPLAY'] = PD['TAGS'] + MAX_PRESETS * TAG_BYTES
PD['DPTRS'] = (PD['DISPLAY'] + MAX_PRESETS * NCOL_BYTES + 3) // 4 * 4
PD['FX'] = PD['DPTRS'] + 4 * MAX_PRESETS
PD['END'] = PD['FX'] + FX_BYTES * MAX_PRESETS
assert PD['END'] <= 0xbc400
LCD_BYTES = (MAX_PRESETS + 2) * SS_COUNT       # LCD_TAGS in lcd_cave.s: MAX_PRESETS presets, rnd, nor


def fx_bytes(p):
    flags = (FX_RAMP * bool(p.get('ramp')) | FX_GBTONE * bool(p.get('ramp') and p.get('gbTone'))
             | FX_PIX4 * (p.get('pixel', 2) == 4))
    return [flags, contrast_fix(p), p.get('brightness', 0) & 0xff, sharpen_weight(p)]


def tag_bytes(tag, paint):
    flat = [v for row in tag_cells(tag, TAG_COLS) for v in row]
    packed = [sum(v << (2 * j) for j, v in enumerate(flat[i:i + 4])) for i in range(0, len(flat), 4)]
    dark, light = tag_colours(paint)
    return packed + [3 * dark, 3 * light]


def main():
    if sys.argv[1:] == ['asm']:
        cfg = config()
        pre = cfg['presets']
        n = len(pre)
        flat = lambda cols: ', '.join('%d,%d,%d' % tuple(c) for c in cols)
        print('@ Generated by tools/palettes.py asm -- do not edit.')
        print(f'    .equ    NPAL, {n}                      @ presets; mode NPAL = random')
        print(f'    .equ    RND_MODE, {int(cfg["rnd"])}                  @ 1 = the center button offers rnd')
        print(f'    .equ    NORMAL_MODE, {int(cfg.get("normal", False))}               @ 1 = and then the normal mode')
        print(f'    .equ    MAX_PRESETS, {MAX_PRESETS}')
        for k, v in PD.items():
            print(f'    .equ    PD_{k}, {v:#x}')
        print('    .macro  MATCH_DATA                    @ per preset: count, then count x (Y,U,V)')
        for p in pre:
            print(f'    .byte {len(p["match"])}, {flat(p["match"])}   @ {p["tag"]}')
        print(f'    .space  {PD["PMATCH"] - PD["MATCH"] - sum(1 + 3 * len(p["match"]) for p in pre)}')
        print('    .endm')
        print('    .macro  PRESET_FX_DATA                @ per preset: flags, contrast_fix, brightness, 0')
        for p in pre:
            print('    .byte ' + ', '.join(map(str, fx_bytes(p))) + f'   @ {p["tag"]}')
        print(f'    .space  {FX_BYTES * (MAX_PRESETS - n)}' if n < MAX_PRESETS else '')
        print('    .endm')
        print(f'    .equ    FX_BYTES, {FX_BYTES}')
        print(f'    .equ    FX_RAMP, {FX_RAMP}\n    .equ    FX_GBTONE, {FX_GBTONE}\n    .equ    FX_PIX4, {FX_PIX4}')
        print(f'    .equ    MAX_BLOCKS, {SIZE_LIMITS["maxW"] // 2}       @ blocks in a row, at most')
        print('    .macro  PRESET_MATCH_DATA             @ per preset: index of its match palette')
        print('    .byte ' + ', '.join(str(i) for i in range(n)))
        print(f'    .space  {MAX_PRESETS - n}' if n < MAX_PRESETS else '')
        print('    .endm')
        print('    .macro  DISPLAY_DATA                  @ per preset: count x (Y,U,V) paint colours')
        for i, p in enumerate(pre):
            print(f'disp_{i}:')
            print(f'    .byte {flat(p["paint"])}   @ {p["tag"]}')
        print(f'    .space  {PD["DPTRS"] - PD["DISPLAY"] - sum(3 * len(p["paint"]) for p in pre)}')
        print('    .endm')
        print('    .macro  DISPLAY_PTR_DATA              @ per preset: address of its paint colours')
        for i in range(n):
            print(f'    .word   disp_{i} - base')
        print(f'    .space  {4 * (MAX_PRESETS - n)}' if n < MAX_PRESETS else '')
        print('    .endm')
        sizes = config_sizes(cfg)
        for name, ((cw, ch), (ow, oh)) in sizes.items():
            k = name.replace(':', '')
            assert ow % 16 == 0 and oh % 4 == 0 and cw % 16 == 0 and ow <= 1020
            print(f'    .equ    P{k}_W, {ow}\n    .equ    P{k}_H, {oh}\n'
                  f'    .equ    P{k}_CW, {cw}\n    .equ    P{k}_CH, {ch}      @ photo {name}: output, crop')
        print(f'    .equ    MAX_W, {max(o[0] for _, o in sizes.values())}           @ widest output (video hook)')
        print(f'    .equ    TAG_ROWS, {TAG_ROWS}')
        print(f'    .equ    TAG_COLS, {TAG_COLS}')
        print(f'    .equ    TAG_SCALE, {TAG_SCALE}')
        print(f'    .equ    TAG_TOP, {TAG_TOP}')
        print(f'    .equ    TAG_RIGHT, {TAG_RIGHT}')
        print(f'    .equ    TAG_BYTES, {TAG_BYTES}')
        print(f'    .macro  TAG_DATA                      @ per preset: {TAG_BYTES - 2} B of 2-bit cells'
              ' (LSB first), dark offset, light offset')
        tagged = pre if cfg.get('tags', True) else []      # no tags: all-zero cells draw nothing
        for p in tagged:
            print('    .byte ' + ', '.join(map(str, tag_bytes(p['tag'], p['paint']))) + f'   @ {p["tag"]}')
        print(f'    .space  {TAG_BYTES * (MAX_PRESETS - len(tagged))}' if len(tagged) < MAX_PRESETS else '')
        print('    .endm')
        print(f'    .equ    SS_FIRST, {SS_FIRST:#x}')
        print(f'    .equ    SS_COUNT, {SS_COUNT}')
        print(f'    .macro  LCD_TAG_DATA                  @ per mode (MAX_PRESETS presets, rnd, nor): HT1621'
              f' nibbles for addresses {SS_FIRST:#x}..{SS_FIRST + SS_COUNT - 1:#x}')
        line = lambda tag, lcd: print('    .byte ' + ', '.join(map(str, lcd_nibbles(lcd))) + f'   @ {tag} {"/".join(lcd)}')
        for p in pre:
            line(p['tag'], p['lcd'])
        print(f'    .space  {SS_COUNT * (MAX_PRESETS - n)}' if n < MAX_PRESETS else '')
        for code in (RND, NORMAL):
            line(code, lcd_segments(code))
        print('    .endm')
        return
    for tag, cols, disp in presets():
        print(f'{tag} ({len(cols)})')
        for c, d in zip(cols, disp):
            print(f'  #{yuv_to_hex(c)} -> #{yuv_to_hex(d)}  Y,U,V = {d[0]:3},{d[1]:3},{d[2]:3}')


if __name__ == '__main__':
    main()
