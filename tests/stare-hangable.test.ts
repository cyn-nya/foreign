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
import { GHOST_FROM_FLOOR, generateFloor } from '../src/game/rules.ts';
import { FOREIGN_ASSETS } from '../src/game/catalog.ts';
import { ROOM_FLOOR_OPTIONS } from '../src/splat/roomAnchors.ts';

const heightOf = new Map(FOREIGN_ASSETS.map((a) => [a.key, a.height ?? 0]));
const tagOf = new Map(FOREIGN_ASSETS.map((a) => [a.key, a.horrorTag]));

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

/**
 * The four ghosts and three dressed people cost Lux3D tasks to generate for these two
 * roles specifically. A pool that ignores the tag still works -- which is exactly why
 * nothing noticed: the models were interchangeable with everything else.
 *
 * Asserted on the reconstructed room, which is the build that ships. Two honest
 * complications are encoded rather than wished away:
 *
 *   - Floors one to three stare with household geometry on purpose, so the first statement
 *     of "this is wrong" is as legible as it can be. The ghosts start at
 *     `GHOST_FROM_FLOOR`.
 *   - An intruder's pool is filtered by the floor's weirdness budget. Where that budget
 *     excludes the doppel models, falling back to the wider pool is the correct behaviour,
 *     not a bug -- so those floors are checked for the weaker property that the intruder is
 *     at least a generated object and never household furniture.
 */
describe('the horror set is used for the kinds it was generated for', () => {
  it('hangs a ghost on the floors that are meant to be past teaching', () => {
    const wrong: string[] = [];
    let stares = 0;
    for (let floor = GHOST_FROM_FLOOR; floor <= 8; floor++) {
      for (let seed = 1; seed <= 12; seed++) {
        const plan = generateFloor(floor, floor * 7919 + seed, ROOM_FLOOR_OPTIONS);
        for (const anomaly of plan.anomalies) {
          if (anomaly.kind !== 'stare' || !anomaly.assetKey) continue;
          stares += 1;
          if (tagOf.get(anomaly.assetKey) !== 'ghost') {
            wrong.push(`floor ${floor} seed ${seed}: ${anomaly.assetKey} (${tagOf.get(anomaly.assetKey)})`);
          }
        }
      }
    }
    // The pinned floor-1 stare is not in this range, and no deep floor may lack one.
    expect(stares, 'no stares were generated on the deep floors at all').toBeGreaterThan(0);
    expect(wrong, `stares not made of the ghost role:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('keeps the teaching floors legible, with a household object rather than a figure', () => {
    // The other half of the same rule, and the half that would break silently: a change
    // that gave every floor a ghost would still pass the check above.
    const wrong: string[] = [];
    for (let floor = 1; floor < GHOST_FROM_FLOOR; floor++) {
      for (let seed = 1; seed <= 12; seed++) {
        const plan = generateFloor(floor, floor * 7919 + seed, ROOM_FLOOR_OPTIONS);
        for (const anomaly of plan.anomalies) {
          if (anomaly.kind !== 'stare' || !anomaly.assetKey) continue;
          if (!anomaly.assetKey.startsWith('mundane_')) {
            wrong.push(`floor ${floor} seed ${seed}: ${anomaly.assetKey}`);
          }
        }
      }
    }
    expect(wrong, `teaching floors stared with something generated:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('puts a generated figure behind an intruder, never household furniture', () => {
    // Household furniture is the one outcome that would collapse the distinction the game
    // rests on, so it is asserted on every floor regardless of the weirdness budget.
    const wrong: string[] = [];
    let intruders = 0;
    for (let floor = 2; floor <= 8; floor++) {
      for (let seed = 1; seed <= 12; seed++) {
        const plan = generateFloor(floor, floor * 7919 + seed, ROOM_FLOOR_OPTIONS);
        for (const anomaly of plan.anomalies) {
          if (anomaly.kind !== 'intrude' || !anomaly.assetKey) continue;
          intruders += 1;
          if (anomaly.assetKey.startsWith('mundane_')) {
            wrong.push(`floor ${floor} seed ${seed}: ${anomaly.assetKey}`);
          }
        }
      }
    }
    // A pool that emptied out would pass the loop above and prove nothing.
    expect(intruders, 'no intruders were generated at all').toBeGreaterThan(0);
    expect(wrong, `intruders made of household furniture:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('uses the doppel models on the floors whose budget can reach them', () => {
    // Not every floor: `foreignPool` narrows by weirdness on the shallow ones. Reported as
    // a floor count rather than asserted per-anomaly, so this states the reach of the
    // feature instead of pretending it is universal.
    let doppelFloors = 0;
    for (let floor = 2; floor <= 8; floor++) {
      const plan = generateFloor(floor, floor * 7919, ROOM_FLOOR_OPTIONS);
      const intruders = plan.anomalies.filter((a) => a.kind === 'intrude');
      if (intruders.some((a) => tagOf.get(a.assetKey ?? '') === 'doppel')) doppelFloors += 1;
    }
    expect(doppelFloors, 'the doppel models are never reachable on any floor').toBeGreaterThan(0);
  });
});
