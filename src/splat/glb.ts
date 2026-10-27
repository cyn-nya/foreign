/**
 * Is this buffer a glTF binary, or is it something a web server made up?
 *
 * This lives on its own because the answer is needed by `SplatRoom`, which pulls in the
 * whole viewer, and importing that is enough to stop a unit test from running. A pure
 * function that decides whether a response is a model is worth being able to test.
 */

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // 'glTF'

/**
 * The check that matters is not "did the request succeed" but "is this a model", and on
 * a static host those are different questions: a path that does not exist is answered
 * with the app's own `index.html` and a 200 OK.
 *
 * That is not hypothetical. One absent `.glb` put a web page into the model cache, and
 * the loader's `JSON.parse` on `<!doctype html>` took the whole session down -- on a
 * floor the player could otherwise have played.
 */
export function hasGlbMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const head = new Uint8Array(buffer, 0, 4);
  return GLB_MAGIC.every((byte, i) => head[i] === byte);
}
