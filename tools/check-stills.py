"""Sanity-check the demo stills without a vision model.

The concern is specific: a still that is mostly wall or floor would look like a
deliberate shot of nothing, and nothing about the file size proves otherwise. So
each image is reduced to statistics that can distinguish "the room" from "a flat
surface", and the torch shot is checked for the shape a torch actually makes —
dark overall with a bright middle.

Usage: python tools/check-stills.py [dir]
"""

import io
import os
import sys

from PIL import Image, ImageStat

DEFAULT = os.path.join('artifacts', 'demo-shots')


def region_stats(image, box):
    crop = image.crop(box).convert('L')
    stat = ImageStat.Stat(crop)
    return stat.mean[0], stat.stddev[0]


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.isdir(directory):
        print(f'no such directory: {directory}')
        return 1

    names = sorted(n for n in os.listdir(directory) if n.endswith('.png'))
    if not names:
        print('no stills found')
        return 1

    print(f"{'still':<20}{'mean':>7}{'sd':>7}{'dark%':>8}{'centre sd':>11}  verdict")
    problems = []
    for name in names:
        image = Image.open(os.path.join(directory, name)).convert('RGB')
        width, height = image.size
        mean, sd = region_stats(image, (0, 0, width, height))

        grey = image.convert('L')
        histogram = grey.histogram()
        total = sum(histogram)
        dark = sum(histogram[:40]) / total * 100

        cx, cy = width // 2, height // 2
        half = min(width, height) // 6
        _, centre_sd = region_stats(image, (cx - half, cy - half, cx + half, cy + half))

        # A flat wall is smooth everywhere: low spread overall and a centre with
        # almost no detail. Real room shots here are textured (sd well above 30).
        flat = sd < 26 and centre_sd < 18
        verdict = 'flat / likely a wall' if flat else 'has detail'
        if flat:
            problems.append(name)
        print(f'{name:<20}{mean:>7.1f}{sd:>7.1f}{dark:>8.1f}{centre_sd:>11.1f}  {verdict}')

    # The torch shot must be dark overall and brighter in the middle, or it is not
    # showing a torch.
    torch = os.path.join(directory, '07-torch.png')
    if os.path.exists(torch):
        image = Image.open(torch).convert('RGB')
        width, height = image.size
        overall, _ = region_stats(image, (0, 0, width, height))
        cx, cy = width // 2, height // 2
        half = min(width, height) // 5
        middle, _ = region_stats(image, (cx - half, cy - half, cx + half, cy + half))
        edge, _ = region_stats(image, (0, 0, width, height // 6))
        lit = middle - edge
        print(
            f"\ntorch: overall {overall:.1f}, centre {middle:.1f}, top strip {edge:.1f}, "
            f"centre-minus-edge {lit:+.1f}"
        )
        if lit < 4:
            print('  -> the centre is not brighter than the edge; this does not read as a torch')
            problems.append('07-torch.png (no visible pool of light)')
        else:
            print('  -> dark with a lit centre, as a torch should be')

    print()
    if problems:
        print(f'{len(problems)} still(s) need attention: {", ".join(problems)}')
        return 1
    print(f'all {len(names)} stills have detail')
    return 0


if __name__ == '__main__':
    sys.exit(main())
