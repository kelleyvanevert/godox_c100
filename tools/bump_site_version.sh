#!/bin/sh
# Stamp the site's own scripts, stylesheet and editor modules with a new ?v=
# (today's date and time), so browsers fetch them afresh after a deploy instead
# of mixing cached and new files. The editor's JSON follows editor.js's stamp.
#   sh tools/bump_site_version.sh
set -e
cd "$(dirname "$0")/.."
v=$(date +%Y%m%d%H%M)
sed -i '' -E "s/\?v=[0-9]+/?v=$v/g" site/index.html site/editor/editor.js site/editor/sim.js site/editor/films.js
echo "site version $v"
