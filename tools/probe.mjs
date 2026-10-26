#!/usr/bin/env node
/**
 * 3DGS probe harness.
 *
 * Answers, without a human looking at a picture, whether the Aholo viewer can
 * really render a reconstructed scene in this environment:
 *
 *   node tools/probe.mjs                 # both scenes
 *   node tools/probe.mjs --scene room    # just the room
 *
 * The decisive one is headless Chromium on SwiftShader — that is what the
 * acceptance harness runs on, so if splats do not rasterise here, the whole
 * 3DGS direction cannot be verified automatically.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'artifacts', 'probe');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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

/**
 * Statistics of a screenshot, decoded by Chromium itself.
 *
 * Reading the WebGL canvas in-page via drawImage returns a blank frame for this
 * renderer — the drawing buffer is already gone by the time we ask. Decoding
 * the screenshot instead measures what a human would actually see, which is
 * both the stronger evidence and the thing that ends up in the report.
 */
async function measureScreenshot(scratch, buffer) {
  return scratch.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const tmp = document.createElement('canvas');
    tmp.width = 192;
    tmp.height = 108;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0, tmp.width, tmp.height);
    const { data } = ctx.getImageData(0, 0, tmp.width, tmp.height);
    const W = tmp.width;
    const H = tmp.height;
    const lum = new Float32Array(W * H);
    let sum = 0;
    let max = 0;
    let nonDark = 0;
    let nonWhite = 0;
    const exact = new Set();
    for (let p = 0, i = 0; i < data.length; i += 4, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[p] = l;
      sum += l;
      if (l > max) max = l;
      if (l > 12) nonDark++;
      if (l < 235) nonWhite++;
      exact.add((r << 16) | (g << 8) | b);
    }
    // Edge energy: mean |gradient| in grey levels per pixel. This is the
    // metric that actually separates "a room" from "a smooth bright wash" —
    // brightness and colour counts alone did not.
    let edge = 0;
    let edgeCount = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        const dx = (lum[p + 1] - lum[p - 1]) / 2;
        const dy = (lum[p + W] - lum[p - W]) / 2;
        edge += Math.sqrt(dx * dx + dy * dy);
        edgeCount++;
      }
    }
    const n = data.length / 4;
    return {
      width: img.width,
      height: img.height,
      mean: +(sum / n).toFixed(1),
      max: +max.toFixed(1),
      nonDarkRatio: +(nonDark / n).toFixed(3),
      nonWhiteRatio: +(nonWhite / n).toFixed(3),
      exactColors: exact.size,
      edge: +(edge / edgeCount).toFixed(3),
    };
  }, `data:image/png;base64,${buffer.toString('base64')}`);
}

/** Aim the camera, using the walk demo's yaw/pitch convention. */
function applyYaw({ yaw, pitch }) {
  const cam = window.__camera;
  if (!cam) return false;
  cam.rotation.set(pitch, yaw, 0, 'YXZ');
  window.__viewer.render();
  return true;
}

/** Control: drop the splat and re-render from the same camera. */
function removeSplat() {
  return typeof window.__removeSplat === 'function' ? window.__removeSplat() : false;
}

/** Undo removeSplat — the sweep afterwards needs the splat back. */
function restoreSplat() {
  return typeof window.__restoreSplat === 'function' ? window.__restoreSplat() : false;
}

const args = process.argv.slice(2);
const argValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const onlyScene = argValue('--scene');
/** Skip the viewpoint sweep and the coverage sweep — for measuring load time. */
const noSweep = args.includes('--no-sweep');
/** Passed through to the probe: decode quality knobs. */
const parseQuery = [
  argValue('--sh') ? `sh=${argValue('--sh')}` : null,
  argValue('--pack') ? `pack=${argValue('--pack')}` : null,
]
  .filter(Boolean)
  .join('&');

