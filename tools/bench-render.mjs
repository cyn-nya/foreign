/**
 * Where does the frame actually go?
 *
 *   node tools/bench-render.mjs
 *
 * The README states, as a measured finding, that the bottleneck is not fill rate:
 * 640x360 was reported not faster than 960x540. That measurement was taken the same
 * way the first sort benchmark was -- a handful of frames and a conclusion -- and
 * this round discredited that method. It also says something a software rasteriser
 * should not do. Doubling the pixels of a fill-bound renderer and seeing nothing is
 * the kind of result that means the measurement was wrong, not that fill is free.
 *
 * So this re-asks the question with the method that survived:
 *
 *   - resolution at 1.0, 0.55 and 0.4, which is the axis the quality controller
 *     actually moves and therefore the one worth knowing about;
 *   - the splat pipeline on and off, which separates "the 63 MB reconstruction
 *     costs this much" from "a frame of anything costs this much";
 *   - one floor, one seed, one camera pose, and the camera pinned, so the geometry
 *     and the view are identical across every sample;
 *   - 90 seconds per condition, and no verdict below 20 frames each.
 *
 * `Splatting.enabled = false` still draws the rest of the frame -- the composite,
 * any post-processing, and the requestAnimationFrame loop itself -- so if an empty
 * splat pipeline costs the same as a full one, the reconstruction is not what the
 * time is going into and no amount of quality tuning will fix it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_MS = Number(process.env.BENCH_SAMPLE_MS ?? 90_000);
const MIN_FRAMES = 20;
const FLOOR = Number(process.env.BENCH_FLOOR ?? 4);
const SEED = Number(process.env.BENCH_SEED ?? 11);
const POSE = { x: -4.148, y: 1.0, z: 1.232, yaw: -1.786, pitch: 0.082 };

/** name, pixel ratio, splats drawn */
const CONDITIONS = [
  { name: 'full  1.00x splats', ratio: 1.0, splats: true },
  { name: 'half  0.55x splats', ratio: 0.55, splats: true },
  { name: 'low   0.40x splats', ratio: 0.4, splats: true },
  { name: 'full  1.00x no splats', ratio: 1.0, splats: false },
  { name: 'low   0.40x no splats', ratio: 0.4, splats: false },
];

const server = await startStatic(path.join(root, 'dist'));
const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`${server.url}/`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForFunction(() => window.__splat && window.__splat.ready, null, { timeout: 240_000 });

const sample = (cond) =>
  page.evaluate(
    async ({ cond, FLOOR, SEED, SAMPLE_MS, POSE }) => {
      const s = window.__splat;
      await s.start(FLOOR, SEED);
      s.setQuality(5);
      s.teleport(POSE.x, POSE.y, POSE.z, POSE.yaw, POSE.pitch);
      s.setSplatsVisible(cond.splats);
      s.setPixelRatio(cond.ratio);
      await new Promise((r) => setTimeout(r, 3000));

      const gaps = [];
      let last = performance.now();
      const until = last + SAMPLE_MS;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          if (now >= until) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      const sorted = [...gaps].sort((a, b) => a - b);
      const keep = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.9)));
      const median = keep.length % 2
        ? keep[(keep.length - 1) / 2]
        : (keep[keep.length / 2 - 1] + keep[keep.length / 2]) / 2;
      return {
        frames: gaps.length,
        medianMs: median,
        ratio: s.renderBudget().ratio,
        splats: cond.splats,
      };
    },
    { cond, FLOOR, SEED, SAMPLE_MS, POSE },
  );

const results = [];
console.log(`sampling ${SAMPLE_MS / 1000}s per condition, floor ${FLOOR}, seed ${SEED}, fixed pose\n`);
for (const cond of CONDITIONS) {
  const r = await sample(cond);
  results.push({ ...r, name: cond.name });
  console.log(
    `  ${cond.name.padEnd(22)} ${String(r.frames).padStart(3)} frames  ` +
      `median ${r.medianMs.toFixed(0).padStart(5)} ms  (reported ratio ${r.ratio})`,
  );
}

console.log('\ncondition                  median frame');
for (const r of results) {
  console.log(`  ${r.name.padEnd(24)} ${r.medianMs.toFixed(0).padStart(6)} ms`);
}

const thin = results.filter((r) => r.frames < MIN_FRAMES);
const find = (name) => results.find((r) => r.name === name);
const at = (name) => find(name)?.medianMs ?? NaN;

console.log();
if (thin.length) {
  console.log(
    `NO VERDICT: ${thin.map((r) => `${r.name} drew ${r.frames}`).join(', ')} — short of ` +
      `${MIN_FRAMES} frames. This machine cannot answer the question in one run.`,
  );
} else {
  const full = at('full  1.00x splats');
  const low = at('low   0.40x splats');
  const noSplatFull = at('full  1.00x no splats');

  // Resolution: 0.40x is 6.25x fewer pixels than 1.00x. Anything less than a clear
  // win means the renderer is not fill-bound, which for a software rasteriser would
  // be a surprising thing to be true and a strong hint that the loop, not the
  // drawing, is the cost.
  const resGain = (1 - low / full) * 100;
  console.log(
    `resolution 1.00x -> 0.40x : ${full.toFixed(0)} -> ${low.toFixed(0)} ms ` +
      `(${resGain >= 0 ? '-' : '+'}${Math.abs(resGain).toFixed(0)}% time)`,
  );

  // Splats: the 63 MB reconstruction against an otherwise identical frame.
  const splatCost = (1 - (full - noSplatFull) / full) * 100;
  console.log(
    `splats on -> off at 1.00x   : ${full.toFixed(0)} -> ${noSplatFull.toFixed(0)} ms ` +
      `(the reconstruction is ${(100 - splatCost).toFixed(0)}% of the frame)`,
  );

  console.log();
  if (resGain >= 25) {
    console.log(
      `VERDICT: the renderer IS fill-bound — dropping to 0.40x removes ${resGain.toFixed(0)}% ` +
        `of the frame time. The README's "640x360 is not faster" finding was wrong, and the ` +
        `resolution controller is the right lever.`,
    );
  } else if (full - noSplatFull < full * 0.1) {
    console.log(
      `VERDICT: the reconstruction is not the cost (${(100 - splatCost).toFixed(0)}% of the ` +
        `frame at full resolution). The time is in the per-frame overhead around it, so no ` +
        `quality setting on the splats can help and the fix is to stop drawing frames.`,
    );
  } else {
    console.log(
      `VERDICT: neither axis dominates on its own — resolution saves ${resGain.toFixed(0)}%, ` +
        `the reconstruction costs ${(100 - splatCost).toFixed(0)}%. Report both.`,
    );
  }
}

await browser.close();
await server.close();
