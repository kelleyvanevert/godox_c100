@ Preset data: up to MAX_PRESETS presets (see tools/palettes.py). Too big for
@ the photo cave, so it lives in the unused end of the video cave's dead range
@ (0xbbc00-0xbc400). Data only; build.sh passes the label addresses to
@ photo_cave.s. Every table is padded to room for MAX_PRESETS (NMAX colours
@ each), so the labels sit at fixed addresses (palettes.py PD) whatever the
@ presets: the site's editor patches its presets into one template build.
@   MATCH_PALETTES  per preset: count, count x (Y,U,V); lut_fill matches
@                   against these
@   PRESET_MATCH    per preset: index of its match palette (= the preset's)
@   DISPLAY_PTRS    per preset: address of its paint colours (count x (Y,U,V),
@                   index for index with the match palette); CUR_PAL, so the
@                   photo and video hooks paint with these
@   PRESET_FX       per preset: FX_BYTES: a flags byte (0; for kinds of
@                   preset to come), the luma map's contrast (/128) and
@                   brightness (signed), a spare byte; lut_fill reads these
@   TAGS            per preset: the 3-letter tag (draw_tag)
    .syntax unified
    .arm
    .include "palettes.inc"
base:
    .org    PD_MATCH
MATCH_PALETTES:
    MATCH_DATA
PRESET_MATCH:
    PRESET_MATCH_DATA
TAGS:
    TAG_DATA
DISPLAY:
    DISPLAY_DATA
DISPLAY_PTRS:
    DISPLAY_PTR_DATA
PRESET_FX:
    PRESET_FX_DATA
PRESET_DATA_END:

@ Code in the rest of the cave (fixed by the template, not patched by the editor).

@ The Game Boy Camera's tone over a luma map (lut_fill, FX_GBTONE), as
@ palettes.py gb_tone: each t -> its MAC-GBD code, 128 + (t - 32) / 2 toward
@ zero, clamped to GB_RANGE (the same fraction as u = 0 or 3), placed in it as
@ k whole steps + d / w of the next (w its width), stretched over the ramp's
@ n - 1 steps and put in the middle of its shade:
@ (256 (2 (kw + d)(n - 1) + 3w) + 3wn) / 6wn. r0 = the map, r1 = n.
@ All registers preserved.
gb_tone_fill:
    push    {r0-r11, lr}
    mov     r4, r0
    mov     r5, r1
    adr     r7, GB_RANGE
    mov     r6, #0
1:  ldrb    r0, [r4, r6]
    sub     r0, r0, #32
    add     r0, r0, r0, lsr #31
    mov     r0, r0, asr #1
    add     r0, r0, #128                  @ r0 = the code
    ldrb    r1, [r7]
    cmp     r0, r1
    movlo   r0, r1
    ldrb    r1, [r7, #3]
    cmp     r0, r1
    movhi   r0, r1
    mov     r2, #2                        @ r2 = k, the last boundary it reaches
2:  ldrb    r1, [r7, r2]
    cmp     r0, r1
    sublo   r2, r2, #1
    blo     2b
    add     r9, r7, r2
    ldrb    r9, [r9, #1]
    sub     r9, r9, r1                    @ r9 = w
    sub     r0, r0, r1                    @ d
    mla     r8, r2, r9, r0                @ r8 = kw + d
    sub     r1, r5, #1
    mul     r0, r8, r1
    mov     r0, r0, lsl #1
    add     r2, r9, r9, lsl #1            @ 3w
    add     r0, r0, r2
    mov     r0, r0, lsl #8
    mul     r3, r2, r5                    @ 3wn
    add     r0, r0, r3
    mov     r1, r3, lsl #1                @ 6wn
    mov     lr, pc
    b       udiv
    strb    r0, [r4, r6]
    add     r6, r6, #1
    cmp     r6, #256
    blo     1b
    pop     {r0-r11, pc}
GB_RANGE:                               @ gb-photo's shade boundaries (contrast 7, high light)
    .byte   0x89, 0x92, 0xA2, 0xD2

@ r0 = r0 / r1 (unsigned, r1 > 0). Clobbers r1-r3.
udiv:
    mov     r3, #1
1:  cmp     r1, r0
    movls   r1, r1, lsl #1
    movls   r3, r3, lsl #1
    bls     1b
    mov     r2, #0
2:  cmp     r0, r1
    subhs   r0, r0, r1
    addhs   r2, r2, r3
    mov     r1, r1, lsr #1
    movs    r3, r3, lsr #1
    bne     2b
    mov     r0, r2
    mov     pc, lr
