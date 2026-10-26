#!/bin/sh
# Rebuild build/GP_CARDVR_UPGRADE.BIN from the original firmware:
# custom sounds + code patches. Edit the lists below to change what goes in.
set -e
cd "$(dirname "$0")/.."
LLVM=/opt/homebrew/opt/llvm/bin
[ -d "$LLVM" ] || LLVM=/opt/homebrew/opt/llvm@18/bin
ORIG=c100_v1.1.6_20260929/GP_CARDVR_UPGRADE.BIN
OUT=build/GP_CARDVR_UPGRADE.BIN
mkdir -p build/obj

# --- sounds ---
# SILENT=1 makes the shutter, power-on and mode-switch click silent (same slots,
# zeroed samples) AND never switches the speaker amplifier on (see SPK_PATCHES
# below), so there is no amp hiss either.
#   SILENT=1 sh tools/build.sh   -> no sounds, speaker amp stays off
#   sh tools/build.sh            -> Super Mario kick / coin sounds
# SHUTTER_WAV / POWERON_WAV pick other sounds (11025 Hz mono 16-bit PCM, at
# most the slot's size; the site's editor makes these).
SILENT=${SILENT:-0}
SHUTTER_WAV=${SHUTTER_WAV:-build/kick_11k.wav}
POWERON_WAV=${POWERON_WAV:-build/coin_11k.wav}
python3 tools/gp_res.py "$ORIG" build/res >/dev/null
if [ "$SILENT" = "1" ]; then
    python3 -I tools/mk_silence.py "$SHUTTER_WAV" build/silent_cam.wav
    python3 -I tools/mk_silence.py "$POWERON_WAV" build/silent_pwr.wav
    python3 -I tools/mk_silence.py build/res/CLICK.wav build/click_silent.wav
    python3 tools/patch_res.py "$ORIG" CAMERA.wav build/silent_cam.wav "$OUT"
    python3 tools/patch_res.py "$OUT" POWERON_AUDIO.wav build/silent_pwr.wav "$OUT"
    python3 tools/patch_res.py "$OUT" CLICK.wav build/click_silent.wav "$OUT"
else
    python3 tools/patch_res.py "$ORIG" CAMERA.wav "$SHUTTER_WAV" "$OUT"
    python3 tools/patch_res.py "$OUT" POWERON_AUDIO.wav "$POWERON_WAV" "$OUT"
fi

# BEEP.wav (the UI/focus beep) is always silenced, in both sound profiles.
python3 -I tools/mk_silence.py build/res/BEEP.wav build/beep_silent.wav
python3 tools/patch_res.py "$OUT" BEEP.wav build/beep_silent.wav "$OUT"

# Speaker amplifier = GPIO 0x2c, driven by gpio_write FUN_000433f4(pin, level).
# Sound playback FUN_00022a80 switches it on, waits 100 ms, then queues the WAV;
# the peripheral task (FUN_00021e60, ~1 s tick) only switches it off again on
# its 2nd tick after that, so every sound gives ~1-2 s of amp hiss even when
# the WAV is silent. With SILENT=1 the "on" calls become NOPs (pure pin writes,
# return value unused), so the amp is never powered:
#   0x22b38  FUN_00022a80, every UI sound (shutter, click, power-on, beep)
#   0x350f0  state_startup_init, unconditional "on" at boot
#   0x2ed50  photo state, the remaining "on"
SPK_PATCHES=""
if [ "$SILENT" = "1" ]; then
    SPK_PATCHES="0x22b38:2d8200eb:0000a0e1 0x350f0:bf3800eb:0000a0e1 0x2ed50:a75100eb:0000a0e1"
fi

