@ The story's hooks (see story_cave.s); each is the stock code
@ unless a story is on (LINE != 0). In the free end of the video cave,
@ 0xbbb08-0xbbc00 (the video cave ends there with VIDTIMING=1).
@
@ The three short-press keys (FUN_0001dcb8 left arrow, FUN_0001dd6c center,
@ FUN_0001de20 right arrow) each post 0x7018 and then their own message,
@ once per press (latch 0x1217bc, cleared by the timer FUN_0001fdc8). Their
@ second post (bl MSG_POST at 0x1dd44, 0x1ddf8, 0x1deac) comes here; in
@ story mode the arrows step the story instead and the center button ends
@ it at once, then they return into the handler. Otherwise the center one
@ goes on to CENTER_NEXT, lcd_cave.s's center_hook (or the stock post with
@ LCDTAG=0).
@
@ The shutter (FUN_0001df64, the "ok" key) sets its own latch (0x12163d,
@ cleared by the timer FUN_0001fdfc) and then, by the UI state, posts the
@ capture (0x7015, 0x7001) or the readout state's 0x7018, 0x703d. The
@ `cmp r3, #2` (UI state 2?) just after the latch, at 0x1dff8, comes here:
@ in story mode step the story and leave through the handler's epilogue
@ (0x1e040), posting nothing.
@
@ The display refresh (FUN_00021318, the peripheral task's periodic call)
@ draws everything on the panel: the readouts, and every other tick the
@ mode icons and logo, the aspect bracket and the battery. Its first
@ instruction, ldr r2, [pc, #0xac] (=0x1217be, its startup flag), at
@ 0x21318 comes here: in story mode draw only the line (draw clears the
@ rest) and return, so nothing else even flickers on. When the story ends,
@ story_next runs one stock refresh at once, as an icon tick and past the
@ startup ticks, so the readouts, icons, bracket and battery are all back.
    .syntax unified
    .arm
base:
    .set    MSG_POST,    base + 0x42c
    .set    SHUTTER_ON,  base + 0x1dffc   @ after the replaced cmp r3, #2
    .set    SHUTTER_OUT, base + 0x1e040   @ the shutter handler's epilogue
    .set    REFRESH,     base + 0x21318   @ the display refresh
    .set    REFRESH_ON,  base + 0x2131c   @ after its replaced first instruction
    .set    FREE,        base + 0x53754   @ the firmware's free
    .set    PREV,        base + PREV_ADDR @ story_cave.s
    .set    DRAW,        base + DRAW_ADDR
    .set    CENTER,      base + CENTER_NEXT
    .equ    STARTED,     0x1217be         @ the refresh's flag: past its startup ticks
    .equ    ICON_TICK,   0x1217b0         @ its tick counter: 1 = this tick draws the icons
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
    ldr     r0, =VARS_ADDR                @ story mode: skip the rest of it
    b       story_end

story_shutter:                          @ r3 = the UI state
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    bne     1f
    cmp     r3, #2                        @ the instruction we replaced
    b       SHUTTER_ON                    @ (b keeps its flags)
1:  ldr     lr, =SHUTTER_OUT - base
    b       story_next

story_refresh:                          @ lr = the refresh's caller
    ldr     r12, =VARS_ADDR
    ldr     r12, [r12, #LINE]
    cmp     r12, #0
    bne     DRAW
    ldr     r2, =STARTED                  @ the instruction we replaced
    b       REFRESH_ON

@ The next line, or past the last one the end of the story (story_end, also
@ the center button's): then free the text and draw the stock display at
@ once. Keeps r4-r11.
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
2:
story_end:                              @ (r0 = VARS) the story is over
    mov     r1, #0
    str     r1, [r0, #LINE]
    push    {r4, lr}
    ldr     r0, [r0, #MEM]
    mov     lr, pc
    b       FREE
    pop     {r4, lr}
    ldr     r0, =ICON_TICK
    mov     r1, #1
    strb    r1, [r0]                      @ this refresh draws the icons too
    strb    r1, [r0, #STARTED - ICON_TICK]
    b       REFRESH

    .ltorg
