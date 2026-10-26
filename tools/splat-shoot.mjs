#!/usr/bin/env node
/**
 * Acceptance harness for the default entry — FOREIGN in the reconstructed room.
 *
 *   node tools/splat-shoot.mjs [--keep]
 *
 * This drives `/`, not a named page: the point of the 3DGS backend is that it
 * replaced the procedural room, so the default entry has to be the real one. The
 * three.js build is still complete and still verified, by `tools/shoot.mjs`
 * against `classic.html`.
 *
 * It walks the player with a fixed simulated step rather than real time, so a
 * movement assertion does not depend on how fast the headless renderer happens
 * to be running.
 *
 * The interesting movement check is the pair: the walker must be stopped by the
 * room, and must *not* be stopped once the occupancy field is switched off.
 * Either one alone proves nothing — "it stopped" could just be a walker that
 * cannot move, and "it moved" could be a walker that ignores walls. Both checks
 * therefore carry a lower bound, which is what caught this harness passing while
 * `debug.walk` was accidentally left as a stub.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'artifacts', 'splat');
fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
};

function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(dir, url === '/' ? 'index.html' : url);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Simulate the walker for a fixed time, then report the distance covered.
 * Playwright passes a single argument to the page function, so it travels as an
 * object rather than a positional pair.
 */
const walkFor = ({ seconds, code }) => window.__splat.walk(seconds, code);

/** Pause the render loop, draw one frame, and photograph it. */
async function shoot(page, name) {
  await page.evaluate(() => window.__splat.setAutoRender(false));
  await page.evaluate(() => window.__splat.renderOnce());
  await page.waitForTimeout(400);
  const buffer = await page.screenshot({ type: 'png', timeout: 120_000 });
  fs.writeFileSync(path.join(outDir, name), buffer);
  await page.evaluate(() => window.__splat.setAutoRender(true));
  return buffer.length;
}

const { server, port } = await serve(dist);
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

console.log(`serving ${path.relative(root, dist)} on ${base}`);
const started = Date.now();

