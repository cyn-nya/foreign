/**
 * Facts about the reconstructed room, with no renderer attached.
 *
 * These live apart from `SplatScene.ts` on purpose: that module imports
 * `@manycore/aholo-viewer`, which needs a browser, so anything importing it
 * cannot be unit-tested in Node. The placement logic needs the spawn and the
 * URLs but not the renderer, so the data is separated from the thing that
 * draws it.
 */

const GS = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';

/** Aholo's open-source indoor reconstruction, and its matching collision field. */
export const ROOM_SCENE_URL = `${GS}/room/scene.7c26e842.spz`;
export const ROOM_VOXEL_META_URL = `${GS}/room/voxel/10c88df3/collision.voxel-meta.json`;
export const ROOM_VOXEL_BIN_URL = `${GS}/room/voxel/10c88df3/collision.voxel.bin`;

/**
 * WALK_DEMO_INDOOR_POSE from the official walk demo: the pose they ship for a
 * first-person walk of this scene. `y` is the eye height, not the feet.
 */
export const ROOM_SPAWN = {
  x: -4.148223469209742,
  y: 1.0000000000000002,
  z: 1.2315243027420304,
  yaw: -1.7860000000000005,
  pitch: 0.082,
} as const;
