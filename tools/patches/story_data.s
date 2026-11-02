@ The story's font and the display's cell wiring, from tools/story.py asm
@ (story.inc): FONT, one byte per character 0x20..0x7f (bit 0 = segment
@ a .. bit 6 = g, bit 7 = the glyph takes a second cell), WIDE, the second
@ cells (character - 0x20, segments; 0xff ends it), and WIRE, per cell (ISO
@ 1-2, F 1-2, SS 1-3) and segment a..g the HT1621 address << 2 | COM. And
@ put, which reads WIRE. In the free end of the display cave's dead range,
@ 0xbc660-0xbc744 (after lcd_cave.s). See story_cave.s.
    .syntax unified
    .arm
    .include "story.inc"
    .org    0xbc660
@ Light segments r0 (bit 0 = a .. bit 6 = g) of cell r7 in the nibbles at
@ [sp] (story_cave.s's draw), and step r7. Uses r0-r3, r12.
put:
    adr     r1, WIRE
    rsb     r2, r7, r7, lsl #3
    add     r1, r1, r2                    @ r1 = the cell's 7 wires
    add     r7, r7, #1
1:  movs    r0, r0, lsr #1
    bcc     2f
    ldrb    r2, [r1]
    and     r3, r2, #3                    @ COM
    mov     r2, r2, lsr #2                @ address
    mov     r12, #8
    mov     r3, r12, lsr r3
    ldrb    r12, [sp, r2]
    orr     r12, r12, r3
    strb    r12, [sp, r2]
2:  add     r1, r1, #1
    cmp     r0, #0
    bne     1b
    mov     pc, lr

    STORY_DATA
