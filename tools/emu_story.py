#!/usr/bin/env python3
"""Run the story (tools/patches/story_cave.s) in the ARM emulator.

Uses emu_seg.py's machine (the firmware with the HT1621 pins decoded) on a
build with the story (the default), with the file calls (open, read, close),
malloc and free stubbed by a fake SD card. It loads a STORY.TXT through story_load as the
card mount calls it, then drives the stock refresh and the stock key
handlers: each line must light exactly what tools/story.py render() says
(the reference for story/maker.html too) and nothing else on the panel,
even what was lit before the story; the right arrow and the
shutter step forward and the left arrow back without posting their stock
messages, the center button does nothing; past the last line the buffer is
freed and the display and keys are stock again. Also: no file, an empty
file, a second mount (no reload), and the readout state.

Usage: uv run --with unicorn tools/emu_story.py [FIRMWARE.BIN]
(FIRMWARE.BIN from SILENT=1 sh tools/build.sh, the default; it is compared with
v024, so the build must have the default LCDTAG=1.)
"""
import os, struct, subprocess, sys
from unicorn import UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_LR, UC_ARM_REG_PC

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
FW = sys.argv[1] if len(sys.argv) > 1 else 'build/GP_CARDVR_UPGRADE.BIN'
STOCK = 'build_backups/v024_editor_template.bin'   # = SILENT=1 STORY=0
sys.argv = sys.argv[:1]
import emu_seg as E
import story

OPEN, READ, CLOSE, MALLOC, FREE, VERSION_TXT = 0x9e608, 0x9e67c, 0x9dc7c, 0x53750, 0x53754, 0x37f34
MSG_POST, UI_STATE, CFG = 0x42c, 0x121706, 0x132160
LEFT, CENTER, RIGHT, SHUTTER = 0x1dcb8, 0x1dd6c, 0x1de20, 0x1df64
KEY_LATCH, SHUTTER_LATCH, PRESS = 0x1217bc, 0x12163d, 0x700000
HEAP = 0x900000


def syms(obj):
    nm = next(p for p in ('/opt/homebrew/opt/llvm/bin/llvm-nm', '/opt/homebrew/opt/llvm@18/bin/llvm-nm') if os.path.exists(p))
    out = subprocess.run([nm, f'build/obj/{obj}.o'], capture_output=True, text=True, check=True).stdout
    return {f[2]: int(f[0], 16) for f in map(str.split, out.splitlines()) if len(f) == 3}


class Card:
    """The SD card: STORY.TXT's bytes, or None for no file."""
    def __init__(self, uc, data):
        self.data, self.opened, self.closed, self.freed, self.version, self.heap = data, 0, 0, [], 0, HEAP
        self.posts = []
        uc.hook_add(UC_HOOK_CODE, self.on_code)

    def ret(self, uc, value=None):
        if value is not None:
            uc.reg_write(UC_ARM_REG_R0, value & 0xffffffff)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

    def on_code(self, uc, addr, size, _):
        if addr == OPEN:
            path = bytes(uc.mem_read(uc.reg_read(UC_ARM_REG_R0), 32)).split(b'\0')[0]
            assert path == b'G:\\STORY.TXT' and uc.reg_read(UC_ARM_REG_R1) == 0, path
            self.opened += 1
            self.ret(uc, 3 if self.data is not None else -1)
        elif addr == READ:
            buf, n = uc.reg_read(UC_ARM_REG_R1), uc.reg_read(UC_ARM_REG_R2)
            chunk = self.data[:n]
            uc.mem_write(buf, chunk)
            self.ret(uc, len(chunk))
        elif addr == CLOSE:
            self.closed += 1
            self.ret(uc, 0)
        elif addr == MALLOC:
            self.last_alloc = self.heap
            self.heap += uc.reg_read(UC_ARM_REG_R0) + 0x100
            self.ret(uc, self.last_alloc)
        elif addr == FREE:
            self.freed.append(uc.reg_read(UC_ARM_REG_R0))
            self.ret(uc)
        elif addr == VERSION_TXT:
            self.version += 1
            self.ret(uc)
        elif addr == MSG_POST:
            self.posts.append(uc.reg_read(UC_ARM_REG_R1))
            self.ret(uc)


