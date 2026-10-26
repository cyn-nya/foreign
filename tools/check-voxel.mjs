#!/usr/bin/env node
/**
 * Verify the voxel occupancy field against the real published scan.
 *
 *   node tools/check-voxel.mjs [--refresh]
 *
 * Splats have no collision, so walkability rests entirely on this sidecar file.
 * If it is missing, truncated, or in a different orientation from the splat,
 * the game either lets the player walk through walls or drops them through the
 * floor — and neither shows up in a screenshot. So the geometry is measured
 * here rather than assumed.
 *
 * Both files are cached under .cache/voxel/ (gitignored): the data belongs to
 * Aholo's open-source sample bucket, so it is fetched, not redistributed, and
 * repeat runs need no network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPSULE_HEIGHT,
  EYE_HEIGHT,
  HOVER_HEIGHT,
  loadVoxelCollision,
  resolveCapsule,
  voxelCollisionFromBuffers,
  worldToVoxel,
} from '../src/viewer/voxel.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache/voxel');
const BASE = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file/room/voxel/10c88df3';
const refresh = process.argv.includes('--refresh');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function ensure(name, url) {
  const file = path.join(cacheDir, name);
  if (!refresh && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

let metaFile;
let binFile;
try {
  metaFile = await ensure('meta.json', `${BASE}/collision.voxel-meta.json`);
  binFile = await ensure('collision.bin', `${BASE}/collision.voxel.bin`);
} catch (error) {
  console.error(`cannot obtain voxel data: ${error instanceof Error ? error.message : error}`);
  console.error(`(network needed once; cached afterwards in ${path.relative(root, cacheDir)})`);
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const binary = new Uint8Array(fs.readFileSync(binFile));
const collision = voxelCollisionFromBuffers(metadata, binary);

// --- file integrity ---------------------------------------------------------
const u32Total = Math.floor(binary.byteLength / 4);
check(
  'the binary is exactly nodeCount + leafDataCount uint32s',
  u32Total === (metadata.nodeCount >>> 0) + (metadata.leafDataCount >>> 0),
  `${u32Total} u32 vs ${metadata.nodeCount} + ${metadata.leafDataCount}`,
);

// --- the published spawn pose must be standable -----------------------------
// WALK_DEMO_INDOOR_POSE from the official walk demo.
const SPAWN = { x: -4.148223469209742, y: 1.0000000000000002, z: 1.2315243027420304 };
const r = metadata.voxelResolution;
const min = metadata.gridBounds.min;

const at = (x, y, z) => worldToVoxel(metadata, x, y, z);
const solidAt = (x, y, z) => {
  const v = at(x, y, z);
  return collision.isVoxelSolid(v.ix, v.iy, v.iz);
};

check('the spawn point is not inside a wall', !solidAt(SPAWN.x, SPAWN.y, SPAWN.z));

// --- wall profile: floor below, headroom, ceiling above ---------------------
// Measured: solid at -0.60..-0.45, free -0.40..2.10, solid from 2.15 up.
let floor = null;
for (let y = SPAWN.y; y > min[1]; y -= r) {
  if (solidAt(SPAWN.x, y, SPAWN.z)) {
    floor = y;
    break;
  }
}
let ceiling = null;
for (let y = SPAWN.y; y < min[1] + 30; y += r) {
  if (solidAt(SPAWN.x, y, SPAWN.z)) {
    ceiling = y;
    break;
  }
}
check(
  'there is a floor beneath the spawn and a ceiling above it',
  floor !== null && ceiling !== null,
  `floor ${floor?.toFixed(2)} ceiling ${ceiling?.toFixed(2)}`,
);
check(
  'the standing space matches the eye height the walk demo ships',
  floor !== null && ceiling !== null && ceiling - floor > EYE_HEIGHT && ceiling - floor < 4,
  `${(ceiling - floor).toFixed(2)} m of headroom for a ${EYE_HEIGHT.toFixed(2)} m eye`,
);
check(
  'the capsule hangs HOVER_HEIGHT above the floor',
  floor !== null && Math.abs(SPAWN.y - EYE_HEIGHT - HOVER_HEIGHT - floor) < 0.2,
  `eye ${SPAWN.y.toFixed(2)} - ${EYE_HEIGHT.toFixed(2)} - ${HOVER_HEIGHT} = ` +
    `${(SPAWN.y - EYE_HEIGHT - HOVER_HEIGHT).toFixed(2)} vs floor ${floor?.toFixed(2)}`,
);

// --- the room is enclosed ---------------------------------------------------
// If the scan's collision were missing or misaligned this is what would break:
// the player would face an open void instead of a wall.
const distances = [];
for (let i = 0; i < 16; i++) {
  const yaw = (i / 16) * Math.PI * 2;
  const hit = collision.queryRay(
    SPAWN.x,
    SPAWN.y,
    SPAWN.z,
    -Math.sin(yaw),
    0,
    -Math.cos(yaw),
    40,
  );
  distances.push(hit ? Math.hypot(hit.x - SPAWN.x, hit.z - SPAWN.z) : null);
}
const enclosed = distances.filter((d) => d !== null && d > 0.3 && d < 30).length;
check(
  'the player is enclosed by walls in every direction',
  enclosed === distances.length,
  `${enclosed}/${distances.length} rays hit; min ${Math.min(...distances.filter((d) => d)).toFixed(2)} m, ` +
    `max ${Math.max(...distances.filter((d) => d)).toFixed(2)} m`,
);

// --- capsule resolution -----------------------------------------------------
const out = { x: 0, y: 0, z: 0 };
const pushedStanding = resolveCapsule(collision, SPAWN.x, SPAWN.y, SPAWN.z, out);
check(
  'a capsule standing at the spawn is not pushed around',
  pushedStanding === false,
  pushedStanding ? `pushed to (${out.x.toFixed(2)}, ${out.y.toFixed(2)}, ${out.z.toFixed(2)})` : 'no contact',
);

// Walk the eye straight up until the capsule first touches the ceiling, then
// require the push to point **down**. Two things are checked at once: the
// capsule stops the player at the ceiling, and its datum is correct. A capsule
// computed from the wrong datum reports a push at the spawn instead (caught
// above) and, here, pushes sideways rather than down.
//
// Scanning for the threshold rather than arithmetic on `ceiling` keeps this
// honest about the 0.05 m voxel quantisation.
let ceilingContactEye = null;
for (let eye = SPAWN.y; eye < ceiling + CAPSULE_HEIGHT; eye += 0.01) {
  if (resolveCapsule(collision, SPAWN.x, eye, SPAWN.z, out)) {
    ceilingContactEye = { eye, push: { ...out } };
    break;
  }
}
check(
  'the capsule is stopped by the ceiling, pushing the player down',
  ceilingContactEye !== null && ceilingContactEye.push.y < -0.01,
  ceilingContactEye
    ? `first contact at eye ${ceilingContactEye.eye.toFixed(2)} (ceiling ${ceiling.toFixed(2)}), ` +
      `push (${ceilingContactEye.push.x.toFixed(3)}, ${ceilingContactEye.push.y.toFixed(3)}, ` +
      `${ceilingContactEye.push.z.toFixed(3)})`
    : `no ceiling contact found below eye ${(ceiling + CAPSULE_HEIGHT).toFixed(2)}`,
);
check(
  'the player has room to stand but not to float — contact is near the ceiling',
  ceilingContactEye !== null && ceilingContactEye.eye > ceiling - 0.6 && ceilingContactEye.eye < ceiling + 0.4,
  ceilingContactEye ? `contact at eye ${ceilingContactEye.eye.toFixed(2)}, ceiling ${ceiling.toFixed(2)}` : 'n/a',
);

// --- the field is not trivially empty or trivially full ---------------------
let solid = 0;
let total = 0;
for (let ix = 0; ix < 336; ix += 7) {
  for (let iy = 0; iy < 112; iy += 7) {
    for (let iz = 0; iz < 296; iz += 7) {
      total++;
      if (collision.isVoxelSolid(ix, iy, iz)) solid++;
    }
  }
}
const fraction = solid / total;
check(
  'the field is neither empty nor uniformly solid',
  fraction > 0.1 && fraction < 0.95,
  `${(fraction * 100).toFixed(1)}% solid over ${total} sampled cells`,
);

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
