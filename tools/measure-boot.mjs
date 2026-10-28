/**
 * How long until the game is playable, versus how long until every asset is there.
 *
 * The catalogue preload is started rather than awaited, so those are now two different numbers
 * and the gap between them is the whole point of the change. Without this measurement the claim
 * "the player starts sooner" is unverifiable -- and the two numbers were identical before, which
 * is why the change looked like it did nothing.
 *
 *     node tools/measure-boot.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = 'dist';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('no');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage();
const started = Date.now();
await page.goto(`${url}/?autostart=1`, { waitUntil: 'load', timeout: 120_000 });

// Poll both flags from the page itself, so the numbers share one clock and are not distorted by
// however long a round trip through the driver takes on a machine this slow.
const timings = await page.evaluate(async () => {
  const s = window.__splat;
  const t0 = performance.now();
  const waitFor = (fn, limit) =>
    new Promise((resolve) => {
      const tick = () => {
        if (fn()) return resolve(performance.now() - t0);
        if (performance.now() - t0 > limit) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    });
  const playable = await waitFor(() => s.ready, 300_000);
  const settled = await waitFor(() => s.assets.settled, 300_000);
  return { playable, settled, loaded: s.assets.loaded, missing: s.assets.missing.length };
});

console.log(`wall clock to load event:   ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (timings.playable === null) {
  console.log('playable: never became ready');
} else {
  console.log(`playable (ready flag):      ${(timings.playable / 1000).toFixed(1)} s`);
}
if (timings.settled === null) {
  console.log('assets: never settled');
} else {
  console.log(`every asset present:        ${(timings.settled / 1000).toFixed(1)} s`);
}
if (timings.playable !== null && timings.settled !== null) {
  const gap = (timings.settled - timings.playable) / 1000;
  console.log(
    `\nthe player waited ${gap.toFixed(1)} s less than the catalogue took ` +
      `(${timings.loaded} loaded, ${timings.missing} missing)`,
  );
}

await browser.close();
server.close();
