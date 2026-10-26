"""What is actually inside the 71 MB of Lux3D assets?

4-8.5 MB per model with only 22-28k faces means the bulk is not geometry. A GLB
is a 12-byte header, a JSON chunk and a binary chunk, so the image dimensions can
be read without a glTF library: find each image's bufferView, slice the bytes out
of the BIN chunk, and read the PNG or JPEG header.
"""

import io
import json
import os
import struct
import sys

ASSETS = os.path.join('public', 'assets', 'foreign')


def png_size(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', data[16:24])


def jpeg_size(data):
    if data[:2] != b'\xff\xd8':
        return None
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return (w, h)
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seglen = struct.unpack('>H', data[i + 2:i + 4])[0]
        i += 2 + seglen
    return None


rows = []
for name in sorted(os.listdir(ASSETS)):
    if not name.endswith('.glb'):
        continue
    path = os.path.join(ASSETS, name)
    total = os.path.getsize(path)
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, _ = struct.unpack('<III', data[:12])
    if magic != 0x46546C67:
        rows.append((name, total, '?', '?', 'not a GLB'))
        continue
    off = 12
    jlen, jtype = struct.unpack('<II', data[off:off + 8])
    assert jtype == 0x4E4F534A
    gltf = json.loads(data[off + 8:off + 8 + jlen].decode('utf-8'))
    off += 8 + jlen
    blen, btype = struct.unpack('<II', data[off:off + 8])
    assert btype == 0x004E4942
    bin_chunk = data[off + 8:off + 8 + blen]

    images = []
    for image in gltf.get('images', []):
        view = gltf['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        raw = bin_chunk[start:start + view['byteLength']]
        size = png_size(raw) or jpeg_size(raw) or ('unknown', len(raw))
        images.append((size, len(raw)))

    meshes = gltf.get('meshes', [])
    tris = 0
    for mesh in meshes:
        for prim in mesh.get('primitives', []):
            if 'indices' in prim:
                tris += gltf['accessors'][prim['indices']]['count'] // 3
    tex_bytes = sum(b for _, b in images)
    biggest = max((s for s, _ in images if isinstance(s, tuple) and len(s) == 2), default=(0, 0))
    rows.append((
        name, total, f'{tris}', f'{len(images)} {biggest[0]}x{biggest[1]}',
        f'{tex_bytes / 1024 / 1024:.1f} MB tex / {100 * tex_bytes / total:.0f}%',
    ))

rows.sort(key=lambda r: -r[1])
print(f'{"asset":<22}{"size":>9}{"tris":>9}  {"images":<12}{"texture share"}')
for name, total, tris, images, share in rows[:21]:
    print(f'{name[:-4]:<22}{total / 1024:>7.0f}K{tris:>9}  {images:<12}{share}')
print(f'\n{len(rows)} assets, {sum(r[1] for r in rows) / 1024 / 1024:.1f} MB total')
