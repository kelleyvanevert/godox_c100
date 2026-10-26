@ Redirect the stock aspect change FUN_000213e0(delta) (the arrow keys; it moves the UI's aspect
@ setting) to aspect_hook (lcd_cave.s). Replaces its first instruction (ldr r2, [pc, #0x34], the
@ address 0x1217bd of the setting), which the hook re-executes before jumping back to 0x213e4.

    .syntax unified
    .arm
base:
    .set    TARGET, base + HOOK           @ aspect_hook (address from build.sh)
    .org    0x213e0
    b       TARGET
