@ Palette dithering for video (VIDFX=1 build). Hooks FUN_00018d14, which
@ hands each 64-row video strip to the H.264 encoder (camera task context).
@ Its first instruction (ldr r3, [r0]) is replaced with a branch here; we
@ re-run it and return to 0x18d18.
@
@ r0 = video encode struct (0x131490): [0] = 1 on the front-camera path,
@ +0x101 = pixel format ('#' = 0x23), [2] = this strip's buffer, tagged
@ | 0x30000000 (0x50000000 = none), +0xdc = width W (one of palettes.py
@ SIZES since v020; 640 before; the hook takes any multiple of 16 up to
@ MAX_W and leaves other video alone). Each call gets one 64-row strip
@ (W x 64 x 1.5 bytes) from a pool of 20, laid out exactly
@ like the photo strips (decoded with the barcode diagnostic in commit
@ ebfafdd, IMG_0314-0317): stride = 1.5 * W; even rows: luma [0, W), chroma
@ pairs 0..W/4-1 at [W, 1.5W); odd rows: chroma pairs W/4..W/2-1 at
@ [0, W/2), luma [W/2, 1.5W). A frame's last strip is partial but still a
@ full buffer.
@
@ The per-block work is the photo hook's: photo_cave.s fx_strip, shared; its
@ 4x4 blocks are fx4 below (at a fixed address, 0xbb774, as fx_strip jumps
@ there): average the luma, the preset's luma map, sharpening, the dither, look (Y, U, V) up in the shared table,
@ paint the block. Strips start on 64-row boundaries, so the Bayer phase
@ (band & 3) lines up across strips. The table and palette are the photo
@ cave's (its VARS); a gap of >= 500 ms since the last strip means a new
@ recording, and then lut_fill takes the preset (the mode, or a random one
@ in rnd) and rebuilds the table if it changed (costing that one strip some
@ tens of ms). The timestamp
@ argument (r1) is the same for every strip of a frame and strips come top
@ to bottom, so a new timestamp means the frame's top strip: draw_tag (also
@ from photo_cave.s) then puts the palette's tag in the top right corner.
@
@ VIDTIMING=1 also draws this strip's hook time in its top 4 rows: a black
@ 16 ms scale (256 px), white for each elapsed ms (16 px per ms, xTickCount).
    .syntax unified
    .arm
    .include "palettes.inc"                      @ MAX_W, MAX_BLOCKS
    .include "look.inc"                          @ VARS offsets, CLAMP, SHARPEN, LOOKUP
base:
    .set    RESUME,      base + 0x18d18
    .set    CACHE_INV,   base + 0x401ac
    .set    CACHE_CLEAN, base + 0x401b8
    .set    LUT_FILL,    base + LUT_FILL_ADDR    @ photo_cave.s (from build.sh)
    .set    DRAW_TAG,    base + DRAW_TAG_ADDR    @ photo_cave.s (from build.sh)
    .set    FX_STRIP,    base + FX_STRIP_ADDR    @ photo_cave.s (from build.sh)
    .equ    PVARS,       PVARS_ADDR              @ photo cave VARS (from build.sh)
    .equ    TICK,        0x126b80                @ FreeRTOS xTickCount
    .equ    NEWREC_MS,   500
    .equ    V_LAST,      0                       @ offsets into VVARS
    .equ    V_T0,        4
    .equ    V_TS,        8

    .org    0xbb774
    b       fx4                           @ fixed: fx_strip (photo_cave.s) jumps here