// Each entry is a pose to photograph once the scene has loaded.
const VIEWS = {
  bear: [
    { name: 'official-basic-example-pose', yaw: 0, pitch: 0, useInitial: true },
    { name: 'control-no-splat', yaw: 0, pitch: 0, withSplatRemoved: true },
  ],
  room: [
    { name: 'spawn-forward', yaw: null, pitch: null, useInitial: true },
    { name: 'spawn-left', yaw: -1.786 + Math.PI / 2, pitch: 0.0 },
    { name: 'spawn-right', yaw: -1.786 - Math.PI / 2, pitch: 0.0 },
    { name: 'spawn-behind', yaw: -1.786 + Math.PI, pitch: 0.0 },
    { name: 'look-up', yaw: -1.786, pitch: 0.5 },
    { name: 'look-down', yaw: -1.786, pitch: -0.5 },
    // the decisive one: same camera, splat removed
    { name: 'control-no-splat', yaw: -1.786, pitch: 0.082, withSplatRemoved: true },
  ],
};

async function main() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('dist/ not found — run `npm run build` first');
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { server, port } = await serve(dist);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  // reused to decode screenshots; see measureScreenshot
  const scratch = await browser.newPage();
  await scratch.goto('about:blank');

  const report = { scenes: [], checks: [] };
  let failures = 0;

  for (const scene of onlyScene ? [onlyScene] : ['bear', 'room']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    console.log(`\n=== ${scene} ===`);
    const started = Date.now();
    await page.goto(`${base}/spike.html?scene=${scene}${parseQuery ? `&${parseQuery}` : ''}`, {
      waitUntil: 'load',
      timeout: 60_000,
    });

    let probe = null;
    try {
      await page.waitForFunction(() => window.__probe && window.__probe.ready, null, { timeout: 240_000 });
      probe = await page.evaluate(() => window.__probe);
    } catch {
      probe = await page.evaluate(() => window.__probe ?? null);
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (!probe) {
      console.error(`  ✗ no probe state after ${elapsed}s`);
      report.checks.push({ name: `${scene}: probe reported state`, ok: false, detail: 'window.__probe missing' });
      failures++;
      await page.close();
      continue;
    }

    console.log(`  stage=${probe.stage} error=${probe.error ?? 'none'} load=${elapsed}s`);
    for (const note of probe.notes) console.log(`    ${note.replace(/<[^>]+>/g, '')}`);

    report.checks.push({
      name: `${scene}: viewer initialised and loaded the splat`,
      ok: probe.stage === 'done' && !probe.error,
      detail: probe.error ?? `stage=${probe.stage}, ${elapsed}s`,
    });
    if (probe.stage !== 'done' || probe.error) failures++;

    report.checks.push({
      name: `${scene}: no page or console errors`,
      ok: pageErrors.length === 0 && consoleErrors.length === 0,
      detail: [...pageErrors, ...consoleErrors].slice(0, 2).join(' | ') || 'clean',
    });
    if (pageErrors.length || consoleErrors.length) failures++;

    const sceneReport = { scene, stage: probe.stage, error: probe.error, loadSeconds: Number(elapsed), views: [] };
    const views = noSweep ? [] : (VIEWS[scene] ?? []);

    for (const view of views) {
      if (view.withSplatRemoved) {
        await page.evaluate(removeSplat);
      } else if (!view.useInitial) {
        await page.evaluate(applyYaw, { yaw: view.yaw, pitch: view.pitch });
      }
      await page.waitForTimeout(700);
      const file = path.join(outDir, `${scene}-${view.name}.png`);
      const shot = await page.screenshot({ path: file, type: 'png' });
      const stats = await measureScreenshot(scratch, shot);
      sceneReport.views.push({ name: view.name, ...stats });
      console.log(
        `    ${view.name.padEnd(26)} mean=${String(stats.mean).padStart(5)} edge=${String(stats.edge).padStart(6)} ` +
          `nonWhite=${String(stats.nonWhiteRatio).padEnd(5)} colors=${String(stats.exactColors).padStart(5)} (${(shot.length / 1024).toFixed(0)} KB)`,
      );
    }

    // The control view removed the splat from the scene. Put it back before
    // measuring anything else, or every later render photographs nothing.
    await page.evaluate(restoreSplat);

    // --- coverage sweep -----------------------------------------------------
    // A reconstructed scan only contains what the capture rig actually saw.
    // The game needs a standing position where the room is there in every
    // direction, so sweep candidates and report which ones work.
    if (scene === 'room' && !noSweep) {
      const POSITIONS = [
        { name: 'walk-pose', x: -4.148, z: 1.232 },
        { name: 'centre', x: -1.0, z: 0.5 },
        { name: 'grid-nw', x: -5.5, z: -3.0 },
        { name: 'grid-ne', x: 2.5, z: -3.0 },
        { name: 'grid-sw', x: -5.5, z: 4.5 },
        { name: 'grid-se', x: 2.5, z: 4.5 },
        { name: 'north', x: -1.0, z: -5.0 },
        { name: 'south', x: -1.0, z: 6.0 },
      ];
      const YAWS = 6;
      sceneReport.coverage = [];
      for (const p of POSITIONS) {
        let rich = 0;
        let bestEdge = 0;
        for (let i = 0; i < YAWS; i++) {
          await page.evaluate(
            ({ x, y, z, yaw }) => window.__setPose(x, y, z, yaw, 0),
            { x: p.x, y: 1.0, z: p.z, yaw: (i / YAWS) * Math.PI * 2 },
          );
          await page.waitForTimeout(240);
          const shot = await page.screenshot({ type: 'png' });
          const s = await measureScreenshot(scratch, shot);
          if (s.edge > 2.5 && s.exactColors > 3000) rich++;
          bestEdge = Math.max(bestEdge, s.edge);
        }
        sceneReport.coverage.push({ ...p, rich, of: YAWS, bestEdge: +bestEdge.toFixed(2) });
        console.log(
          `    coverage ${p.name.padEnd(11)} ${rich}/${YAWS} directions rich (best edge ${bestEdge.toFixed(2)})`,
        );
      }
      const byCoverage = sceneReport.coverage.slice().sort((a, b) => b.rich - a.rich || b.bestEdge - a.bestEdge);
      const best = byCoverage[0];
      report.checks.push({
        name: 'room: some standing position sees the room in every direction',
        ok: best.rich >= YAWS - 1,
        detail: `best=${best.name} ${best.rich}/${YAWS} · ` +
          sceneReport.coverage.map((c) => `${c.name}:${c.rich}`).join(' '),
      });
      if (best.rich < YAWS - 1) failures++;
    }

    // A reconstructed scan is not a full 360° environment: some directions have
    // no captured data and legitimately render black. What must hold is that
    // the room is richly rendered from most directions, and that the splat —
    // not the viewer's background — is what fills the frame.
    const splatViews = sceneReport.views.filter((v) => !v.name.startsWith('control-'));
    const rich = splatViews.filter((v) => v.edge > 2.5 && v.exactColors > 3000);
    if (splatViews.length > 0) {
      const enough = rich.length >= Math.ceil(splatViews.length * 0.6);
      report.checks.push({
        name: `${scene}: renders a detailed image from most tested angles`,
        ok: enough,
        detail: `${rich.length}/${splatViews.length} rich — ` +
          splatViews.map((v) => `${v.name}:edge=${v.edge}/colors=${v.exactColors}`).join(' '),
      });
      if (!enough) failures++;
    }

    // And it must differ from the same view with the splat removed. If these
    // match, the splat is not on screen at all and everything above is noise.
    const control = sceneReport.views.find((v) => v.name === 'control-no-splat');
    const reference = splatViews[0];
    if (control && reference) {
      const differs = Math.abs(control.mean - reference.mean) > 1.5 || Math.abs(control.edge - reference.edge) > 0.5;
      report.checks.push({
        name: `${scene}: the splat actually contributes to the frame`,
        ok: differs,
        detail:
          `with splat mean=${reference.mean}/edge=${reference.edge} · ` +
          `without mean=${control.mean}/edge=${control.edge}`,
      });
      if (!differs) failures++;
    }

    report.scenes.push(sceneReport);
    await page.close();
  }

  await browser.close();
  server.close();

  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(report, null, 2));

  console.log(`\n${'='.repeat(64)}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }
  console.log(`\n${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed`);
  console.log(`screenshots -> ${outDir}`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