# --- assemble a patch: prints ADDR:OLDHEX:NEWHEX for patch_code.py ---
asm() {  # asm NAME START END [extra llvm-mc args, e.g. --defsym=X=1]
    name=$1 start=$2 end=$3; shift 3
    $LLVM/llvm-mc -triple=armv5te-none-eabi \
        -I build/obj "$@" -filetype=obj "tools/patches/$name.s" -o "build/obj/$name.o"
    set -- "$name" "$start" "$end"
    if $LLVM/llvm-readobj -r "build/obj/$1.o" | grep -q R_ARM; then
        echo "$1: unresolved relocation (use 'mov lr, pc; b X' instead of 'bl X')" >&2; exit 1
    fi
    $LLVM/llvm-objcopy -O binary "build/obj/$1.o" "build/obj/$1.bin"
    python3 -I -c "
import sys
start, end = int(sys.argv[3], 0), int(sys.argv[4], 0)
blob = open(sys.argv[1], 'rb').read()
assert len(blob) <= end, f'{sys.argv[1]}: code runs past {end:#x} (ends at {len(blob):#x})'
new = blob[start:end]
old = open(sys.argv[2], 'rb').read()[start + 0x10200:end + 0x10200]
new += old[len(new):]
print(f'{start:#x}:{old.hex()}:{new.hex()}')
" "build/obj/$1.bin" "$ORIG" "$2" "$3"
}

# --- code patches ---
# Presets (match palettes x film colours) with their contrast and brightness,
# rnd and the normal mode (no effect) on or off, tags and display codes from
# tools/palettes.py (PRESETS_JSON), included by the caves. The preset data is too big for the
# photo cave: it goes in the unused end of the video cave's dead range,
# 0xbbc00-0xbc400 (see tools/patches/preset_data.s).
python3 -I tools/palettes.py asm > build/obj/palettes.inc
nmsym() {  # nmsym OBJ LABEL: address of a label in an assembled cave
    $LLVM/llvm-nm "build/obj/$1.o" | awk -v s="$2" '$3 == s { print "0x" $1 }'
}
PDATA=$(asm preset_data 0xbbc00 0xbc400)
CAVE=$(asm photo_cave 0xbab6c 0xbb340 \
    --defsym=MATCH_ADDR=$(nmsym preset_data MATCH_PALETTES) --defsym=PMATCH_ADDR=$(nmsym preset_data PRESET_MATCH) \
    --defsym=DPTRS_ADDR=$(nmsym preset_data DISPLAY_PTRS) --defsym=TAGS_ADDR=$(nmsym preset_data TAGS) \
    --defsym=FX_ADDR=$(nmsym preset_data PRESET_FX))  # dead FUN_000bab6c
sym() {  # address of a label in the assembled photo cave
    nmsym photo_cave "$1"
}
HOOK_JUMP=$(asm hook_jump 0x15448 0x1544c --defsym=HOOK=$(sym hook))
CYC_JUMP=$(asm cyc_jump 0x187c4 0x187c8 --defsym=STUB=$(sym idx_stub))  # per-photo palette + table
# Video palette dithering (VIDFX=1, default; VIDFX=0 = plain video): hook FUN_00018d14 (one 64-row video
# strip -> H.264 encoder) into a second cave in dead code at 0xbb774-0xbbc00
# (unreferenced functions FUN_000bb774..FUN_000bc19c; see
# tools/patches/video_cave.s). It shares the photo cave's presets and table.
# VIDTIMING=1 adds a per-strip timing bar (test builds only).
VIDFX=${VIDFX:-1}
VIDTIMING=${VIDTIMING:-0}
VFX_PATCHES=""
if [ "$VIDFX" = "1" ]; then
    VT=""; [ "$VIDTIMING" = "1" ] && VT="--defsym=VIDTIMING=1"
    VCAVE=$(asm video_cave 0xbb774 0xbbc00 --defsym=LUT_FILL_ADDR=$(sym lut_fill) --defsym=PVARS_ADDR=$(sym VARS) --defsym=DRAW_TAG_ADDR=$(sym draw_tag) $VT)
    VHOOK=$(asm vhook_jump 0x18d14 0x18d18 --defsym=HOOK=$($LLVM/llvm-nm build/obj/video_cave.o | awk '$3 == "vhook" { print "0x" $1 }'))
    VFX_PATCHES="$VCAVE $VHOOK"
