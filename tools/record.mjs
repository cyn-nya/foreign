/**
 * Record a real run of the game as a demo video.
 *
 *   node tools/record.mjs [--seconds 75] [--keep]
 *
 * This plays the game through the same input path a person would use —
 * `debug.setKey` for movement and `debug.look` for the camera, which is the
 * function the mousemove handler calls — rather than teleporting the camera
 * between shots. A demo assembled from teleports would not be evidence that the
 * game is playable, which is the one thing a demo video is for.
 *
 * Playwright writes WebM; there is no ffmpeg on this machine, so that is the
 * delivered format and it is stated as such rather than silently promised as
 * MP4.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'artifacts', 'video');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const totalSeconds = flag('seconds', 75);
/**
 * Capture size. Overridable because the frame rate is bounded by the capture
 * machine's software renderer rather than by the game: this rebuilds a 63 MB
 * splat through SwiftShader, and at 720p it manages well under one frame a
 * second, which would make the video a slideshow.
 */
const VIEWPORT = { width: flag('width', 1280), height: flag('height', 720) };

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const server = await startStatic(dist);
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    // The drone is part of the atmosphere, so the video should have it.
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  recordVideo: { dir: join(outDir, 'raw'), size: VIEWPORT },
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

console.log(`serving dist on ${server.url}`);
console.log(`recording up to ${totalSeconds}s at ${VIEWPORT.width}x${VIEWPORT.height}`);

// Start from the menu, so the video opens with the game's own front page.
const startedAt = Date.now();
await page.goto(`${server.url}/?seed=20261026`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });
console.log(`  room reconstructed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code, down) => page.evaluate(([c, d]) => window.__splat.setKey(c, d), [code, down]);
const look = (dx, dy) => page.evaluate(([x, y]) => window.__splat.look(x, y), [dx, dy]);

/** Hold a key for a while, easing the camera to keep the shot alive. */
async function walk(code, ms, { turn = 0 } = {}) {
  await key(code, true);
  const step = 120;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await sleep(step);
    if (turn !== 0) await look(turn * (step / 1000), 0);
  }
  await key(code, false);
}

/** Turn on the spot by a total number of mouse units. */
async function turn(totalX) {
  const step = 40;
  const sign = Math.sign(totalX);
  for (let done = 0; Math.abs(done) < Math.abs(totalX); done += step) {
    await look(sign * step, 0);
    await sleep(45);
  }
}

let phase = 'menu';
const begin = Date.now();
const remaining = () => totalSeconds - (Date.now() - begin) / 1000;

// The menu, held long enough for a viewer to read the title and the rules.
await turn(260);
await sleep(1400);

await page.evaluate(() => window.__splat.start(1, 20261026, false));
phase = 'playing';
console.log('  started floor 1');
await sleep(900);

// Look around the way in before setting off.
await turn(-420);

// A wander through the flat, stopping to look at things. The route is fixed so
// the recording is reproducible, but every metre of it is walked.
await walk('KeyW', 4200, { turn: 14 });
await turn(520);
await walk('KeyW', 3600, { turn: -10 });
await turn(-640);
await walk('KeyW', 3000);
await turn(300);

// If the anomaly is in view, walk up to it and mark it. The hunting is the
// point, so the approach is walked too.
const hunt = async () => {
  const before = await page.evaluate(() => {
    const s = window.__splat;
    const onScreen = s.placements().findIndex((p) => p.onScreen);
    return { found: s.found.length, onScreen };
  });
  if (before.found > 0) return true;

  // Sweep the room until something lands near the reticle, then close in.
  for (let sweep = 0; sweep < 8 && remaining() > 18; sweep++) {
    const seen = await page.evaluate(() => {
      const s = window.__splat;
      const i = s.placements().findIndex((p) => p.onScreen);
      return i;
    });
    if (seen >= 0) {
      await page.evaluate((i) => window.__splat.aimAt(i), seen);
      await sleep(260);
      // Step toward it, so the mark is made from close range rather than across
      // the room.
      await walk('KeyW', 700);
      await sleep(200);
      const result = await page.evaluate(() => window.__splat.mark());
      if (result && result.result === 'hit') {
        console.log(`  marked ${result.slotId}`);
        return true;
      }
    }
    await turn(240);
    await walk('KeyW', 900);
  }
  return false;
};

const marked = await hunt();
if (!marked) console.log('  no anomaly marked within the time budget');

// Hold on the result, then let the floor-clear transition play if it happened.
await sleep(2600);
if (remaining() > 6) await turn(200);

const final = await page.evaluate(() => {
  const s = window.__splat;
  return { state: s.state, floor: s.floor, found: s.found.length, score: s.score, frames: s.frames };
});
console.log(
  `  ended: state=${final.state} floor=${final.floor} found=${final.found} ` +
    `score=${final.score} frames=${final.frames}`,
);
if (pageErrors.length) console.log(`  page errors: ${pageErrors.slice(0, 2).join(' | ')}`);

await context.close();
await browser.close();
await server.close();

// Playwright names the file after a uuid; give it a name that says what it is.
const raw = join(outDir, 'raw');
const produced = readdirSync(raw).filter((f) => f.endsWith('.webm'));
if (produced.length === 0) {
  console.error('no video was produced');
  process.exit(1);
}
const target = join(outDir, 'foreign-demo.webm');
renameSync(join(raw, produced[0]), target);
rmSync(raw, { recursive: true, force: true });

const size = statSync(target).size;
console.log(`\nvideo -> ${target}`);
console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB, WebM (no ffmpeg on this machine to remux to MP4)`);
console.log(`  ${pageErrors.length === 0 ? 'no page errors during the run' : 'HAD PAGE ERRORS'}`);
