"""Build the household furniture the room is furnished with.

The room needs a *normal* for the player to judge against. That was the missing
piece behind the playtest note "必须能够轻易分辨这个东西完全就不该出现": while the
innocent objects were drawn from the same absurd generated catalogue as the
intruders, a bystander and an intruder were the same picture and there was no
right answer.

These are written as GLB rather than built with three.js at runtime because the
reconstruction is rendered by the Aholo viewer, and its scene only accepts its
own objects — handing it a three.js Group fails with "object has attached to
another scene". Going through GLB reuses the loading path that the fourteen
generated assets already proved.

No textures: these are small props seen across a room, and a flat colour each
keeps every one of them under 10 KB. Total is well under the download cost of a
single generated asset.

Usage: python tools/build-mundane.py [--dry-run]
"""

import argparse
import io
import json
import math
import os
import struct

OUT = os.path.join('public', 'assets', 'foreign')
GLB_MAGIC = 0x46546C67


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

def box(w, h, d, x=0.0, y=0.0, z=0.0):
    """An axis-aligned box, y measured up from its own base."""
    hw, hd = w / 2, d / 2
    y0, y1 = y, y + h
    positions, normals, indices = [], [], []

    def face(corners, normal):
        base = len(positions)
        for cx, cy, cz in corners:
            positions.append((cx, cy, cz))
            normals.append(normal)
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])

    x0, x1 = x - hw, x + hw
    z0, z1 = z - hd, z + hd
    face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1))
    face([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], (0, 0, -1))
    face([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], (1, 0, 0))
    face([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], (-1, 0, 0))
    face([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], (0, 1, 0))
    face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0))
    return positions, normals, indices


def cylinder(r, h, segments=14, x=0.0, y=0.0, z=0.0, r_top=None):
    """A capped cylinder (or truncated cone), y measured up from its own base."""
    r_top = r if r_top is None else r_top
    positions, normals, indices = [], [], []

    for i in range(segments):
        a = (i / segments) * math.tau
        ca, sa = math.cos(a), math.sin(a)
        slope = (r - r_top) / h if h else 0.0
        ny = slope / math.sqrt(1 + slope * slope) if slope else 0.0
        nr = 1 / math.sqrt(1 + slope * slope) if slope else 1.0
        positions.append((x + ca * r, y, z + sa * r))
        normals.append((ca * nr, ny, sa * nr))
        positions.append((x + ca * r_top, y + h, z + sa * r_top))
        normals.append((ca * nr, ny, sa * nr))

    for i in range(segments):
        a0, a1 = i * 2, ((i + 1) % segments) * 2
        indices.extend([a0, a1, a0 + 1, a1, a1 + 1, a0 + 1])

    # Caps, as fans around a centre vertex.
    for (cy, radius, up) in ((y, r, False), (y + h, r_top, True)):
        centre = len(positions)
        positions.append((x, cy, z))
        normals.append((0, -1 if not up else 1, 0))
        start = len(positions)
        for i in range(segments):
            a = (i / segments) * math.tau
            positions.append((x + math.cos(a) * radius, cy, z + math.sin(a) * radius))
            normals.append((0, -1 if not up else 1, 0))
        for i in range(segments):
            i0, i1 = start + i, start + (i + 1) % segments
            if up:
                indices.extend([centre, i0, i1])
            else:
                indices.extend([centre, i1, i0])
    return positions, normals, indices


# --------------------------------------------------------------------------- #
# The objects
# --------------------------------------------------------------------------- #

WOOD, DARK, METAL, CLOTH, GREEN, WHITE, CERAMIC, PLASTIC = (
    0x8A6A46, 0x2E2A27, 0xB8BCC0, 0x6E7A85,
    0x4C7A3F, 0xE8E6E1, 0xD8D2C6, 0xC0503A,
)


def plant():
    return [
        (cylinder(0.18, 0.30, 12, r_top=0.22), CERAMIC),
        (box(0.26, 0.34, 0.26, y=0.30), GREEN),
        (box(0.30, 0.22, 0.22, y=0.56), GREEN),
        (box(0.16, 0.26, 0.16, y=0.66), GREEN),
    ]


def trash_bin():
    return [
        (cylinder(0.16, 0.56, 14, r_top=0.18), METAL),
        (cylinder(0.19, 0.05, 14, y=0.56), DARK),
    ]


