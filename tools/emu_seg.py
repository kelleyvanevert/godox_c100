#!/usr/bin/env python3
"""Run the transparent-display (HT1621 segment LCD) code in an ARM emulator.

Loads the factory firmware, hooks the GPIO write routine (FUN_000433f4) and
decodes what goes out on CS=0x28 / WR=0x29 / DATA=0x2a back into HT1621
commands and RAM writes, so the segment map in docs/c100-firmware.md comes
from the real code rather than from the decompiler.

With a build that has the preset mode (LCDTAG=1, e.g.
build/GP_CARDVR_UPGRADE.BIN) it also runs that feature end to end: center
button presses through the stock key handler cycle the presets and rnd in
photo and video mode (and still post the stock messages), the SS cells show
the mode, captures use it, presses while recording or in the readout state
change nothing, everything outside the SS cells matches the factory refresh,
and the readout state is fully stock.

Usage: uv run --with unicorn tools/emu_seg.py [FIRMWARE.BIN]
"""
import os, subprocess, struct, sys
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm_const import (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3,
                               UC_ARM_REG_LR, UC_ARM_REG_PC, UC_ARM_REG_SP)

FW = sys.argv[1] if len(sys.argv) > 1 else 'build_backups/v001_original.bin'
APP = 0x10200                       # file offset of RAM address 0
CS, WR, DATA = 0x28, 0x29, 0x2a
GPIO_WRITE = 0x433f4
STUBS = {0x43314, 0x4352c, 0x43468,  # GPIO direction / pull setup
         0x48990, 0x49d48,           # busy-wait delays
         0x53758}                    # printf
SHADOW, NIB = 0x1240e0, 25          # firmware's copy of the HT1621 RAM
LOGO_FLAG = 0xf187e                 # 1 = sensor preview init failed
STACK, RET = 0xf00000, 0xfffff0
MALLOC, HEAP = 0x5374c, 0x800000    # pvPortMalloc, for lut_fill's table


class Ht1621:
    """Rebuild HT1621 frames from the bit-banged pins."""
    def __init__(self):
        self.pins = {CS: 1, WR: 1, DATA: 1}
        self.bits, self.ram, self.cmds, self.writes = [], [0] * 32, [], []

    def gpio(self, pin, val):
        old = self.pins.get(pin)
        self.pins[pin] = val
        if pin == WR and old == 0 and val == 1 and self.pins[CS] == 0:
            self.bits.append(self.pins[DATA])
        elif pin == CS and old == 0 and val == 1:
            self.frame(self.bits)
            self.bits = []

    def frame(self, b):
        num = lambda bits: int(''.join(map(str, bits)), 2)
        if b[:3] == [1, 0, 0]:
            self.cmds.append(num(b[3:11]))
        elif b[:3] == [1, 0, 1]:
            addr, rest = num(b[3:9]), b[9:]
            while len(rest) >= 4:   # D0 (COM0) is sent first; store as nibble bit 3
                self.ram[addr] = num(rest[:4])
                self.writes.append((addr, self.ram[addr]))
                addr, rest = addr + 1, rest[4:]
        else:
            raise ValueError(f'unknown HT1621 frame {b}')


def machine():
    uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
    uc.mem_map(0, 0x1000000)
    uc.mem_write(0, open(FW, 'rb').read()[APP:APP + 0x200000])
    uc.mem_write(SHADOW, bytes(NIB))
    lcd = Ht1621()
    unknown = set()

    def on_code(uc, addr, size, _):
        if addr == RET:
            uc.emu_stop()
        elif addr == GPIO_WRITE:
            lcd.gpio(uc.reg_read(UC_ARM_REG_R0), uc.reg_read(UC_ARM_REG_R1) & 1)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr in STUBS:
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
        elif addr == MALLOC:
            uc.reg_write(UC_ARM_REG_R0, HEAP)
            uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))
    uc.hook_add(UC_HOOK_CODE, on_code)
    return uc, lcd


