#!/usr/bin/env node
/**
 * Acceptance harness for the 3DGS backend (`splat.html`).
 *
 *   node tools/splat-shoot.mjs [--keep]
 *
 * The three.js game has `tools/shoot.mjs`; this is its counterpart for the
 * reconstructed-room build. It walks the player with a fixed simulated step
 * rather than real time, so a movement assertion does not depend on how fast
 * the headless renderer happens to be running.
 *
 * The interesting check is the pair at the end: the walker must be stopped by
 * the room, and must *not* be stopped once the occupancy field is switched off.
 * Either one alone proves nothing — "it stopped" could just be a walker that
 * cannot move, and "it moved" could be a walker that ignores walls.
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
  await page.goto(`${base}/splat.html`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });
  const state = await page.evaluate(() => window.__splat);
  const loadSeconds = (Date.now() - started) / 1000;

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
    longDistance < 12,
    `${longDistance.toFixed(2)} m in 14.0 s (unobstructed would be ~35 m)`,
  );

  const wallBytes = await shoot(page, '02-walked-into-wall.png');
  console.log(`    02-walked-into-wall.png ${Math.round(wallBytes / 1024)} KB`);

  check(
    'the player is still at a sane eye height, so they neither fell nor flew',
    long.to[1] > -1.5 && long.to[1] < 4,
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