def side_table():
    parts = [(box(0.50, 0.05, 0.44, y=0.50), WOOD)]
    for sx in (-0.21, 0.21):
        for sz in (-0.18, 0.18):
            parts.append((box(0.05, 0.50, 0.05, sx, 0.0, sz), WOOD))
    return parts


def dining_chair():
    parts = [(box(0.44, 0.05, 0.42, y=0.45), WOOD)]
    for sx in (-0.19, 0.19):
        for sz in (-0.17, 0.17):
            parts.append((box(0.045, 0.45, 0.045, sx, 0.0, sz), WOOD))
    parts.append((box(0.42, 0.48, 0.05, y=0.50, z=0.19), WOOD))
    return parts


def desk_chair():
    return [
        (box(0.46, 0.06, 0.44, y=0.44), CLOTH),
        (box(0.42, 0.46, 0.06, y=0.50, z=0.19), CLOTH),
        (cylinder(0.035, 0.40, 10, y=0.04), METAL),
        (box(0.44, 0.04, 0.08, y=0.0), METAL),
    ]


def floor_lamp():
    return [
        (cylinder(0.17, 0.03, 14), DARK),
        (cylinder(0.022, 1.30, 10, y=0.03), METAL),
        (cylinder(0.20, 0.26, 14, y=1.33, r_top=0.13), WHITE),
    ]


def table_lamp():
    return [
        (cylinder(0.10, 0.03, 12), DARK),
        (cylinder(0.016, 0.26, 8, y=0.03), METAL),
        (cylinder(0.13, 0.18, 12, y=0.29, r_top=0.09), WHITE),
    ]


def kettle():
    return [
        (cylinder(0.09, 0.17, 14, r_top=0.075), METAL),
        (cylinder(0.02, 0.11, 8, x=0.10, y=0.07), METAL),
        (cylinder(0.055, 0.03, 12, y=0.17), DARK),
    ]


def microwave():
    return [
        (box(0.50, 0.30, 0.38), METAL),
        (box(0.30, 0.22, 0.02, x=-0.07, y=0.04, z=0.20), DARK),
        (box(0.10, 0.22, 0.02, x=0.18, y=0.04, z=0.20), DARK),
    ]


def key_bowl():
    return [(cylinder(0.12, 0.07, 14, r_top=0.13), CERAMIC)]


def umbrella_stand():
    parts = [(cylinder(0.15, 0.58, 14, r_top=0.15), CERAMIC)]
    for i, (dx, dz) in enumerate(((-0.03, 0.02), (0.04, -0.03), (0.0, 0.05))):
        parts.append((cylinder(0.018, 0.95, 8, dx, 0.10, dz), PLASTIC if i == 1 else DARK))
    return parts


def shoe_rack():
    parts = [
        (box(0.68, 0.03, 0.34, y=0.24), WOOD),
        (box(0.68, 0.03, 0.34, y=0.46), WOOD),
    ]
    for sx in (-0.32, 0.32):
        parts.append((box(0.04, 0.50, 0.04, sx, 0.0, -0.15), WOOD))
        parts.append((box(0.04, 0.50, 0.04, sx, 0.0, 0.15), WOOD))
    parts.append((box(0.20, 0.10, 0.28, y=0.27, z=0.0), DARK))
    return parts


def nightstand():
    return [
        (box(0.44, 0.52, 0.40), WOOD),
        (box(0.36, 0.16, 0.02, y=0.06, z=0.20), DARK),
        (box(0.36, 0.16, 0.02, y=0.28, z=0.20), DARK),
    ]


MUNDANE = {
    'plant': (plant, 0.90, '盆栽'),
    'trash_bin': (trash_bin, 0.61, '垃圾桶'),
    'side_table': (side_table, 0.55, '边桌'),
    'dining_chair': (dining_chair, 0.98, '餐椅'),
    'desk_chair': (desk_chair, 0.96, '书桌椅'),
    'floor_lamp': (floor_lamp, 1.59, '落地灯'),
    'table_lamp': (table_lamp, 0.47, '台灯'),
    'kettle': (kettle, 0.20, '水壶'),
    'microwave': (microwave, 0.30, '微波炉'),
    'key_bowl': (key_bowl, 0.07, '钥匙碗'),
    'umbrella_stand': (umbrella_stand, 1.05, '伞架'),
    'shoe_rack': (shoe_rack, 0.49, '鞋架'),
    'nightstand': (nightstand, 0.52, '床头柜'),
}