def call(uc, entry, *args, count=5_000_000):
    regs = (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3)
    for r, v in zip(regs, args):
        uc.reg_write(r, v & 0xffffffff)
    uc.reg_write(UC_ARM_REG_SP, STACK)
    uc.reg_write(UC_ARM_REG_LR, RET)
    uc.emu_start(entry, 0xffffffff, count=count)


def shadow(uc):
    return list(uc.mem_read(SHADOW, NIB))


def lit(ram):
    """Set of (address, COM) for every lit segment; nibble bit 3 = COM0."""
    return {(a, c) for a in range(NIB) for c in range(4) if ram[a] >> (3 - c) & 1}


def fmt(segs):
    return ' '.join(f'{a:02x}.{c}' for a, c in sorted(segs)) or '-'


if __name__ == '__main__':
    uc, lcd = machine()

    # Boot: HT1621 init as called by the display task at 0xe0dc.
    call(uc, 0x4ad68)
    print('init commands:', ' '.join(f'{c:02x}' for c in lcd.cmds))
    print('after init lit:', fmt(lit(lcd.ram)))
    assert lcd.ram[:NIB] == shadow(uc), 'shadow RAM and panel disagree'

    # Logo helper 0x4a64c(on).
    for on in (0, 1):
        call(uc, 0x4a64c, on)
        print(f'logo helper({on}): lit {fmt(lit(lcd.ram))}')

    # Mode/logo routine FUN_0004a670(arg) with the sensor-failed flag 0 and 1.
    for flag in (0, 1):
        for arg in (0, 1):
            call(uc, 0x4a64c, 1)                     # start from the boot state
            uc.mem_write(LOGO_FLAG, bytes([flag]))
            call(uc, 0x4a670, arg)
            print(f'FUN_0004a670({arg}) sensor_failed={flag}: nibble 0x16 = {lcd.ram[0x16]:x}')
    uc.mem_write(LOGO_FLAG, b'\0')

    # Aspect marker FUN_0004a7f4(hide, aspect).
    for hide in (0, 1):
        for asp in range(6):
            call(uc, 0x4a7f4, hide, asp)
            on = {s for s in lit(lcd.ram) if s[0] in (0x06, 0x15)}
            print(f'aspect({hide},{asp}): {fmt(on)}')

    # Digit routines: each digit 0..9 (10 = blank) should light the usual
    # 7-segment count, and the segments used should form one 7-segment cell.
    SEVEN = [6, 2, 5, 5, 4, 5, 6, 3, 7, 6]
    digits = {'FUN_00049ea8 (0,1,2)': (0x49ea8, (0, 1, 2, 0, 0)),
              'FUN_00049ea8 (3,4,5)': (0x49ea8, (3, 4, 5, 0, 0)),
              'FUN_0004a4ec (7,8,9)': (0x4a4ec, (0,)),
              'FUN_0004a074 (9,a,b)': (0x4a074, (9, 10, 11, 0)),
              'FUN_0004a374 (d,e,f)': (0x4a374, (0,)),
              'FUN_0004a1f0 (f,10,11)': (0x4a1f0, (0, 0)),
              'FUN_0004a074 (11,12,13)': (0x4a074, (0x11, 0x12, 0x13, 0))}
    fonts = {}
    for name, (entry, rest) in digits.items():
        counts, used, patterns = [], set(), []
        for dgt in range(11):
            uc.mem_write(SHADOW, bytes(NIB))
            call(uc, 0x4ad30)                        # clear the panel
            call(uc, entry, dgt, *rest)
            segs = lit(lcd.ram)
            counts.append(len(segs))
            used |= segs
            patterns.append(segs)
        ok = counts[:10] == SEVEN or counts[:10] == [6, 2, 5, 5, 4, 5, 6, 4, 7, 6]
        print(f'{name}: counts {counts} -> {"7-seg" if ok and counts[10] == 0 else "??"}, cell {fmt(used)}')
        fonts[name] = (used, {frozenset(p): (str(dg) if dg < 10 else "_") for dg, p in enumerate(patterns)})

    # Whole periodic refresh FUN_00021318 with the manual-exposure tables
    # (flags set so ISO/F/SS come from the tables, not the live meter).
    CFG = 0x132160
    def refresh(state, aspect, iso, f_idx, ss_idx, battery_adc=0x400):
        uc.mem_write(SHADOW, bytes(NIB)); call(uc, 0x4ad30)
        uc.mem_write(0x121706, bytes([state]))      # UI state
        uc.mem_write(0x1217be, b'\1')               # past the 5 startup ticks
        uc.mem_write(0x1217b0, b'\1')               # this tick does mode/aspect/battery
        uc.mem_write(CFG + 0xf, bytes([aspect]))
        uc.mem_write(0xe3279, b'\1'); uc.mem_write(CFG + 0xec, struct.pack('<H', iso))
        uc.mem_write(0xe3278, b'\1'); uc.mem_write(CFG + 0xeb, bytes([f_idx]))
        uc.mem_write(0x12170b, b'\1'); uc.mem_write(CFG + 0xea, bytes([ss_idx]))
        call(uc, 0x21318)
        return lit(lcd.ram)
    def read(segs):
        """Digits shown in each cell, plus the lit segments outside any cell."""
        out, rest = [], set(segs)
        for name, (cell, font) in fonts.items():
            out.append(font.get(frozenset(segs & cell), ' ' if not segs & cell else '?'))
            rest -= cell
        return ''.join(out), rest
    for state in (0, 1, 2):
        segs = refresh(state, 1, 400, 15, 11)       # ISO 400, F5.6, SS 1/25
        dg, rest = read(segs)
        print(f'refresh state={state} aspect=1 ISO400 F5.6 SS1/25: digits [{dg}] other {fmt(rest)}')
    for iso, fi, si, label in [(200, 15, 11, 'ISO200 F5.6 SS1/25'), (1600, 9, 18, 'ISO1600 F2.8 SS1/125'),
                               (100, 21, 21, 'ISO100 F11 SS1/250'), (400, 9, 27, 'ISO400 F2.8 SS1/1000'), (3200, 12, 36, 'ISO3200 F4.0 SS1/8000')]:
        dg, rest = read(refresh(2, 1, iso, fi, si))
        print(f'  state=2 {label}: digits [{dg}] other {fmt(rest)}')
    for state in (0, 2):
        for asp in (1, 2, 3, 4):
            segs = refresh(state, asp, 400, 15, 11)
            print(f'  state={state} aspect={asp}: 06.0={int((6,0) in segs)} 15.x={fmt({s for s in segs if s[0]==0x15})}')

    # Boot sequence: HT1621 init, then the periodic refresh from a cold start
    # (startup counter 0x12170c, skip flag 0x1217be, tick counter 0x1217b0 all 0).
    uc2, lcd2 = machine()
    call(uc2, 0x4ad68)
    for addr, val in [(0x121706, 2), (0x1217be, 0), (0x12170c, 0), (0x1217b0, 0), (CFG + 0xf, 1),
                      (0xe3279, 1), (0xe3278, 1), (CFG + 0xeb, 15), (0x12170b, 1), (CFG + 0xea, 11)]:
        uc2.mem_write(addr, bytes([val]))
    uc2.mem_write(CFG + 0xec, struct.pack('<H', 200))
    uc, lcd = uc2, lcd2                              # read() uses the fonts only
    print('boot: after init', fmt(lit(lcd2.ram)))
    for tick in range(1, 9):
        call(uc2, 0x21318)
        dg, rest = read(lit(lcd2.ram))
        print(f'boot: refresh {tick}: logo={"on " if (0x16, 1) in lit(lcd2.ram) else "off"} '
              f'digits [{dg}] other {fmt(rest - {(0x16, 1)})}')

    # ---- Preset mode: center button + code on the display (builds with LCDTAG=1) ----
    word = struct.unpack('<I', open(FW, 'rb').read()[APP + 0x21218:APP + 0x2121c])[0]
    if word >> 24 == 0xea and 0xbc400 <= (0x21218 + 8 + (word & 0xffffff) * 4) & 0xffffffff < 0xbc744:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import palettes
        nm = next(p for p in ('/opt/homebrew/opt/llvm/bin/llvm-nm', '/opt/homebrew/opt/llvm@18/bin/llvm-nm')
                  if os.path.exists(p))
        syms = {f[2]: int(f[0], 16) for f in map(str.split, subprocess.run(
            [nm, 'build/obj/photo_cave.o'], capture_output=True, text=True, check=True).stdout.splitlines())
            if len(f) == 3}
        VARS, LUT_FILL = syms['VARS'], syms['lut_fill']
        PAL_IDX = VARS + 8
        MODE, DIRTY = CFG + 0xf1, CFG + 0xa0           # mode byte, settings dirty flag
        TICK, REC_FLAGS = 0x126b80, 0x132abb
        CENTER_KEY, KEY_LATCH, MSG_POST, PRESS = 0x1dd6c, 0x1217bc, 0x42c, 0x700000   # F key handler
        # The center button is the key whose message the readout state cycles
        # ISO/F/SS on: `*0x372bc + 1` in FUN_000362b8 (the arrows are -1/+1 there).
        CYCLE_MSG = struct.unpack('<I', open(FW, 'rb').read()[APP + 0x372bc:APP + 0x372c0])[0] + 1
        STOCK_POSTS = ['0x7018', hex(CYCLE_MSG)]
        cfg = palettes.config()                        # as build.sh built them (PRESETS_JSON)
        pre = cfg['presets']
        NOR = len(pre) + 1                             # the normal mode's byte
        # the center button's cycle: the presets, rnd, the normal mode (those two if on)
        modes = list(range(len(pre))) + [len(pre)] * cfg['rnd'] + [NOR] * cfg.get('normal', False)
        code = lambda mode: pre[mode]['tag'] if mode < len(pre) else palettes.RND if mode == len(pre) else palettes.NORMAL
        segments = lambda mode: pre[mode]['lcd'] if mode < len(pre) else palettes.lcd_segments(code(mode))
        lcd_text = lambda mode: ''.join(glyph[frozenset(s)] for s in segments(mode))
        SS = set(range(palettes.SS_FIRST, palettes.SS_FIRST + palettes.SS_COUNT))
        glyph = {frozenset(segs): name for name, segs in palettes.SEG7.items()}
        glyph[frozenset()] = ' '

        def shown(segs):
            """The glyphs on the three SS cells, e.g. 'EP6' or '8W<W>'."""
            text = ''
            for cell in palettes.SS_CELLS:
                on = frozenset(seg for seg, ac in cell.items() if ac in segs)
                text += glyph.get(on, '?' if on else ' ')
            return text

        def run(fw_uc, lcd_, state, rec=0):
            for addr, val in [(0x121706, state), (0x1217be, 1), (0x1217b0, 1), (REC_FLAGS, rec),
                              (0xe3279, 1), (CFG + 0xeb, 15), (0x12170b, 1), (CFG + 0xea, 11)]:
                fw_uc.mem_write(addr, bytes([val]))
            fw_uc.mem_write(CFG + 0xec, struct.pack('<H', 400))
            call(fw_uc, 0x21318)
            return lit(lcd_.ram)

        FW_STOCK = FW
        FW = 'build_backups/v001_original.bin'
        stock_uc, stock_lcd = machine()               # the factory refresh, for comparison
        FW = FW_STOCK
        uc, lcd = machine()
        posts = []
        def on_post(uc_, addr, size, _):
            posts.append(uc_.reg_read(UC_ARM_REG_R1))
            uc_.reg_write(UC_ARM_REG_PC, uc_.reg_read(UC_ARM_REG_LR))
        uc.hook_add(UC_HOOK_CODE, on_post, begin=MSG_POST, end=MSG_POST)
        word32 = lambda a: struct.unpack('<I', uc.mem_read(a, 4))[0]

        def tick_refresh(state, rec=0):
            segs = run(uc, lcd, state, rec)
            stock = run(stock_uc, stock_lcd, state, rec)
            return segs, {sg for sg in segs ^ stock if sg[0] not in SS}

        def press(state, rec=0):
            """A short press of the center button, through the stock key handler."""
            uc.mem_write(0x121706, bytes([state]))
            uc.mem_write(REC_FLAGS, bytes([rec]))
            uc.mem_write(KEY_LATCH, b'\0')           # released since the last press
            uc.mem_write(PRESS, struct.pack('<H', 5))
            posts.clear()
            call(uc, CENTER_KEY, PRESS)
            return [hex(m) for m in posts]

        uc.mem_write(TICK, struct.pack('<I', 0x1234))
        ok = True
        def check(label, got, want):
            global ok
            ok &= got == want
            print(f'mode: {label}: {got!r} (want {want!r}){"" if got == want else "  <-- FAIL"}')

        segs, outside = tick_refresh(0)
        check('fresh settings: mode 0', uc.mem_read(MODE, 1)[0], 0)
        check('photo mode shows it', shown(segs), lcd_text(0))
        check('photo mode, everything outside the SS cells as stock', outside, set())
        ASPECT, ASPECT_SAVE = 0x1217bd, CFG + 0xf2      # the UI's aspect, and the user's one in the normal mode
        NIDX = [6, 7, 8, 10, 13]                        # the normal mode's slot for each aspect 0-4
        cls = lambda mode: mode == NOR
        uc.mem_write(ASPECT, bytes([2]))                # 3:2 selected
        for n in range(1, len(modes) + 1):             # cycle through every mode and back
            state = n % 2                              # alternate photo and video mode
            old, new = modes[(n - 1) % len(modes)], modes[n % len(modes)]
            change = cls(old) != cls(new)
            # only into or out of the normal mode does the center button also post the stock aspect change
            check(f'press {n} ({"video" if state else "photo"} mode) posts the cycle message'
                  f'{" and the resize" if change else ""}', press(state),
                  STOCK_POSTS[:1] + (['0x7000'] if change else []) + STOCK_POSTS[1:])
            want = NIDX[2] if cls(new) else 2
            check(f'press {n}: the aspect is {want} ({"the factory sizes" if cls(new) else "regular"})',
                  uc.mem_read(ASPECT, 1)[0], want)
            if cls(new):
                check(f'press {n}: the user\'s aspect is remembered', uc.mem_read(ASPECT_SAVE, 1)[0], 2)
            m = new
            check(f'press {n} steps the mode', uc.mem_read(MODE, 1)[0], m)
            check(f'press {n} marks the settings to be saved', uc.mem_read(DIRTY, 1)[0], 1)
            uc.mem_write(DIRTY, b'\0')
            segs, outside = tick_refresh(state)
            check(f'press {n} display shows {code(m)}', shown(segs), lcd_text(m))
            check(f'press {n} outside the SS cells as stock', outside, set())
        uc.mem_write(DIRTY, b'\0')
        uc.mem_write(MODE, b'\x37')                     # settings from before: not a mode
        check('mode byte 0x37 shows as the first', shown(tick_refresh(0)[0]), lcd_text(0))
        check('mode byte 0x37: a press goes to the second', (press(0), uc.mem_read(MODE, 1)[0]), (STOCK_POSTS, 1))
        for n in range(2):
            call(uc, LUT_FILL, count=400_000_000)
            check(f'fixed mode, capture {n + 1} uses it', word32(PAL_IDX), 1)
        if NOR in modes:
            uc.mem_write(MODE, bytes([NOR]))
            call(uc, LUT_FILL, count=400_000_000)
            check('the normal mode: a capture has the hooks off', word32(VARS + 4), 0)
            uc.mem_write(MODE, b'\1')
        uc.mem_write(DIRTY, b'\0')
        check('recording: press posts as stock', press(1, rec=2), STOCK_POSTS)
        check('recording: mode unchanged, not marked', (uc.mem_read(MODE, 1)[0], uc.mem_read(DIRTY, 1)[0]), (1, 0))
        segs, outside = tick_refresh(1, rec=2)
        check('recording: display shows the mode', shown(segs), lcd_text(1))
        check('readout state: press posts as stock', press(2), STOCK_POSTS)
        check('readout state: mode unchanged', uc.mem_read(MODE, 1)[0], 1)
        segs = run(uc, lcd, 2)
        check('readout state exactly as stock (ISO 400, F5.6, SS 1/25): differing',
              fmt(segs ^ run(stock_uc, stock_lcd, 2)), '-')
        # ---- the arrow keys' aspect change (FUN_000213e0), and in the normal mode ----
        def arrow(delta):
            call(uc, 0x213e0, delta & 0xffffffff)
            return uc.mem_read(ASPECT, 1)[0]
        uc.mem_write(MODE, b'\0')
        uc.mem_write(ASPECT, bytes([2]))
        check('arrow keys in a palette: stock (right, left, right x3)', [arrow(1), arrow(-1), arrow(1), arrow(1), arrow(1)], [3, 2, 3, 4, 0])
        uc.mem_write(MODE, bytes([len(pre)]))
        check('arrow keys in rnd: stock (left, left)', [arrow(-1), arrow(-1)], [4, 3])
        if NOR in modes:
            uc.mem_write(MODE, bytes([NOR]))
            uc.mem_write(ASPECT_SAVE, bytes([2]))
            uc.mem_write(ASPECT, bytes([NIDX[2]]))
            seen = [arrow(1), arrow(1), arrow(1), arrow(-1)]          # aspects 3, 4, wrap to 0, back to 4
            check('arrow keys in the normal mode: the factory-size slots (right x3, left)', seen, [NIDX[3], NIDX[4], NIDX[0], NIDX[4]])
            check('... and the remembered aspect follows', uc.mem_read(ASPECT_SAVE, 1)[0], 4)
        orig = open('c100_v1.1.6_20260929/GP_CARDVR_UPGRADE.BIN', 'rb').read()
        fw = open(FW, 'rb').read()
        entry = lambda d, base, i: d[APP + base + 4 * i:APP + base + 4 * i + 4]
        for table, base in (('photo', 0xf3d0), ('video', 0xf0a0)):
            check(f'{table} size table: the normal slots are the factory handlers of aspects 0-4',
                  [entry(fw, base, i) for i in NIDX] == [entry(orig, base, i) for i in range(5)], True)
        BRACKET = 0x4a7f4                               # FUN_0004a7f4(state, aspect): the aspect bracket
        shown_b = lambda l: (l.ram[6] & 8, l.ram[0x15])
        for a in range(5):
            call(stock_uc, BRACKET, 0, a)
            call(uc, BRACKET, 0, NIDX[a])
            check(f'bracket for the normal slot {NIDX[a]} = the stock one for aspect {a}', shown_b(lcd), shown_b(stock_lcd))
            call(uc, BRACKET, 0, a)
            check(f'bracket for aspect {a} as stock', shown_b(lcd), shown_b(stock_lcd))
        call(stock_uc, BRACKET, 0, 9)
        call(uc, BRACKET, 0, 9)
        check('bracket for an unknown slot: as stock', shown_b(lcd), shown_b(stock_lcd))
        print('mode test', 'PASSED' if ok else 'FAILED')
        sys.exit(0 if ok else 1)