def boot(fw, data):
    E.FW = fw
    uc, lcd = E.machine()
    E.call(uc, 0x4ad68)                             # HT1621 init
    return uc, lcd, Card(uc, data)


BATTERY = {0x17: 0xf, 0x18: 0x2}                  # blinks with no battery level in the emulator: not compared


def masked(ram):
    return [v & ~BATTERY.get(a, 0) for a, v in enumerate(ram)]


def refresh(uc, lcd, state, raw=False):
    """One display refresh; the panel (the battery masked unless raw)."""
    for addr, val in [(UI_STATE, state), (0x1217be, 1), (0x1217b0, 1), (0x132abb, 0), (CFG + 0xf, 1),
                      (0xe3279, 1), (CFG + 0xeb, 15), (0x12170b, 1), (CFG + 0xea, 11)]:
        uc.mem_write(addr, bytes([val]))
    uc.mem_write(CFG + 0xec, struct.pack('<H', 400))   # ISO 400, F5.6, SS 1/25 in the readout state
    E.call(uc, 0x21318)
    ram = list(lcd.ram[:E.NIB])
    return ram if raw else masked(ram)


def press(uc, card, key, state):
    """A short press through the stock key handler; the messages it posted."""
    uc.mem_write(UI_STATE, bytes([state]))
    uc.mem_write(KEY_LATCH, b'\0')
    uc.mem_write(SHUTTER_LATCH, b'\0')
    uc.mem_write(0xe3388, b'\0')                    # shutter: not busy
    uc.mem_write(0xf187e, b'\0')                    # sensor preview fine
    uc.mem_write(PRESS, struct.pack('<H', 5))
    card.posts.clear()
    E.call(uc, key, PRESS)
    return [hex(m) for m in card.posts]


ok = True
def check(label, got, want):
    global ok
    ok &= got == want
    print(f'{label}: {got!r}{"" if got == want else f"  <-- FAIL, want {want!r}"}')


