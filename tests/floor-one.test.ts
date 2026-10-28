/**
 * Floor one has exactly one job: teach the rule. It cannot do that with something the player
 * walks past.
 *
 * This is the only complaint that has come back from the one person who has played the game,
 * and it came back twice: "I walked almost the whole first floor and found nothing suspicious."
 * A note in `rules.ts` records that the same symptom was found and fixed once before, so the
 * first fix was not enough, and a test is what stops the third occurrence.
 *
 * The numbers here are the ones that make the difference between "in the room" and "findable":
 * how far the anomaly is from the way in, how large it is, and how many pixels of a 720-line
 * frame it covers. A previous investigation established that the model is present and the
 * crosshair reaches it from the spawn without walking, so presence is not what is guarded
 * here -- legibility is.
 */
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/game/rules.ts';
import { ASSETS_BY_KEY } from '../src/game/catalog.ts';
import { ROOM_ANCHORS, ROOM_ENTRY, ROOM_FLOOR_OPTIONS } from '../src/splat/roomAnchors.ts';

/** The rendered vertical field of view, in degrees. */
const FOV_Y = 70;
/** The shortest frame the game is expected to run at. */
const VIEW_H = 720;

/** How many pixels tall an object of `height` metres is, `distance` metres away. */
function pixelsTall(height: number, distance: number): number {
  if (distance <= 0.01) return VIEW_H;
  const radians = 2 * Math.atan(height / 2 / distance);
  return (radians / ((FOV_Y * Math.PI) / 180)) * VIEW_H;
}

/** The seeds a player is most likely to meet, because the game derives them from the floor. */
const SEEDS = [7919, 4104, 3103, 5105, 909, 1234, 8888];

describe('floor one asks the player to find something findable', () => {
  it('places its single anomaly near the way in, and never across the room', () => {
    for (const seed of SEEDS) {
      const plan = generateFloor(1, seed, ROOM_FLOOR_OPTIONS);
      expect(plan.anomalies, `seed ${seed}`).toHaveLength(1);
      const anchor = ROOM_ANCHORS.find((a) => a.id === plan.anomalies[0]!.slotId);
      expect(anchor, `seed ${seed}: the anomaly is not on a known anchor`).toBeDefined();
      const distance = Math.hypot(
        anchor!.pos.x - ROOM_ENTRY.x,
        anchor!.pos.z - ROOM_ENTRY.z,
      );
      // It is meant to be "the anchor nearest the way in". Three metres is a wall away; the
      // point is that a player who only turns their head has already seen it.
      expect(distance, `seed ${seed}: the only anomaly is ${distance.toFixed(1)} m away`).toBeLessThan(3);
    }
  });

  it('puts it at head height rather than on the floor, where a chair is just a chair', () => {
    for (const seed of SEEDS) {
      const plan = generateFloor(1, seed, ROOM_FLOOR_OPTIONS);
      const anomaly = plan.anomalies[0]!;
      // `stare` floats. On the floor it would be a chair in a room of chairs, and the whole
      // rule the floor exists to teach would be invisible.
      expect(anomaly.kind, `seed ${seed}`).toBe('stare');
      const lift = anomaly.offset?.y ?? 0;
      expect(lift, `seed ${seed}: lifted only ${lift.toFixed(2)} m`).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('makes it large enough to read across the room, not a speck', () => {
    const worst: string[] = [];
    for (const seed of SEEDS) {
      const plan = generateFloor(1, seed, ROOM_FLOOR_OPTIONS);
      const anomaly = plan.anomalies[0]!;
      const asset = ASSETS_BY_KEY.get(anomaly.assetKey ?? '');
      expect(asset, `seed ${seed}: ${anomaly.assetKey} is not in the catalogue`).toBeDefined();
      const anchor = ROOM_ANCHORS.find((a) => a.id === anomaly.slotId)!;
      const distance = Math.hypot(anchor.pos.x - ROOM_ENTRY.x, anchor.pos.z - ROOM_ENTRY.z);
      const px = pixelsTall(asset!.height, distance);
      worst.push(`seed ${seed} ${anomaly.assetKey} ${px.toFixed(0)}px`);
      // A tenth of the frame. Below that the object stops reading as an object at all in a dark
      // room at a low frame rate, which is the condition the game is actually played in.
      expect(px, `seed ${seed}: ${anomaly.assetKey} is ${px.toFixed(0)}px tall`).toBeGreaterThan(
        VIEW_H / 10,
      );
    }
    expect(worst.length).toBe(SEEDS.length);
  });

  it('uses a household object, so the lesson is "this is wrong" and not "this is new"', () => {
    // The floor's teaching value depends on the payload being innocent. A generated prop
    // arriving on floor one would make the lesson "generated things are wrong", which is a
    // different and much weaker game.
    for (const seed of SEEDS) {
      const plan = generateFloor(1, seed, ROOM_FLOOR_OPTIONS);
      expect(
        plan.anomalies[0]!.assetKey ?? '',
        `seed ${seed} reached for a generated asset on the teaching floor`,
      ).toMatch(/^mundane_/);
    }
  });
});
