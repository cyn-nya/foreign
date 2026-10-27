/**
 * Capture the specific moments the demo video needs to show.
 *
 *   node tools/capture-demo.mjs [--width 1280] [--height 720]
 *
 * Stills, not a screen recording, and that is a response to this machine rather
 * than a preference. Under SwiftShader the reconstruction renders at well under
 * one frame a second, so filming the game produces a slideshow — the previous
 * demo video was 75 seconds of almost-static frames. The game is playable; it
 * cannot be *filmed* here. So each moment is captured as a still, driven through
 * the game's own input path, and tools/build-demo-page.mjs plays them back with
 * motion that is cheap to render.
 *
 * Every still of a subject is verified before it is kept: the camera is aimed at
 * a specific object, and `crosshair()` — the game's own raycast — has to report
 * that same object back. Aiming alone is not enough, because `aimAt` does no
 * line-of-sight check and happily points the camera at the far side of a wall.
 * The first attempt produced a furniture still that was 91% black with a centre
 * standard deviation of 3.6: a wall, framed beautifully.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'artifacts', 'demo-shots');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
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
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every still written, in order, so the page builder cannot drift from them. */
const shots = [];
/** What each still is of, and the raycast that proves it. */
const evidence = [];
const failures = [];

/** Wait for the render loop to actually produce frames, so a shot is not blank. */
async function settle(minFrames = 5) {
  const target = (await page.evaluate(() => window.__splat.frames)) + minFrames;
  await page
    .waitForFunction((t) => window.__splat.frames >= t, target, { timeout: 180_000 })
    .catch(() => console.log('    (frame budget not reached; shooting anyway)'));
}

async function shot(name) {
  await page.evaluate(() => window.__splat.renderOnce());
  await sleep(450);
  const buffer = await page.screenshot({ type: 'png', timeout: 240_000 });
  writeFileSync(join(outDir, name), buffer);
  shots.push(name);
  console.log(`  ${name}  ${Math.round(buffer.length / 1024)} KB`);
}

async function turn(totalX) {
  const step = 40;
  const sign = Math.sign(totalX) || 1;
  for (let done = 0; Math.abs(done) < Math.abs(totalX); done += step) {
    await page.evaluate(([x]) => window.__splat.look(x, 0), [sign * step]);
    await sleep(45);
  }
}

async function startWith(floor, seed, kinds) {
  await page.evaluate(
    ([f, s, k]) => window.__splat.start(f, s, undefined, k),
    [floor, seed, kinds ?? null],
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await page.evaluate(() => window.__splat.state)) === 'playing') return;
    await sleep(150);
  }
}

/** Aim at a placed anomaly and keep trying until the raycast confirms it. */
async function aimAtVisible(tries = 6) {
  for (let i = 0; i < tries; i++) {
    const aimed = await page.evaluate((index) => {
      const s = window.__splat;
      const list = s.placements();
      if (index >= list.length) return null;
      return { slotId: s.aimAt(index), kind: list[index].kind, key: list[index].assetKey };
    }, i);
    if (!aimed) break;
    await settle(2);
    const under = await page.evaluate(() => window.__splat.crosshair());
    if (under !== null && under === aimed.slotId) {
      return { ...aimed, index: i, confirmed: true };
    }
  }
  return null;
}

/** The same, for an innocent household object. */
async function aimAtVisibleBystander(tries = 8) {
  for (let i = 0; i < tries; i++) {
    const aimed = await page.evaluate((index) => window.__splat.aimAtBystander(index), i);
    if (!aimed) break;
    await settle(2);
    const under = await page.evaluate(() => window.__splat.crosshair());
    if (under !== null && under === aimed) {
      return { slotId: aimed, index: i, confirmed: true };
    }
  }
  return null;
}

console.log(`serving dist on ${server.url}`);
await page.goto(`${server.url}/?seed=20261026`, { waitUntil: 'load', timeout: 120_000 });
await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 300_000 });
await page.evaluate(() => window.__splat.setAutoRender(true));

// --- 1. the front page -------------------------------------------------------
await settle(4);
await shot('01-entry.png');

// --- 2. the reconstructed room ----------------------------------------------
await startWith(1, 20261026, null);
await settle(6);
await turn(300);
await settle(4);
await shot('02-room.png');

// --- 3. household furniture: the room's normal ------------------------------
// A bystander is a household prop doing nothing. This is the baseline the player
// judges everything else against, and while it did not exist "does this belong"
// had no answer.
//
// Floor 3 rather than 4, and the reason is in the check rather than in the eye: on floor 4
// this shot came back at 89% near-black with a centre standard deviation of 3.6 -- a frame
// of a dark corner. `check-stills.py` flags exactly that ("flat / likely a wall"), which is
// how it was caught. The floor number is not part of what this still has to show, and the
// darkness curve is, so the shot moves up rather than the check moving down.
await startWith(3, 3103, null);
await settle(5);
{
  const found = await aimAtVisibleBystander();
  if (found) {
    await shot('03-furniture.png');
    evidence.push({ still: '03-furniture.png', of: 'bystander', ...found });
    console.log(`    confirmed on ${found.slotId} (bystander ${found.index})`);
  } else {
    failures.push('03-furniture.png: no bystander with a clear line of sight');
  }
}

