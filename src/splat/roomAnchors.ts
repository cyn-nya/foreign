/**
 * Placement anchors for the reconstructed room.
 *
 * These are not authored — `tools/build-anchors.mjs` measures them out of the
 * scan's own voxel field, keeping only spots that have floor underneath,
 * headroom above, clearance around, and that the walker's own capsule can
 * actually stand in. See `data/room-anchors.json` for the full derivation.
 *
 * That indirection matters: the procedural room's anchors could be typed by
 * hand because I decided where its walls were. Here the walls are wherever the
 * capture rig saw them, and guessing coordinates would put objects inside them.
 */

import data from '../../data/room-anchors.json';
import type { AnchorDef } from '../game/rules.ts';
import { ROOM_SPAWN } from './roomData.ts';

export const ROOM_ANCHORS: AnchorDef[] = data.anchors.map((anchor) => ({
  id: anchor.id,
  pos: anchor.pos,
  place: anchor.place,
}));

/** Mean floor height across the anchors — the walker's datum in this scan. */
export const ROOM_FLOOR_LEVEL: number = data.floorLevel;

/** The way in, which 'stare' turns to face. */
export const ROOM_ENTRY = { x: ROOM_SPAWN.x, y: ROOM_SPAWN.y, z: ROOM_SPAWN.z };

/** Everything `generateFloor` needs to build a floor for this room. */
export const ROOM_FLOOR_OPTIONS = {
  anchors: ROOM_ANCHORS,
  spawn: ROOM_ENTRY,
  foreignOnly: true as const,
};

/** Look up a placement by the anchor id an anomaly carries as its slot id. */
export function anchorById(id: string): AnchorDef | null {
  return ROOM_ANCHORS.find((anchor) => anchor.id === id) ?? null;
}
