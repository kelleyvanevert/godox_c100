@ Redirect the aspect bracket routine FUN_0004a7f4 (after its flag set-up) to bracket_hook (lcd_cave.s).
@ Replaces `sub r1, r1, #1` at 0x4a818 (the aspect to the jump table's index), which the hook re-executes
@ before jumping back to 0x4a81c.

    .syntax unified
    .arm
base:
    .set    TARGET, base + HOOK           @ bracket_hook (address from build.sh)
    .org    0x4a818
    b       TARGET
