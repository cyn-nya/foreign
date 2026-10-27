/**
 * The apartment. One room, authored once, reused for every floor —
 * the anomaly system is what changes. This is the whole art budget.
 *
 * Plan view (x right, z down-page), 10m x 8m, ceiling 2.7m:
 *
 *      z=-4  +-----------------+-----------------+
 *            |                 |                 |
 *            |     LIVING      |    BEDROOM      |
 *            |                 |                 |
 *      z=0.2 |                 +------+ +--------+
 *            |                 |      | |        |
 *            |                 |      | | KITCHEN|
 *      z=3.0 +--------+  +-----+------+ |        |
 *            |        |  |            | |        |
 *            |        |  |  HALL      | +--------+
 *      z=4.6 +--------+--+------------+----------+
 *           x=-5                              x=5
 */

import catalogue from '../../data/foreign-assets.json';
import type { PropKind, SlotDef, Vec3 } from './types';

export const ROOM = {
  minX: -5,
  maxX: 5,
  minZ: -4,
  // 4.6 rather than 4.0: the hall needs to be deep enough to actually place a
  // generated object in. At 1.0m deep nothing wider than a shoebox fits.
  maxZ: 4.6,
  wallHeight: 2.7,
  wallThickness: 0.12,
  /** Player eye height. */
  eyeHeight: 1.62,
  /** Player collision radius. */
  radius: 0.32,
} as const;

export interface WallDef {
  /** Axis-aligned box, already inflated by wallThickness. */
  min: Vec3;
  max: Vec3;
  /** Interior partitions get a slightly different material. */
  partition?: boolean;
}

const T = ROOM.wallThickness;

function hWall(z: number, x0: number, x1: number, partition = false): WallDef {
  return {
    min: { x: Math.min(x0, x1), y: 0, z: z - T / 2 },
    max: { x: Math.max(x0, x1), y: ROOM.wallHeight, z: z + T / 2 },
    partition,
  };
}

function vWall(x: number, z0: number, z1: number, partition = false): WallDef {
  return {
    min: { x: x - T / 2, y: 0, z: Math.min(z0, z1) },
    max: { x: x + T / 2, y: ROOM.wallHeight, z: Math.max(z0, z1) },
    partition,
  };
}

/** Outer shell + interior partitions, with doorways left as gaps. */
export const WALLS: WallDef[] = [
  // outer shell
  hWall(ROOM.minZ, ROOM.minX, ROOM.maxX),
  hWall(ROOM.maxZ, ROOM.minX, ROOM.maxX),
  vWall(ROOM.minX, ROOM.minZ, ROOM.maxZ),
  vWall(ROOM.maxX, ROOM.minZ, ROOM.maxZ),

  // P1 — vertical partition at x = 0.2
  vWall(0.2, -4.0, -2.8, true),
  vWall(0.2, -1.6, 0.4, true),
  vWall(0.2, 1.7, 3.0, true),

  // P2 — bedroom / kitchen partition at z = 0.2
  hWall(0.2, 0.2, 1.4, true),
  hWall(0.2, 2.6, 5.0, true),

  // P3 — hall / kitchen partition at z = 3.0
  hWall(3.0, 0.2, 4.0, true),
];

/** Where the player spawns and looks. */
export const SPAWN = {
  pos: { x: -0.4, y: 0, z: 3.6 } as Vec3,
  /** yaw 0 looks down -z, i.e. from the hall into the apartment. */
  yaw: 0,
};

const s = (
  id: string,
  kind: PropKind,
  zone: SlotDef['zone'],
  x: number,
  z: number,
  size: Vec3,
  opts: { rotY?: number; y?: number; anchored?: boolean; subtle?: boolean } = {},
): SlotDef => ({
  id,
  kind,
  zone,
  pos: { x, y: opts.y ?? 0, z },
  size,
  rotY: opts.rotY,
  anchored: opts.anchored,
  subtle: opts.subtle,
});

