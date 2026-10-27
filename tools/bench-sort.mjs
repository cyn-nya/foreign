/**
 * Does throttling the sort actually buy frames?
 *
 *   node tools/bench-sort.mjs
 *
 * The quality controller gained a second axis -- `sort.minIntervalMs`, which caps
 * how often the gaussian sort runs -- because the measured bottleneck is the CPU
 * sort rather than fill rate. That change shipped unmeasured.
 *
 * Absolute frame rate here is meaningless: SwiftShader renders this room under one
 * frame per second, and that says nothing about a GPU. But two configurations
 * measured the same way on the same machine are comparable, and "does capping the
 * sort raise the frame rate on a sort-bound renderer" is a question this machine is
 * unusually well suited to answer. It is the most sort-bound machine the game will
 * ever run on.
 *
 * The first version of this benchmark ran for 12 seconds per condition and drew
 * three to eight frames, then printed a verdict. That was not a measurement: the
 * numbers went down and then up, which is what noise looks like, and a conclusion
 * drawn from it would have been about the machine's mood. So:
 *
 *   - the floor, the seed and the camera pose are pinned, so the geometry and the
 *     view are identical across every sample;
 *   - the resolution is pinned at 1.0, so the only thing varying is the sort. Left
 *     to the controller, a frame-rate change would lower the resolution too and the
 *     two effects would cancel into a flat line reading "the sort does nothing";
 *   - each condition is sampled for 90 seconds and repeated, so drift over the run
 *     cannot land on one condition;
 *   - the result is a trimmed median frame time, and the script refuses to state a
 *     verdict unless it collected enough frames for one to mean anything.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStatic } from './static-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTERVALS = [0, 8, 24, 50];
const SAMPLE_MS = Number(process.env.BENCH_SAMPLE_MS ?? 90_000);
const REPEATS = Number(process.env.BENCH_REPEATS ?? 2);
/** Below this, a median frame time is a coin toss and no verdict is allowed. */
const MIN_FRAMES = 20;
const FLOOR = Number(process.env.BENCH_FLOOR ?? 4);
const SEED = Number(process.env.BENCH_SEED ?? 11);
/** One fixed pose, so every sample looks at exactly the same thing. */
const POSE = { x: -4.148, y: 1.0, z: 1.232, yaw: -1.786, pitch: 0.082 };

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

const sample = (ms) =>
  page.evaluate(
    async ({ ms, FLOOR, SEED, SAMPLE_MS, POSE }) => {
      const s = window.__splat;
      await s.start(FLOOR, SEED);
      // Pin the level first (which locks auto off and the resolution at full),
      // then override only the sort interval.
      s.setQuality(5);
      s.teleport(POSE.x, POSE.y, POSE.z, POSE.yaw, POSE.pitch);
      s.setSortInterval(ms);
      // Let the floor load and the loop settle before the clock starts; the first
      // frames after a start carry the load, not the steady state.
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

      // A stall in the middle is the machine, not the configuration. Drop the
      // slowest tenth before taking the median, and keep the count honest.
      const sorted = [...gaps].sort((a, b) => a - b);
      const keep = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.9)));
      const median = keep.length % 2
        ? keep[(keep.length - 1) / 2]
        : (keep[keep.length / 2 - 1] + keep[keep.length / 2]) / 2;
      return {
        frames: gaps.length,
        kept: keep.length,
        medianMs: median,
        meanMs: keep.reduce((a, b) => a + b, 0) / Math.max(1, keep.length),
        applied: s.quality().sortIntervalMs,
        ratio: s.quality().ratio,
      };
    },
    { ms, FLOOR, SEED, SAMPLE_MS, POSE },
  );

async function run(ms) {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) {
    const r = await sample(ms);
    runs.push(r);
    console.log(
      `  sort ${String(ms).padStart(2)} ms  rep ${i + 1}  ${r.frames} frames ` +
        `(kept ${r.kept})  median ${r.medianMs.toFixed(0)} ms  mean ${r.meanMs.toFixed(0)} ms  ` +
        `applied ${r.applied}  ratio ${r.ratio}`,
    );
  }
  // Median of the repeats, so one bad rep cannot decide the condition.
  const medians = runs.map((r) => r.medianMs).sort((a, b) => a - b);
  const median = medians.length % 2
    ? medians[(medians.length - 1) / 2]
    : (medians[medians.length / 2 - 1] + medians[medians.length / 2]) / 2;
  return { ms, runs, frames: runs.reduce((a, r) => a + r.frames, 0), medianMs: median };
}

const results = [];
console.log(`sampling ${SAMPLE_MS / 1000}s per rep, ${REPEATS} reps, floor ${FLOOR}, fixed pose\n`);
for (const ms of INTERVALS) results.push(await run(ms));

console.log('\ncondition   median frame   vs every-frame');
const base = results.find((r) => r.ms === 0) ?? results[0];
for (const r of results) {
  const delta = base.medianMs > 0 ? (r.medianMs / base.medianMs - 1) * 100 : 0;
  console.log(
    `sort ${String(r.ms).padStart(2)} ms   ${r.medianMs.toFixed(0).padStart(8)} ms   ` +
      `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% ${delta < 0 ? '(faster)' : ''}`,
  );
}

const totalFrames = results.reduce((a, r) => a + r.frames, 0);
const thin = results.filter((r) => r.frames < MIN_FRAMES);
console.log(`\ntotal frames collected: ${totalFrames}`);
if (thin.length) {
  console.log(
    `NO VERDICT: ${thin.map((r) => `${r.ms} ms drew only ${r.frames}`).join(', ')} — short of ` +
      `${MIN_FRAMES} frames each. This machine is too slow to answer the question in one run, ` +
      `and the numbers above are noise. Raise BENCH_SAMPLE_MS or BENCH_REPEATS.`,
  );
} else {
  const best = results.reduce((a, b) => (b.medianMs < a.medianMs ? b : a), results[0]);
  const gain = base.medianMs > 0 ? (1 - best.medianMs / base.medianMs) * 100 : 0;
  if (gain >= 10) {
    console.log(
      `VERDICT: capping the sort pays — ${best.ms} ms is ${gain.toFixed(0)}% less time per ` +
        `frame than sorting every frame, on the most sort-bound machine available.`,
    );
  } else {
    console.log(
      `VERDICT: capping the sort did not pay here (best ${best.ms} ms, ${gain.toFixed(0)}%). ` +
        `Either the sort is not the bottleneck or the renderer already skips it. It should ` +
        `not be claimed as a speed-up.`,
    );
  }
}

await browser.close();
await server.close();
