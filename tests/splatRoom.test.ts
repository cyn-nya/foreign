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
import { ROOM_ANCHORS, ROOM_ENTRY, ROOM_FLOOR_LEVEL, ROOM_FLOOR_OPTIONS, anchorById } from '../src/splat/roomAnchors.ts';

const opts = ROOM_FLOOR_OPTIONS;
const nameOf = (key: string) => ASSETS_BY_KEY.get(key)?.name ?? '';
const ALL_KINDS: AnomalyKind[] = ['intrude', 'stare', 'shift', 'warp', 'twin', 'invert', 'swarm'];
/** The kinds that are supposed to leave the ground. */
const AIRBORNE: AnomalyKind[] = ['stare', 'shift', 'swarm'];
/** Kinds whose whole point is that they are off the floor, but only a little. */
const LIFTED: AnomalyKind[] = ['invert'];

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

  it('gives every placed anomaly an asset, since the object is the anomaly', () => {
    for (let floor = 1; floor <= 8; floor++) {
      const plan = generateFloor(floor, 2000 + floor, opts);
      expect(plan.anomalies.length).toBeGreaterThan(0);
      for (const anomaly of plan.anomalies) {
        expect(anomaly.assetKey).toBeTruthy();
        expect(ASSETS_BY_KEY.has(anomaly.assetKey!)).toBe(true);
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

  it('opens on a single unmissable intruder, as the procedural room does', () => {
    const plan = generateFloor(1, 5, opts);
    expect(plan.anomalies).toHaveLength(1);
    expect(plan.anomalies[0].kind).toBe('intrude');
    expect(plan.anomalies[0].assetKey).toBe('duck');
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
