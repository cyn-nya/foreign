#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
OUT=llm
mkdir -p "$OUT"

fetch () {
  local path="$1" name="$2"
  for attempt in 1 2 3 4; do
    code=$(curl -sL --max-time 30 -w '%{http_code}' "https://aholojs.dev${path}" -o "$OUT/$name" 2>/dev/null)
    size=$(wc -c < "$OUT/$name" 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "$size" -gt 20 ]; then
      echo "OK   $name ($size)"
      return 0
    fi
    sleep 1
  done
  echo "FAIL $path"
  return 1
}

fetch "/llm/index.md"                    "index.md"
fetch "/llm/manual/index.md"             "manual-index.md"
fetch "/llm/manual/getting-started.md"   "manual-getting-started.md"
fetch "/llm/manual/basic-concepts.md"    "manual-basic-concepts.md"
fetch "/llm/manual/config.md"            "manual-config.md"
fetch "/llm/manual/3dgs-preset-config.md" "manual-3dgs-preset.md"
fetch "/llm/manual/splat-transform.md"   "manual-splat-transform.md"
fetch "/llm/manual/physics-collision.md" "manual-physics-collision.md"
fetch "/llm/manual/playground.md"        "manual-playground.md"
fetch "/llm/manual/viewer.md"            "manual-viewer.md"
fetch "/llm/manual/chunk-lod.md"         "manual-chunk-lod.md"
echo "--- api index (may be large) ---"
fetch "/llm/api/index.md"                "api-index.md"
echo "--- examples ---"
fetch "/llm/examples/index.md"           "examples-index.md"
echo "--- done ---"
ls -la "$OUT"
