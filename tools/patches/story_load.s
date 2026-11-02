@ Read STORY.TXT from the SD card root for story_cave.s.
@
@ The storage task mounts the card and then checks TIME.TXT (FUN_00037914),
@ FORMAT.TXT (FUN_0003bff8) and writes VERSION.TXT (FUN_00037f34, whose only
@ call is the bl at 0x3e03c). story_mount_jump points that bl here: the
@ first time (once per power-on, not when a card goes in later) read up to
@ MAXLEN bytes of the file into a buffer from the heap and start the story
@ at its first line (LINE), then go on to VERSION.TXT. No file, or an empty
@ one: no story. With the firmware's file calls, as its SD update uses them:
@ open(path, 0 = read) -> fd (< 0: none), read(fd, buf, n) -> bytes, close.
@ In the end of the photo cave's dead function, 0xbb340-0xbb3f8.
    .syntax unified
    .arm
base:
    .set    VERSION_TXT, base + 0x37f34   @ the call we replaced
    .set    OPEN,        base + 0x9e608
    .set    READ,        base + 0x9e67c
    .set    CLOSE,       base + 0x9dc7c
    .set    MALLOC,      base + 0x53750
    .set    FREE,        base + 0x53754
    .equ    MAXLEN,      0x1000           @ ~4 KB, hundreds of lines
    .equ    MEM, 0                        @ VARS in story_cave.s
    .equ    BUF, 4
    .equ    END, 8
    .equ    LINE, 12
    .equ    TRIED, 16

    .org    0xbb340
story_load:
    push    {r4-r6, lr}
    ldr     r4, =VARS_ADDR
    ldrb    r0, [r4, #TRIED]
    cmp     r0, #0
    bne     9f
    mov     r0, #1
    strb    r0, [r4, #TRIED]
    ldr     r0, =PATH_ADDR                @ "G:\STORY.TXT" (story_cave.s)
    mov     r1, #0
    mov     lr, pc
    b       OPEN
    subs    r5, r0, #0                    @ r5 = fd
    blt     9f
    mov     r0, #MAXLEN
    mov     lr, pc
    b       MALLOC
    subs    r6, r0, #0                    @ r6 = the buffer
    beq     8f
    mov     r0, r5
    mov     r1, r6
    mov     r2, #MAXLEN
    mov     lr, pc
    b       READ
    add     r1, r6, r0                    @ r1 = the end
    ldrb    r2, [r6]
    cmp     r2, #0xef                     @ a UTF-8 byte order mark (EF BB BF): skip it
    addeq   r2, r6, #3
    movne   r2, r6
    cmp     r0, #0
    cmpgt   r1, r2
    ble     7f                            @ nothing to show
    str     r6, [r4, #MEM]
    str     r2, [r4, #BUF]
    str     r1, [r4, #END]
    str     r2, [r4, #LINE]               @ last: now the story is on
    b       8f
7:  mov     r0, r6
    mov     lr, pc
    b       FREE
8:  mov     r0, r5
    mov     lr, pc
    b       CLOSE
9:  pop     {r4-r6, lr}
    b       VERSION_TXT

    .ltorg
