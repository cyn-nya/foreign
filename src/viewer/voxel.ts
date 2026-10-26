/**
 * Load and query the voxel occupancy field that ships beside a 3DGS scan.
 *
 * A splat is a cloud of view-dependent blobs: it has no surfaces, so a
 * reconstructed room is see-through and has nothing to collide with. Aholo
 * publishes a separate occupancy field for each sample scan
 * (`collision.voxel-meta.json` + `collision.voxel.bin`) and `VoxelCollision`
 * (vendored in this directory) is the reader.
 *
 * ## File format
 *
 * The `.bin` is one flat `Uint32Array`, split by the metadata's counts:
 *
 *     [ 0 .. nodeCount )                     octree nodes
 *     [ nodeCount .. nodeCount+leafDataCount ) packed leaf bits
 *
 * For the bundled room that is 41865 + 34292 = 76157 u32 = 304,628 bytes,
 * which matches the published file size exactly — a cheap integrity check.
 *
 * ## Measured geometry of the bundled room
 *
 * These were measured, not assumed (`npm run voxel:check` re-measures them):
 *
 *   floor       y -0.600 .. -0.450 solid, so the walking surface is ~-0.425
 *   standing    y -0.400 ..  2.100 free   (2.5 m of headroom)
 *   ceiling     y  2.150 and up solid
 *   walls       every one of 8 horizontal rays hits at 3.0-7.8 m
 *
 * The official spawn pose `y = 1.0` is therefore the **eye** height, and it
 * agrees with the walk demo's own tuning: a capsule bottom resting
 * `WALK_HOVER_HEIGHT` (0.2) above the floor, with the eye `WALK_EYE_HEIGHT`
 * (1.2) above that, lands at -0.425 + 0.2 + 1.2 = 0.975 ≈ 1.0.
 *
 * Deliberately plain TypeScript — no enums, no parameter properties — because
 * `tools/check-voxel.mjs` imports this file directly through Node's type
 * stripping to run the real data without a browser. The `.ts` extension on the
 * import below is required for that: Node's ESM resolver does no extension
 * guessing, and it is what `allowImportingTsExtensions` in tsconfig is for.
 */

import { VoxelCollision } from './VoxelCollision.ts';

/** Tuning from the official walk demo (ex-walk-demo.ts lines 462-465). */
export const CAPSULE_HEIGHT = 1.5;
export const CAPSULE_RADIUS = 0.12;
/** Gap kept between the capsule bottom and the floor it stands on. */
export const HOVER_HEIGHT = 0.2;
/** Eye height above the capsule bottom. */
export const EYE_HEIGHT = CAPSULE_HEIGHT - 0.1 - HOVER_HEIGHT;

/**
 * How far the eye sits **above** the centre of the collision capsule.
 *
 * The capsule bottom rests `HOVER_HEIGHT` above the floor and the eye is
 * `EYE_HEIGHT` above that bottom, so the centre is `EYE_HEIGHT -
 * CAPSULE_HEIGHT / 2` (0.45 m) *below* the eye. Getting this direction wrong is
 * silent in every screenshot — it just puts the capsule inside the ceiling and
 * the player cannot walk — so it is named for the direction, not the distance.
 */
export const EYE_ABOVE_CAPSULE_CENTRE = EYE_HEIGHT - CAPSULE_HEIGHT / 2;

export interface VoxelMetadata {
  gridBounds: { min: number[]; max: number[] };
  voxelResolution: number;
  leafSize: number;
  treeDepth: number;
  nodeCount: number;
  leafDataCount: number;
  [key: string]: unknown;
}

/**
 * Build a collision field from the two published files.
 *
 * Throws rather than degrading: a game where the player walks through walls is
 * worse than one that refuses to start, and the callers can surface the reason.
 */
export function voxelCollisionFromBuffers(
  metadata: VoxelMetadata,
  binary: Uint8Array,
): VoxelCollision {
  const nodeCount = metadata.nodeCount >>> 0;
  const leafDataCount = metadata.leafDataCount >>> 0;
  if (nodeCount === 0 || leafDataCount === 0) {
    throw new Error('voxel metadata has no nodes or no leaf data');
  }
  const all = new Uint32Array(binary.buffer, binary.byteOffset, Math.floor(binary.byteLength / 4));
  if (nodeCount + leafDataCount > all.length) {
    throw new Error(
      `voxel binary is too small: needs ${nodeCount + leafDataCount} u32 for ` +
        `nodeCount ${nodeCount} + leafDataCount ${leafDataCount}, has ${all.length}`,
    );
  }
  return new VoxelCollision(
    metadata,
    all.slice(0, nodeCount),
    all.slice(nodeCount, nodeCount + leafDataCount),
  );
}

/** Fetch both files and build the collision field. */
export async function loadVoxelCollision(
  metaUrl: string,
  binUrl: string,
  signal?: AbortSignal,
): Promise<VoxelCollision> {
  const metaResponse = await fetch(metaUrl, { signal });
  if (!metaResponse.ok) {
    throw new Error(`voxel metadata failed: HTTP ${metaResponse.status} ${metaUrl}`);
  }
  const metadata = (await metaResponse.json()) as VoxelMetadata;

  const binResponse = await fetch(binUrl, { signal });
  if (!binResponse.ok) {
    throw new Error(`voxel binary failed: HTTP ${binResponse.status} ${binUrl}`);
  }
  const binary = new Uint8Array(await binResponse.arrayBuffer());

  return voxelCollisionFromBuffers(metadata, binary);
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Push a standing capsule out of solid voxels.
 *
 * `eyeY` is the eye position, because that is what the camera and the scan's
 * published poses use; the capsule is derived downward from it.
 *
 * `out` always receives a **displacement** to add to the position — never an
 * absolute position. It is zeroed when there is no contact, so callers can
 * apply it unconditionally:
 *
 *     if (resolveCapsule(col, x, y, z, out)) { x += out.x; y += out.y; z += out.z; }
 *
 * The first version of this returned an absolute position on a clear frame and
 * a delta on a contact, in the same object. That is a trap, and the walker
 * walked into it: it assigned the "delta" instead of adding it, teleporting the
 * player to the push vector's own coordinates.
 *
 * Returns whether there was any contact.
 */
export function resolveCapsule(
  collision: VoxelCollision,
  x: number,
  eyeY: number,
  z: number,
  out: Vec3Like,
): boolean {
  const centreY = eyeY - EYE_ABOVE_CAPSULE_CENTRE;
  return collision.queryCapsule(x, centreY, z, CAPSULE_HEIGHT / 2, CAPSULE_RADIUS, out);
}

/** World position of a voxel centre, for debugging and assertions. */
export function voxelToWorld(metadata: VoxelMetadata, ix: number, iy: number, iz: number): Vec3Like {
  const r = metadata.voxelResolution;
  return {
    x: metadata.gridBounds.min[0] + (ix + 0.5) * r,
    y: metadata.gridBounds.min[1] + (iy + 0.5) * r,
    z: metadata.gridBounds.min[2] + (iz + 0.5) * r,
  };
}

/** Grid cell containing a world position. */
export function worldToVoxel(
  metadata: VoxelMetadata,
  x: number,
  y: number,
  z: number,
): { ix: number; iy: number; iz: number } {
  const r = metadata.voxelResolution;
  return {
    ix: Math.floor((x - metadata.gridBounds.min[0]) / r),
    iy: Math.floor((y - metadata.gridBounds.min[1]) / r),
    iz: Math.floor((z - metadata.gridBounds.min[2]) / r),
  };
}
