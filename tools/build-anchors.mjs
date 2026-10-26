#!/usr/bin/env node
/**
 * Derive placement anchors for foreign objects from the scan itself.
 *
 *   node tools/build-anchors.mjs [--count 24] [--out data/room-anchors.json]
 *
 * The procedural room's anchors are authored coordinates. A reconstructed room
 * cannot work that way: its floor is not level, its walls are where the capture
 * rig saw them, and there are no named rooms. So the anchors are *measured* —
 * find every spot that has floor under it, headroom over it, and clearance
 * around it, then keep a spread-out subset.
 *
 * Runs against the cached voxel field (.cache/voxel), so it needs no browser
 * and no network after the first fetch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelCollision } from '../src/viewer/VoxelCollision.ts';
import { EYE_HEIGHT, HOVER_HEIGHT, resolveCapsule, worldToVoxel } from '../src/viewer/voxel.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache/voxel');
const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const wanted = Number(argValue('--count') ?? 24);
const outFile = path.resolve(root, argValue('--out') ?? 'data/room-anchors.json');

const metaFile = path.join(cacheDir, 'meta.json');
const binFile = path.join(cacheDir, 'collision.bin');
if (!fs.existsSync(metaFile) || !fs.existsSync(binFile)) {
  console.error('voxel data missing — run `npm run voxel:check` once to fetch it');
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const binary = new Uint8Array(fs.readFileSync(binFile));
const all = new Uint32Array(binary.buffer, binary.byteOffset, Math.floor(binary.byteLength / 4));
const nodeCount = metadata.nodeCount >>> 0;
const leafCount = metadata.leafDataCount >>> 0;
const collision = new VoxelCollision(
  metadata,
  all.slice(0, nodeCount),
  all.slice(nodeCount, nodeCount + leafCount),
);

const STEP = 0.25;
const RADIUS = 0.42;
const CLEARANCE = 0.8;
const HEADROOM = 1.9;
const MIN_FLOOR = -1.2;
const MAX_FLOOR = 0.6;
/** Anchors closer together than this are the same spot for gameplay purposes. */
const MIN_SEPARATION = 1.6;

/** Anything solid between two points? */
function blocked(x, z, y0, y1, radius) {
  for (let y = y0; y <= y1; y += 0.15) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const v = worldToVoxel(metadata, x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius);
      if (collision.isVoxelSolid(v.ix, v.iy, v.iz)) return true;
    }
  }
  return false;
}

/** Nearest wall distance in 8 directions, at a given height. */
function wallDistance(x, y, z) {
  let nearest = Infinity;
  for (let a = 0; a < 8; a++) {
    const angle = (a / 8) * Math.PI * 2;
    const hit = collision.queryRay(x, y, z, Math.cos(angle), 0, Math.sin(angle), 20);
    if (hit) nearest = Math.min(nearest, Math.hypot(hit.x - x, hit.z - z));
  }
  return nearest;
}

const min = metadata.gridBounds.min;
const max = metadata.gridBounds.max;

const candidates = [];
for (let x = min[0] + 0.5; x < max[0] - 0.5; x += STEP) {
  for (let z = min[2] + 0.5; z < max[2] - 0.5; z += STEP) {
    // Find the surface under this column. Casting from above means this is
    // often a table or a counter top rather than the floor — that is filtered
    // out below by the modal-level band.
    const ground = collision.queryRay(x, 2.0, z, 0, -1, 0, 3.5);
    if (!ground) continue;
    const floorY = ground.y;
    if (floorY < MIN_FLOOR || floorY > MAX_FLOOR) continue;

    // Headroom, then body clearance.
    if (blocked(x, z, floorY + 0.25, floorY + HEADROOM, 0.05)) continue;
    if (blocked(x, z, floorY + 0.3, floorY + 1.5, RADIUS)) continue;

    // Not wedged against a wall, or the prop would be half inside it.
    const wall = wallDistance(x, floorY + 0.6, z);
    if (wall < CLEARANCE + RADIUS) continue;

    candidates.push({ x: +x.toFixed(3), y: +floorY.toFixed(3), z: +z.toFixed(3), wall: +wall.toFixed(2) });
  }
}

console.log(`scanned a ${STEP} m grid: ${candidates.length} candidate surfaces`);

/**
 * Keep only real floor.
 *
 * Casting down finds whatever is solid first, so furniture tops and other
 * raised surfaces show up as "floor" a few tens of centimetres off the ground.
 * A foreign object placed on a table top would read as floating, so the
 * dominant level wins and everything off it is dropped. The band is generous
 * because a reconstructed floor is genuinely uneven.
 */
