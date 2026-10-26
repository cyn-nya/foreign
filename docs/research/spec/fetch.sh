#!/usr/bin/env bash
# Download Aholo viewer repo files via jsDelivr with retries.
set -u
cd "$(dirname "$0")"
OUT=gh
mkdir -p "$OUT"

fetch () {
  local path="$1" name="$2"
  local urls=(
    "https://cdn.jsdelivr.net/gh/manycoretech/aholo-viewer@master/${path}"
    "https://fastly.jsdelivr.net/gh/manycoretech/aholo-viewer@master/${path}"
    "https://raw.githubusercontent.com/manycoretech/aholo-viewer/master/${path}"
  )
  for u in "${urls[@]}"; do
    for attempt in 1 2 3; do
      code=$(curl -sL --max-time 30 -w '%{http_code}' "$u" -o "$OUT/$name" 2>/dev/null)
      size=$(wc -c < "$OUT/$name" 2>/dev/null || echo 0)
      if [ "$code" = "200" ] && [ "$size" -gt 20 ]; then
        echo "OK   $name  ($size bytes)  <- ${u%%/gh/*}"
        return 0
      fi
      sleep 1
    done
  done
  echo "FAIL $name"
  return 1
}

fetch "packages/renderer/src/index.ts"                      "renderer-index.ts"
fetch "packages/renderer/package.json"                      "renderer-package.json"
fetch "packages/renderer/README.md"                         "renderer-README.md"
fetch "packages/renderer/src/gltf-loader.ts"                "gltf-loader.ts"
fetch "docs/ai/skills/use-aholo-viewer/SKILL.md"            "skill-use-aholo-viewer.md"
fetch "docs/ai/vibe-coding-guide.md"                        "vibe-coding-guide.md"
fetch "docs/architecture.md"                                "architecture.md"
fetch "website/src/content/examples/3d-buffer-geometry.ts"  "ex-3d-buffer-geometry.ts"
fetch "website/src/content/examples/walk-demo.ts"           "ex-walk-demo.ts"
fetch "website/src/content/examples/home-interaction.ts"    "ex-home-interaction.ts"
fetch "website/src/content/examples/splatting-lod-stream.ts" "ex-splatting-lod-stream.ts"
fetch "website/src/content/examples/3d-point-light.ts"      "ex-3d-point-light.ts"
fetch "website/src/content/examples/splatting-basic.ts"     "ex-splatting-basic.ts"
fetch "website/src/content/examples/webxr-vr.json"          "ex-webxr-vr.json"
fetch "website/src/content/manual/en-US/basic-concepts.md"  "manual-basic-concepts.md"
fetch "website/src/content/manual/en-US/config.md"          "manual-config.md"
fetch "website/src/content/manual/en-US/chunk-lod.md"       "manual-chunk-lod.md"
fetch "website/src/content/manual/en-US/splat-transform.md" "manual-splat-transform.md"
fetch "website/src/content/manual/en-US/3dgs-preset-config.md" "manual-3dgs-preset.md"
fetch "README.md"                                           "viewer-README.md"
fetch "packages/splat-transform/README.md"                  "splat-transform-README.md"
fetch "AGENTS.md"                                           "AGENTS.md"
echo "--- done ---"
ls -la "$OUT"
