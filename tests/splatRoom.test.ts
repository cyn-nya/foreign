/**
 * The `foreignOnly` floor mode: floors generated for the reconstructed room,
 * where the furniture is baked into the scan and nothing can be moved.
 *
 * The important assertions here are that every anomaly is placeable (its slot
 * id resolves to a real anchor), that none of them depend on a furniture slot,
 * and that the room is never asked to hide or duplicate something it cannot
 * reach. The procedural room's own behaviour is covered by rules.test.ts and
 * must be unaffected — one generator, two rooms.
 */

import { describe, expect, it } from 'vitest';
import { ASSETS_BY_KEY, INTRUDE_ANCHORS, SPAWN } from '../src/game/catalog.ts';
import { generateFloor, judgeMark, resetAnomalySerial } from '../src/game/rules.ts';
import type { AnomalyKind } from '../src/game/types.ts';

/** The household kinds a bystander may be. Bystanders are furniture now. */

import { ROOM_ANCHORS, ROOM_ENTRY, ROOM_FLOOR_LEVEL, ROOM_FLOOR_OPTIONS, anchorById } from '../src/splat/roomAnchors.ts';

const opts = ROOM_FLOOR_OPTIONS;
const nameOf = (key: string) => ASSETS_BY_KEY.get(key)?.name ?? '';
const ALL_KINDS: AnomalyKind[] = ['intrude', 'stare', 'shift', 'warp', 'twin', 'invert', 'swarm'];
/** The kinds that are supposed to leave the ground. */
const AIRBORNE: AnomalyKind[] = ['stare', 'shift', 'swarm'];
/** Kinds whose whole point is that they are off the floor, but only a little. */
const LIFTED: AnomalyKind[] = ['invert'];

/**
 * Household props are catalogue entries with weirdness 0 — real GLB files built
 * by tools/build-mundane.py, not generated and not textured.
 *
 * The split is the whole answer to "必须要能够轻易分辨这个东西完全就不该出现": the
 * room's furniture is household and an intruder never is, so the two sets cannot
 * be confused. If they ever overlap, the question stops being decidable.
 */
function isHousehold(key: string): boolean {
  const asset = ASSETS_BY_KEY.get(key);
  return asset !== undefined && asset.weirdness === 0;
}

describe('the reconstructed room’s anchors', () => {
  it('were measured out of the scan, not authored', () => {
    expect(ROOM_ANCHORS.length).toBeGreaterThanOrEqual(6);
    expect(ROOM_ANCHORS.every((a) => a.id.startsWith('fx_room_'))).toBe(true);
  });

  it('all sit on the scan’s real floor, which is below the origin', () => {
    // The procedural room's floor is y=0 by construction. This one is not, and
    // code that assumed zero would float every object.
    expect(ROOM_FLOOR_LEVEL).toBeLessThan(-0.2);
    for (const anchor of ROOM_ANCHORS) {
      expect(Math.abs(anchor.pos.y - ROOM_FLOOR_LEVEL)).toBeLessThan(0.25);
    }
  });

  it('keeps every anchor clear of the spawn, so nothing is in the player’s face', () => {
    for (const anchor of ROOM_ANCHORS) {
      const distance = Math.hypot(anchor.pos.x - ROOM_ENTRY.x, anchor.pos.z - ROOM_ENTRY.z);
      expect(distance).toBeGreaterThan(1.5);
    }
  });

  it('gives every anchor a positional label rather than a room name', () => {
    // Nobody ever told the scanner which part was the kitchen, so claiming one
    // is would be a lie the player can catch.
    for (const anchor of ROOM_ANCHORS) {
      expect(anchor.place).toBeTruthy();
      expect(anchor.zone).toBeUndefined();
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(ROOM_ANCHORS.map((a) => a.id)).size).toBe(ROOM_ANCHORS.length);
  });
});

