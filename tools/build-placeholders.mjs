#!/usr/bin/env node
/**
 * Export every catalogue entry's procedural placeholder to .glb.
 *
 *   node tools/build-placeholders.mjs [--only duck,eye] [--out public/assets/foreign]
 *
 * The game renders through `@manycore/aholo-viewer`, which has no geometry
 * helpers — you build meshes from raw vertex buffers there. Rather than
 * maintain a second copy of ~600 lines of prop geometry, the existing three.js
 * builders are run once here and their output is baked to .glb, which the
 * viewer loads with its own GLTFLoader.
 *
 * Every placeholder is baked at 1 metre tall, so the game can size it to the
 * real world by scaling by the catalogue's `height`. One file serves all sizes.
 *
 * This is also the fallback path: the game is fully playable from these baked
 * placeholders alone, and Aholo Lux3D .glb files simply replace them by key.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProp } from '../src/game/props.ts';
import { exportGlb } from './glb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const outDir = path.resolve(root, argValue('--out') ?? 'public/assets/foreign');
const only = argValue('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

/** Matches DEFAULT_FOREIGN_SIZE in src/game/Room.ts. */
const CANONICAL = { x: 0.8, y: 1.0, z: 0.8 };

/** Read the back of a .glb and confirm it is structurally complete. */
function inspectGlb(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('bad magic');
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength !== buffer.length) {
    throw new Error(`declared length ${declaredLength} != actual ${buffer.length}`);
  }
  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = JSON.parse(buffer.subarray(20, 20 + chunkLength).toString('utf8'));
  const meshes = json.meshes?.length ?? 0;
  const primitives = (json.meshes ?? []).reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
  const accessors = json.accessors?.length ?? 0;
  if (meshes === 0 || primitives === 0 || accessors === 0) {
    throw new Error(`empty glTF: meshes=${meshes} primitives=${primitives} accessors=${accessors}`);
  }
  return { version, meshes, primitives, accessors, materials: json.materials?.length ?? 0 };
}

const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'data/foreign-assets.json'), 'utf8'));
const assets = (catalogue.assets ?? []).filter((a) => a.key);

fs.mkdirSync(outDir, { recursive: true });
console.log(`baking ${only ? only.length : assets.length} placeholder(s) -> ${path.relative(root, outDir)}`);

const manifest = [];
let failures = 0;

for (const asset of assets) {
  if (only && !only.includes(asset.key)) continue;
  const started = Date.now();
  try {
    const object = createProp(asset.placeholder, CANONICAL);
    const buffer = await exportGlb(object);
    const info = inspectGlb(buffer);
    const file = path.join(outDir, `${asset.key}.glb`);
    fs.writeFileSync(file, buffer);
    manifest.push({
      key: asset.key,
      name: asset.name,
      placeholder: asset.placeholder,
      file: `${asset.key}.glb`,
      /** World height in metres — the baked model is always 1 m tall. */
      height: asset.height,
      color: asset.color,
      weirdness: asset.weirdness,
      bytes: buffer.length,
    });
    console.log(
      `  ✓ ${asset.key.padEnd(11)} ${String(buffer.length).padStart(6)} B  ` +
        `${info.meshes} mesh / ${info.primitives} prim / ${info.materials} mat  ${Date.now() - started}ms`,
    );
  } catch (error) {
    failures++;
    console.error(`  ✗ ${asset.key}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failures === 0) {
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ source: 'procedural placeholders', canonicalHeight: CANONICAL.y, assets: manifest }, null, 2)}\n`,
  );
  console.log(`\n${manifest.length} placeholder(s) written, manifest updated`);
} else {
  console.error(`\n${failures} placeholder(s) FAILED — manifest left untouched`);
  process.exit(1);
}
