import { describe, expect, it } from 'vitest';
import { hasGlbMagic } from '../src/splat/glb.ts';

/**
 * The bug this guards was live and reachable.
 *
 * `loadAssets` accepted any successful response as a model. A static host answers an
 * unknown path with the app's own `index.html` and a 200, so one absent `.glb` put a web
 * page in the model cache, and the loader's `JSON.parse` on `<!doctype html>` took the
 * whole session down -- on a floor the player could otherwise have played.
 */
describe('hasGlbMagic', () => {
  const glb = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

  it('accepts a real GLB header', () => {
    // 'glTF' then version 2 and a zero length, which is the smallest legal preamble.
    expect(hasGlbMagic(glb([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
  });

  it('rejects a web page served in place of a missing model', () => {
    const html = new TextEncoder().encode('<!doctype html><html><body>nope</body></html>');
    expect(hasGlbMagic(html.buffer as ArrayBuffer)).toBe(false);
  });

  it('rejects a truncated or empty response', () => {
    expect(hasGlbMagic(glb([0x67, 0x6c]))).toBe(false);
    expect(hasGlbMagic(glb([]))).toBe(false);
  });
});
