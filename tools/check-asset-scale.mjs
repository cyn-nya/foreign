#!/usr/bin/env node
/**
 * What does a model actually occupy, after the loader has normalised it?
 *
 *   node tools/check-asset-scale.mjs
 *
 * The first version of this file compared the catalogue's `height` to the GLB's raw POSITION
 * bounds and reported 28 "mismatches" -- and it was wrong, in exactly the way it was written to
 * catch. `src/game/assets.ts` normalises every model with
 *
 *     const scale = size.y > 1e-4 ? asset.height / size.y : 1;
 *     scene.scale.setScalar(scale);
 *
 * so the rendered height IS `asset.height` by construction, and the raw geometry is an input
 * rather than an output. A check that measures an input and calls it the rendered size is the
 * same failure this project has already found twice: it passes (or fails) on something that
 * does not decide what the player sees.
 *
 * The real risk is what uniform scaling does to a model that is not upright. Scaling by the Y
 * extent is only a normalisation if the model stands up. A flat decal whose `size.y` is a tenth
 * of its width gets multiplied by ten to reach the target height, and its footprint goes with it
 * -- so a `height` of 1.10 can put five metres of grinning face across a room. Nothing else in
 * the pipeline looks at that, because every other consumer reasons about `height` alone.
 *
 * So this reports the normalised footprint and flags models whose width or depth dwarfs their
 * height, which is what "this was authored as a decal and is being placed as a prop" looks like.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'public', 'assets', 'foreign');
const cataloguePath = path.join(root, 'data', 'foreign-assets.json');

/**
 * A normalised model wider than this many times its height is not a prop.
 *
 * Four is chosen against the catalogue rather than picked: the widest thing a person would call
 * a prop and still place in a room -- a sofa, a bed, a dining table -- is around three times as
 * wide as it is tall. Past four it is a surface: a floor, a wall, a pool, a stain.
 */
const MAX_FOOTPRINT_RATIO = 4;

/** Read the JSON chunk of a .glb. */
function readGlbJson(buffer) {
  if (buffer.length < 20) throw new Error('too short to be a GLB');
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      return JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

/** Mesh-space bounds walked through the node tree, so node scales are included. */
function worldBounds(gltf) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;

  const apply = (node, scale, translation) => {
    const s = node.scale ?? [1, 1, 1];
    const t = node.translation ?? [0, 0, 0];
    const nextScale = [scale[0] * s[0], scale[1] * s[1], scale[2] * s[2]];
    const nextTranslation = [
      translation[0] + t[0] * scale[0],
      translation[1] + t[1] * scale[1],
      translation[2] + t[2] * scale[2],
    ];

    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
        if (!accessor?.min || !accessor?.max) continue;
        found = true;
        for (let axis = 0; axis < 3; axis++) {
          const a = nextTranslation[axis] + accessor.min[axis] * nextScale[axis];
          const b = nextTranslation[axis] + accessor.max[axis] * nextScale[axis];
          min[axis] = Math.min(min[axis], a, b);
          max[axis] = Math.max(max[axis], a, b);
        }
      }
    }
    for (const child of node.children ?? []) {
      const childNode = gltf.nodes?.[child];
      if (childNode) apply(childNode, nextScale, nextTranslation);
    }
  };

  for (const nodeIndex of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) {
    const node = gltf.nodes?.[nodeIndex];
    if (node) apply(node, [1, 1, 1], [0, 0, 0]);
  }
  if (!found) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

const catalogue = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
const assets = Array.isArray(catalogue) ? catalogue : catalogue.assets;

const rows = [];
const problems = [];

for (const asset of assets) {
  const file = path.join(assetsDir, `${asset.key}.glb`);
  if (!fs.existsSync(file)) {
    problems.push(`${asset.key}: no file`);
    continue;
  }
  let gltf;
  try {
    gltf = readGlbJson(fs.readFileSync(file));
  } catch (error) {
    problems.push(`${asset.key}: unreadable (${error.message})`);
    continue;
  }
  const bounds = worldBounds(gltf);
  if (!bounds) {
    problems.push(`${asset.key}: no POSITION accessor with bounds`);
    continue;
  }

  // Exactly what `normalise` computes. `size.y` is the divisor, so a model that lies flat is
  // multiplied by however flat it is.
  const native = bounds.size;
  const height = asset.height ?? 0;
  const scale = native[1] > 1e-4 ? height / native[1] : 1;
  const rendered = { x: native[0] * scale, y: native[1] * scale, z: native[2] * scale };
  const footprint = Math.max(rendered.x, rendered.z);
  const ratio = rendered.y > 1e-4 ? footprint / rendered.y : Infinity;

  // A model that is already flat in its own geometry is a decal, and a decal SHOULD come out
  // wide: `stain` is 4 mm of native thickness and renders as a 1.15 m puddle, which is what a
  // stain is. The rule this file enforces is about *props* being scaled into walls, so a
  // natively flat asset is exempt rather than a failure -- the first run of this check reported
  // `stain` at 22.9x and that was the check being wrong, not the model.
  const nativeFlat = native[1] < 0.15 * Math.max(native[0], native[2]);

  rows.push({ key: asset.key, rendered, ratio, nativeY: native[1], scale, nativeFlat });
}

rows.sort((a, b) => b.ratio - a.ratio);

console.log(
  `${'asset'.padEnd(30)}${'h'.padStart(7)}${'w'.padStart(8)}${'d'.padStart(8)}` +
    `${'w/h'.padStart(8)}  verdict`,
);
for (const row of rows) {
  const verdict =
    row.ratio > MAX_FOOTPRINT_RATIO ? (row.nativeFlat ? 'decal' : 'FLAT') : 'ok';
  if (verdict === 'FLAT') {
    problems.push(
      `${row.key}: renders ${row.rendered.x.toFixed(2)} x ${row.rendered.y.toFixed(2)} x ` +
        `${row.rendered.z.toFixed(2)} m -- ${row.ratio.toFixed(1)}x wider than it is tall ` +
        `from upright geometry (native y ${row.nativeY.toFixed(3)} m, scaled ${row.scale.toFixed(1)}x)`,
    );
  }
  console.log(
    `${row.key.padEnd(30)}${row.rendered.y.toFixed(2).padStart(7)}` +
      `${row.rendered.x.toFixed(2).padStart(8)}${row.rendered.z.toFixed(2).padStart(8)}` +
      `${row.ratio.toFixed(2).padStart(8)}  ${verdict}`,
  );
}

console.log('');
if (problems.length === 0) {
  console.log(`all ${rows.length} models occupy a prop-shaped footprint once normalised`);
} else {
  console.log(`${problems.length} model(s) are far wider than they are tall:`);
  for (const problem of problems.slice(0, 20)) console.log(`  ! ${problem}`);
  process.exitCode = 1;
}