// --- 4. an intruder: a generated object that should not exist ----------------
await startWith(4, 4104, ['intrude']);
await settle(5);
{
  const found = await aimAtVisible();
  if (found) {
    await shot('04-intruder.png');
    evidence.push({ still: '04-intruder.png', of: 'intrude', ...found });
    console.log(`    confirmed on ${found.slotId} (${found.key})`);
  } else {
    failures.push('04-intruder.png: the intruder never landed under the crosshair');
  }
}

// --- 5. furniture behaving impossibly ---------------------------------------
await startWith(4, 4104, ['invert']);
await settle(5);
{
  const found = await aimAtVisible();
  if (found) {
    await shot('05-inverted.png');
    evidence.push({ still: '05-inverted.png', of: 'invert', ...found });
    console.log(`    confirmed on ${found.slotId} (${found.key})`);
  } else {
    failures.push('05-inverted.png: the inverted prop never landed under the crosshair');
  }
}

// --- 6. a swarm, which is the same idea past counting ------------------------
await startWith(5, 5105, ['swarm']);
await settle(5);
{
  const found = await aimAtVisible();
  if (found) {
    await shot('06-swarm.png');
    evidence.push({ still: '06-swarm.png', of: 'swarm', ...found });
    console.log(`    confirmed on ${found.slotId} (${found.key})`);
  } else {
    failures.push('06-swarm.png: the swarm never landed under the crosshair');
  }
}

// --- 7. the torch, and how dark a deep floor is ------------------------------
await startWith(7, 7107, null);
await page.evaluate(() => window.__splat.setTorch(true));
await settle(5);
await shot('07-torch.png');

// --- 8. a jump scare ---------------------------------------------------------
await startWith(5, 5105, null);
await settle(4);
await page.evaluate(() => window.__splat.scare(1));
const showing = await page.evaluate(() => window.__splat.scareFaceShowing());
if (showing) {
  await sleep(120);
  await shot('08-scare.png');
  evidence.push({ still: '08-scare.png', of: 'scare', confirmed: true });
} else {
  failures.push('08-scare.png: the scare layer never showed');
}

// --- 9. a correct mark, scored ----------------------------------------------
await startWith(4, 4104, ['invert']);
await settle(5);
{
  const found = await aimAtVisible();
  if (found) {
    const result = await page.evaluate(() => window.__splat.mark());
    await sleep(700);
    await shot('09-marked.png');
    evidence.push({ still: '09-marked.png', of: 'mark', result: result?.result, ...found });
    console.log(`    mark returned ${result?.result}`);
    if (result?.result !== 'hit') failures.push(`09-marked.png: mark returned ${result?.result}`);
  } else {
    failures.push('09-marked.png: nothing under the crosshair to mark');
  }
}

// --- 10. the charge: a generated model crossing the room ---------------------
//
// The newest mechanic and the clearest single frame of what Lux3D is for: the thing
// walking at the camera is a model generated from a text prompt, in a room nobody built.
// Photographed mid-approach rather than at the moment of impact, because the point is that
// it is *coming* -- a frame of the strike is a frame of the screen going white.
await startWith(5, 5105, null);
await settle(4);
{
  const spawned = await page.evaluate(() => {
    const s = window.__splat;
    s.charge();
    // A third of the way in, so the model is legible and the approach is still happening.
    for (let i = 0; i < 3; i++) s.stepCharge(0.3);
    return s.charger();
  });
  if (spawned?.key) {
    await sleep(150);
    await shot('10-charge.png');
    evidence.push({
      still: '10-charge.png',
      of: 'charge',
      key: spawned.key,
      distance: spawned.distance,
      travelled: spawned.travelled,
    });
    console.log(`    caught ${spawned.key} at ${spawned.distance?.toFixed?.(2)} m`);
  } else {
    failures.push('10-charge.png: no charge model spawned');
  }
  // Cleared before the next shot, so a fright from the strike does not land in it.
  await page.evaluate(() => window.__splat.defuseCharge());
  await sleep(250);
}

const report = await page.evaluate(() => {
  const s = window.__splat;
  return { frames: s.frames, state: s.state, darkness: s.darkness() };
});

writeFileSync(
  join(outDir, 'capture.json'),
  JSON.stringify({ viewport: VIEWPORT, shots, evidence, failures, report, pageErrors }, null, 2),
);
console.log(`\ncaptured ${shots.length} stills -> artifacts/demo-shots/`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
if (failures.length) {
  console.log(`\n${failures.length} still(s) could not be verified:`);
  for (const f of failures) console.log(`  - ${f}`);
}

await browser.close();
await server.close();
process.exit(failures.length === 0 ? 0 : 1);
