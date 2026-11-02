@ One `b HOOK` at AT (both from build.sh, --defsym), in place of an
@ instruction or a tail call: the story's hooks (story_hooks.s).
    .syntax unified
    .arm
    .org    AT
    .word   0xea000000 | (((HOOK - AT - 8) >> 2) & 0xffffff)