if __name__ == '__main__':
    font = story.load_font()
    load = syms('story_load')['story_load']
    VARS = syms('story_cave')['VARS']
    word = lambda uc, off: struct.unpack('<I', uc.mem_read(VARS + off, 4))[0]
    text = '\ufeffHI5.6ABC\r\nWOW MOM\n\nMEOW\nW.M  OK.X\nlast'
    lines = [l.rstrip('\r') for l in text.lstrip('\ufeff').split('\n')]
    data = text.encode()

    stock_uc, stock_lcd, stock_card = boot(STOCK, None)
    def stock_view(state):
        return refresh(stock_uc, stock_lcd, state)

    def shows(uc, lcd, state, line, label):
        """The refresh draws `line` and nothing else on the whole panel."""
        check(f'{label}: only the line {line!r}', refresh(uc, lcd, state, raw=True), story.render(line, font))

    def started(uc, lcd, state):
        """Everything lit as before the story (a stock refresh, with the logo
        and a full battery), and one address where SHADOW says off but the
        panel is lit, then the card mount."""
        refresh(uc, lcd, state)
        E.call(uc, 0x4a64c, 1)                          # the logo on
        uc.mem_write(E.SHADOW + 0x17, b'\0')            # the battery bars: lit, SHADOW says off
        lcd.ram[0x17] = 0xe
        E.call(uc, load)

    for state, mode in ((0, 'photo'), (1, 'video'), (2, 'readout')):
        uc, lcd, card = boot(FW, data)
        started(uc, lcd, state)
        check(f'{mode}: mount reads the file once and goes on to VERSION.TXT', (card.opened, card.closed, card.version), (1, 1, 1))
        E.call(uc, load)
        check(f'{mode}: a second mount reads nothing', (card.opened, card.version), (1, 2))
        check(f'{mode}: the text starts after the byte order mark', word(uc, 4) - word(uc, 0), 3)
        i = 0
        shows(uc, lcd, state, lines[0], f'{mode} line 1')
        check(f'{mode}: left on the first line posts only 0x7018', press(uc, card, LEFT, state), ['0x7018'])
        shows(uc, lcd, state, lines[0], f'{mode} still line 1')
        steps = [(RIGHT, 1, ['0x7018']), (SHUTTER, 1, []), (CENTER, 0, ['0x7018']), (LEFT, -1, ['0x7018']),
                 (RIGHT, 1, ['0x7018']), (SHUTTER, 1, []), (RIGHT, 1, ['0x7018']), (RIGHT, 1, ['0x7018'])]
        for key, step, posts in steps:
            name = {LEFT: 'left', RIGHT: 'right', SHUTTER: 'shutter', CENTER: 'center'}[key]
            check(f'{mode}: {name} posts {posts}', press(uc, card, key, state), posts)
            i += step
            check(f'{mode}: {name} draws line {i + 1} at once', list(lcd.ram[:E.NIB]), story.render(lines[i], font))
            shows(uc, lcd, state, lines[i], f'{mode} line {i + 1}')
        check(f'{mode}: on the last line', i, len(lines) - 1)
        check(f'{mode}: right past the last posts only 0x7018', press(uc, card, RIGHT, state), ['0x7018'])
        check(f'{mode}: the story is over, the buffer freed', (word(uc, 12), card.freed), (0, [word(uc, 0)]))
        check(f'{mode}: the stock display at once', masked(lcd.ram[:E.NIB]), stock_view(state))
        check(f'{mode}: then the display is stock', refresh(uc, lcd, state), stock_view(state))
        stock_keys = {LEFT: ['0x7018', '0x7042'], RIGHT: ['0x7018', '0x7043']}
        for key, posts in stock_keys.items():
            check(f'{mode}: after the story the arrows post as stock', press(uc, card, key, state), posts)
        if state < 2:                                   # photo and video mode: the center button's preset mode
            pm = uc.mem_read(CFG + 0xf1, 1)[0]
            check(f'{mode}: the preset mode stayed through the story', pm, 0)
            check(f'{mode}: after the story the center button posts as stock', press(uc, card, CENTER, state), ['0x7018', '0x7041'])
            check(f'{mode}: ... and steps the preset mode', uc.mem_read(CFG + 0xf1, 1)[0], 1)
        sh = press(uc, card, SHUTTER, state)
        check(f'{mode}: after the story the shutter posts as stock',
              sh, ['0x7018', '0x703d'] if state == 2 else ['0x7015', '0x7001'])

    # The shutter on the last line ends it too.
    uc, lcd, card = boot(FW, b'ONE\nTWO\n')
    started(uc, lcd, 0)
    press(uc, card, RIGHT, 0)
    shows(uc, lcd, 0, 'TWO', 'trailing newline: line 2')
    check('trailing newline: the shutter past the last posts nothing', press(uc, card, SHUTTER, 0), [])
    check('trailing newline: no blank screen after it, the story is over', word(uc, 12), 0)

    for data, label in ((None, 'no STORY.TXT'), (b'', 'an empty STORY.TXT'), (b'\xef\xbb\xbf', 'only a byte order mark')):
        uc, lcd, card = boot(FW, data)
        E.call(uc, load)
        check(f'{label}: no story, VERSION.TXT as before', (word(uc, 12), card.version), (0, 1))
        check(f'{label}: nothing kept', card.freed == [card.last_alloc] if data is not None else True, True)
        check(f'{label}: the display is stock', refresh(uc, lcd, 0), stock_view(0))
        check(f'{label}: the right arrow posts as stock', press(uc, card, RIGHT, 0), ['0x7018', '0x7043'])

    # Every printable character, one per line (the whole font through the firmware).
    chars = ''.join(chr(c) for c in range(0x20, 0x7f))
    uc, lcd, card = boot(FW, '\n'.join(chars).encode())
    E.call(uc, load)
    bad = []
    for n, ch in enumerate(chars):
        if n:
            press(uc, card, RIGHT, 0)
        got = list(lcd.ram[:E.NIB]) if n else refresh(uc, lcd, 0, raw=True)
        if got != story.render(ch, font):
            bad.append(ch)
    check('the whole font as story.py renders it, wrong', ''.join(bad), '')
    # Long lines: 7 cells, then nothing; a two-cell glyph that doesn't fit ends it.
    for line in ('ABCDEFGHIJ', 'ABCDEFW', 'ABC.DEFG', 'A B.C', 'AB.', 'ABW.C', 'AW.BC', '...'):
        uc, lcd, card = boot(FW, line.encode())
        E.call(uc, load)
        shows(uc, lcd, 0, line, 'layout')
    print('story test', 'PASSED' if ok else 'FAILED')
    sys.exit(0 if ok else 1)
