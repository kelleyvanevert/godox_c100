@ The story's hooks (see story_cave.s); each is the stock code
@ unless a story is on (LINE != 0). In the free end of the video cave,
@ 0xbbb08-0xbbc00 (the video cave ends there with VIDTIMING=1).
@
@ The three short-press keys (FUN_0001dcb8 left arrow, FUN_0001dd6c center,
@ FUN_0001de20 right arrow) each post 0x7018 and then their own message,
@ once per press (latch 0x1217bc, cleared by the timer FUN_0001fdc8). Their
@ second post (bl MSG_POST at 0x1dd44, 0x1ddf8, 0x1deac) comes here; in
@ story mode it steps the story instead and returns into the handler.
@ The center one goes on to CENTER_NEXT, lcd_cave.s's center_hook (or the
@ stock post with LCDTAG=0).
@
@ The shutter (FUN_0001df64, the "ok" key) sets its own latch (0x12163d,
@ cleared by the timer FUN_0001fdfc) and then, by the UI state, posts the
@ capture (0x7015, 0x7001) or the readout state's 0x7018, 0x703d. The
@ `cmp r3, #2` (UI state 2?) just after the latch, at 0x1dff8, comes here:
@ in story mode step the story and leave through the handler's epilogue
@ (0x1e040), posting nothing.
@
@ The display refresh (FUN_00021318) ends with b 0x21180, the readouts, at
@ 0x213b8 (r0 = 1 in the readout state; r3-r5 and lr already restored):
@ in story mode draw the line in their place.
    .syntax unified
    .arm
base:
    .set    MSG_POST,    base + 0x42c
    .set    SHUTTER_ON,  base + 0x1dffc   @ after the replaced cmp r3, #2
    .set    SHUTTER_OUT, base + 0x1e040   @ the shutter handler's epilogue
    .set    READOUTS,    base + 0x21180   @ the stock readouts (r0 = 1 in the readout state)
    .set    FREE,        base + 0x53754   @ the firmware's free
    .set    PREV,        base + PREV_ADDR @ story_cave.s
    .set    DRAW,        base + DRAW_ADDR
    .set    CENTER,      base + CENTER_NEXT
    .equ    UI_STATE,    0x121706         @ 0/1 = photo/video mode, 2 = readout
    .equ    MEM, 0                        @ story_cave.s's VARS
    .equ    END, 8
    .equ    LINE, 12

    .org    0xbbb08
story_right:                            @ r0-r3, [sp]: MSG_POST's arguments
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    beq     MSG_POST
    b       story_next

story_left:
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    beq     MSG_POST
    b       PREV

story_center:
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    beq     CENTER
    mov     pc, lr

story_shutter:                          @ r3 = the UI state
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    bne     1f
    cmp     r3, #2                        @ the instruction we replaced
    b       SHUTTER_ON                    @ (b keeps its flags)
1:  ldr     lr, =SHUTTER_OUT - base
    b       story_next

story_refresh:                          @ r0 = the readouts' flag
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    beq     READOUTS
    b       DRAW

@ The next line, or past the last one the end of the story: then free the
@ text and draw the stock readouts at once. Keeps r4-r11.
story_next:
    ldr     r0, =VARS_ADDR
    ldr     r1, [r0, #LINE]
    ldr     r2, [r0, #END]
1:  cmp     r1, r2
    bhs     2f
    ldrb    r3, [r1], #1
    cmp     r3, #10
    bne     1b
    cmp     r1, r2
    strlo   r1, [r0, #LINE]
    blo     DRAW
2:  mov     r1, #0
    str     r1, [r0, #LINE]               @ the story is over
    push    {r4, lr}
    ldr     r0, [r0, #MEM]
    mov     lr, pc
    b       FREE
    pop     {r4, lr}
    ldr     r0, =UI_STATE
    ldrb    r0, [r0]
    cmp     r0, #2
    moveq   r0, #1
    movne   r0, #0
    b       READOUTS

    .ltorg
