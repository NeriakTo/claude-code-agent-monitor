#!/bin/sh
# Writes the plain-text renders that tests/renders.test.ts prints into docs/renders/<name>.txt,
# so a reviewer can see the band and the pane without loading the mod.
set -eu
cd "$(dirname "$0")/.."
mkdir -p docs/renders
claude plugin test . 2>&1 | awk '
  /^----- render:/ { name = $2; sub(/^render:/, "", name); file = "docs/renders/" name ".txt"; printf "" > file; next }
  /^----- end:/ { if (file != "") close(file); file = ""; next }
  file != "" { print >> file }
'
ls docs/renders
