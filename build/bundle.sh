#!/bin/sh
# Bundles the decision-pipeline core (+ zod) into one ES module the mod runtime can import:
# a hooks module may only import files of its own plugin, and has no Node.
#   build/bundle.sh /path/to/decision-pipeline     (a checkout with `npm install` done)
set -eu
repo=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
entry=$(mktemp -t dp-entry).ts
cat > "$entry" <<ENTRY
export * from "$repo/src/index";
export { testPorts } from "$repo/src/testing";
export { z } from "$repo/node_modules/zod";
ENTRY
cd "$repo" && npx esbuild "$entry" --bundle --format=esm --platform=neutral --target=es2023 \
  --main-fields=module,main --minify-whitespace --minify-syntax --legal-comments=none \
  --alias:node:crypto="$here/crypto-shim.ts" --outfile="$here/../hooks/vendor/dp.js"
rm -f "$entry"
