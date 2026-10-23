#!/bin/sh
# Check the site's firmware editor against build.sh: for random configs (1-8
# presets of 1-32 colours, random tags, display segments, rnd on/off, sounds
# on/off, tags on/off, random photo sizes, random and stock WAVs), the
# editor's patched template must equal what build.sh assembles from the same
# config, byte for byte.
#   sh tools/editor_check.sh [COUNT]
# Run tools/editor_data.py first (the template and site/editor/template.json).
set -e
cd "$(dirname "$0")/.."
OUT=build/editor_check
rm -rf "$OUT"
node tools/editor_check.mjs "$OUT" "${1:-12}"
fail=0
for dir in "$OUT"/case*; do
    PRESETS_JSON=$dir/config.json SILENT=$(cat "$dir/silent") \
        SHUTTER_WAV=$dir/shutter.wav POWERON_WAV=$dir/poweron.wav \
        sh tools/build.sh >/dev/null
    if cmp -s build/GP_CARDVR_UPGRADE.BIN "$dir/editor.bin"; then
        echo "$(basename "$dir"): same"
    else
        echo "$(basename "$dir"): DIFFERENT, $(cmp -l build/GP_CARDVR_UPGRADE.BIN "$dir/editor.bin" | wc -l | tr -d ' ') bytes"
        fail=1
    fi
done
# leave build/ as the template build again
uv run -q --with pillow tools/editor_data.py >/dev/null
[ $fail = 0 ] && echo "editor check PASSED" || { echo "editor check FAILED"; exit 1; }
