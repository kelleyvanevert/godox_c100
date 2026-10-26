#!/usr/bin/env python3
"""Run the built photo cave in an ARM emulator and check it against the sim.

Loads build/GP_CARDVR_UPGRADE.BIN, stubs the firmware calls the cave makes
(cache maintenance, pvPortMalloc), then:
  1. sets the preset mode byte (each fixed preset, a repeat, rnd, and an
     out-of-range value, which must act as the first preset), then runs
     idx_stub (the per-photo entry), which picks the preset and fills the
     lookup table, or keeps it when the preset didn't change (checked by
     counting the fill's inner loop); the normal mode (if on) must turn the
     hook off;
  2. packs 640x64 slices of a photo into strips in the camera's YUV 4:2:0
     layout (see docs/c100-firmware.md) and runs the strip hook
     on two of them;
  3. unpacks each strip and checks that every 2x2 block is exactly the colour
     the sim expects: sim_palette.py's pick in the preset's match palette (same
     WY, table and the preset's contrast and brightness), painted with the
     preset's film colour; including the preset tag on the photo's first strip
     and not on the second. In the normal mode the strips must come back
     untouched.

It does this at every photo output width (palettes.py SIZES; all modes
at the first, one pass over the presets at the others), and reports the
hook's instructions per 64-row strip (at the measured ~310 M instructions/s,
roughly its time in the interrupt).

Usage: uv run --with unicorn,numpy,pillow tools/emu_cave.py PHOTO.jpg
"""
import os, struct, subprocess, sys
import numpy as np
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_BLOCK, UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_SP
from palettes import LUT, SIZES, WY, config
from sim_palette import add_tag, match, prepare

FW = 'build/GP_CARDVR_UPGRADE.BIN'
APP = 0x10200                       # file offset of RAM address 0
RESUME, RESUME187 = 0x1544c, 0x187c8
CACHE_INV, CACHE_CLEAN, MALLOC = 0x401ac, 0x401b8, 0x5374c
PHOTO, STRIP_BYTES, TICK = 0x1317ac, 0x13155c, 0x126b80
CFG_MODE = 0x132160 + 0xf1          # the preset mode byte in the camera's saved settings
STRIP_A, HEAP, STACK = 0x400000, 0x800000, 0xf00000
W, ROWS = 640, 64


def symbols(obj='build/obj/photo_cave.o'):
    nm = next(p for p in ('/opt/homebrew/opt/llvm/bin/llvm-nm', '/opt/homebrew/opt/llvm@18/bin/llvm-nm')
              if os.path.exists(p))
    out = subprocess.run([nm, obj], capture_output=True, text=True,
                         check=True).stdout
    return {parts[2]: int(parts[0], 16) for parts in map(str.split, out.splitlines()) if len(parts) == 3}


def machine():
    uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    uc.mem_map(0, 0x1000000)
    uc.mem_write(0, open(FW, 'rb').read()[APP:APP + 0x200000])
    calls = []

    def on_code(uc, addr, size, _):
        if addr in (CACHE_INV, CACHE_CLEAN, MALLOC):
            calls.append((addr, uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1)))
            if addr == MALLOC:
                uc.reg_write(UC_ARM_REG_R0, HEAP)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr in (RESUME, RESUME187):
            uc.emu_stop()
    uc.hook_add(UC_HOOK_CODE, on_code)
    return uc, calls


def run(uc, entry, r0=0, r1=0):
    uc.reg_write(UC_ARM_REG_SP, STACK)
    uc.reg_write(UC_ARM_REG_R0, r0)
    uc.reg_write(UC_ARM_REG_R1, r1)
    uc.emu_start(entry, 0xffffffff, count=200_000_000)
    return uc.reg_read(UC_ARM_REG_PC)


