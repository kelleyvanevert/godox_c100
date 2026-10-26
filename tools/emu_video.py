#!/usr/bin/env python3
"""Run the built video cave in an ARM emulator and check it against the sim.

Like emu_cave.py (whose strip packing and comparison it reuses), but for the
video hook (tools/patches/video_cave.s, build with VIDFX=1): each call of
FUN_00018d14 gets one 64-row strip in the photo strip layout. Checks that
  1. the first strip of a recording (>= 500 ms since the last one) picks a
     palette and fills the table, and every 2x2 block is exactly the palette
     colour sim_palette.py picks, with the palette tag on the first strip of
     every frame (a new timestamp argument) and nowhere else;
  2. the next strip, 8 ms later, reuses the table (no second allocation);
  3. a strip after a 1 s gap starts a new recording with a different palette;
  4. with VIDTIMING=1, the top 4 rows x < 256 are the timing bar (all black
     here: the emulated clock does not advance during the hook);
  5. the hook restores r0-r12/lr and resumes at 0x18d18 with r3 = venc[0];
  6. video of a width that isn't one of ours (1920, stock size) is left alone.
It does this at every output width (palettes.py SIZES) and estimates the
hook's share of each 33.3 ms frame from its instructions per strip (~310 M
instructions/s, measured) and the strips per frame (height / 64, rounded up:
a frame's last strip is a full buffer).

Usage: uv run --with unicorn,numpy,pillow tools/emu_video.py PHOTO.jpg [--timing]
  (--timing for a VIDTIMING=1 build)
"""
import math, struct, sys
import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_BLOCK, UC_HOOK_CODE
from unicorn.arm_const import *
import emu_cave
from emu_cave import FW, APP, CACHE_INV, CACHE_CLEAN, MALLOC, TICK, ROWS, pack, symbols, unpack, differing
from palettes import LUT, SIZES, WY, config
from sim_palette import add_tag, match, prepare

RESUME = 0x18d18
VENC, STRIP, HEAP, STACK = 0x131490, 0x3e9a00, 0x800000, 0xf00000   # STRIP: a pool buffer, untagged
SAVED = [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R4, UC_ARM_REG_R5, UC_ARM_REG_R6,
         UC_ARM_REG_R7, UC_ARM_REG_R8, UC_ARM_REG_R9, UC_ARM_REG_R10, UC_ARM_REG_R11, UC_ARM_REG_R12,
         UC_ARM_REG_LR]