export const SLOTS: SlotDef[] = [
  // ---------------- LIVING ----------------
  s('sofa', 'sofa', 'living', -3.5, 1.4, { x: 2.1, y: 0.82, z: 0.9 }, { rotY: Math.PI / 2 }),
  s('coffee_table', 'coffee_table', 'living', -1.7, 1.4, { x: 1.1, y: 0.42, z: 0.62 }),
  s('tv_stand', 'tv_stand', 'living', -0.35, 1.1, { x: 0.5, y: 0.48, z: 1.7 }, { rotY: Math.PI / 2 }),
  s('tv', 'tv', 'living', -0.3, 1.1, { x: 0.06, y: 0.72, z: 1.28 }, { y: 0.48, rotY: Math.PI / 2 }),
  s('rug', 'rug', 'living', -2.5, 1.4, { x: 2.6, y: 0.02, z: 2.0 }, { anchored: true }),
  s('floor_lamp', 'floor_lamp', 'living', -4.4, 2.6, { x: 0.42, y: 1.7, z: 0.42 }),
  s('bookshelf', 'bookshelf', 'living', -4.6, -1.2, { x: 0.45, y: 2.0, z: 1.5 }),
  s('armchair', 'armchair', 'living', -4.1, -2.7, { x: 0.85, y: 0.85, z: 0.85 }, { rotY: Math.PI / 2 }),
  s('plant', 'plant', 'living', -4.6, 3.35, { x: 0.5, y: 1.2, z: 0.5 }, { subtle: true }),
  s('wall_art', 'wall_art', 'living', -4.93, -0.4, { x: 0.05, y: 0.7, z: 1.0 }, { y: 1.5, anchored: true }),
  s('side_table', 'side_table', 'living', -3.4, 2.7, { x: 0.5, y: 0.55, z: 0.5 }),
  s('ceiling_light', 'ceiling_light', 'living', -2.5, 0.6, { x: 0.6, y: 0.22, z: 0.6 }, { y: 2.48, anchored: true }),

  // ---------------- KITCHEN ----------------
  s('counter', 'counter', 'kitchen', 2.1, 2.6, { x: 3.6, y: 0.9, z: 0.62 }, { rotY: Math.PI }),
  s('sink', 'sink', 'kitchen', 1.1, 2.6, { x: 0.6, y: 0.1, z: 0.5 }, { y: 0.9 }),
  s('stove', 'stove', 'kitchen', 2.9, 2.6, { x: 0.62, y: 0.06, z: 0.56 }, { y: 0.9 }),
  s('fridge', 'fridge', 'kitchen', 4.5, 2.5, { x: 0.72, y: 1.85, z: 0.72 }, { rotY: Math.PI }),
  s('upper_cabinet', 'upper_cabinet', 'kitchen', 1.6, 2.85, { x: 1.4, y: 0.75, z: 0.36 }, { y: 1.55, anchored: true }),
  s('dining_table', 'dining_table', 'kitchen', 2.2, 0.95, { x: 1.4, y: 0.75, z: 0.9 }),
  s('dining_chair_a', 'dining_chair', 'kitchen', 2.2, 0.25, { x: 0.46, y: 0.9, z: 0.46 }, { subtle: true }),
  s('dining_chair_b', 'dining_chair', 'kitchen', 2.2, 1.65, { x: 0.46, y: 0.9, z: 0.46 }, { rotY: Math.PI, subtle: true }),
  s('kettle', 'kettle', 'kitchen', 3.6, 2.6, { x: 0.22, y: 0.24, z: 0.22 }, { y: 0.9 }),
  s('microwave', 'microwave', 'kitchen', 0.7, 2.6, { x: 0.5, y: 0.32, z: 0.4 }, { y: 0.9 }),
  s('trash_bin', 'trash_bin', 'kitchen', 4.5, 0.6, { x: 0.36, y: 0.7, z: 0.36 }, { subtle: true }),

  // ---------------- BEDROOM ----------------
  s('bed', 'bed', 'bedroom', 2.4, -2.4, { x: 1.6, y: 0.55, z: 2.0 }),
  s('nightstand', 'nightstand', 'bedroom', 1.2, -3.4, { x: 0.5, y: 0.55, z: 0.45 }),
  s('table_lamp', 'table_lamp', 'bedroom', 1.2, -3.4, { x: 0.3, y: 0.45, z: 0.3 }, { y: 0.55 }),
  s('wardrobe', 'wardrobe', 'bedroom', 4.55, -1.6, { x: 1.8, y: 2.1, z: 0.6 }, { rotY: -Math.PI / 2 }),
  s('desk', 'desk', 'bedroom', 4.4, -3.15, { x: 1.4, y: 0.75, z: 0.7 }, { rotY: -Math.PI / 2 }),
  s('desk_chair', 'desk_chair', 'bedroom', 3.4, -3.3, { x: 0.5, y: 0.95, z: 0.5 }, { subtle: true }),
  s('mirror', 'mirror', 'bedroom', 4.93, -2.7, { x: 0.05, y: 1.0, z: 0.6 }, { y: 1.5, anchored: true }),

  // ---------------- HALL ----------------
  s('shoe_rack', 'shoe_rack', 'hall', 2.0, 3.9, { x: 0.9, y: 0.85, z: 0.35 }),
  s('doormat', 'doormat', 'hall', 0.0, 3.9, { x: 1.0, y: 0.02, z: 0.6 }, { anchored: true }),
  s('coat_hook', 'coat_hook', 'hall', -1.3, 4.5, { x: 0.6, y: 1.6, z: 0.08 }, { y: 0.9, anchored: true }),
  s('umbrella_stand', 'umbrella_stand', 'hall', -0.7, 4.0, { x: 0.26, y: 0.5, z: 0.26 }, { subtle: true }),
  s('key_bowl', 'key_bowl', 'hall', 2.0, 3.9, { x: 0.2, y: 0.08, z: 0.2 }, { y: 0.85 }),
];

