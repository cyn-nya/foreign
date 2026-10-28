#!/usr/bin/env python
"""Shrink the generated assets by downscaling their textures, in place.

    python tools/shrink-assets.py --dry-run
    python tools/shrink-assets.py

Why this exists
---------------
The demo loads all 55 models at boot, 254.5 MB of them, and measurement says 84% of that is
texture data: 82 images, every one of them 2048x2048 PNG, accounting for 212.2 MB. The other
28 images are 256x256 JPEG and total 0.3 MB, which is nothing.

Nothing on screen can show 2048x2048. The props are 0.1-2.05 m tall in a dark room, and the
viewer rasterises at 0.4x on any machine that struggles -- a 1 m object two metres away covers
about 290 px of a 720-line frame, so the texture is already oversampled roughly seven times.
1024 is still a three-to-fourfold margin.

What it does
------------
Rewrites each .glb with its PNG images decoded, resized to a 1024 px box, and re-encoded as
PNG. No format changes: a normal map stays a normal map, with no JPEG ringing on the one kind
of texture where artefacts are visible as shading errors.

The BIN chunk is rebuilt bufferView by bufferView in the original order, so every accessor
index and every byteStride stays valid; only the image views change size, and every view's
byteOffset is recomputed with the 4-byte alignment the format requires.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import struct
import sys

from PIL import Image

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

MAX_EDGE = 1024


def read_glb(path: str):
    with open(path, "rb") as handle:
        data = handle.read()
    if len(data) < 20 or struct.unpack_from("<I", data, 0)[0] != 0x46546C67:
        raise ValueError("not a GLB")
    offset = 12
    gltf = None
    binary = b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        body = data[offset + 8 : offset + 8 + length]
        if kind == JSON_CHUNK:
            gltf = json.loads(body.decode("utf-8"))
        elif kind == BIN_CHUNK:
            binary = body
        offset += 8 + length + ((4 - length % 4) % 4)
    if gltf is None:
        raise ValueError("no JSON chunk")
    return gltf, binary


def write_glb(path: str, gltf: dict, binary: bytes) -> None:
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    bn = binary + b"\x00" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bn)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<III", 0x46546C67, 2, total))
        handle.write(struct.pack("<II", len(js), JSON_CHUNK))
        handle.write(js)
        handle.write(struct.pack("<II", len(bn), BIN_CHUNK))
        handle.write(bn)


def shrink(path: str, dry_run: bool) -> tuple[int, int, int]:
    """Returns (before bytes, after bytes, textures resized)."""
    before = os.path.getsize(path)
    gltf, binary = read_glb(path)

    images = gltf.get("images", [])
    views = gltf.get("bufferViews", [])
    # Which bufferViews are images, and what they become.
    replacements: dict[int, bytes] = {}
    resized = 0

    for image in images:
        index = image.get("bufferView")
        if index is None:
            continue
        view = views[index]
        start = view.get("byteOffset", 0)
        raw = binary[start : start + view["byteLength"]]
        try:
            with Image.open(io.BytesIO(raw)) as opened:
                opened.load()
                width, height = opened.size
                if max(width, height) <= MAX_EDGE:
                    continue
                scale = MAX_EDGE / max(width, height)
                target = (max(1, round(width * scale)), max(1, round(height * scale)))
                out = io.BytesIO()
                # A generous filter: these are being cut by half, and a cheap resample would
                # show as aliasing on exactly the hard edges the anomalies are made of.
                opened.convert("RGBA" if opened.mode in ("RGBA", "LA", "P") else "RGB").resize(
                    target, Image.LANCZOS
                ).save(out, format="PNG", optimize=True)
                replacements[index] = out.getvalue()
                resized += 1
        except Exception as error:  # noqa: BLE001 - reported, never fatal
            print(f"    ! {os.path.basename(path)}: image {index} left alone ({error})")

    if not replacements:
        return before, before, 0
    if dry_run:
        saved = sum(views[i]["byteLength"] - len(v) for i, v in replacements.items())
        return before, before - saved, resized

    # Rebuild the binary chunk in the original bufferView order so nothing that indexes a view
    # by number has to move.
    chunks: list[bytes] = []
    cursor = 0
    for index, view in enumerate(views):
        payload = replacements.get(index)
        if payload is None:
            start = view.get("byteOffset", 0)
            payload = binary[start : start + view["byteLength"]]
        pad = (4 - cursor % 4) % 4
        if pad:
            chunks.append(b"\x00" * pad)
            cursor += pad
        view["byteOffset"] = cursor
        view["byteLength"] = len(payload)
        chunks.append(payload)
        cursor += len(payload)

    gltf.setdefault("buffers", [{}])[0]["byteLength"] = cursor
    write_glb(path, gltf, b"".join(chunks))
    return before, os.path.getsize(path), resized


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--dir", default="public/assets/foreign")
    parser.add_argument(
        "--backup",
        default=".cache/foreign-original",
        help="originals are copied here once, before anything is rewritten",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"no such directory: {args.dir}")
        return 1

    files = sorted(f for f in os.listdir(args.dir) if f.endswith(".glb"))
    if not files:
        print(f"no .glb files in {args.dir}")
        return 1

    if not args.dry_run:
        os.makedirs(args.backup, exist_ok=True)
        for name in files:
            target = os.path.join(args.backup, name)
            # Only once: re-running must not overwrite a good backup with an already-shrunk
            # file, or the originals would be gone after the second run.
            if not os.path.exists(target):
                shutil.copy2(os.path.join(args.dir, name), target)
        print(f"originals in {args.backup} ({len(files)} files)")

    total_before = total_after = 0
    resized = 0
    for name in files:
        before, after, count = shrink(os.path.join(args.dir, name), args.dry_run)
        total_before += before
        total_after += after
        resized += count
        print(f"  {name:<32} {before/1e6:6.2f} -> {after/1e6:6.2f} MB  ({count} textures)")

    saved = 100 * (1 - total_after / total_before) if total_before else 0
    print(
        f"\n{len(files)} files, {resized} textures over {MAX_EDGE}px\n"
        f"{total_before/1e6:.1f} MB -> {total_after/1e6:.1f} MB  ({saved:.0f}% smaller)"
        + ("\n[dry run: nothing written]" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