def machine(width):
    uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    uc.mem_map(0, 0x1000000)
    uc.mem_write(0, open(FW, 'rb').read()[APP:APP + 0x200000])
    venc = bytearray(0x200)
    struct.pack_into('<I', venc, 0, 1)
    venc[0x101] = 0x23
    struct.pack_into('<I', venc, 8, STRIP | 0x30000000)
    struct.pack_into('<I', venc, 0xdc, width)
    uc.mem_write(VENC, bytes(venc))
    calls = []

    def on_code(uc, addr, size, _):
        if addr in (CACHE_INV, CACHE_CLEAN, MALLOC):
            calls.append({CACHE_INV: 'inv', CACHE_CLEAN: 'clean', MALLOC: 'malloc'}[addr])
            if addr == MALLOC:
                uc.reg_write(UC_ARM_REG_R0, HEAP)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr == RESUME:
            uc.emu_stop()
    uc.hook_add(UC_HOOK_CODE, on_code)
    count = [0]
    uc.hook_add(UC_HOOK_BLOCK, lambda uc_, addr, size, _: count.__setitem__(0, count[0] + size // 4))
    return uc, calls, count


def run_strip(uc, entry, tick, ts=0x1004):
    uc.mem_write(TICK, struct.pack('<I', tick))
    regs = {r: 0x1000 + 4 * i for i, r in enumerate(SAVED)}
    regs[UC_ARM_REG_R0] = VENC
    regs[UC_ARM_REG_R1] = ts
    for r, v in regs.items():
        uc.reg_write(r, v)
    uc.reg_write(UC_ARM_REG_SP, STACK)
    uc.emu_start(entry, 0xffffffff, count=200_000_000)
    assert uc.reg_read(UC_ARM_REG_PC) == RESUME, 'did not resume at 0x18d18'
    assert all(uc.reg_read(r) == v for r, v in regs.items()), 'registers not restored'
    assert uc.reg_read(UC_ARM_REG_R3) == 1, 'r3 != venc[0]'


def main():
    photo, timing = sys.argv[1], '--timing' in sys.argv[2:]
    psym, vsym = symbols(), symbols('build/obj/video_cave.o')
    cfg = config()                                    # as build.sh built them (PRESETS_JSON)
    pre, tags = cfg['presets'], cfg.get('tags', True)
    worst = 0
    for aspect, (_, (W, H)) in SIZES.items():
        emu_cave.W = W                                    # pack/unpack/differing use it
        print(f'-- {aspect} video, {W}x{H}')
        per_strip = run_width(photo, W, timing, psym, vsym, pre, tags)
        worst = max(worst, per_strip[0])
        strips = math.ceil(H / ROWS)
        ms = strips * per_strip[1] / 310e3
        print(f'   hook: {per_strip[1] / 1e6:.2f} M instructions per strip, x {strips} strips = '
              f'~{ms:.1f} ms per frame, {100 * ms / 33.3:.0f}% of 33.3 ms')
    # a width that isn't one of ours (stock full-size video): untouched
    emu_cave.W = 640
    uc, calls, _ = machine(1920)
    before = pack(np.asarray(prepare(photo, 640).crop((0, 0, 640, ROWS)).convert('YCbCr')))
    uc.mem_write(STRIP, before)
    run_strip(uc, vsym['vhook'], 5000, 0x900)
    untouched = bytes(uc.mem_read(STRIP, len(before))) == before and not calls
    print('1920-wide video left alone:', untouched)
    print('max difference', worst)
    sys.exit(0 if worst == 0 and untouched else 1)


def run_width(photo, W, timing, psym, vsym, pre, tags):
    """(worst % differing, most instructions per strip) at one width."""
    STRIDE = W * 3 // 2
    src = prepare(photo, W)
    uc, calls, count = machine(W)
    uc.mem_write(0x132160 + 0xf1, bytes([len(pre)]))   # mode byte = rnd: a new preset per recording
    worst, last_idx, most = 0, None, 0
    #        label           tick  timestamp  photo row  tag expected
    steps = (('new recording', 1000, 0x100, 0, True), ('next strip', 1008, 0x100, 64, False),
             ('next frame', 1016, 0x121, 200, True), ('next strip', 1024, 0x121, 264, False),
             ('new recording', 2100, 0x500, 0, True), ('next strip', 2108, 0x500, 300, False))
    for label, tick, ts, top, tagged in steps:
        crop = src.crop((0, top, W, top + ROWS))
        uc.mem_write(STRIP, pack(np.asarray(crop.convert('YCbCr'))))
        calls.clear()
        count[0] = 0
        run_strip(uc, vsym['vhook'], tick, ts)
        most = max(most, count[0]) if label != 'new recording' else most   # without the table fill
        idx = struct.unpack('<I', uc.mem_read(psym['VARS'] + 8, 4))[0]
        p = pre[idx]
        tag, P, D = p['tag'], [tuple(c) for c in p['match']], [tuple(c) for c in p['paint']]
        Y, UV = unpack(bytes(uc.mem_read(STRIP, STRIDE * ROWS)))
        ref = match(crop, P, wy=WY, lut=LUT, contrast=100 + p.get('contrast', 0), bright=p.get('brightness', 0))
        if tagged and tags:
            add_tag(ref, tag, D)
        bar = np.zeros(ref.shape, bool)
        if timing:
            bar[:2, :128] = True
            assert (Y[:4, :256] == 16).all() and (UV[:2, :128] == 128).all(), 'timing bar wrong'
        diff = differing(Y, UV, np.array(D)[ref])[~bar].mean() * 100
        worst = max(worst, diff)
        if label == 'new recording':
            assert last_idx is None or idx != last_idx, 'new recording kept the preset'
        else:
            assert idx == last_idx and 'malloc' not in calls, 'table rebuilt mid-recording'
        last_idx = idx
        print(f'tick {tick:5} {label:13}: preset {idx} {tag} ({len(P)} colours), '
              f'{"tag, " if tagged else ""}blocks differing from sim {diff:.2f}%, calls {calls}'
              f'{", timing bar ok" if timing else ""}')
    return worst, most


if __name__ == '__main__':
    main()
