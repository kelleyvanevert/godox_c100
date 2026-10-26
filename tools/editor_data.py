#!/usr/bin/env python3
"""Make everything the site's firmware editor (site/editor/) needs.

  uv run --with pillow tools/editor_data.py

- the template firmware: build.sh with the built-in presets, silent
  (SILENT=1), copied to site/editor/TEMPLATE. It is also the site's default
  download (what v020 does, in the editor's layout). The editor patches a
  visitor's presets, rnd, tags, sizes and sounds into it.
- site/editor/template.json: where to patch, read from the assembled caves
  (llvm-nm), the resource table and palettes.py, plus the template's sha256.
- site/editor/library.json: palettes to start from (the current presets and
  palettes.py BASE as they are, without endesga32: EP6 is its successor), the films (FILMS: G'MIC HaldCLUTs
  from film_luts/, copied to site/editor/films/) and the S-curve (BW's tone
  curve). A preset's paint colours are its colours through the S-curve (if
  on), then through its film (if any), as film.py does it; the editor's
  films.js repeats that exactly. No firmware involved: the camera only ever
  sees match and paint colours.
- site/editor/sounds/: the stock shutter and power-on sounds (from the
  factory firmware) and the Super Mario ones (build/*_11k.wav); and the
  factory's CLICK slot as it is, padding included (stock_click.wav), which
  the editor puts back when sounds are on (SILENT=1 silences it).
- site/editor/photos/: the preview photos.
- site/img/tags/: the current presets' tags as the camera draws them
  (13x7-ish PNGs, one pixel per font cell), for the page's preset list; and
  rnd and nor (the normal mode), in black and white, letters shaped like the display's.

tools/editor_check.sh then checks the editor's patcher against build.sh.
"""
import glob, hashlib, json, os, shutil, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import palettes as P
from gp_res import parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = 'v023_editor_template.bin'
SITE = os.path.join(ROOT, 'site', 'editor')
ORIG = os.path.join(ROOT, 'c100_v1.1.6_20260929', 'GP_CARDVR_UPGRADE.BIN')
APP = 0x10200                     # file offset of RAM address 0
LLVM = next(d for d in ('/opt/homebrew/opt/llvm/bin', '/opt/homebrew/opt/llvm@18/bin') if os.path.isdir(d))
SPEAKER = [(0x22b38, '2d8200eb'), (0x350f0, 'bf3800eb'), (0x2ed50, 'a75100eb')]  # build.sh SPK_PATCHES
NOP = '0000a0e1'
# The films the editor offers: (id, name); id is the LUT's name in film_luts/.
FILMS = [('polaroid_690', 'Polaroid 690'), ('fuji_provia_100_generic', 'Fuji Provia 100'),
         ('fuji_velvia_100_generic', 'Fuji Velvia 100'), ('kodak_ektachrome_100_vs', 'Kodak Ektachrome 100 VS'),
         ('kodak_kodachrome_64', 'Kodak Kodachrome 64'), ('kodak_portra_160_vc', 'Kodak Portra 160 VC'),
         ('kodak_ektar_100', 'Kodak Ektar 100'), ('agfa_vista_200', 'Agfa Vista 200'),
         ('fuji_superia_200', 'Fuji Superia 200'), ('polaroid_669', 'Polaroid 669'),
         ('lomography_x-pro_slide_200', 'Lomography X-Pro 200'), ('lomography_redscale_100', 'Lomography Redscale 100')]
LIBRARY_SKIP = {'endesga32'}   # EP6 is endesga32, reworked (palettes.py PRESETS)
PRESET_FILMS = {'EP6': 'polaroid_690', '6FP': 'fuji_provia_100_generic', 'BW': None}
PRESET_CURVE = {'BW'}   # BW's look is the S-curve: BW_MATCH -> BW_LEVELS on luma
# The preview photos, in grid order (3 x 3): streets, natural, close-ups
# (images/ isn't committed; the results in site/editor/photos/ are). Each is
# cropped to 4:3, the camera's 4:3 photo, a bit above the centre if it's
# taller, so the grid lines up.
PHOTOS = ['images/editor/street_sign.jpg', 'images/editor/street_duck.jpg', 'images/editor/snail.jpg',
          'images/editor/hydrangeas.jpg', 'images/editor/mimosa.jpg', 'images/editor/turtle.jpg',
          'images/editor/cup.jpg', 'images/plain/IMG_0577.jpg', 'images/editor/dessert.jpg']
PHOTO_ASPECT = 4 / 3


def symbols(obj):
    out = subprocess.run([f'{LLVM}/llvm-nm', os.path.join(ROOT, 'build', 'obj', obj)],
                         check=True, capture_output=True, text=True).stdout
    return {name: int(addr, 16) for addr, _, name in (l.split() for l in out.splitlines() if len(l.split()) == 3)}


def wav_bytes(blob):
    """The RIFF file at the start of a resource slot (without the 0xFF padding)."""
    assert blob[:4] == b'RIFF'
    return blob[:8 + int.from_bytes(blob[4:8], 'little')]


