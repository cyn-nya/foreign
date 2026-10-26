/**
 * Pure level-geometry checks. No three.js, no DOM.
 *
 * A room authored by hand has a specific failure mode: a prop rotated the
 * wrong way ends up half inside a wall, or two props end up occupying the
 * same floor space. Both are invisible in code review and obvious to a
 * player. These helpers turn "the room looks right" into something a test
 * can assert.
 */

import { INTRUDE_ANCHORS, ROOM, SLOTS, WALLS } from './catalog';
import type { SlotDef } from './types';

export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Props that lie flat on the floor — other furniture is allowed on top. */
export const FLAT_KINDS: ReadonlySet<string> = new Set(['rug', 'doormat']);

/**
 * Radius the game reserves around an intruder anchor. Must match the
 * collider Room builds, otherwise the two disagree about what fits.
 */
export const ANCHOR_CLEARANCE = 0.4;

/**
 * `size.x` is the prop's extent along X *before* rotation and `size.z` its
 * extent along Z. Rotating by a quarter turn swaps them.
 */
export function rotatedFootprint(
  x: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  rotY = 0,
  scale = 1,
): Footprint {
  const hx = (sizeX / 2) * scale;
  const hz = (sizeZ / 2) * scale;
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  const ex = c * hx + s * hz;
  const ez = s * hx + c * hz;
  return { minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez };
}

export function slotFootprint(slot: SlotDef, scale = 1): Footprint {
  return rotatedFootprint(slot.pos.x, slot.pos.z, slot.size.x, slot.size.z, slot.rotY ?? 0, scale);
}

export function overlapArea(a: Footprint, b: Footprint): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const d = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return w > 0 && d > 0 ? w * d : 0;
}

/** Footprint of a circular intruder anchor. */
export function anchorFootprint(x: number, z: number, radius: number): Footprint {
  return { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
}

const EPS = 1e-6;

/** The prop must sit between the four outer walls, not through them. */
export function insideRoomShell(f: Footprint): boolean {
  const t = ROOM.wallThickness;
  return (
    f.minX >= ROOM.minX + t - EPS &&
    f.maxX <= ROOM.maxX - t + EPS &&
    f.minZ >= ROOM.minZ + t - EPS &&
    f.maxZ <= ROOM.maxZ - t + EPS
  );
}

export function partitionFootprints(): Footprint[] {
  return WALLS.filter((w) => w.partition).map((w) => ({
    minX: w.min.x,
    maxX: w.max.x,
    minZ: w.min.z,
    maxZ: w.max.z,
  }));
}

export function intersectsPartition(f: Footprint): boolean {
  return partitionFootprints().some((p) => overlapArea(f, p) > 0.01);
}

/** Ground-standing props: on the floor and not flat like a rug. */
export function groundProps(): SlotDef[] {
  return SLOTS.filter((s) => s.pos.y < 0.05 && !FLAT_KINDS.has(s.kind));
}

export interface LayoutProblem {
  kind: 'outside-room' | 'in-partition' | 'overlap' | 'anchor-blocked';
  detail: string;
}

/** Every structural problem in the authored room, as plain strings. */
export function layoutProblems(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];

  for (const slot of groundProps()) {
    const f = slotFootprint(slot);
    if (!insideRoomShell(f)) problems.push({ kind: 'outside-room', detail: slot.id });
    if (intersectsPartition(f)) problems.push({ kind: 'in-partition', detail: slot.id });
  }

  const props = groundProps();
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      const area = overlapArea(slotFootprint(props[i]), slotFootprint(props[j]));
      // small tolerance: adjacent furniture is allowed to just touch
      if (area > 0.04) {
        problems.push({
          kind: 'overlap',
          detail: `${props[i].id} / ${props[j].id} share ${area.toFixed(3)} m²`,
        });
      }
    }
  }

  const obstacles = props.map((s) => ({ id: s.id, f: slotFootprint(s) }));
  for (const anchor of INTRUDE_ANCHORS) {
    const f = anchorFootprint(anchor.pos.x, anchor.pos.z, ANCHOR_CLEARANCE);
    if (!insideRoomShell(f)) {
      problems.push({ kind: 'anchor-blocked', detail: `${anchor.id} outside room` });
      continue;
    }
    if (intersectsPartition(f)) {
      problems.push({ kind: 'anchor-blocked', detail: `${anchor.id} in a partition` });
      continue;
    }
    for (const o of obstacles) {
      const area = overlapArea(f, o.f);
      if (area > 0.35) {
        problems.push({
          kind: 'anchor-blocked',
          detail: `${anchor.id} collides with ${o.id} (${area.toFixed(2)} m²)`,
        });
      }
    }
  }

  return problems;
}
