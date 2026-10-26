@ Shared by photo_cave.s and video_cave.s: the current look's state in the
@ photo cave's VARS (lut_fill sets it), and the per-block steps of fx_strip
@ (photo_cave.s, 2x2 blocks; video_cave.s fx4, 4x4 blocks). tools/sim_look.py
@ is the exact reference.

    .equ    LUT_PTR,     0                @ offsets into VARS: the table (after the row buffer and luma map)
    .equ    CUR_PAL,     4                @ the look's paint colours; 0 = hooks off
    .equ    PAL_IDX,     8                @ the look of the current photo/video
    .equ    STRIP_N,     12               @ strips processed in this photo
    .equ    FLAGS,       16               @ byte: the look's PRESET_FX flags (FX_RAMP, FX_GBTONE, FX_PIX4)
    .equ    SHARP_W,     17               @ byte: its sharpening, /128
    .equ    NCOL,        18               @ byte: its number of colours
    .equ    DITHER,      20               @ 16 signed bytes: luma offset at (row & 3) * 4 + (col & 3)
    .equ    YMAP_BYTES,  256              @ the luma map, right before the table
    .equ    ROWBUF_BYTES, 448             @ a row of blocks' mapped luma (from its 2nd byte), before the luma map
    .if     ROWBUF_BYTES < MAX_BLOCKS + 2
    .error  "the row buffer holds fewer blocks than the widest size has"
    .endif

@ r0 clamped to 0..255.
    .macro  CLAMP
    cmp     r0, #0
    movlt   r0, #0
    cmp     r0, #255
    movgt   r0, #255
    .endm

@ r0 = a block's mapped luma, sharpened with its row neighbours (r4 = the row
@ buffer, padded with a copy of each end, r9 = its column): y + ((2y - left -
@ right) * w >> 7), w at [sp], none if 0; left unclamped (the dither's clamp
@ follows). Clobbers r1-r3.
    .macro  SHARPEN
    ldr     r3, [sp]
    cmp     r3, #0
    beq     9f
    add     r2, r4, r9
    ldrb    r1, [r2, #-1]                 @ left
    ldrb    r2, [r2, #1]                  @ right
    add     r1, r1, r2
    rsb     r1, r1, r0, lsl #1            @ 2y - left - right
    mul     r1, r3, r1
    add     r0, r0, r1, asr #7
9:
    .endm

@ Pad the row buffer (r4) of n blocks (the operand) with a copy of each end,
@ at -1 and n. Clobbers r0, r1.
    .macro  PAD n:vararg
    ldrb    r0, [r4]
    strb    r0, [r4, #-1]
    mov     r1, \n
    add     r1, r1, r4
    ldrb    r0, [r1, #-1]
    strb    r0, [r1]
    .endm

@ (r0, r1, r2) = a block's Y, U, V -> the paint colour the table gives for
@ them: ((yq * 33 + uq) * 33 + vq), q = (x + 4) >> 3. r12 = the table, r5 =
@ the paint colours. Clobbers r3.
    .macro  LOOKUP
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
    add     r3, r5, r3
    ldrb    r0, [r3]
    ldrb    r1, [r3, #1]
    ldrb    r2, [r3, #2]
    .endm