# --------------------------------------------------------------------------- #
# GLB writer
# --------------------------------------------------------------------------- #

def build_glb(parts):
    """One mesh per part, each with its own accessors.

    Straightforward rather than clever: sharing buffer views between parts would
    save a few hundred bytes on a file that is already under 10 KB, at the cost of
    arithmetic that has to be exactly right.
    """
    accessors, views, blob = [], [], bytearray()
    meshes, materials, nodes = [], [], []
    material_index = {}

    def add_view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        views.append({
            'buffer': 0,
            'byteOffset': len(blob),
            'byteLength': len(data),
            **({'target': target} if target else {}),
        })
        blob.extend(data)
        return len(views) - 1

    def add_accessor(view, kind, count, minimum=None, maximum=None):
        entry = {
            'bufferView': view,
            'componentType': kind[1],
            'count': count,
            'type': kind[0],
        }
        if minimum is not None:
            entry['min'] = minimum
            entry['max'] = maximum
        accessors.append(entry)
        return len(accessors) - 1

    FLOAT, UINT = 5126, 5125
    for (geometry, colour) in parts:
        pos, nor, idx = geometry
        if colour not in material_index:
            material_index[colour] = len(materials)
            materials.append({
                'pbrMetallicRoughness': {
                    'baseColorFactor': [
                        ((colour >> 16) & 255) / 255,
                        ((colour >> 8) & 255) / 255,
                        (colour & 255) / 255,
                        1.0,
                    ],
                    'metallicFactor': 0.05,
                    'roughnessFactor': 0.85,
                },
                'doubleSided': False,
            })

        flat = [c for p in pos for c in p]
        nflat = [c for n in nor for c in n]
        v_pos = add_view(struct.pack(f'<{len(flat)}f', *flat), 34962)
        v_nor = add_view(struct.pack(f'<{len(nflat)}f', *nflat), 34962)
        v_idx = add_view(struct.pack(f'<{len(idx)}I', *idx), 34963)

        mins = [min(p[i] for p in pos) for i in range(3)]
        maxs = [max(p[i] for p in pos) for i in range(3)]
        a_pos = add_accessor(v_pos, ('VEC3', FLOAT), len(pos), mins, maxs)
        a_nor = add_accessor(v_nor, ('VEC3', FLOAT), len(nor))
        a_idx = add_accessor(v_idx, ('SCALAR', UINT), len(idx))

        meshes.append({'primitives': [{
            'attributes': {'POSITION': a_pos, 'NORMAL': a_nor},
            'indices': a_idx,
            'material': material_index[colour],
        }]})
        nodes.append({'mesh': len(meshes) - 1})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'foreign/build-mundane'},
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes)))}],
        'nodes': nodes,
        'meshes': meshes,
        'materials': materials,
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(blob)}],
    }

    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    binc = bytes(blob) + b'\x00' * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binc)

    out = io.BytesIO()
    out.write(struct.pack('<III', GLB_MAGIC, 2, total))
    out.write(struct.pack('<II', len(js), 0x4E4F534A))
    out.write(js)
    out.write(struct.pack('<II', len(binc), 0x004E4942))
    out.write(binc)
    return out.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    os.makedirs(OUT, exist_ok=True)

    total_before = 0
    report = {}
    for kind, (builder, height, name) in MUNDANE.items():
        key = f'mundane_{kind}'
        data = build_glb(builder())
        path = os.path.join(OUT, f'{key}.glb')
        if not args.dry_run:
            with open(path, 'wb') as fh:
                fh.write(data)
        report[key] = {'name': name, 'height': height, 'bytes': len(data)}
        total_before += len(data)
        print(f'{key:<22} {len(data) / 1024:>6.1f} KB   {name}  (height {height} m)')

    print(f'\n{len(report)} household props, {total_before / 1024:.1f} KB total')
    if args.dry_run:
        print('(dry run — nothing written)')
    else:
        with open(os.path.join('.cache', 'mundane-report.json'), 'w', encoding='utf-8') as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
