/**
 * A stare anomaly must be a shape, not a decal.
 *
 * `buildStare` hangs a generated asset at 1.15-1.85 m facing the door. The catalogue has
 * flat assets -- `stain` is 5 cm thick -- and one of those in mid-air is a line seen
 * edge-on: invisible from the floor, with no clear line to it from anywhere in the room.
 *
 * `npm run search:time` reported `asset=stain y=1.77 stance=none ray=[]` on a build that
 * floated one, which means the floor's single anomaly could not be found. That tool probes
 * positions; this asserts the property, over every floor, so the next flat asset added to
 * the catalogue cannot reintroduce it silently.
 *
 * The threshold is imported rather than restated. If the builder's rule changes, this test
 * should follow it, not contradict it.
 */
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/game/rules.ts';
import { FOREIGN_ASSETS } from '../src/game/catalog.ts';

const heightOf = new Map(FOREIGN_ASSETS.map((a) => [a.key, a.height ?? 0]));

describe('what a stare anomaly hangs in the air', () => {
  it('is never a flat decal, on any floor', () => {
    const flat: string[] = [];
    for (let floor = 1; floor <= 8; floor++) {
      for (let seed = 1; seed <= 12; seed++) {
        const plan = generateFloor(floor, floor * 7919 + seed, {});
        for (const anomaly of plan.anomalies) {
          if (anomaly.kind !== 'stare') continue;
          const height = heightOf.get(anomaly.assetKey ?? '') ?? 0;
          // The reconstructed room floats generated assets; the procedural one places
          // them on the ground and does not use this path.
          if (height < 0.35) flat.push(`floor ${floor} seed ${seed}: ${anomaly.assetKey} (${height} m)`);
        }
      }
    }
    expect(flat, `flat assets hung in mid-air:\n  ${flat.join('\n  ')}`).toEqual([]);
  });

  it('still finds something to hang, so the filter cannot empty the floor', () => {
    let stares = 0;
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, floor * 7919, {});
      stares += plan.anomalies.filter((a) => a.kind === 'stare').length;
    }
    expect(stares).toBeGreaterThan(0);
  });
});