fi
# Preset mode on the see-through display and the center button (LCDTAG=1,
# default; LCDTAG=0 = stock blank display, center button does nothing, always
# the first preset): in photo and video mode the center button cycles the
# presets and rnd (a random preset per photo/recording), and the display's
# shutter-speed readout cells show the current one. Redirects the refresh's
# tail call to 0x20fd0 (SS readout) at 0x21218 and the center key handler's
# message post at 0x1ddf8 into a third cave in the same dead code,
# 0xbc400-0xbc744. See tools/patches/lcd_cave.s. It also switches to the
# factory's sizes in the normal mode (aspect slots 6, 7, 8, 10 and 13,
# NORMAL_PATCHES below), redirecting the arrow keys' aspect change at 0x213e0
# and the display's aspect bracket at 0x4a818 there too.
LCDTAG=${LCDTAG:-1}
LCD_PATCHES=""
if [ "$LCDTAG" = "1" ]; then
    LCAVE=$(asm lcd_cave 0xbc400 0xbc744)
    LJUMP=$(asm lcd_jump 0x21218 0x2121c --defsym=HOOK=$(nmsym lcd_cave lcd_hook))
    KJUMP=$(asm key_jump 0x1ddf8 0x1ddfc --defsym=HOOK=$(nmsym lcd_cave center_hook))
    AJUMP=$(asm aspect_jump 0x213e0 0x213e4 --defsym=HOOK=$(nmsym lcd_cave aspect_hook))
    BJUMP=$(asm bracket_jump 0x4a818 0x4a81c --defsym=HOOK=$(nmsym lcd_cave bracket_hook))
    LCD_PATCHES="$LCAVE $LJUMP $KJUMP $AJUMP $BJUMP"
fi
# Resolution jump table @0xf3d0 (ldrls pc,[pc,idx,lsl#2] @0xf3c8): entries hold
# absolute handler addresses, so point each photo aspect ratio straight at its
# cave stub. 0/1=16:9 1920, 2=3:2 1616, 3=4:3 1440, 4=1:1 1024; b/c = hi-res.
jt() {  # jt ENTRY OLDHEX LABEL -> ENTRY:OLDHEX:<label address, little-endian>
    printf '%s:%s:%s\n' "$1" "$2" "$(python3 -I -c "import sys; print(int(sys.argv[1], 0).to_bytes(4, 'little').hex())" "$(sym "$3")")"
}
# Video resolution jump table @0xf0a0 (ldrls pc,[pc,idx,lsl#2] @0xf098), same
# scheme as the photo one; video follows the camera's aspect setting:
# 0/1/9 = 16:9 1920, 2 = 3:2 1616, 3 = 4:3 1440, 4 = 1:1 1024, each to the
# photo's size (palettes.py SIZES, ~274k pixels; 640 wide until v019).
# SMALLVID=0 keeps the stock full-size video.
SMALLVID=${SMALLVID:-1}
# The normal mode uses the factory's sizes: its aspects are slots 6, 7,
# 8, 10 and 13 (lcd_cave.s NIDX), whose entries in both tables become the factory
# handlers of aspects 0-4, copied from the original (nothing else uses those slots).
NORMAL_PATCHES="0xf3e8:10f70000:9cf70000 0xf3ec:24f70000:9cf70000 0xf3f0:38f70000:b0f70000 0xf3f8:4cf70000:c4f70000 0xf404:88f70000:d4f60000"
VID_PATCHES=""
if [ "$SMALLVID" = "1" ]; then
    NORMAL_PATCHES="$NORMAL_PATCHES 0xf0b8:58f60000:f8f50000 0xf0bc:68f60000:f8f50000 0xf0c0:d8f70000:a8f60000 0xf0c8:d8f70000:88f60000 0xf0d4:d8f70000:98f60000"
    VID_PATCHES="$(jt 0xf0a0 f8f50000 vid169) $(jt 0xf0a4 f8f50000 vid169) $(jt 0xf0c4 f8f50000 vid169)
        $(jt 0xf0a8 a8f60000 vid32) $(jt 0xf0ac 88f60000 vid43) $(jt 0xf0b0 98f60000 vid11)"
fi
python3 tools/patch_code.py "$OUT" "$OUT" \
    "$HOOK_JUMP" "$CYC_JUMP" "$PDATA" "$CAVE" $VFX_PATCHES $LCD_PATCHES \
    "$(jt 0xf3d0 9cf70000 stub169)" \
    "$(jt 0xf3d4 9cf70000 stub169)" \
    "$(jt 0xf3d8 b0f70000 stub32)" \
    "$(jt 0xf3dc c4f70000 photo43)" \
    "$(jt 0xf3e0 d4f60000 stub11)" \
    $NORMAL_PATCHES \
    "$(jt 0xf3fc 60f70000 photo43)" \
    "$(jt 0xf400 74f70000 photo43)" \
    $VID_PATCHES \
    $SPK_PATCHES
