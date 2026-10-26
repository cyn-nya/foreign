/**
 * Headless verification + screenshot harness.
 *
 * Boots the built game in Chromium (SwiftShader), drives it through a
 * scripted run, asserts the frame is actually rendering something, and
 * writes PNGs used for the project report and the demo video.
 *
 *   node tools/shoot.mjs
 *
 * Exits non-zero on: page errors, console errors, a black frame, or a
 * gameplay assertion failing.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'artifacts', 'shots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
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

/** Mean luminance + distinct-colour count of a downsampled frame. */
const FRAME_STATS = `() => {
  const canvas = document.getElementById('viewport');
  const tmp = document.createElement('canvas');
  tmp.width = 192; tmp.height = 108;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
  const { data } = ctx.getImageData(0, 0, tmp.width, tmp.height);
  let sum = 0, max = 0, nonDark = 0;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l;
    if (l > max) max = l;
    if (l > 12) nonDark++;
    seen.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3));
  }
  const n = data.length / 4;
  return { mean: sum / n, max, nonDarkRatio: nonDark / n, colors: seen.size };
}`;

// Camera angles chosen to show each zone off in the report screenshots.
// yaw 0 looks down -z; yaw +PI/2 looks down -x; yaw PI looks down +z.
const SHOT_VIEWS = [
  { name: '01-hall-into-apartment', x: -0.4, z: 4.15, yaw: 0 },
  { name: '02-living-room', x: -0.6, z: 2.9, yaw: 0.5 },
  { name: '03-living-left-wall', x: 0.0, z: -1.0, yaw: Math.PI / 2 },
  { name: '04-kitchen', x: 2.4, z: 1.6, yaw: Math.PI },
  { name: '05-bedroom', x: 2.2, z: 0.0, yaw: 0 },
  { name: '06-hall-and-entry', x: -2.6, z: 3.9, yaw: -Math.PI / 2 },
];

// Open floor positions, every one verified clear of furniture and walls by
// tests/layout.test.ts. Sweeping these proves no prop is authored into a
// spot nobody can ever see — without anyone having to guess an angle.
const SWEEP = [
  { x: -0.4, z: 4.15 },
  { x: -2.6, z: 3.6 },
  { x: -0.5, z: 3.3 },
  { x: -2.4, z: 1.0 },
  { x: -2.4, z: -1.5 },
  { x: -4.0, z: -2.0 },
  { x: -1.0, z: -1.0 },
  { x: 1.0, z: 1.4 },
  { x: 2.4, z: 1.6 },
  { x: 2.0, z: 0.0 },
  { x: 1.2, z: -1.6 },
  { x: 4.0, z: -2.0 },
  { x: 3.3, z: -2.0 },
];
const SWEEP_YAWS = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