describe('generateFloor in foreignOnly mode', () => {
  it('places nothing on a furniture slot, because the scan has none to move', () => {
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 1000 + floor, opts);
      expect(plan.hiddenSlots).toEqual([]);
      expect(plan.twinSlots).toEqual([]);
      for (const anomaly of plan.anomalies) {
        expect(anchorById(anomaly.slotId)).not.toBeNull();
      }
    }
  });

  it('gives every placed anomaly a way to exist, and the right one for its kind', () => {
    // The split is the design. An intruder is a generated object the room could
    // never contain; everything else is household furniture misbehaving. Getting
    // this backwards would quietly return the game to the state a playtester
    // complained about, where an object being present proved nothing.
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 2000 + floor, opts);
      expect(plan.anomalies.length).toBeGreaterThan(0);
      for (const anomaly of plan.anomalies) {
        expect(anomaly.assetKey).toBeTruthy();
        expect(ASSETS_BY_KEY.has(anomaly.assetKey!)).toBe(true);
        if (anomaly.kind === 'intrude') {
          expect(isHousehold(anomaly.assetKey!)).toBe(false);
        } else {
          expect(isHousehold(anomaly.assetKey!)).toBe(true);
        }
      }
    }
  });

  it('never puts two anomalies in the same place', () => {
    for (let floor = 1; floor <= 10; floor++) {
      const plan = generateFloor(floor, 3000 + floor, opts);
      const slots = plan.anomalies.map((a) => a.slotId);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });

  it('is deterministic — the same floor and seed rebuild the same room', () => {
    // Anomaly ids carry a session serial, which only repeats after a reset;
    // that is the documented way to make a replay or a test reproducible, and
    // it is what makes this a check of the ids as well as the content.
    resetAnomalySerial();
    const a = generateFloor(4, 77, opts);
    resetAnomalySerial();
    const b = generateFloor(4, 77, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('picks the same places and assets for a given seed even without a reset', () => {
    const a = generateFloor(4, 77, opts);
    const b = generateFloor(4, 77, opts);
    // The serial is the only thing allowed to differ, so gameplay does not
    // change just because the generator was called a different number of times.
    const shape = (plan: typeof a) =>
      plan.anomalies.map((x) => [x.kind, x.slotId, x.assetKey, x.offset?.y ?? 0, x.label]);
    expect(shape(a)).toEqual(shape(b));
  });

  it('opens on a single unmissable anomaly, nearest the way in', () => {
    const plan = generateFloor(1, 5, opts);
    expect(plan.anomalies).toHaveLength(1);
    // A household chair hanging in the air, turned to face the player. It needs
    // no reference point, no memory and no comparison — it is the one kind a
    // first floor can teach on its own, and the fact that the thing floating is
    // an ordinary chair rather than a horror prop is what makes it frightening.
    expect(plan.anomalies[0].kind).toBe('stare');
    expect(isHousehold(plan.anomalies[0].assetKey!)).toBe(true);
    // nearest the way in, which is the direction the player is already facing
    const slot = anchorById(plan.anomalies[0].slotId)!;
    const nearest = Math.min(
      ...ROOM_ANCHORS.map((a) => Math.hypot(a.pos.x - ROOM_ENTRY.x, a.pos.z - ROOM_ENTRY.z)),
    );
    expect(Math.hypot(slot.pos.x - ROOM_ENTRY.x, slot.pos.z - ROOM_ENTRY.z)).toBeCloseTo(nearest, 5);
  });

  it('keeps every anomaly on the floor plane or deliberately above it', () => {
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 4000 + floor, opts);
      for (const anomaly of plan.anomalies) {
        const lift = anomaly.offset?.y ?? 0;
        // 'shift' and 'stare' are supposed to be off the ground; everything else
        // must sit on it, or it reads as a bug rather than as an anomaly.
        if (AIRBORNE.includes(anomaly.kind)) {
          expect(lift).toBeGreaterThan(0.4);
        } else if (LIFTED.includes(anomaly.kind)) {
          // enough to be plainly not standing on its own base
          expect(lift).toBeGreaterThan(0.1);
          expect(lift).toBeLessThan(0.6);
        } else {
          expect(Math.abs(lift)).toBeLessThan(0.01);
        }
      }
    }
  });

  it('turns a stare toward the way in, not away from it', () => {
    for (let floor = 2; floor <= 8; floor++) {
      const plan = generateFloor(floor, 5000 + floor, { ...opts, kinds: ['stare'] });
      for (const anomaly of plan.anomalies) {
        const anchor = anchorById(anomaly.slotId)!;
        // The prop's +z is rotated by rotY; atan2(dx,dz) points it at the spawn.
        const expected = Math.atan2(ROOM_ENTRY.x - anchor.pos.x, ROOM_ENTRY.z - anchor.pos.z);
        expect(anomaly.rotY).toBeCloseTo(expected, 6);
      }
    }
  });

  it('can express all five kinds without a furniture slot', () => {
    for (const kind of ALL_KINDS) {
      const plan = generateFloor(6, 9, { ...opts, kinds: [kind] });
      expect(plan.anomalies.length).toBeGreaterThan(0);
      expect(plan.anomalies[0].kind).toBe(kind);
      expect(anchorById(plan.anomalies[0].slotId)).not.toBeNull();
      expect(plan.anomalies[0].assetKey).toBeTruthy();
    }
  });

  it('runs out of anchors rather than stacking two anomalies on one', () => {
    const few = { ...opts, anchors: ROOM_ANCHORS.slice(0, 2) };
    for (let seed = 0; seed < 30; seed++) {
      const plan = generateFloor(6, seed, few);
      expect(plan.anomalies.length).toBeLessThanOrEqual(2);
      expect(new Set(plan.anomalies.map((a) => a.slotId)).size).toBe(plan.anomalies.length);
    }
  });

  it('is impossible to score without marking the anchor the anomaly named', () => {
    const plan = generateFloor(3, 12, opts);
    const anomaly = plan.anomalies[0];
    expect(judgeMark(plan, anomaly.slotId, []).result).toBe('hit');
    expect(judgeMark(plan, 'fx_living_centre', []).result).toBe('miss');
  });

  it('flips an inverted anomaly and leaves every other kind upright', () => {
    const inverted = generateFloor(4, 21, { ...opts, kinds: ['invert'] });
    expect(inverted.anomalies[0].flip).toBe(true);

    // The control: flip must not leak into the other kinds, or "upside down"
    // would stop meaning anything.
    for (const kind of ALL_KINDS.filter((k) => k !== 'invert')) {
      const plan = generateFloor(4, 21, { ...opts, kinds: [kind] });
      expect(plan.anomalies[0].flip).toBeUndefined();
    }
  });

  it('scatters a swarm past the point of counting, unlike a twin', () => {
    for (let seed = 0; seed < 20; seed++) {
      const swarm = generateFloor(6, seed, { ...opts, kinds: ['swarm'] });
      const anomaly = swarm.anomalies[0];
      // A dozen is the floor: below that it is a twin with extra steps.
      expect(anomaly.count).toBeGreaterThanOrEqual(12);
      expect(anomaly.spread).toBeGreaterThan(1.0);
      // shrunk, or a dozen full-size objects read as one solid mass
      expect(anomaly.scale).toBeLessThan(0.7);

      const twin = generateFloor(6, seed, { ...opts, kinds: ['twin'] });
      expect(twin.anomalies[0].count).toBeLessThan(6);
      expect(twin.anomalies[0].spread).toBeUndefined();
    }
  });

  it('labels every anomaly in a way a player could act on', () => {
    for (let floor = 1; floor <= 8; floor++) {
      for (const anomaly of generateFloor(floor, 6000 + floor, opts).anomalies) {
        expect(anomaly.label.length).toBeGreaterThan(6);
        expect(anomaly.label).not.toContain('undefined');
        // no procedural room names leaking into a room that does not have them
        expect(anomaly.label).not.toMatch(/客厅|厨房|卧室|玄关/);
        if (anomaly.assetKey) expect(anomaly.label).toContain(nameOf(anomaly.assetKey));
      }
    }
  });
});

