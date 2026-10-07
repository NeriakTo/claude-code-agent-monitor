#!/bin/sh
# Writes the renders that tests/renders.test.ts prints into docs/renders/: the plain-text samples
# as <name>.txt and the README's pictures as <name>.svg, so a reviewer can see the band and the
# pane without loading the mod.
set -eu
cd "$(dirname "$0")/.."
mkdir -p docs/renders
claude plugin test . 2>&1 | awk '
  /^----- render:/ { name = $2; sub(/^render:/, "", name); file = "docs/renders/" name ".txt"; printf "" > file; next }
  /^----- svg:/ { name = $2; sub(/^svg:/, "", name); file = "docs/renders/" name ".svg"; printf "" > file; next }
  /^----- end(-svg)?:/ { if (file != "") close(file); file = ""; next }
  file != "" { print >> file }
'
ls docs/renders