async function main() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('dist/ not found — run `npm run build` first');
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { server, port } = await serve(dist);
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-lcd-text'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });

  const report = { url: base, views: [], checks: [] };
  try {
    await page.goto(`${base}/classic.html?autostart=1&capture=1&seed=20261026`, { waitUntil: 'load' });

    await page.waitForFunction(() => {
      const g = window.__game;
      return !!g && g.debug().state === 'playing';
    }, null, { timeout: 30000 });

    const first = await page.evaluate(() => window.__game.debug());
    report.checks.push({
      name: 'boots into a live floor',
      ok: first.state === 'playing' && first.anomalies.length >= 1,
      detail: `state=${first.state} floor=${first.floor} anomalies=${first.anomalies.length}`,
    });
    report.anomalies = first.anomalies;
    report.assets = first.assets;

    for (const view of SHOT_VIEWS) {
      await page.evaluate(
        (v) => window.__game.debugPlace(v.x, v.z, v.yaw, v.pitch ?? 0),
        view,
      );
      await page.waitForTimeout(260);
      const stats = await page.evaluate(FRAME_STATS);
      const fan = await page.evaluate(() => window.__game.debugRaycastFan(9, 5));
      const file = path.join(outDir, `${view.name}.png`);
      await page.screenshot({ path: file, type: 'png' });

      const seen = fan.slots.map(([id]) => id);
      report.views.push({ name: view.name, ...stats, raysHit: `${fan.hit}/${fan.total}`, seen });
      report.checks.push({
        name: `${view.name}: renders a furnished view`,
        ok: fan.hit / fan.total > 0.5 && seen.length >= 3,
        detail: `rays ${fan.hit}/${fan.total}, ${seen.length} distinct props: ${seen.slice(0, 6).join(', ')}`,
      });
    }

    // --- coverage sweep: can the player actually see everything? ----------
    const targets = await page.evaluate(() => window.__game.debugCoverTargets());
    const union = new Set();
    for (const spot of SWEEP) {
      for (const yaw of SWEEP_YAWS) {
        await page.evaluate(
          (v) => window.__game.debugPlace(v.x, v.z, v.yaw),
          { ...spot, yaw },
        );
        const visible = await page.evaluate(() => window.__game.debugVisibleTargets());
        for (const id of visible) union.add(id);
      }
    }
    const neverSeen = targets.filter((id) => !union.has(id));
    report.coverage = {
      considered: targets.length,
      seen: targets.length - neverSeen.length,
      neverSeen,
      totalDistinctPropsSeen: union.size,
    };
    report.checks.push({
      name: 'every findable prop is visible from somewhere the player can stand',
      ok: neverSeen.length === 0,
      detail: neverSeen.length
        ? `never seen: ${neverSeen.join(', ')}`
        : `${targets.length}/${targets.length} props visible across ${SWEEP.length * SWEEP_YAWS.length} viewpoints`,
    });

    // a frame of pure background means the WebGL context died silently
    const dead = report.views.filter((v) => v.nonDarkRatio < 0.05 || v.colors < 12);
    report.checks.push({
      name: 'every view renders geometry',
      ok: dead.length === 0,
      detail: dead.length ? `blank views: ${dead.map((v) => v.name).join(', ')}` : `${report.views.length} views ok`,
    });

    // --- gameplay: a wrong mark costs time ---------------------------------
    await page.evaluate(() => window.__game.debugPlace(-2.4, 2.4, 0));
    await page.waitForTimeout(150);
    const beforeMiss = await page.evaluate(() => window.__game.debug());
    await page.evaluate(() => window.__game.debugMark('__definitely_not_a_slot__'));
    await page.waitForTimeout(120);
    const afterMiss = await page.evaluate(() => window.__game.debug());
    report.checks.push({
      name: 'a wrong mark costs time and does not score',
      ok: afterMiss.score === beforeMiss.score && afterMiss.timeLeft < beforeMiss.timeLeft,
      detail: `score ${beforeMiss.score} -> ${afterMiss.score}, time ${beforeMiss.timeLeft.toFixed(1)} -> ${afterMiss.timeLeft.toFixed(1)}`,
    });
    await page.screenshot({ path: path.join(outDir, '07-wrong-mark.png'), type: 'png' });

    // --- gameplay: mark the floor-1 intruder and clear the floor -----------
    const target = first.anomalies[0];
    await page.evaluate((slot) => window.__game.debugMark(slot), target.slotId);
    await page.waitForTimeout(220);
    const afterHit = await page.evaluate(() => window.__game.debug());
    report.checks.push({
      name: 'marking the anomaly scores and clears the floor',
      ok: afterHit.score > 0 && afterHit.state === 'floorClear' && afterHit.found === 1,
      detail: `state=${afterHit.state} score=${afterHit.score} found=${afterHit.found}`,
    });
    await page.screenshot({ path: path.join(outDir, '08-floor-clear.png'), type: 'png' });

    // --- gameplay: the limited budget of wrong marks -----------------------
    // Playtest feedback asked for a real cost to guessing. These checks prove
    // the budget is spent, is enforced, and actually ends the run.
    await page.evaluate(() => window.__game.debugStartFloor(2));
    await page.waitForTimeout(200);
    const budgetBefore = await page.evaluate(() => window.__game.debug());
    await page.evaluate(() => window.__game.debugMark('__not_a_slot__'));
    await page.waitForTimeout(140);
    const budgetAfter = await page.evaluate(() => window.__game.debug());
    report.checks.push({
      name: 'a wrong mark spends exactly one of the limited marks',
      ok: budgetAfter.marksLeft === budgetBefore.marksLeft - 1 && budgetAfter.state === 'playing',
      detail: `marks ${budgetBefore.marksLeft} -> ${budgetAfter.marksLeft}, state=${budgetAfter.state}`,
    });

    // burn whatever is left, then confirm the run is over
    const cleanSlots = await page.evaluate(() => {
      const anomalous = new Set(window.__game.debug().anomalies.map((a) => a.slotId));
      return window.__game.debugCoverTargets().filter((id) => !anomalous.has(id));
    });
    for (let i = 1; i < budgetBefore.marksLeft; i++) {
      await page.evaluate((slot) => window.__game.debugMark(slot), cleanSlots[i - 1]);
      await page.waitForTimeout(90);
    }
    const exhausted = await page.evaluate(() => window.__game.debug());
    report.checks.push({
      name: 'running out of marks ends the run',
      ok: exhausted.state === 'gameOver' && exhausted.overReason === 'marks' && exhausted.marksLeft === 0,
      detail: `state=${exhausted.state} reason=${exhausted.overReason} marksLeft=${exhausted.marksLeft}`,
    });
    await page.screenshot({ path: path.join(outDir, '09-out-of-marks.png'), type: 'png' });

    // --- gameplay: a horror 'stare' anomaly is real and seeable ------------
    // The design fix for "how do I know what counts?" rests on these objects
    // being unmissable, so this aims the player at one and requires the
    // raycast fan to actually hit it.
    await page.evaluate(() => window.__game.debugStartFloor(4, ['stare']));
    await page.waitForTimeout(260);
    const stareRun = await page.evaluate(() => window.__game.debug());
    const stare = stareRun.anomalies.find((a) => a.kind === 'stare');
    let stareRay = { distance: 0, hits: [] };
    let stance = null;
    if (stare?.pos) {
      // The spawn is in the hall; a stare in the bedroom is legitimately behind
      // a wall from there. Walk a small ring around it and require it to be
      // unoccluded from at least one legal standing position — the same
      // standard the furniture sweep is held to.
      const aimY = stare.pos.y + 0.35;
      for (let i = 0; i < 8 && !stance; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const px = stare.pos.x + Math.cos(ang) * 1.7;
        const pz = stare.pos.z + Math.sin(ang) * 1.7;
        const dx = stare.pos.x - px;
        const dz = stare.pos.z - pz;
        await page.evaluate(
          ({ x, z, yaw, pitch }) => window.__game.debugPlace(x, z, yaw, pitch),
          { x: px, z: pz, yaw: Math.atan2(-dx, -dz), pitch: Math.atan((aimY - 1.6) / Math.hypot(dx, dz)) },
        );
        await page.waitForTimeout(110);
        const ray = await page.evaluate(
          ({ x, y, z }) => window.__game.debugRayToPoint(x, y, z),
          { x: stare.pos.x, y: aimY, z: stare.pos.z },
        );
        if (ray.hits[0]?.slot === stare.slotId) {
          stance = { x: +px.toFixed(2), z: +pz.toFixed(2) };
          stareRay = ray;
        }
      }
      if (stance) {
        await page.screenshot({ path: path.join(outDir, '10-horror-stare.png'), type: 'png' });
      }
    }
    report.checks.push({
      name: 'a stare anomaly hangs at head height and is seeable from the floor',
      ok: !!stare && (stare.offset?.y ?? 0) > 1 && stance !== null,
      detail: stare
        ? `asset=${stare.assetKey} y=${(stare.offset?.y ?? 0).toFixed(2)} ` +
          `stance=${stance ? `(${stance.x}, ${stance.z})` : 'none'} ray=${JSON.stringify(stareRay.hits)}`
        : 'no stare anomaly was produced',
    });

    report.checks.push({
      name: 'no page or console errors',
      ok: problems.length === 0,
      detail: problems.slice(0, 5).join(' | ') || 'clean',
    });
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const failed = report.checks.filter((c) => !c.ok);
  for (const c of report.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  }
  console.log(`\n${report.views.length} screenshots -> ${outDir}`);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