const BAND = 0.22;
const histogram = new Map();
for (const c of candidates) {
  const bin = Math.round(c.y / 0.05) * 0.05;
  histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
}
let modalLevel = 0;
let modalCount = -1;
for (const [level, count] of histogram) {
  if (count > modalCount) {
    modalCount = count;
    modalLevel = level;
  }
}
const onFloor = candidates.filter((c) => Math.abs(c.y - modalLevel) <= BAND);
console.log(
  `modal floor level ${modalLevel.toFixed(2)} (${modalCount}/${candidates.length} surfaces), ` +
    `${onFloor.length} within ±${BAND} m`,
);

/**
 * And the walker has to actually be able to stand there. This reuses the same
 * capsule the game moves with, so an anchor cannot be somewhere the player can
 * never reach — which is the failure that would make an anomaly unfindable.
 *
 * The spawn is excluded too: a prop dropped within arm's reach of where the
 * player opens their eyes is not a search.
 */
const SPAWN = { x: -4.148223469209742, z: 1.2315243027420304 };
const SPAWN_CLEARANCE = 1.6;

const standable = [];
const push = { x: 0, y: 0, z: 0 };
let onTopOfSpawn = 0;
for (const c of onFloor) {
  if (Math.hypot(c.x - SPAWN.x, c.z - SPAWN.z) < SPAWN_CLEARANCE) {
    onTopOfSpawn++;
    continue;
  }
  if (resolveCapsule(collision, c.x, c.y + EYE_HEIGHT + HOVER_HEIGHT, c.z, push)) continue;
  standable.push(c);
}
console.log(
  `${standable.length} of those are standable by the walker's own capsule ` +
    `(${onTopOfSpawn} dropped for being on top of the spawn)`,
);

const candidates2 = standable;

// Greedy farthest-point sampling: a spread of anchors is more interesting than
// an arbitrary slice, and two anchors in the same corner are one anchor.
const chosen = [];
const remaining = candidates2.slice();
// Seed with the spot that has the most room around it.
remaining.sort((a, b) => b.wall - a.wall);
if (remaining.length > 0) chosen.push(remaining.shift());

while (chosen.length < wanted && remaining.length > 0) {
  let bestIndex = -1;
  let bestDistance = -1;
  for (let i = 0; i < remaining.length; i++) {
    const c = remaining[i];
    let nearest = Infinity;
    for (const anchor of chosen) {
      nearest = Math.min(nearest, Math.hypot(c.x - anchor.x, c.z - anchor.z));
    }
    // Prefer far from existing anchors, with a mild preference for open space.
    const score = nearest + c.wall * 0.3;
    if (score > bestDistance) {
      bestDistance = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestDistance < MIN_SEPARATION) break;
  chosen.push(remaining.splice(bestIndex, 1)[0]);
}

/**
 * A positional label. The real room has no room names — calling something
 * "the kitchen" would be a guess about a space nobody labelled.
 */
function placeLabel(anchor, centreX, centreZ) {
  const dx = anchor.x - centreX;
  const dz = anchor.z - centreZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 2.0) return '房间中央';
  const angle = (Math.atan2(dz, dx) * 180) / Math.PI;
  if (angle >= -45 && angle < 45) return '靠东侧';
  if (angle >= 45 && angle < 135) return '靠南侧';
  if (angle >= -135 && angle < -45) return '靠北侧';
  return '靠西侧';
}

const centreX = chosen.reduce((sum, a) => sum + a.x, 0) / Math.max(1, chosen.length);
const centreZ = chosen.reduce((sum, a) => sum + a.z, 0) / Math.max(1, chosen.length);

const anchors = chosen.map((anchor, index) => ({
  id: `fx_room_${String(index + 1).padStart(2, '0')}`,
  pos: { x: anchor.x, y: anchor.y, z: anchor.z },
  place: placeLabel(anchor, centreX, centreZ),
  wall: anchor.wall,
}));

// The floor level the walker stands on, for anything that needs a datum.
const floorLevel = anchors.length
  ? +(anchors.reduce((sum, a) => sum + a.pos.y, 0) / anchors.length).toFixed(3)
  : -0.425;

const payload = {
  source: 'derived from the scan voxel field by tools/build-anchors.mjs',
  grid: { step: STEP, radius: RADIUS, clearance: CLEARANCE, headroom: HEADROOM },
  floorLevel,
  bounds: { min, max },
  count: anchors.length,
  anchors,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`floor level ${floorLevel}`);
console.log(`wrote ${anchors.length} anchors -> ${path.relative(root, outFile)}`);
for (const anchor of anchors) {
  console.log(
    `  ${anchor.id}  (${String(anchor.pos.x).padStart(7)}, ${String(anchor.pos.y).padStart(6)}, ` +
      `${String(anchor.pos.z).padStart(7)})  wall ${anchor.wall.toFixed(2)} m  ${anchor.place}`,
  );
}
