"""Shrink the Lux3D assets by rebuilding their textures at a sane size.

Measured: the 14 generated assets carry 2 x 2048x2048 textures each, and 85-93%
of every file is texture, not geometry. That is ~54 MB of texture for props the
player looks at from across a room — and it is what makes a floor with six of
them render at seconds per frame under software rasterisation, and what makes the
first load 71 MB.

These are background props at gameplay distance. 256 px is indistinguishable
there and cuts the texture payload by 64x, so the same room loads far faster and
fits in GPU memory on a weak laptop.

The GLB container is rebuilt properly rather than patched in place: a GLB is a
header plus a JSON chunk plus a BIN chunk, and every bufferView is addressed by
byte offset, so replacing an image means re-laying-out the whole BIN chunk and
rewriting the offsets. Writing bytes back at the same offsets would corrupt any
bufferView that came after a resized image.

Usage: python tools/optimize-assets.py [--size 256] [--quality 82] [--dry-run]
"""

import argparse
import io
import json
import os
import shutil
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image  # noqa: E402

ASSETS = os.path.join('public', 'assets', 'foreign')
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
GLB_MAGIC = 0x46546C67


def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, _ = struct.unpack('<III', data[:12])
    if magic != GLB_MAGIC:
        raise ValueError('not a GLB')
    chunks = {}
    off = 12
    while off < len(data):
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        chunks[ctype] = data[off + 8:off + 8 + clen]
        off += 8 + clen
    gltf = json.loads(chunks[JSON_CHUNK].decode('utf-8'))
    return gltf, chunks[BIN_CHUNK]


def write_glb(path, gltf, bin_chunk):
    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    binc = bin_chunk + b'\x00' * ((4 - len(bin_chunk) % 4) % 4)
    total = 12 + 8 + len(js) + (8 + len(binc) if binc else 0)
    out = io.BytesIO()
    out.write(struct.pack('<III', GLB_MAGIC, 2, total))
    out.write(struct.pack('<II', len(js), JSON_CHUNK))
    out.write(js)
    if binc:
        out.write(struct.pack('<II', len(binc), BIN_CHUNK))
        out.write(binc)
    with open(path, 'wb') as fh:
        fh.write(out.getvalue())


def shrink(data, size, quality):
    image = Image.open(io.BytesIO(data))
    if image.mode not in ('RGB', 'L'):
        image = image.convert('RGB')
    if max(image.size) > size:
        image.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format='JPEG', quality=quality, optimize=True)
    return buf.getvalue()


def optimize(path, size, quality, dry_run):
    gltf, bin_chunk = read_glb(path)
    views = gltf['bufferViews']
    before = os.path.getsize(path)

    # Replace the bytes each image view points at, keyed by view index.
    replacements = {}
    for image in gltf.get('images', []):
        idx = image.get('bufferView')
        if idx is None:
            continue
        view = views[idx]
        start = view.get('byteOffset', 0)
        raw = bin_chunk[start:start + view['byteLength']]
        try:
            new_raw = shrink(raw, size, quality)
        except Exception as exc:  # noqa: BLE001
            print(f'  ! {os.path.basename(path)} image {idx}: {exc}')
            continue
        if len(new_raw) >= len(raw):
            continue
        replacements[idx] = new_raw
        image['mimeType'] = 'image/jpeg'

    if not replacements:
        return before, before, 0

    # Re-lay-out the BIN chunk in the original byte order, so views that were
    # adjacent (or that share a region) keep a sane relative arrangement.
    order = sorted(range(len(views)), key=lambda i: views[i].get('byteOffset', 0))
    out = bytearray()
    for i in order:
        view = views[i]
        if i in replacements:
            raw = replacements[i]
        else:
            start = view.get('byteOffset', 0)
            raw = bin_chunk[start:start + view['byteLength']]
        out += b'\x00' * ((4 - len(out) % 4) % 4)
        view['byteOffset'] = len(out)
        view['byteLength'] = len(raw)
        out += raw
    out += b'\x00' * ((4 - len(out) % 4) % 4)

    gltf['buffers'][0]['byteLength'] = len(out)
    if dry_run:
        # The layout loop above has already written the new lengths into `views`,
        # so the container size can be computed directly. Estimating it by
        # subtracting the old lengths double-counted them and reported "0%
        # smaller" for a file that had in fact shrunk.
        js_len = len(json.dumps(gltf, separators=(',', ':')).encode('utf-8'))
        js_len += (4 - js_len % 4) % 4
        after = 12 + 8 + js_len + 8 + len(out)
    else:
        write_glb(path, gltf, bytes(out))
        after = os.path.getsize(path)
    return before, after, len(replacements)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--size', type=int, default=256)
    parser.add_argument('--quality', type=int, default=82)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--only', default=None, help='single asset name, without .glb')
    args = parser.parse_args()

    names = sorted(n for n in os.listdir(ASSETS) if n.endswith('.glb'))
    if args.only:
        names = [n for n in names if n[:-4] == args.only]
    if not names:
        raise SystemExit('no assets matched')

    if not args.dry_run:
        backup = os.path.join('.cache', 'assets-original')
        os.makedirs(backup, exist_ok=True)
        for name in names:
            src, dst = os.path.join(ASSETS, name), os.path.join(backup, name)
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
        print(f'originals backed up to {backup}\n')

    total_before = total_after = 0
    for name in names:
        path = os.path.join(ASSETS, name)
        before, after, count = optimize(path, args.size, args.quality, args.dry_run)
        total_before += before
        total_after += after
        if count:
            print(f'{name[:-4]:<14} {before / 1024:>7.0f}K -> {after / 1024:>6.0f}K  '
                  f'({100 - 100 * after / before:>3.0f}% smaller, {count} textures)')
    print(f'\n{"TOTAL":<14} {total_before / 1024 / 1024:>7.1f} MB -> '
          f'{total_after / 1024 / 1024:.1f} MB  '
          f'({100 - 100 * total_after / max(total_before, 1):.0f}% smaller)')
    if args.dry_run:
        print('(dry run — nothing written)')


if __name__ == '__main__':
    main()
