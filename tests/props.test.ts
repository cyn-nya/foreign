/**
 * The catalogue and the prop builders have to agree.
 *
 * `createProp` silently falls back to a sofa for an unknown kind, so a typo in
 * a catalogue entry's `placeholder` would ship a sofa instead of a shark and
 * nothing would fail. These tests make that loud.
 */

import { describe, expect, it } from 'vitest';
import { FOREIGN_ASSETS, SLOTS } from '../src/game/catalog';
import { createProp, isForeign } from '../src/game/props';
import { DEFAULT_FOREIGN_SIZE } from '../src/game/Room';

const SIZE = DEFAULT_FOREIGN_SIZE;

/** Count meshes, so "it returned an object" cannot pass for "it built something". */
function meshCount(root: import('three').Object3D): number {
  let n = 0;
  root.traverse((child) => {
    if ((child as { isMesh?: boolean }).isMesh) n++;
  });
  return n;
}

describe('prop builders', () => {
  it('builds every furniture slot kind', () => {
    for (const slot of SLOTS) {
      const object = createProp(slot.kind, slot.size);
      expect(meshCount(object), `${slot.id} (${slot.kind}) built no geometry`).toBeGreaterThan(0);
    }
  });

  it('builds every catalogue placeholder', () => {
    for (const asset of FOREIGN_ASSETS) {
      // Household props have no placeholder: they are real geometry, and the
      // procedural builder is not asked to stand in for them.
      if (!asset.placeholder) continue;
      const object = createProp(asset.placeholder, SIZE);
      expect(
        meshCount(object),
        `${asset.key} -> placeholder "${asset.placeholder}" built no geometry`,
      ).toBeGreaterThan(0);
    }
  });

  it('recognises exactly the catalogue placeholders as foreign', () => {
    const foreign = new Set(FOREIGN_ASSETS.map((a) => a.placeholder));
    for (const asset of FOREIGN_ASSETS) {
      if (asset.weirdness === 0) {
        // Household props are real GLB, not placeholders, so they have none — and
        // must not be claimed as foreign, which is exactly what would leak the
        // horror pool into the room's furniture.
        expect(asset.placeholder, `${asset.key} declares a placeholder`).toBeUndefined();
        continue;
      }
      expect(isForeign(asset.placeholder!), `${asset.key} is not reported as foreign`).toBe(true);
    }
    // furniture must not be reported as foreign, or the horror pool leaks
    expect(isForeign('sofa')).toBe(false);
    expect(isForeign('bed')).toBe(false);
    expect(foreign.has('sofa')).toBe(false);
  });

  it('gives every catalogue entry a usable height and uniqueness', () => {
    const keys = new Set<string>();
    for (const asset of FOREIGN_ASSETS) {
      expect(asset.key, 'a catalogue entry has an empty key').toBeTruthy();
      expect(keys.has(asset.key), `duplicate catalogue key "${asset.key}"`).toBe(false);
      keys.add(asset.key);
      // the game scales a 1 m baked model to this, so it must be sane
      expect(asset.height, `${asset.key} has an unusable height`).toBeGreaterThan(0.02);
      expect(asset.height).toBeLessThan(4);
    }
  });

  it('keeps a horror pool for the stare anomaly', () => {
    const horror = FOREIGN_ASSETS.filter((a) => a.weirdness === 3);
    expect(horror.length).toBeGreaterThanOrEqual(5);
  });
});