vhook:
    push    {r0-r12, lr}                  @ r0-r1 are FUN_00018d14's live args
    ldr     r1, [r0]
    cmp     r1, #1                        @ front camera path
    bne     vdone
    ldrb    r1, [r0, #0x101]
    cmp     r1, #0x23                     @ '#'
    bne     vdone
    ldr     r1, [r0, #0xdc]                @ width: one of ours (palettes.py SIZES),
    tst     r1, #15                       @  so a multiple of 16
    bne     vdone
cmp_max_w:                                @ (the editor patches the immediate)
    cmp     r1, #MAX_W                    @  and no wider than the widest
    bhi     vdone
    cmp     r1, #0
    beq     vdone
    add     r7, r1, r1, lsr #1            @ r7 = stride = width * 3/2 (kept across the calls)
    mov     r8, r1, lsr #1                @ r8 = third = width/2
    ldr     r11, [r0, #8]                 @ r11 = strip
    cmp     r11, #0x50000000
    cmpne   r11, #0
    beq     vdone
    bic     r11, r11, #0x30000000         @ strip the tag (FUN_00047228)
    ldr     r4, =VVARS - base
    ldr     r1, =TICK
    ldr     r1, [r1]
    str     r1, [r4, #V_T0]
    ldr     r2, [r4, #V_LAST]
    str     r1, [r4, #V_LAST]
    sub     r2, r1, r2
    cmp     r2, #NEWREC_MS                @ first strip of a new recording:
    blo     1f
    mov     lr, pc                        @  new palette, rebuild the table
    b       LUT_FILL
1:  ldr     r0, =PVARS
    ldr     r12, [r0, #LUT_PTR]
    ldr     r5, [r0, #CUR_PAL]
    cmp     r12, #0
    cmpne   r5, #0
    beq     vdone                         @ no table (allocation failed, or the normal mode)
    mov     r0, r11
    mov     r1, r7, lsl #6                @ the 64-row strip
    mov     lr, pc
    b       CACHE_INV
    mov     lr, pc                        @ the look (photo_cave.s; r5 = paint colours, kept)
    b       FX_STRIP
    @ ---- first strip of a frame (new timestamp): palette tag, top right ----
    ldr     r4, =VVARS - base
    ldr     r1, [sp, #4]                  @ saved r1 = the frame's timestamp
    ldr     r2, [r4, #V_TS]
    str     r1, [r4, #V_TS]
    cmp     r1, r2
    movne   lr, pc
    bne     DRAW_TAG                      @ wants r11, r7, r8, r5; keeps all

    .ifdef  VIDTIMING
    @ ---- timing bar: rows 0-3, x < 256 = 16 ms scale, white per elapsed ms ----
    ldr     r4, =VVARS - base
    ldr     r1, =TICK
    ldr     r1, [r1]
    ldr     r2, [r4, #V_T0]
    sub     r2, r1, r2                    @ r2 = ms spent in this hook so far
    mov     r2, r2, lsl #4                @ r2 = bar end x
    mov     r10, #0                       @ band 0..1 (rows 0-3)
2:  mul     r3, r10, r7
    add     r6, r11, r3, lsl #1           @ r6 = even row start (strip + 2*band*stride)
    add     r4, r6, r7
    add     r4, r4, r8                    @ r4 = odd row luma start
    add     r12, r6, r8, lsl #1           @ r12 = even-row chroma pairs (x < third)
    mov     r9, #0                        @ x
3:  cmp     r9, r2
    movlo   r0, #235
    movhs   r0, #16
    strb    r0, [r6, r9]
    strb    r0, [r4, r9]
    mov     r0, #128
    strb    r0, [r12, r9]                 @ pair x/2 = bytes x, x+1: neutral grey
    add     r9, r9, #1
    cmp     r9, #256
    blo     3b
    add     r10, r10, #1
    cmp     r10, #2
    blo     2b
    .endif

    mov     r0, r11
    mov     r1, r7, lsl #6
    mov     lr, pc
    b       CACHE_CLEAN
vdone:
    pop     {r0-r12, lr}
    ldr     r3, [r0]                      @ the instruction we replaced
    b       RESUME
    .ltorg

@ fx_strip (photo_cave.s) for 4x4 blocks (FX_PIX4), from its stack frame and
@ registers: r11 = strip, r7 = stride, r8 = third, r12 = table, r5 = paint
@ colours, r4 = row buffer, [sp] = the sharpening weight. A row of 4x4
@ blocks is 2 bands; their luma is read as words (two bytes per 16-bit lane)
@ and painted as words, so the strip must be word aligned (it is; else it is
@ left alone). Ends as fx_strip's fxdone.
fx4:
    tst     r11, #3
    bne     4f
    mov     r10, #0                       @ r10 = a row of 4x4 blocks, 0..15
fx4row:
    sub     lr, r12, #YMAP_BYTES          @ lr = the luma map
    ldr     r6, =0x00FF00FF
    mov     r9, #0                        @ r9 = block c, x = 4c
1:  add     r2, r11, r9, lsl #2
    mov     r0, #0
    @ the 4 rows: the upper band's even and odd, the lower band's
    ldr     r1, [r2]
    and     r3, r1, r6
    add     r0, r0, r3
    and     r3, r6, r1, lsr #8
    add     r0, r0, r3
    add     r2, r2, r7
    add     r2, r2, r8
    ldr     r1, [r2]
    and     r3, r1, r6
    add     r0, r0, r3
    and     r3, r6, r1, lsr #8
    add     r0, r0, r3
    add     r2, r2, r7
    sub     r2, r2, r8
    ldr     r1, [r2]
    and     r3, r1, r6
    add     r0, r0, r3
    and     r3, r6, r1, lsr #8
    add     r0, r0, r3
    add     r2, r2, r7
    add     r2, r2, r8
    ldr     r1, [r2]
    and     r3, r1, r6
    add     r0, r0, r3
    and     r3, r6, r1, lsr #8
    add     r0, r0, r3
    add     r0, r0, r0, lsr #16
    mov     r0, r0, lsl #16
    mov     r0, r0, lsr #20               @ the 16 luma's mean
    ldrb    r0, [lr, r0]
    strb    r0, [r4, r9]
    add     r9, r9, #1
    cmp     r9, r8, lsr #1
    blo     1b
    PAD     r8, lsr #1
    ldr     lr, =PVARS + DITHER
    and     r0, r10, #3
    add     lr, lr, r0, lsl #2            @ lr = this row's 4 dither offsets
    mov     r9, #0
2:  ldrb    r0, [r4, r9]
    SHARPEN
    and     r1, r9, #3
    ldrsb   r1, [lr, r1]
    add     r0, r0, r1
    CLAMP
    str     r0, [sp, #-4]!
    mov     r3, r9, lsl #1                @ its first 2x2 column's pair: in the even
    cmp     r3, r8, lsr #1                @  row's chroma, or the odd row's
    addlo   r6, r11, r8, lsl #1
    addlo   r6, r6, r3, lsl #1
    subhs   r3, r3, r8, lsr #1
    addhs   r6, r11, r7
    addhs   r6, r6, r3, lsl #1            @ r6 = the upper band's 2 pairs (+ 2 stride: the lower's)
    add     r0, r6, r7, lsl #1
    ldrb    r1, [r6]                      @ U: the 4 pairs' mean
    ldrb    r3, [r6, #2]
    add     r1, r1, r3
    ldrb    r3, [r0]
    add     r1, r1, r3
    ldrb    r3, [r0, #2]
    add     r1, r1, r3
    ldrb    r2, [r6, #1]                  @ V
    ldrb    r3, [r6, #3]
    add     r2, r2, r3
    ldrb    r3, [r0, #1]
    add     r2, r2, r3
    ldrb    r3, [r0, #3]
    add     r2, r2, r3
    mov     r1, r1, lsr #2
    mov     r2, r2, lsr #2
    ldr     r0, [sp], #4
    LOOKUP
    orr     r1, r1, r2, lsl #8            @ paint: the 4 pairs, U V U V
    orr     r1, r1, r1, lsl #16
    str     r1, [r6]
    str     r1, [r6, r7, lsl #1]
    orr     r0, r0, r0, lsl #8            @ the 16 luma, 4 per row
    orr     r0, r0, r0, lsl #16
    add     r3, r11, r9, lsl #2
    str     r0, [r3]
    add     r3, r3, r7
    str     r0, [r3, r8]
    add     r3, r3, r7
    str     r0, [r3]
    add     r3, r3, r7
    str     r0, [r3, r8]
    add     r9, r9, #1
    cmp     r9, r8, lsr #1
    blo     2b
    add     r11, r11, r7, lsl #2          @ next row: 2 bands
    add     r10, r10, #1
    cmp     r10, #16
    blo     fx4row
4:  add     sp, sp, #4                    @ fx_strip's fxdone
    pop     {r0-r12, pc}
    .ltorg
    .align  2
VVARS:
    .word   0                             @ V_LAST: tick of the last strip
    .word   0                             @ V_T0: tick at this strip's start
    .word   0                             @ V_TS: timestamp of the last strip's frame
