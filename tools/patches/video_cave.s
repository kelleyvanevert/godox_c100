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
@ The per-block work is the photo hook's (photo_cave.s): average the 2x2
@ luma, the preset's luma map, 4x4 Bayer, look (Y, U, V) up in the shared table,
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
    .include "palettes.inc"                      @ MAX_W
base:
    .set    RESUME,      base + 0x18d18
    .set    CACHE_INV,   base + 0x401ac
    .set    CACHE_CLEAN, base + 0x401b8
    .set    LUT_FILL,    base + LUT_FILL_ADDR    @ photo_cave.s (from build.sh)
    .set    DRAW_TAG,    base + DRAW_TAG_ADDR    @ photo_cave.s (from build.sh)
    .equ    PVARS,       PVARS_ADDR              @ photo cave VARS (from build.sh)
    .equ    LUT_PTR,     0                       @ offsets into PVARS
    .equ    CUR_PAL,     4
    .equ    YMAP_BYTES,  256                     @ the luma map, right before the table (lut_fill)
    .equ    TICK,        0x126b80                @ FreeRTOS xTickCount
    .equ    NEWREC_MS,   500
    .equ    V_LAST,      0                       @ offsets into VVARS
    .equ    V_T0,        4
    .equ    V_TS,        8

    .org    0xbb774
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
    ldr     r0, =PVARS                    @ reload: the call may clobber r12
    ldr     r12, [r0, #LUT_PTR]           @ r12 = table
    ldr     r5, [r0, #CUR_PAL]            @ r5 = palette colours (Y,U,V each)
    mov     r10, #0                       @ r10 = band index b (0..31)
bandloop:
    mov     r9, #0                        @ r9 = block index c, x = 2c
pixloop:
    @ ---- representative luma = average of the 4 block pixels ----
    add     r6, r11, r9, lsl #1           @ even luma addr (x, x+1)
    ldrb    r0, [r6]
    ldrb    r1, [r6, #1]
    add     r0, r0, r1
    add     r6, r11, r7                   @ odd_base
    add     r6, r6, r8                    @ + third (odd luma starts there)
    add     r6, r6, r9, lsl #1            @ + x
    ldrb    r1, [r6]
    ldrb    r2, [r6, #1]
    add     r0, r0, r1
    add     r0, r0, r2                    @ sum of 4 luma
    mov     r0, r0, lsr #2                @ repY
    @ ---- contrast / brightness: the preset's luma map (lut_fill) ----
    add     r0, r12, r0
    ldrb    r0, [r0, #-YMAP_BYTES]
    @ ---- Bayer dither: repY += (BAYER[b&3][c&3] - 8) * 4, clamped 0..255 ----
    adr     lr, BAYER
    and     r6, r10, #3
    add     lr, lr, r6, lsl #2
    and     r6, r9, #3
    ldrb    r6, [lr, r6]
    sub     r6, r6, #8
    add     r0, r0, r6, lsl #2
    cmp     r0, #0
    movlt   r0, #0
    cmp     r0, #255
    movgt   r0, #255                      @ r0 = Yp
    @ ---- chroma U,V of this block (split at third/2, even chroma at +2*third) ----
    cmp     r9, r8, lsr #1
    addlo   r6, r11, r8, lsl #1
    addlo   r6, r6, r9, lsl #1
    subhs   r1, r9, r8, lsr #1
    addhs   r6, r11, r7
    addhs   r6, r6, r1, lsl #1            @ r6 = chroma pair addr (kept for the write)
    ldrb    r1, [r6]                      @ U
    ldrb    r2, [r6, #1]                  @ V
    @ ---- table lookup: ((yq*33 + uq)*33 + vq), q = (x + 4) >> 3 ----
    add     r0, r0, #4
    mov     r0, r0, lsr #3
    add     r1, r1, #4
    mov     r1, r1, lsr #3
    add     r2, r2, #4
    mov     r2, r2, lsr #3
    add     r0, r0, r0, lsl #5            @ yq * 33
    add     r0, r0, r1
    add     r0, r0, r0, lsl #5            @ * 33
    add     r0, r0, r2
    ldrb    r3, [r12, r0]                 @ byte offset of the colour (3 * index)
    add     r4, r5, r3
    ldrb    r0, [r4]                      @ pY
    ldrb    r1, [r4, #1]                  @ pU
    ldrb    r2, [r4, #2]                  @ pV
    @ ---- write the palette colour to the whole 2x2 block ----
    strb    r1, [r6]                      @ chroma pair
    strb    r2, [r6, #1]
    add     r6, r11, r9, lsl #1           @ even luma (x, x+1)
    strb    r0, [r6]
    strb    r0, [r6, #1]
    add     r6, r11, r7                   @ odd luma (x, x+1)
    add     r6, r6, r8
    add     r6, r6, r9, lsl #1
    strb    r0, [r6]
    strb    r0, [r6, #1]
    add     r9, r9, #1
    cmp     r9, r8                        @ third chroma pairs (= width/2) per band
    blo     pixloop
    add     r11, r11, r7, lsl #1          @ even_base += 2*stride
    add     r10, r10, #1
    cmp     r10, #32
    blo     bandloop
    sub     r11, r11, r7, lsl #6          @ r11 = strip base again
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
    .align  2
BAYER:
    .byte   0, 8, 2, 10
    .byte   12, 4, 14, 6
    .byte   3, 11, 1, 9
    .byte   15, 7, 13, 5
VVARS:
    .word   0                             @ V_LAST: tick of the last strip
    .word   0                             @ V_T0: tick at this strip's start
    .word   0                             @ V_TS: timestamp of the last strip's frame