def pack(ycc):
    """640x64 YCbCr (H, W, 3) -> one strip: per 2-row band, even row = luma +
    first half of the chroma pairs, odd row = second half + luma."""
    third, stride = W // 2, W * 3 // 2
    blk = (ycc.astype(int).reshape(ROWS // 2, 2, W // 2, 2, 3).sum(axis=(1, 3)) // 4).astype(np.uint8)  # as sim
    out = bytearray()
    for b in range(ROWS // 2):
        uv = blk[b, :, 1:].reshape(-1)                 # U,V per pair, W/2 pairs
        half = len(uv) // 2
        out += bytes(ycc[2 * b, :, 0]) + bytes(uv[:half])
        out += bytes(uv[half:]) + bytes(ycc[2 * b + 1, :, 0])
    assert len(out) == stride * ROWS
    return bytes(out)


def unpack(buf):
    third, stride = W // 2, W * 3 // 2
    Y = np.zeros((ROWS, W), np.uint8)
    UV = np.zeros((ROWS // 2, W // 2, 2), np.uint8)
    for b in range(ROWS // 2):
        even = np.frombuffer(buf, np.uint8, stride, 2 * b * stride)
        odd = np.frombuffer(buf, np.uint8, stride, (2 * b + 1) * stride)
        Y[2 * b], Y[2 * b + 1] = even[:2 * third], odd[third:]
        UV[b] = np.concatenate([even[2 * third:], odd[:third]]).reshape(-1, 2)
    return Y, UV


def differing(Y, UV, want):
    """Per 2x2 block: not exactly the wanted (Y,U,V) (all 4 luma equal to it)."""
    Yb = Y.reshape(ROWS // 2, 2, W // 2, 2).transpose(0, 2, 1, 3).reshape(ROWS // 2, W // 2, 4)
    return ((Yb != want[..., :1]).any(-1) | (UV != want[..., 1:]).any(-1))


def main():
    global W
    photo = sys.argv[1]
    sym = symbols()
    cfg = config()                                    # as build.sh built them (PRESETS_JSON)
    pre = cfg['presets']
    rnd = len(pre)                                    # MODE value for random
    nor = [rnd + 1] if cfg.get('normal') else []      # and for the normal mode
    tags = cfg.get('tags', True)
    uc, calls = machine()
    fill, steps = [0], [0]
    uc.hook_add(UC_HOOK_CODE, lambda *_: fill.__setitem__(0, fill[0] + 1), begin=sym['sl'], end=sym['sl'])
    uc.hook_add(UC_HOOK_BLOCK, lambda uc_, addr, size, _: steps.__setitem__(0, steps[0] + size // 4))
    kinds = {CACHE_INV: 'inv', CACHE_CLEAN: 'clean', MALLOC: 'malloc'}
    worst, table, ok, n = 0, None, True, 0           # table: the preset the table holds, while on
    widths = sorted({o[0] for _, o in SIZES.values()}, reverse=True)
    all_modes = list(range(rnd)) + [0, 0, 2, 2] + [rnd] * 6 + nor + [1, 0x37] + nor + [1]   # 0x37: not a mode = the first
    for W in widths:
      src = prepare(photo, W)
      per_strip = []
      print(f'-- photo width {W}')
      for mode in (all_modes if W == widths[0] else list(range(rnd)) + nor):
        n += 1
        uc.mem_write(TICK, struct.pack('<I', 100 + 37 * n))
        uc.mem_write(CFG_MODE, bytes([mode]))
        calls.clear()
        fill[0] = 0
        assert run(uc, sym['idx_stub']) == RESUME187
        cur_pal = struct.unpack('<I', uc.mem_read(sym['VARS'] + 4, 4))[0]
        normal = mode in nor
        idx = struct.unpack('<I', uc.mem_read(sym['VARS'] + 8, 4))[0] if mode == rnd else mode if mode < rnd else 0
        p = {'tag': 'nor', 'match': [], 'paint': []} if normal else pre[idx]
        tag, P, D = p['tag'], [tuple(c) for c in p['match']], [tuple(c) for c in p['paint']]
        want = idx != table if mode == rnd else True
        want &= (cur_pal == 0) == normal
        refilled = fill[0] > 0
        want_fill = not normal and idx != table
        ok &= want and refilled == want_fill
        table = None if normal else idx
        diffs = []
        for strip, top in enumerate((0, 200)):       # the photo's 1st and 2nd strip
            crop = src.crop((0, top, W, top + ROWS))
            uc.mem_write(STRIP_A, pack(np.asarray(crop.convert('YCbCr'))))
            uc.mem_write(PHOTO + 0x18, struct.pack('<I', STRIP_A))
            uc.mem_write(STRIP_BYTES, struct.pack('<I', W * 32 * 3 // 2))
            steps[0] = 0
            assert run(uc, sym['hook'], r0=0x300000, r1=STRIP_A) == RESUME
            per_strip.append(steps[0])
            out = bytes(uc.mem_read(STRIP_A, W * 3 // 2 * ROWS))
            if normal:                               # no effect: the strip as it was
                diffs.append(100.0 * (out != pack(np.asarray(crop.convert('YCbCr')))))
                continue
            Y, UV = unpack(out)
            # every 2x2 block must be exactly one palette colour, the one the sim picks
            ref = match(crop, P, wy=WY, lut=LUT, contrast=100 + p.get('contrast', 0), bright=p.get('brightness', 0))
            if strip == 0 and tags:
                add_tag(ref, tag, D)
            diffs.append(differing(Y, UV, np.array(D)[ref]).mean() * 100)
        worst = max(worst, *diffs)
        print(f'mode {"rnd" if mode == rnd else "nor" if normal else hex(mode)}: preset {"-" if normal else idx} {tag} '
              f'({"normal" if normal else f"{len(P)} colours"}, c{p.get("contrast", 0)} b{p.get("brightness", 0)})'
              f'{"" if want else " WRONG PRESET"}, table {"filled" if refilled else "kept"}'
              f'{"" if refilled == want_fill else " (WRONG)"}, blocks differing from sim: '
              f'strip 1 (tag) {diffs[0]:.2f}%, strip 2 {diffs[1]:.2f}%, '
              f'calls: {[kinds[a] for a, _, _ in calls]}')
      most = max(per_strip)
      print(f'   hook: up to {most / 1e6:.2f} M instructions per strip, ~{most / 310e3:.1f} ms at 310 MIPS')
    print('max difference', worst)
    print('preset selection and table reuse', 'PASSED' if ok else 'FAILED')
    sys.exit(0 if ok and worst == 0 else 1)


if __name__ == '__main__':
    main()
