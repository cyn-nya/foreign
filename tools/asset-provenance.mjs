/**
 * Which foreign-object assets have actually come from Lux3D.
 *
 * Extracted from `generate-assets.mjs` so the decision can be tested without a
 * network, an API key, or a real catalogue on disk. The bug this guards against
 * is specific and easy to reintroduce: deciding "already generated" from whether
 * the `.glb` exists, when `build-placeholders.mjs` writes a procedural stand-in
 * to exactly the same path.
 */

import fs from 'node:fs';

/** Value written by `generate-assets.mjs`; `build-placeholders.mjs` writes another. */
export const LUX3D_SOURCE = 'aholo-lux3d-text-to-3d';

export const PLACEHOLDER_SOURCE = 'procedural placeholders';

/**
 * Reject a file that is not a usable GLB.
 *
 * Returns a reason, or `null` when the bytes are fine. Applied to everything
 * that lands in `public/assets/foreign/` from outside, because the failure this
 * prevents is quiet: a truncated download or an HTML error page saved with a
 * `.glb` extension both produce a file the game will fail to parse at runtime,
 * long after whoever downloaded it has moved on.
 */
export function validateGlbBytes(bytes) {
  if (bytes.length < 1024) return `suspiciously small (${bytes.length} bytes)`;
  // GLB magic is "glTF"
  if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') return 'not a GLB (bad magic)';
  return null;
}

/**
 * Keys recorded in the manifest as produced by Lux3D.
 *
 * Anything unreadable, missing, or written by another tool yields an empty set —
 * the safe direction, because it means regenerating rather than silently keeping
 * a stand-in.
 */
export function lux3dKeys(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.source !== LUX3D_SOURCE) return new Set();
    return new Set((manifest.assets ?? []).map((a) => a.key));
  } catch {
    return new Set();
  }
}

/**
 * Split a catalogue into what still needs generating and what does not.
 *
 * `force` overrides provenance entirely — the point of `--force` is to regenerate
 * real assets as well as stand-ins.
 */
export function classifyAssets({ assets, target, manifestPath, force = false }) {
  const fromLux3d = lux3dKeys(manifestPath);
  const present = (a) => fs.existsSync(target(a.key));
  const isDone = (a) => present(a) && fromLux3d.has(a.key);

  return {
    /**
     * Files that will be skipped: present and recorded as Lux3D output. Empty
     * under `force`, because nothing is skipped then — `already` means "will not
     * be touched", not "came from Lux3D".
     */
    already: force ? [] : assets.filter(isDone),
    /** Work still to do. */
    todo: force ? [...assets] : assets.filter((a) => !isDone(a)),
    /** Files that exist but hold a procedural stand-in. */
    standIns: force ? [] : assets.filter((a) => present(a) && !fromLux3d.has(a.key)),
  };
}