/**
 * Free floor anchors where an AI-generated intruder can materialise.
 * Chosen so the object is always visible from a normal walking path
 * and never spawns inside existing furniture.
 */
export const INTRUDE_ANCHORS: { id: string; pos: Vec3; zone: SlotDef['zone'] }[] = [
  { id: 'fx_living_centre', pos: { x: -2.4, y: 0, z: -1.6 }, zone: 'living' },
  { id: 'fx_living_window', pos: { x: -3.6, y: 0, z: -3.2 }, zone: 'living' },
  { id: 'fx_living_corner', pos: { x: -1.2, y: 0, z: 2.6 }, zone: 'living' },
  { id: 'fx_living_mid', pos: { x: -3.0, y: 0, z: 0.2 }, zone: 'living' },
  { id: 'fx_kitchen_centre', pos: { x: 3.4, y: 0, z: 1.6 }, zone: 'kitchen' },
  { id: 'fx_kitchen_door', pos: { x: 1.9, y: 0, z: 2.2 }, zone: 'kitchen' },
  { id: 'fx_bedroom_centre', pos: { x: 2.4, y: 0, z: -1.3 }, zone: 'bedroom' },
  { id: 'fx_bedroom_corner', pos: { x: 1.0, y: 0, z: -1.0 }, zone: 'bedroom' },
  { id: 'fx_hall_centre', pos: { x: -2.8, y: 0, z: 3.9 }, zone: 'hall' },
  { id: 'fx_hall_door', pos: { x: 0.9, y: 0, z: 3.9 }, zone: 'hall' },
];

/**
 * The AI-generated object catalogue. Every entry is produced with
 * Aholo Lux3D from the `prompt` (an English prompt keeps the model
 * on-distribution); `placeholder` is the procedural stand-in the game
 * uses until the .glb lands in /public/assets.
 */
export interface ForeignAsset {
  key: string;
  /** Chinese name shown in the round report. */
  name: string;
  /** Prompt handed to Aholo Lux3D text-to-3D, verbatim. Absent on household props. */
  prompt?: string;
  /**
   * The procedural stand-in used until the .glb lands. Absent on household props,
   * which ship as real geometry built by tools/build-mundane.py and never need
   * a stand-in.
   */
  placeholder?: PropKind;
  /** Uniform scale applied to the procedural placeholder. */
  scale?: number;
  /**
   * Target height in metres for the loaded .glb. Generation output has no
   * canonical scale, so every model is normalised to this before it enters
   * the room - otherwise a "milk carton" arrives two metres tall.
   */
  height: number;
  /** Default tint for the procedural placeholder. */
  color: number;
  /**
   * How strange the object is. 0 is household furniture, 1 = screaming obvious,
   * 3 = genuinely unsettling.
   *
   * The zero is load-bearing rather than decorative. Household props make up the
   * room's normal, and the split between 0 and everything above it is what lets
   * "this does not belong" be answered from a single frame.
   */
  weirdness: 0 | 1 | 2 | 3;
  /** True for the household props built by tools/build-mundane.py. */
  mundane?: boolean;
  /**
   * Which horror role this model was generated for.
   *
   * Present only on the horror set. The anomalies are placed by `weirdness`, which says
   * *that* something is wrong; this says which kind of wrong it is, and it is what lets a
   * charge pick something that reads as coming at you rather than a hanging ghost.
   */
  horrorTag?: HorrorTag;
}

/**
 * The horror set's roles.
 *
 *   charge    built to move: gaunt, low, wrong-limbed. What the game sends at the player.
 *   ghost     built to hang: sheets, long hair, something suspended and still.
 *   doppel    built to pass: dressed people who are almost right.
 *   intruder  built as objects that should not be objects: doors, mirrors, holes.
 */
export type HorrorTag = 'charge' | 'ghost' | 'doppel' | 'intruder';

/**
 * Authored in data/foreign-assets.json because two consumers need the exact
 * same list: this game, and tools/generate-assets.mjs which pushes each
 * `prompt` through Lux3D. Duplicating it would let the two drift apart.
 */
export const FOREIGN_ASSETS: ForeignAsset[] = catalogue.assets as ForeignAsset[];

export const ASSETS_BY_KEY = new Map(FOREIGN_ASSETS.map((a) => [a.key, a]));

/**
 * The models generated for one horror role.
 *
 * Empty when a role has no models yet, which callers must survive: the room falls back to
 * the screen-space scare rather than spawning nothing. A missing model should make the
 * effect plainer, never make the mechanic silently stop working.
 */
export function assetsWithHorrorTag(tag: HorrorTag): ForeignAsset[] {
  return FOREIGN_ASSETS.filter((a) => a.horrorTag === tag);
}
export const SLOTS_BY_ID = new Map(SLOTS.map((s2) => [s2.id, s2]));
export const ANCHORS_BY_ID = new Map(INTRUDE_ANCHORS.map((a) => [a.id, a]));