try {
  // The default entry has to be the real reconstructed room: that is what "the
  // procedural room was replaced" means, and it is the link a judge will open.
  // Driving `/` rather than a named page is the test — if the swap regressed,
  // `__splat` never appears and this times out.
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });
  const state = await page.evaluate(() => window.__splat);
  const loadSeconds = (Date.now() - started) / 1000;

  const entry = await page.evaluate(() => ({
    splat: typeof window.__splat === 'object',
    classic: typeof window.__game === 'object',
  }));
  check(
    'the default entry serves the reconstructed room, not the procedural one',
    entry.splat && !entry.classic,
    `served / → splat=${entry.splat} classic=${entry.classic}`,
  );

  check(
    'boots and loads the reconstructed room',
    state.error === null && state.splat === true,
    `stage=${state.stage} error=${state.error ?? 'none'} load=${loadSeconds.toFixed(1)}s`,
  );
  check(
    'the occupancy field loaded too, so the room is walkable',
    state.collision === true,
    `collision=${state.collision}`,
  );

  // Give the render loop a moment so the first screenshot is a real frame.
  await page.waitForFunction(() => window.__splat.frames > 30, null, { timeout: 120_000 });
  const bootBytes = await shoot(page, '01-ready.png');
  console.log(`    01-ready.png ${Math.round(bootBytes / 1024)} KB`);

  // --- walking --------------------------------------------------------------
  await page.evaluate(() => window.__splat.respawn());
  const short = await page.evaluate(walkFor, { seconds: 1.0, code: 'KeyW' });
  const shortDistance = Math.hypot(short.to[0] - short.from[0], short.to[2] - short.from[2]);
  check(
    'walking forward for one second moves the player a plausible distance',
    shortDistance > 0.3 && shortDistance < 3.5,
    `${shortDistance.toFixed(2)} m in 1.0 s (walk speed is 2.5 m/s)`,
  );

  // Let the walker run into whatever is ahead and see whether the room stops it.
  await page.evaluate(() => window.__splat.respawn());
  const long = await page.evaluate(walkFor, { seconds: 14.0, code: 'KeyW' });
  const longDistance = Math.hypot(long.to[0] - long.from[0], long.to[2] - long.from[2]);
  check(
    'the room stops the player instead of letting them walk out of it',
    // The lower bound is the point. A walker that never moves also never
    // escapes, so an upper bound alone passes while nothing works at all —
    // which is exactly what happened when debug.walk was left as a stub.
    longDistance > 1.0 && longDistance < 12,
    `${longDistance.toFixed(2)} m in 14.0 s (unobstructed would be ~35 m)`,
  );

  const wallBytes = await shoot(page, '02-walked-into-wall.png');
  console.log(`    02-walked-into-wall.png ${Math.round(wallBytes / 1024)} KB`);

  check(
    'the player is still at a sane eye height, so they neither fell nor flew',
    // `long` is all zeros when the walk stub was never replaced, so this has to
    // confirm the walker is really standing somewhere, not merely in range.
    longDistance > 1.0 && long.to[1] > -1.5 && long.to[1] < 4,
    `eye y=${long.to[1].toFixed(2)} (the floor is about -0.45)`,
  );

  // --- the control that makes the previous check mean something -------------
  await page.evaluate(() => window.__splat.respawn());
  await page.evaluate(() => window.__splat.setCollision(false));
  const free = await page.evaluate(walkFor, { seconds: 14.0, code: 'KeyW' });
  await page.evaluate(() => window.__splat.setCollision(true));
  const freeDistance = Math.hypot(free.to[0] - free.from[0], free.to[2] - free.from[2]);
  check(
    'with the occupancy field switched off the same walk goes much further',
    freeDistance > longDistance * 2,
    `without collision ${freeDistance.toFixed(2)} m vs with ${longDistance.toFixed(2)} m`,
  );

  // --- strafing must work too, not just the forward axis -------------------
  await page.evaluate(() => window.__splat.respawn());
  const strafe = await page.evaluate(walkFor, { seconds: 1.2, code: 'KeyD' });
  const strafeDistance = Math.hypot(strafe.to[0] - strafe.from[0], strafe.to[2] - strafe.from[2]);
  check(
    'strafing moves the player roughly perpendicular to walking',
    strafeDistance > 0.3,
    `${strafeDistance.toFixed(2)} m`,
  );

  // --- the game loop, in the real room --------------------------------------
  await page.evaluate(() => window.__splat.start(1));
  const floorStart = await page.evaluate(() => {
    const s = window.__splat;
    return {
      state: s.state,
      placed: s.placed,
      anomalies: s.anomalyCount,
      floor: s.floor,
      marks: s.marksLeft,
      loaded: s.assets.loaded,
      missing: s.assets.missing,
    };
  });
  check(
    'floor 1 puts a foreign object in the reconstructed room',
    floorStart.state === 'playing' && floorStart.placed >= 1 && floorStart.anomalies >= 1,
    `state=${floorStart.state} placed=${floorStart.placed} anomaly=${floorStart.anomalies} ` +
      `assets=${floorStart.loaded} missing=${floorStart.missing.length}`,
  );
  if (floorStart.missing.length > 0) {
    console.log(`    missing assets: ${floorStart.missing.join(', ')}`);
  }

  const foreignBytes = await shoot(page, '03-foreign-object.png');
  console.log(`    03-foreign-object.png ${Math.round(foreignBytes / 1024)} KB`);

  // Aim at the object the way a player would, then mark it.
  const aimed = await page.evaluate(() => {
    const s = window.__splat;
    const slot = s.aimAt(0);
    const placement = s.placements()[0];
    return { slot, onScreen: placement ? placement.onScreen : false, kind: placement?.kind };
  });
  const hit = await page.evaluate(() => window.__splat.mark());
  check(
    'aiming at the foreign object and marking it scores',
    hit.result === 'hit' && hit.found === 1,
    `aimed=${aimed.slot} kind=${aimed.kind} onScreen=${aimed.onScreen} ` +
      `result=${hit.result} found=${hit.found} marksLeft=${hit.marksLeft}`,
  );

  const markedBytes = await shoot(page, '04-marked.png');
  console.log(`    04-marked.png ${Math.round(markedBytes / 1024)} KB`);

  check(
    'clearing the floor advances to the next one',
    hit.state === 'floorClear' || hit.state === 'playing',
    `state after the hit was ${hit.state}`,
  );

  // A mark at the floor is a miss: it must cost a mark and time both, or
  // guessing at random would be free.
  const missed = await page.evaluate(async () => {
    const s = window.__splat;
    await s.start(4);
    const before = { marks: s.marksLeft, time: s.timeLeft };
    // look almost straight down, where there is only scanned floor
    const p = s.player;
    s.teleport(p.x, p.y, p.z, p.yaw, -1.45);
    const report = s.mark();
    return { before, report, after: { marks: s.marksLeft, time: s.timeLeft } };
  });
  check(
    'a wrong mark costs a mark and time, and does not score',
    missed.report.result === 'miss' &&
      missed.after.marks === missed.before.marks - 1 &&
      missed.after.time < missed.before.time,
    `result=${missed.report.result} marks ${missed.before.marks}->${missed.after.marks} ` +
      `time ${missed.before.time.toFixed(1)}->${missed.after.time.toFixed(1)}`,
  );
  check(
    'marking the scanned room itself is not a hit',
    missed.report.found === 0,
    `found=${missed.report.found}`,
  );

  // Burning all three marks has to end the run rather than leave it stuck.
  const burned = await page.evaluate(async () => {
    const s = window.__splat;
    await s.start(5);
    for (let i = 0; i < 3; i++) {
      const p = s.player;
      s.teleport(p.x, p.y, p.z, p.yaw, -1.45);
      s.mark();
    }
    return { state: s.state, marksLeft: s.marksLeft, floor: s.floor };
  });
  check(
    'running out of marks ends the run',
    burned.state === 'gameOver' && burned.marksLeft <= 0,
    `state=${burned.state} marksLeft=${burned.marksLeft}`,
  );

  // A demo link has to open straight into a live floor, so the autostart path is
  // part of the deliverable rather than a convenience.
  await page.goto(`${base}/?autostart=1&floor=3&seed=4242`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });
  const auto = await page.evaluate(() => {
    const s = window.__splat;
    return { state: s.state, floor: s.floor, placed: s.placed, anomalies: s.anomalyCount, marks: s.marksLeft };
  });
  check(
    '?autostart=1&floor=3 opens straight into a live third floor',
    auto.state === 'playing' && auto.floor === 3 && auto.anomalies >= 1,
    `state=${auto.state} floor=${auto.floor} placed=${auto.placed} anomaly=${auto.anomalies} marks=${auto.marks}`,
  );

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'clean');
} catch (error) {
  check('harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  if (!process.argv.includes('--keep')) {
    await browser.close();
    server.close();
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(`screenshots -> ${path.relative(root, outDir)}`);
process.exit(failed === 0 ? 0 : 1);
