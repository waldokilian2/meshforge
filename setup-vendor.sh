#!/usr/bin/env bash
# Download Meshy's decoder files (same files the meshy-ai-to-stl extension fetches).
# Run from the repo root. The decoder is not redistributed in this repo.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p vendor

fetch() {
  local url="$1" out="$2"
  echo "Downloading $url"
  curl -fsSL -o "vendor/$out" "$url"
  local size
  size=$(wc -c < "vendor/$out")
  if [ "$size" -le 0 ]; then
    echo "Downloaded file is empty: vendor/$out" >&2
    exit 1
  fi
  echo "Saved vendor/$out ($size bytes)"
}

fetch "https://www.meshy.ai/resource/decrypt/mesh_loader.js" mesh_loader.js
fetch "https://www.meshy.ai/resource/decrypt/mesh_loader.wasm" mesh_loader.wasm

echo "Vendor files ready."