/**
 * The room contains objects that are present and innocent.
 *
 * Before these existed there was no judgement in the game at all: the scan's own
 * furniture is baked into the splat, so every crisp 3D object *was* an anomaly
 * and finding one was a visual-search task. The playtest note — "没有明确说明怎么样
 * 算不该出现，如何判断" — was accurate, and the cause was that there was nothing to
 * judge.
 */
describe('bystanders make the room a judgement call', () => {
  it('puts innocent objects in the reconstruction', () => {
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 900 + floor, opts);
      expect(plan.bystanders.length).toBeGreaterThan(0);
      for (const b of plan.bystanders) {
        // A bystander is now household furniture built from geometry rather than
        // a generated asset — that is the whole fix for "怎么判断什么不该出现".
        // What still has to hold is that it is a real prop kind, that it has a
        // sensible size, and that it stands on an anchor, because a household
        // object at furniture scale is only innocent if it is actually plausible.
        expect(isHousehold(b.assetKey)).toBe(true);
        expect(ASSETS_BY_KEY.has(b.assetKey)).toBe(true);
        expect(anchorById(b.slotId)).not.toBeNull();
        expect(b.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('never puts a bystander where an anomaly is', () => {
    for (let floor = 1; floor <= 10; floor++) {
      for (let seed = 0; seed < 12; seed++) {
        const plan = generateFloor(floor, seed * 31 + floor, opts);
        const anomalySlots = new Set(plan.anomalies.map((a) => a.slotId));
        for (const b of plan.bystanders) {
          // Overlapping would make the mark ambiguous: one slot, two answers.
          expect(anomalySlots.has(b.slotId)).toBe(false);
        }
      }
    }
  });

  it('counts bystanders as misses, and says which test they failed', () => {
    const plan = generateFloor(4, 4321, opts);
    expect(plan.bystanders.length).toBeGreaterThan(0);

    for (const b of plan.bystanders) {
      expect(judgeMark(plan, b.slotId, []).result).toBe('miss');
      expect(b.label).toMatch(/待在原位|没在看你/);
    }

    // The control: an anomaly at its own slot must still be a hit, or "everything
    // is a miss" would satisfy the assertion above.
    for (const a of plan.anomalies) {
      expect(judgeMark(plan, a.slotId, []).result).toBe('hit');
    }
  });

  it('does not count bystanders toward the floor total', () => {
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 700 + floor, opts);
      // The HUD shows found/total from plan.anomalies. If bystanders leaked into
      // that count the floor would be unclearable.
      const cleared = plan.anomalies.every((a) => judgeMark(plan, a.slotId, []).result === 'hit');
      expect(cleared).toBe(true);
      for (const b of plan.bystanders) {
        expect(plan.anomalies.some((a) => a.slotId === b.slotId)).toBe(false);
      }
    }
  });

  it('leaves the procedural room without bystanders, because it has furniture', () => {
    for (let floor = 1; floor <= 8; floor++) {
      expect(generateFloor(floor, 200 + floor).bystanders).toEqual([]);
    }
  });

  it('keeps intruders out of the furniture, so presence is never the whole question', () => {
    // 'intrude' used to be dropped from this mode entirely, because with the
    // innocent objects drawn from the same absurd catalogue an intruder and a
    // bystander were the same picture. Now the room is furnished with household
    // objects, so an intruder is the only generated thing in it and "this does
    // not belong" is answerable again — the user asked for exactly that.
    //
    // What still has to hold is the converse: a bystander must never be a
    // generated object, or the split collapses from the other side.
    let sawIntruder = false;
    for (let floor = 1; floor <= 10; floor++) {
      for (let seed = 0; seed < 10; seed++) {
        const plan = generateFloor(floor, seed * 17 + floor, opts);
        for (const anomaly of plan.anomalies) {
          if (anomaly.kind === 'intrude') sawIntruder = true;
        }
        for (const bystander of plan.bystanders) {
          expect(isHousehold(bystander.assetKey)).toBe(true);
        }
      }
    }
    expect(sawIntruder).toBe(true);
  });
});

describe('an object that does not belong is obvious', () => {
  /**
   * The playtest complaint this whole design answers.
   *
   * "必须要能够轻易分辨这个东西完全就不该出现" — you have to be able to tell at a
   * glance that a thing absolutely should not be there. That was impossible while
   * the innocent objects came from the same generated catalogue as the intruders,
   * because then a bystander and an intruder were the same object and the question
   * had no answer.
   *
   * The property that makes it answerable is a separation, and this asserts it
   * directly rather than one piece at a time: **nothing that is furniture is ever
   * an intruder, and nothing that is an intruder is ever furniture**. If those two
   * sets ever overlap, "does this belong?" stops being decidable and the game
   * silently goes back to visual search.
   */
  it('is never ambiguous: furniture is innocent and an intruder is never furniture', () => {
    let intruders = 0;
    let furniture = 0;
    for (let floor = 1; floor <= 8; floor++) {
      for (let seed = 0; seed < 12; seed++) {
        const plan = generateFloor(floor, seed * 31 + floor, opts);

        for (const anomaly of plan.anomalies) {
          expect(anomaly.assetKey).toBeTruthy();
          if (anomaly.kind === 'intrude') {
            intruders++;
            expect(isHousehold(anomaly.assetKey!)).toBe(false);
          } else {
            furniture++;
            expect(isHousehold(anomaly.assetKey!)).toBe(true);
          }
        }

        for (const bystander of plan.bystanders) {
          furniture++;
          // A bystander must be household furniture. If it were a generated
          // object, the split collapses from the other side and "does this
          // belong?" stops being decidable again.
          expect(isHousehold(bystander.assetKey)).toBe(true);
          expect(bystander.label.length).toBeGreaterThan(0);
        }
      }
    }
    // Both sides have to actually occur, or the test passes by measuring nothing.
    expect(intruders).toBeGreaterThan(0);
    expect(furniture).toBeGreaterThan(0);
  });
});

describe('the procedural room is unaffected by the new mode', () => {
  it('still uses its own anchors and slots when foreignOnly is off', () => {
    let sawSlotAnomaly = false;
    for (let floor = 1; floor <= 12; floor++) {
      const plan = generateFloor(floor, 800 + floor);
      for (const anomaly of plan.anomalies) {
        const isAnchor = INTRUDE_ANCHORS.some((a) => a.id === anomaly.slotId);
        const isRoomAnchor = ROOM_ANCHORS.some((a) => a.id === anomaly.slotId);
        expect(isAnchor || !isRoomAnchor).toBe(true);
        if (!isAnchor) sawSlotAnomaly = true;
      }
    }
    expect(sawSlotAnomaly).toBe(true);
  });

  it('defaults its spawn to the procedural room’s', () => {
    const plan = generateFloor(5, 42, { kinds: ['stare'] });
    const anchor = INTRUDE_ANCHORS.find((a) => a.id === plan.anomalies[0].slotId)!;
    // Turned toward the procedural spawn, not the reconstructed room's entry.
    const wants = Math.atan2(SPAWN.pos.x - anchor.pos.x, SPAWN.pos.z - anchor.pos.z);
    expect(plan.anomalies[0].rotY).toBeCloseTo(wants, 6);
    const towardsRoom = Math.atan2(ROOM_ENTRY.x - anchor.pos.x, ROOM_ENTRY.z - anchor.pos.z);
    expect(plan.anomalies[0].rotY).not.toBeCloseTo(towardsRoom, 3);
  });
});
