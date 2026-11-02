@ A story on the see-through display at startup (STORY=0 leaves it out).
@
@ If the SD card holds STORY.TXT in its root, the camera shows it one line
@ at a time on the display's 7 segment cells, 2 under ISO, 2 under F and 3
@ under SS, as story/maker.html shows it: a character per cell (W and M
@ over two), and a '.' right after the 3rd character lights the F decimal
@ point. The right arrow and the shutter go to the next line, the left
@ arrow back one (not before the first), the center button does nothing;
@ none of them do what they otherwise would. Past the last line the story
@ is over and the camera is in the mode it was in all along (photo, video
@ or the readout state, from the switch). Everything else (the icons, the
@ brackets, the battery) is drawn as stock throughout.
@
@ story_load.s reads the file when the card is first mounted (once per
@ power-on) into a buffer from the firmware's heap: MEM, BUF (the text,
@ after a UTF-8 byte order mark), END, and LINE, the start of the line
@ shown; LINE != 0 is story mode. story_hooks.s holds the hooks: the
@ display refresh's last step, b 0x21180 (the ISO/F/SS readouts) at
@ 0x213b8, draws the line instead in story mode, and the keys step it
@ (story_next there, story_prev here).
@
@ draw builds the nibbles for HT1621 addresses 0x00..0x14 (the readouts'
@ cells, labels and boxes, the fixed zeros and the decimal point; all off
@ but the line, lit by put in story_data.s) keeping the two segments there
@ that aren't the readouts' as the firmware's copy (SHADOW) has them: 06.0,
@ the 16:9 bracket, and 14.0, the video icon. It sends what changed through
@ seg_write (0x49e34, which updates SHADOW), and address 0x14 always: the
@ icons routine sets the video icon only in SHADOW, and the SS routine we
@ skip is what sends it. All of it runs in the peripheral task, as the
@ refresh and the key handlers do.
    .syntax unified
    .arm
    .include "story.inc"                  @ STORY_NADDR
base:
    .set    SEG_WRITE,   base + 0x49e34   @ seg_write(addr, nibble), updates SHADOW
    .set    PUT,         base + PUT_ADDR  @ story_data.s
    .equ    SHADOW,      0x1240e0         @ firmware's copy of the HT1621 RAM
    .equ    MEM, 0                       @ VARS: the buffer (for free)
    .equ    BUF, 4                        @ the text
    .equ    END, 8                        @ its end
    .equ    LINE, 12                      @ the line shown, 0 = no story
    .equ    TRIED, 16                     @ (byte) 1 = looked for the file

    .org    0xba74c
@ Draw the line at LINE (not 0). From the refresh hook (lr = the refresh's
@ caller) and after a key. Keeps r4-r11.
draw:
    push    {r4-r10, lr}
    sub     sp, sp, #24                   @ [sp] = the nibbles for 0..STORY_NADDR-1
    mov     r0, #0
    mov     r1, #0
    mov     r2, #0
    mov     r3, #0
    stmia   sp, {r0-r3}
    str     r0, [sp, #16]
    str     r0, [sp, #20]
    ldr     r1, =SHADOW
    ldrb    r0, [r1, #0x06]
    and     r0, r0, #8                    @ keep 06.0 (the 16:9 bracket)
    strb    r0, [sp, #0x06]
    ldrb    r0, [r1, #0x14]
    and     r0, r0, #8                    @ keep 14.0 (the video icon)
    strb    r0, [sp, #0x14]
    mov     r0, #0xff                     @ and send it: the icons set it only in SHADOW,
    strb    r0, [r1, #0x14]               @  the SS routine we skip sends it
    ldr     r4, =VARS - base
    ldr     r5, [r4, #LINE]               @ r5 = the next character
    ldr     r6, [r4, #END]
    mov     r7, #0                        @ r7 = the next cell
    mov     r8, #0                        @ r8 = 1: a '.' now lights the decimal point
1:  cmp     r5, r6
    bhs     5f
    ldrb    r0, [r5], #1
    cmp     r0, #10                       @ the end of the line
    beq     5f
    cmp     r0, #13
    beq     1b
    cmp     r0, #'.'
    bne     2f
    cmp     r8, #0
    ldrbne  r1, [sp, #0x09]
    orrne   r1, r1, #2                    @ 09.2, the decimal point
    strbne  r1, [sp, #0x09]
    movne   r8, #0
    bne     1b
2:  sub     r9, r0, #0x20                 @ r9 = the character's index in FONT
    cmp     r9, #0x5f
    movhi   r9, #0                        @ not in the font's range: a space
    ldr     r1, =FONT_ADDR
    ldrb    r10, [r1, r9]                 @ r10 = its segments, bit 7 = two cells
    tst     r10, #0x80
    addeq   r0, r7, #1
    addne   r0, r7, #2
    cmp     r0, #7
    bhi     5f                            @ doesn't fit: the rest of the line doesn't show
    and     r0, r10, #0x7f
    mov     lr, pc
    b       PUT
    tst     r10, #0x80
    beq     4f
    ldr     r1, =WIDE_ADDR                @ the second cell
3:  ldrb    r0, [r1], #2
    cmp     r0, #0xff
    moveq   r0, #0
    beq     6f
    cmp     r0, r9
    bne     3b
    ldrb    r0, [r1, #-1]
6:  mov     lr, pc
    b       PUT
4:  mov     r8, #0                        @ a character just filled the 3rd cell
    cmp     r7, #3                        @  and isn't a space: a '.' may follow
    bne     1b
    cmp     r9, #0
    movne   r8, #1
    b       1b
5:  mov     r7, #0                        @ send what changed
    ldr     r8, =SHADOW
7:  ldrb    r1, [sp, r7]
    ldrb    r0, [r8, r7]
    cmp     r0, r1
    movne   r0, r7
    movne   lr, pc
    bne     SEG_WRITE
    add     r7, r7, #1
    cmp     r7, #STORY_NADDR
    blo     7b
    add     sp, sp, #24
    pop     {r4-r10, pc}

@ The line before, if there is one.
story_prev:
    ldr     r0, =VARS - base
    ldr     r1, [r0, #LINE]
    ldr     r2, [r0, #BUF]
    cmp     r1, r2
    movls   pc, lr                        @ the first line: stay
    sub     r1, r1, #1                    @ the '\n' that ends the line before
3:  cmp     r1, r2
    bls     4f
    ldrb    r3, [r1, #-1]
    cmp     r3, #10
    subne   r1, r1, #1
    bne     3b
4:  str     r1, [r0, #LINE]
    b       draw

    .ltorg
    .align  2
VARS:
    .word   0, 0, 0, 0                    @ MEM, BUF, END, LINE
    .byte   0, 0, 0, 0                    @ TRIED
PATH:                                   @ for story_load.s (out of room there)
    .asciz  "G:\\STORY.TXT"
