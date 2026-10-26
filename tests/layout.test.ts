import { describe, expect, it } from 'vitest';
import {
  ANCHOR_CLEARANCE,
  FLAT_KINDS,
  anchorFootprint,
  groundProps,
  insideRoomShell,
  intersectsPartition,
  layoutProblems,
  overlapArea,
  partitionFootprints,
  rotatedFootprint,
  slotFootprint,
} from '../src/game/layout';
import { INTRUDE_ANCHORS, ROOM, SLOTS, WALLS } from '../src/game/catalog';

describe('footprint maths', () => {
  it('is symmetric about the prop centre when unrotated', () => {
    const f = rotatedFootprint(2, -3, 1.4, 0.6);
    expect(f.minX).toBeCloseTo(1.3);
    expect(f.maxX).toBeCloseTo(2.7);
    expect(f.minZ).toBeCloseTo(-3.3);
    expect(f.maxZ).toBeCloseTo(-2.7);
  });

  it('swaps the extents on a quarter turn', () => {
    const f = rotatedFootprint(0, 0, 2, 1, Math.PI / 2);
    expect(f.maxX - f.minX).toBeCloseTo(1);
    expect(f.maxZ - f.minZ).toBeCloseTo(2);
  });

  it('is invariant under a half turn', () => {
    const a = rotatedFootprint(1, 1, 1.2, 0.8, 0);
    const b = rotatedFootprint(1, 1, 1.2, 0.8, Math.PI);
    expect(b.maxX - b.minX).toBeCloseTo(a.maxX - a.minX);
    expect(b.maxZ - b.minZ).toBeCloseTo(a.maxZ - a.minZ);
  });

  it('reports zero overlap for disjoint boxes', () => {
    expect(overlapArea(rotatedFootprint(0, 0, 1, 1), rotatedFootprint(5, 5, 1, 1))).toBe(0);
  });
});

describe('authored room layout', () => {
  it('has no structural problems', () => {
    const problems = layoutProblems();
    const message = problems.map((p) => `${p.kind}: ${p.detail}`).join('\n');
    expect(problems, `\n${message}\n`).toEqual([]);
  });

  it('keeps every floor-standing prop between the outer walls', () => {
    for (const slot of groundProps()) {
      expect(insideRoomShell(slotFootprint(slot)), `${slot.id} breaches the shell`).toBe(true);
    }
  });

  it('mounts every elevated anchored prop against a wall or partition', () => {
    const faces = [
      { axis: 'x' as const, at: ROOM.minX + ROOM.wallThickness },
      { axis: 'x' as const, at: ROOM.maxX - ROOM.wallThickness },
      { axis: 'z' as const, at: ROOM.minZ + ROOM.wallThickness },
      { axis: 'z' as const, at: ROOM.maxZ - ROOM.wallThickness },
    ];
    const partitions = partitionFootprints();

    const wallMounted = SLOTS.filter((s) => s.anchored && s.pos.y > 0.5 && s.kind !== 'ceiling_light');
    expect(wallMounted.length).toBeGreaterThan(0);

    for (const slot of wallMounted) {
      const f = slotFootprint(slot);
      const nearShell = faces.some((face) => {
        const lo = face.axis === 'x' ? f.minX : f.minZ;
        const hi = face.axis === 'x' ? f.maxX : f.maxZ;
        return face.at >= lo - 0.06 && face.at <= hi + 0.06;
      });
      const nearPartition = partitions.some((p) => overlapArea(f, p) > 0);
      expect(nearShell || nearPartition, `${slot.id} is floating off a wall`).toBe(true);
    }
  });

  it('builds partitions as full-height thin slabs', () => {
    // a typo in a partition would show up as a fat or short "wall"
    for (const w of WALLS.filter((x) => x.partition)) {
      const sx = w.max.x - w.min.x;
      const sz = w.max.z - w.min.z;
      const sy = w.max.y - w.min.y;
      expect(Math.min(sx, sz), `partition at ${w.min.x},${w.min.z} is not thin`).toBeLessThan(0.15);
      expect(Math.max(sx, sz)).toBeGreaterThan(0.5);
      expect(sy).toBeCloseTo(ROOM.wallHeight, 5);
      expect(w.min.y).toBe(0);
    }
  });

  it('does not push standing furniture through a partition', () => {
    for (const slot of SLOTS) {
      if (slot.anchored || FLAT_KINDS.has(slot.kind)) continue;
      expect(intersectsPartition(slotFootprint(slot)), `${slot.id} is inside a wall`).toBe(false);
    }
  });

  it('keeps every intruder anchor reachable and free of furniture', () => {
    for (const anchor of INTRUDE_ANCHORS) {
      const f = anchorFootprint(anchor.pos.x, anchor.pos.z, ANCHOR_CLEARANCE);
      expect(insideRoomShell(f), `${anchor.id} is outside the room`).toBe(true);
      expect(intersectsPartition(f), `${anchor.id} is inside a wall`).toBe(false);
    }
  });

  it('spawns the player inside the room, clear of the walls', () => {
    // SPAWN is asserted here rather than imported to keep this file about geometry
    const spawn = { x: -0.4, z: 3.6 };
    const f = anchorFootprint(spawn.x, spawn.z, ROOM.radius);
    expect(insideRoomShell(f)).toBe(true);
    expect(intersectsPartition(f)).toBe(false);
  });

  it('gives every slot a unique id', () => {
    const ids = SLOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every intruder anchor a unique id', () => {
    const ids = INTRUDE_ANCHORS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