def tag_png(Image, tag, paint):
    """The tag as draw_tag paints it: letters in the paint colours' lightest,
    outline in their darkest, the photo (here: transparent) elsewhere."""
    cells = P.tag_cells(tag)
    dark, light = (P.yuv_to_hex(paint[i]) for i in P.tag_colours(paint))
    img = Image.new('RGBA', (len(cells[0]), len(cells)), (0, 0, 0, 0))
    for y, row in enumerate(cells):
        for x, v in enumerate(row):
            if v:
                h = (dark, light)[v - 1]
                img.putpixel((x, y), tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (255,))
    return img


def build_template():
    env = {k: v for k, v in os.environ.items() if k not in ('PRESETS_JSON', 'SHUTTER_WAV', 'POWERON_WAV')}
    env['SILENT'] = '1'
    subprocess.run(['sh', 'tools/build.sh'], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    shutil.copy(os.path.join(ROOT, 'build', 'GP_CARDVR_UPGRADE.BIN'), os.path.join(SITE, TEMPLATE))
    return open(os.path.join(SITE, TEMPLATE), 'rb').read()


def manifest(fw):
    photo, lcd, data = symbols('photo_cave.o'), symbols('lcd_cave.o'), symbols('preset_data.o')
    video = symbols('video_cave.o')
    for label, key in (('MATCH_PALETTES', 'MATCH'), ('PRESET_MATCH', 'PMATCH'), ('TAGS', 'TAGS'),
                       ('DISPLAY', 'DISPLAY'), ('DISPLAY_PTRS', 'DPTRS'), ('PRESET_FX', 'FX'),
                       ('PRESET_DATA_END', 'END')):
        assert data[label] == P.PD[key], f'{label} at {data[label]:#x}, palettes.py PD says {P.PD[key]:#x}'
    npal = [photo[k] for k in ('npal_fill', 'npal_pick1', 'npal_pick2', 'npal_pick3')] + \
           [lcd[k] for k in ('npal_lcd', 'npal_lcd2')]
    npal1 = [photo['npal1_fill']] + [lcd[k] for k in ('npal1_center', 'npal1_normal')]
    mode_max = [photo['max_fill']] + [lcd[k] for k in ('max_lcd', 'max_center', 'max_normal')]
    n = len(P.builtin_config()['presets'])
    for a in npal:                       # data-processing immediate, rotation 0: the low byte is NPAL
        assert fw[APP + a] == n and fw[APP + a + 1] & 0x0f == 0, f'{a:#x} is not an immediate {n}'
    for a in npal1 + mode_max:           # NPAL + 1 = the last mode, the normal one (on)
        assert fw[APP + a] == n + 1 and fw[APP + a + 1] & 0x0f == 0, f'{a:#x} is not an immediate {n + 1}'
    assert fw[APP + lcd['last_center']] == n                       # NPAL - 1 + RND_MODE, rnd on
    assert fw[APP + lcd['after_last']] == n + 1                    # then the normal mode
    table = [int.from_bytes(fw[APP + photo['SIZES'] + 4 * i:APP + photo['SIZES'] + 4 * i + 4], 'little')
             for i in range(16)]
    assert table == [x for c, o in P.SIZES.values() for x in (*o, *c)], table   # W, H, CW, CH per aspect
    cmp = int.from_bytes(fw[APP + video['cmp_max_w']:APP + video['cmp_max_w'] + 4], 'little')
    assert cmp >> 20 == 0xe35, f'{cmp:#x} is not cmp rN, #imm'                    # cmp r1, #MAX_W
    for addr, _ in SPEAKER:
        assert fw[APP + addr:APP + addr + 4].hex() == NOP          # silent: speaker never on
    slots = {f'{name}.{ext}'.upper(): (s, e) for name, ext, s, e in parse(fw)}
    return {
        'file': TEMPLATE,
        'size': len(fw),
        'sha256': hashlib.sha256(fw).hexdigest(),
        'appOffset': APP,
        'maxPresets': P.MAX_PRESETS,
        'maxColours': P.NMAX,
        'pd': P.PD,
        'fx': {'bytes': P.FX_BYTES, 'contrast': P.CONTRAST_RANGE, 'brightness': P.BRIGHTNESS_RANGE},
        'tag': {'letters': P.TAG_LETTERS, 'rows': P.TAG_ROWS, 'cols': P.TAG_COLS, 'bytes': P.TAG_BYTES,
                'scale': P.TAG_SCALE, 'top': P.TAG_TOP, 'right': P.TAG_RIGHT},
        'font': P.FONT,
        'lcdTags': lcd['LCD_TAGS'],
        'ssFirst': P.SS_FIRST,
        'ssCount': P.SS_COUNT,
        'ssCells': P.SS_CELLS,
        'rndLcd': P.lcd_segments(P.RND),
        'norLcd': P.lcd_segments(P.NORMAL),
        'npal': npal,
        'npal1': npal1,
        'modeMax': mode_max,
        'lastCenter': lcd['last_center'],
        'afterLast': lcd['after_last'],
        'speaker': [[addr, on, NOP] for addr, on in SPEAKER],
        'slots': {'shutter': slots['CAMERA.WAV'], 'poweron': slots['POWERON_AUDIO.WAV'],
                  'click': slots['CLICK.WAV']},
        'wav': {'rate': 11025, 'channels': 1, 'bits': 16},
        'sizes': {k: v[1] for k, v in P.SIZES.items()},
        'crops': {k: v[0] for k, v in P.SIZES.items()},
        'stockCrops': P.STOCK_CROPS,
        'sizeLimits': P.SIZE_LIMITS,
        'sizeTable': photo['SIZES'],      # per aspect, in 'sizes' order: W, H, CW, CH words
        'maxWCmp': video['cmp_max_w'],    # cmp r1, #MAX_W (widest output)
        'wy': P.WY,
        'defaults': P.builtin_config(),
    }


def library():
    assert {f for _, _, f in P.PRESETS if f} <= {f for f, _ in FILMS}
    palettes = [{'name': f'{p["tag"]}', 'tag': p['tag'], 'colours': p['match'],
                 'film': PRESET_FILMS[p['tag']], 'curve': p['tag'] in PRESET_CURVE, 'lcd': p['lcd']}
                for p in P.builtin_config()['presets']]
    for name, hexes in P.BASE.items():
        if name in LIBRARY_SKIP:
            continue
        base = [list(P.hex_to_yuv(h)) for h in dict.fromkeys(hexes)]
        palettes.append({'name': f'{name} ({len(base)})', 'tag': P.TAG[name], 'colours': base, 'film': None, 'curve': False})
    films = [{'id': f, 'name': name, 'file': f'films/{f}.png'} for f, name in FILMS]
    curve = [[0, 0]] + [list(p) for p in zip(P.BW_MATCH, P.BW_LEVELS)][1:-1] + [[255, 255]]
    return {'palettes': palettes, 'films': films, 'curve': curve}


def main():
    for d in ('sounds', 'photos', 'films'):
        os.makedirs(os.path.join(SITE, d), exist_ok=True)
    fw = build_template()
    luts = {os.path.splitext(os.path.basename(f))[0]: f for f in glob.glob(os.path.join(ROOT, 'film_luts', '*', '*.png'))}
    for f, _ in FILMS:
        shutil.copy(luts[f], os.path.join(SITE, 'films', f'{f}.png'))
    json.dump(manifest(fw), open(os.path.join(SITE, 'template.json'), 'w'), indent=1)
    with open(os.path.join(SITE, 'library.json'), 'w') as f:
        json.dump(library(), f, separators=(',', ':'))
        f.write('\n')

    orig = open(ORIG, 'rb').read()
    slots = {f'{name}.{ext}'.upper(): (s, e) for name, ext, s, e in parse(orig)}
    for res, out in (('CAMERA.WAV', 'stock_shutter.wav'), ('POWERON_AUDIO.WAV', 'stock_poweron.wav')):
        s, e = slots[res]
        open(os.path.join(SITE, 'sounds', out), 'wb').write(wav_bytes(orig[s:e]))
    s, e = slots['CLICK.WAV']
    open(os.path.join(SITE, 'sounds', 'stock_click.wav'), 'wb').write(orig[s:e])
    shutil.copy(os.path.join(ROOT, 'build', 'kick_11k.wav'), os.path.join(SITE, 'sounds', 'mario_shutter.wav'))
    shutil.copy(os.path.join(ROOT, 'build', 'coin_11k.wav'), os.path.join(SITE, 'sounds', 'mario_poweron.wav'))

    from PIL import Image
    tags = os.path.join(ROOT, 'site', 'img', 'tags')
    os.makedirs(tags, exist_ok=True)
    for p in P.builtin_config()['presets']:
        tag_png(Image, p['tag'], p['paint']).save(os.path.join(tags, f'{p["tag"]}.png'))
    # rnd and nor have no palette of their own: black and white
    for tag in (P.RND, P.NORMAL):
        tag_png(Image, tag, [(0, 128, 128), (255, 128, 128)]).save(os.path.join(tags, f'{tag}.png'))
    for old in glob.glob(os.path.join(SITE, 'photos', '*')):
        os.remove(old)
    for src in PHOTOS:
        img = Image.open(os.path.join(ROOT, src)).convert('RGB')
        w, h = img.size
        if w / h < PHOTO_ASPECT:                           # too tall: keep a bit above the centre
            ch = round(w / PHOTO_ASPECT)
            top = round((h - ch) * 0.4)
            img = img.crop((0, top, w, top + ch))
        elif w / h > PHOTO_ASPECT:                         # too wide: keep the middle
            cw = round(h * PHOTO_ASPECT)
            img = img.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h))
        img.thumbnail((800, 800), Image.LANCZOS)        # the camera's sizes are at most 704 wide
        name = os.path.splitext(os.path.basename(src))[0].lstrip('_') + '.jpg'
        img.save(os.path.join(SITE, 'photos', name), quality=88)
    print(f'template {TEMPLATE}: {len(fw)} B, sha256 {hashlib.sha256(fw).hexdigest()[:16]}...')


if __name__ == '__main__':
    main()
